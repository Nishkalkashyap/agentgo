#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { basename, relative, resolve, sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import { privateDirectory, stateDirectory, withLock } from './storage.js';
import { loadConfig, saveConfig, rotateToken } from './config.js';
import { identifier, modelSchema, type Config } from './schema.js';
import { WorkspaceFiles } from './filesystem.js';
import { start, stop, restart, status, configureCloudflare } from './hosting.js';
import { createProviders } from './providers.js';
import { runCommand } from './commands.js';
import { AgentError, failureOf } from './errors.js';
import type { StartOptions } from './hosting-types.js';
import { formatConnection, formatStatus, formatToken, formatWorkspaces, formatModels, formatConfig, formatDoctor } from './cli-output.js';
import { version } from './version.js';

// Parsing errors must respect --json too.
let jsonOutput = process.argv.slice(2).includes('--json');
const entry = process.argv[1];
const relativeEntry = entry ? relative(process.cwd(), entry) : '';
const shellQuote = (value: string) => /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
// Suggest `node dist/cli.js` only in a source checkout. Installed copies live under node_modules,
// and some launchers (pnpm's, for one) run cli.js by its full path rather than through a symlink.
const fromSource = entry && basename(entry) === 'cli.js' && !entry.split(sep).includes('node_modules');
const executable = fromSource ? `node ${shellQuote(relativeEntry)}` : 'agentgo';

const help = `Usage: agentgo <command> [options]

Run Codex and Claude Code on this computer from a remote MCP client.

Setup:
  doctor                           Check that codex, claude, rg and cloudflared are ready
  workspace add-folder <path>      Let agents work in every project inside a folder, e.g. ~/code
  workspace add <id> <path>        Let agents work in one project
  workspace remove <id|path>       Remove a project or a folder of projects
  workspace list                   List the projects agents can work in
  model add <id> --efforts <list>  Add a Claude model, e.g. --efforts low,medium,high
  config show                      Show the current settings

Server:
  start                            Start the server in the background and print connection details
  restart                          Stop the server, then start it
  status                           Show whether the server is running
  stop                             Stop the server; runs in progress are interrupted
  token rotate                     Replace the connection password
  stdio                            Serve a single local MCP client over stdin and stdout

Start options:
  --quick                          Use a random trycloudflare.com address (the default)
  --custom-domain-with-cf <host>   Use your own domain through a Cloudflare tunnel
  --tunnel-token-file <path>       Use a tunnel created in the Cloudflare dashboard
  --hostname <host>                Public hostname of that dashboard tunnel
  --port <number>                  Local port; required with --tunnel-token-file
  --local                          Listen on 127.0.0.1 only, with no tunnel
  --cloudflared <path>             Use this cloudflared executable
  --yes                            Download cloudflared if it isn't installed
  --no-download                    Never download cloudflared

Other options:
  --state-dir <path>               Where settings and run history live (default ~/.agentgo)
  --json                           Print JSON instead of text
  -h, --help                       Show this help
  -v, --version                    Show the version

Changes to workspaces, models and settings apply straight away; no restart needed.
`;
async function findWorkspaces(directory: string, config: Config) {
  await privateDirectory(directory);
  const files = new WorkspaceFiles(config, directory);
  await files.prepare();
  return files.all();
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'state-dir': { type: 'string' }, quick: { type: 'boolean' }, local: { type: 'boolean' }, 'custom-domain-with-cf': { type: 'string' },
    'tunnel-token-file': { type: 'string' }, hostname: { type: 'string' }, port: { type: 'string' }, cloudflared: { type: 'string' },
    yes: { type: 'boolean' }, 'no-download': { type: 'boolean' }, json: { type: 'boolean' }, efforts: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  } });
  jsonOutput = Boolean(values.json);
  if (values.version) { console.log(version); return; }
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
      const config = await loadConfig(directory);
      const found = await findWorkspaces(directory, config);
      return output({ folders: config.folders, workspaces: found }, formatWorkspaces(config.folders, found, invocation));
    }
    const target = id;
    if (!target || !['add-folder', 'add', 'remove'].includes(action ?? '') || (action === 'add' && !path)) {
      throw new AgentError('USAGE', 'Use workspace add-folder <path>, workspace add <id> <path>, workspace remove <id|path> or workspace list.');
    }
    return withLock(directory, async () => {
      const config = await loadConfig(directory);
      if (action === 'add-folder') config.folders = [...config.folders, resolve(target)];
      if (action === 'add') {
        identifier.parse(target);
        config.workspaces = [...config.workspaces.filter(workspace => workspace.id !== target), { id: target, path: resolve(path!) }];
      }
      if (action === 'remove') {
        const full = await realpath(resolve(target)).catch(() => resolve(target));
        const before = config.workspaces.length + config.folders.length;
        config.workspaces = config.workspaces.filter(workspace => workspace.id !== target && workspace.path !== full);
        config.folders = config.folders.filter(folder => folder !== full);
        if (config.workspaces.length + config.folders.length === before) {
          throw new AgentError('NOT_FOUND', `No workspace or folder matches ${target}. Run workspace list to see them.`);
        }
      }
      // Adding the same folder twice is harmless; keep one copy.
      config.folders = [...new Set(config.folders)];
      await saveConfig(directory, config);
      const saved = await loadConfig(directory);
      const found = await findWorkspaces(directory, saved);
      output({ folders: saved.folders, workspaces: found }, formatWorkspaces(saved.folders, found, invocation));
    });
  }
  if (command === 'model') {
    if (action !== 'add' || !id || !values.efforts) throw new AgentError('USAGE', 'Use model add <id> --efforts low,medium,high.');
    return withLock(directory, async () => {
      const config = await loadConfig(directory);
      const model = modelSchema.parse({ id, efforts: values.efforts!.split(',') });
      config.claudeModels = [...config.claudeModels.filter(m => m.id !== id), model];
      await saveConfig(directory, config);
      output({ models: config.claudeModels }, formatModels(config.claudeModels));
    });
  }
  if (command === 'config' && action === 'show') {
    const config = await loadConfig(directory);
    return output(config, formatConfig(config, await findWorkspaces(directory, config), invocation));
  }
  if (command === 'token' && action === 'rotate') return withLock(directory, async () => {
    const token = await rotateToken(directory);
    output({ token, message: 'Password replaced. The old one stops working immediately.' }, formatToken(token));
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
    const workspaces = (await findWorkspaces(directory, config)).length;
    return output({ checks, workspaces, stateDir: directory, approvalPolicy: 'auto-approval' }, formatDoctor(checks, workspaces, directory, invocation));
  }
  if (command === 'status') {
    const result = await status({ stateDir: directory });
    return output(result, formatStatus(result, invocation));
  }
  if (command === 'stop') return output(await stop({ stateDir: directory }), 'AgentGo is stopped.');
  if (command === 'start' || command === 'restart') {
    if ([values.local, values.quick, values['custom-domain-with-cf'], values['tunnel-token-file']].filter(Boolean).length > 1) throw new AgentError('USAGE', 'Use only one of --quick, --local, --custom-domain-with-cf and --tunnel-token-file.');
    const options: StartOptions = { stateDir: directory, ...(values.port ? { port: Number(values.port) } : {}), cloudflaredPath: values.cloudflared,
      downloadCloudflared: values.yes ? true : values['no-download'] ? false : undefined };
    if (values.local) options.tunnel = null;
    if (values.quick) options.tunnel = { mode: 'quick' };
    if (values['custom-domain-with-cf']) options.tunnel = await configureCloudflare({ ...options, hostname: values['custom-domain-with-cf'], login: true });
    if (values['tunnel-token-file']) {
      if (!values.hostname) throw new AgentError('USAGE', '--tunnel-token-file also needs --hostname and --port.');
      options.tunnel = { mode: 'token', hostname: values.hostname, tokenFile: resolve(values['tunnel-token-file']) };
    }
    const result = await (command === 'restart' ? restart : start)(options);
    const workspaces = (await findWorkspaces(directory, await loadConfig(directory))).length;
    return output(result, formatConnection(result, invocation, workspaces));
  }
  throw new AgentError('USAGE', 'Unknown command. Run agentgo --help.');
}
void main().catch(error => {
  const failure = failureOf(error);
  console.error(jsonOutput ? JSON.stringify(failure) : `Error [${failure.code}]: ${failure.message}`);
  process.exitCode = 1;
});
