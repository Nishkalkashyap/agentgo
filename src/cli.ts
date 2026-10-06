#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { stateDirectory, withLock } from './storage.js';
import { loadConfig, saveConfig, rotateToken } from './config.js';
import { identifier, modelSchema } from './schema.js';
import { start, stop, restart, status, configureCloudflare } from './hosting.js';
import { serveAgentStdio } from './stdio.js';
import { createProviders } from './providers.js';
import { runCommand } from './commands.js';
import { AgentError, failureOf } from './errors.js';
import type { StartOptions } from './hosting-types.js';

const help = `agentgo — local Codex and Claude Code over MCP

Commands:
  workspace add <id> <path>       Register a trusted project directory
  workspace list                 List configured workspaces
  workspace remove <id>          Remove a workspace (restart to apply)
  model add <id> --efforts <csv>  Configure a Claude model and supported efforts
  config show                    Show local configuration
  doctor                         Inspect dependencies and login readiness
  stdio                          Serve a local MCP client
  start | restart                Start background HTTP + Cloudflare hosting
  status | stop                  Inspect or stop the local daemon
  token rotate                   Create/rotate the remote bearer token

Options:
  --state-dir <path>              State directory (default ~/.agentgo)
  --quick                        Account-free Quick Tunnel
  --local                        Loopback HTTP without a tunnel
  --custom-domain-with-cf <host>  Configure a named tunnel and DNS
  --tunnel-token-file <path>      Use a dashboard-managed tunnel
  --hostname <host>              Hostname for a token tunnel
  --port <number>                HTTP port (required for token tunnels)
  --cloudflared <path>            Explicit cloudflared executable
  --yes                          Allow verified cloudflared download
  --no-download                  Require an installed cloudflared
  --json                         Machine-readable output (also the default)

Both providers always use native auto-approval. No per-run policy override.
Workspace/config changes require a daemon restart. Token rotation is immediate.
`;
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'state-dir': { type: 'string' }, quick: { type: 'boolean' }, local: { type: 'boolean' }, 'custom-domain-with-cf': { type: 'string' },
    'tunnel-token-file': { type: 'string' }, hostname: { type: 'string' }, port: { type: 'string' }, cloudflared: { type: 'string' },
    yes: { type: 'boolean' }, 'no-download': { type: 'boolean' }, json: { type: 'boolean' }, efforts: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  if (values.version) { console.log('0.1.0'); return; }
  if (values.help || !positionals.length) { console.log(help); return; }
  const directory = stateDirectory(values['state-dir']);
  const [command, action, id, path] = positionals;
  const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
  if (command === 'stdio') {
    const server = await serveAgentStdio({ stateDir: directory });
    process.once('SIGINT', () => void server.close()); process.once('SIGTERM', () => void server.close());
    return;
  }
  if (command === 'workspace') {
    if (action === 'list') return output({ workspaces: (await loadConfig(directory)).workspaces });
    if (!id || !['add','remove'].includes(action ?? '') || (action === 'add' && !path)) throw new AgentError('USAGE', 'Use workspace add <id> <path> or workspace remove <id>.');
    identifier.parse(id);
    return withLock(directory, async () => {
      const config = await loadConfig(directory);
      config.workspaces = config.workspaces.filter(workspace => workspace.id !== id);
      if (action === 'add') config.workspaces.push({ id, path: resolve(path!) });
      await saveConfig(directory, config);
      output({ workspaces: config.workspaces, message: 'Restart a running daemon to apply workspace changes.' });
    });
  }
  if (command === 'model' && action === 'add' && id && values.efforts) return withLock(directory, async () => {
    const config = await loadConfig(directory);
    const model = modelSchema.parse({ id, efforts: values.efforts!.split(',') });
    config.claudeModels = [...config.claudeModels.filter(m => m.id !== id), model];
    await saveConfig(directory, config); output({ models: config.claudeModels });
  });
  if (command === 'config' && action === 'show') return output(await loadConfig(directory));
  if (command === 'token' && action === 'rotate') return withLock(directory, async () => output({ token: await rotateToken(directory), message: 'Token rotated. Existing credentials stop working on the next request.' }));
  if (command === 'doctor') {
    const config = await loadConfig(directory);
    const providers = createProviders(config);
    const checks = await Promise.all(['codex','claude','rg','cloudflared'].map(async name => {
      try {
        if (name === 'codex') {
          const capabilities = await providers.codex.capabilities();
          let authenticated = false;
          try { await runCommand(config.codexPath, ['login','status']); authenticated = true; } catch {}
          return { ...capabilities, authenticated };
        }
        if (name === 'claude') {
          const capabilities = await providers.claude.capabilities();
          let authenticated = false;
          try { authenticated = Boolean(JSON.parse(await runCommand(config.claudePath, ['auth','status'])).loggedIn); } catch {}
          return { ...capabilities, authenticated };
        }
        return { dependency: name, version: (await runCommand(name === 'rg' ? config.rgPath : values.cloudflared ?? 'cloudflared', ['--version'])).split('\n')[0], available: true };
      } catch (error) { return { dependency: name, available: false, error: failureOf(error) }; }
    }));
    return output({ checks, workspaces: config.workspaces.length, stateDir: directory, approvalPolicy: 'auto-approval' });
  }
  if (command === 'status') return output(await status({ stateDir: directory }));
  if (command === 'stop') return output(await stop({ stateDir: directory }));
  if (command === 'start' || command === 'restart') {
    if ([values.local, values.quick, values['custom-domain-with-cf'], values['tunnel-token-file']].filter(Boolean).length > 1) throw new AgentError('USAGE', 'Choose one hosting mode.');
    const options: StartOptions = { stateDir: directory, ...(values.port ? { port: Number(values.port) } : {}), cloudflaredPath: values.cloudflared,
      downloadCloudflared: values.yes ? true : values['no-download'] ? false : undefined };
    if (values.local) options.tunnel = null;
    if (values.quick) options.tunnel = { mode: 'quick' };
    if (values['custom-domain-with-cf']) options.tunnel = await configureCloudflare({ ...options, hostname: values['custom-domain-with-cf'], login: true });
    if (values['tunnel-token-file']) {
      if (!values.hostname) throw new AgentError('USAGE', 'Token tunnels require --hostname and --port.');
      options.tunnel = { mode: 'token', hostname: values.hostname, tokenFile: resolve(values['tunnel-token-file']) };
    }
    return output(await (command === 'restart' ? restart : start)(options));
  }
  throw new AgentError('USAGE', 'Unknown command. Run agentgo --help.');
}
void main().catch(error => { console.error(JSON.stringify(failureOf(error))); process.exitCode = 1; });
