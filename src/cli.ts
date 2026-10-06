#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { basename, relative, resolve } from 'node:path';
import { stateDirectory, withLock } from './storage.js';
import { loadConfig, saveConfig, rotateToken } from './config.js';
import { identifier, modelSchema } from './schema.js';
import { start, stop, restart, status, configureCloudflare } from './hosting.js';
import { createProviders } from './providers.js';
import { runCommand } from './commands.js';
import { AgentError, failureOf } from './errors.js';
import type { StartOptions } from './hosting-types.js';
import { formatConnection, formatStatus, formatToken, formatWorkspaces, formatModels, formatConfig, formatDoctor } from './cli-output.js';

// Parsing errors must respect --json too.
let jsonOutput = process.argv.slice(2).includes('--json');
const entry = process.argv[1];
const relativeEntry = entry ? relative(process.cwd(), entry) : '';
const shellQuote = (value: string) => /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
const executable = entry && basename(entry) === 'cli.js' ? `node ${shellQuote(relativeEntry)}` : 'agentgo';

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
  --json                         Return JSON instead of human-readable output

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
  jsonOutput = Boolean(values.json);
  if (values.version) { console.log('0.1.0'); return; }
  if (values.help || !positionals.length) { console.log(help); return; }
  const directory = stateDirectory(values['state-dir']);
  const invocation = values['state-dir'] ? `${executable} --state-dir ${shellQuote(directory)}` : executable;
  const [command, action, id, path] = positionals;
  const output = (value: unknown, human: string) => console.log(jsonOutput ? JSON.stringify(value, null, 2) : human);
  if (command === 'stdio') {
    const { serveAgentStdio } = await import('./stdio.js');
    const server = await serveAgentStdio({ stateDir: directory });
    process.once('SIGINT', () => void server.close()); process.once('SIGTERM', () => void server.close());
    return;
  }
  if (command === 'workspace') {
    if (action === 'list') {
      const { workspaces } = await loadConfig(directory);
      return output({ workspaces }, formatWorkspaces(workspaces));
    }
    if (!id || !['add','remove'].includes(action ?? '') || (action === 'add' && !path)) throw new AgentError('USAGE', 'Use workspace add <id> <path> or workspace remove <id>.');
    identifier.parse(id);
    return withLock(directory, async () => {
      const config = await loadConfig(directory);
      config.workspaces = config.workspaces.filter(workspace => workspace.id !== id);
      if (action === 'add') config.workspaces.push({ id, path: resolve(path!) });
      await saveConfig(directory, config);
      const message = 'Restart a running daemon to apply workspace changes.';
      output({ workspaces: config.workspaces, message }, formatWorkspaces(config.workspaces, message));
    });
  }
  if (command === 'model' && action === 'add' && id && values.efforts) return withLock(directory, async () => {
    const config = await loadConfig(directory);
    const model = modelSchema.parse({ id, efforts: values.efforts!.split(',') });
    config.claudeModels = [...config.claudeModels.filter(m => m.id !== id), model];
    await saveConfig(directory, config); output({ models: config.claudeModels }, formatModels(config.claudeModels));
  });
  if (command === 'config' && action === 'show') {
    const config = await loadConfig(directory);
    return output(config, formatConfig(config));
  }
  if (command === 'token' && action === 'rotate') return withLock(directory, async () => {
    const token = await rotateToken(directory);
    output({ token, message: 'Token rotated. Existing credentials stop working on the next request.' }, formatToken(token));
  });
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
    return output({ checks, workspaces: config.workspaces.length, stateDir: directory, approvalPolicy: 'auto-approval' }, formatDoctor(checks, config.workspaces.length, directory));
  }
  if (command === 'status') {
    const result = await status({ stateDir: directory });
    return output(result, formatStatus(result, invocation));
  }
  if (command === 'stop') return output(await stop({ stateDir: directory }), 'AgentGo is stopped.');
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
    const result = await (command === 'restart' ? restart : start)(options);
    return output(result, formatConnection(result, invocation));
  }
  throw new AgentError('USAGE', 'Unknown command. Run agentgo --help.');
}
void main().catch(error => {
  const failure = failureOf(error);
  console.error(jsonOutput ? JSON.stringify(failure) : `Error [${failure.code}]: ${failure.message}`);
  process.exitCode = 1;
});
