import type { Config } from './schema.js';
import type { DaemonState } from './hosting-types.js';

const field = (label: string, value: string | number) => `  ${`${label}:`.padEnd(17)} ${value}`;
const setupHint = (command: string) => [
  'No workspaces yet, so agents have nowhere to work. Add the folder your projects live in:',
  `  ${command} workspace add-folder ~/code`,
  'Every project inside it becomes a workspace, including ones you create later. No restart needed.',
];

function authentication(token: string): string[] {
  return [
    field('Header name', 'Authorization'),
    field('Header value', `Bearer ${token}`),
    '',
    'Add this header to your MCP client. Keep it secret: anyone who has it can run agents on this computer as you.',
  ];
}

export function formatConnection(result: { alreadyRunning: boolean; token: string; mcpConnectionURL?: string; tunnelStatus?: string }, command: string, workspaces: number): string {
  const lines = ['AgentGo', '', result.alreadyRunning ? 'Server is already running.' : 'Server started.', ''];
  if (result.mcpConnectionURL) lines.push(field('MCP URL', result.mcpConnectionURL));
  else lines.push(`Waiting for the tunnel to connect. Run ${command} status to see the URL once it's up.`);
  lines.push(field('Transport', 'Streamable HTTP'), ...authentication(result.token));
  if (result.tunnelStatus === 'disabled') lines.push('', 'Local access only; no Cloudflare tunnel is running.');
  else if (result.tunnelStatus !== 'connected') lines.push('', 'The tunnel is reconnecting. Runs in progress carry on.');
  if (!workspaces) lines.push('', ...setupHint(command));
  lines.push('', `Check status: ${command} status`, `Stop server:  ${command} stop`);
  return lines.join('\n');
}

export function formatStatus(result: DaemonState | { status: 'stopped' | 'unreachable' }, command: string): string {
  if (result.status === 'stopped') return 'AgentGo is stopped.';
  if (!('tunnelStatus' in result)) return 'AgentGo is running but not responding. Check daemon.log in the state directory.';
  const labels = { starting: 'Starting', running: 'Running', failed: 'Failed' };
  const lines = ['AgentGo', '', field('Status', labels[result.status])];
  if (result.mcpConnectionURL) lines.push(field('MCP URL', result.mcpConnectionURL));
  const tunnel = { disabled: 'Off (local access only)', connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting; runs in progress carry on' };
  lines.push(field('Tunnel', tunnel[result.tunnelStatus]));
  if (result.pid) lines.push(field('Process ID', result.pid));
  if (result.error) lines.push('', result.error);
  lines.push('', `Show the connection password: ${command} start`);
  return lines.join('\n');
}

export function formatToken(token: string): string {
  return ['New connection password created.', '', ...authentication(token), '', 'Update the header in your MCP client. The old password no longer works.'].join('\n');
}

export function formatWorkspaces(folders: string[], workspaces: Array<{ id: string; path: string }>, command: string): string {
  const lines: string[] = [];
  if (folders.length) lines.push('Project folders:', '', ...folders.map(folder => `  ${folder}`), '');
  if (!workspaces.length) return [...lines, ...setupHint(command)].join('\n');
  const width = Math.max(...workspaces.map(w => w.id.length));
  lines.push(`Workspaces (${workspaces.length}):`, '', ...workspaces.map(w => `  ${w.id.padEnd(width)}  ${w.path}`));
  return lines.join('\n');
}

export function formatModels(models: Config['claudeModels']): string {
  return ['Claude models:', '', ...models.map(model => `  ${model.id}\n    Effort: ${model.efforts.join(', ')}`)].join('\n');
}

export function formatConfig(config: Config, workspaces: Array<{ id: string; path: string }>, command: string): string {
  return [
    'AgentGo settings', '',
    field('Codex CLI', config.codexPath), field('Claude CLI', config.claudePath), field('ripgrep', config.rgPath),
    field('Approval', 'Automatic for both agents'),
    field('Concurrent runs', config.maxConcurrentRuns), field('Queued runs', config.maxQueuedRuns),
    field('Max run time', `${config.maxRunSeconds} seconds`),
    field('Output limit', `${config.maxRunOutputBytes} bytes per run`), field('Keep output', `${config.retentionDays} days`),
    field('Search skips', config.searchExclude.join(', ')),
    '', formatWorkspaces(config.folders, workspaces, command), '', formatModels(config.claudeModels),
  ].join('\n');
}

type DoctorCheck = { provider?: string; dependency?: string; version?: string; authenticated?: boolean; available?: boolean; error?: { message: string } };
export function formatDoctor(checks: DoctorCheck[], workspaces: number, stateDir: string, command: string): string {
  const lines = ['AgentGo checks', ''];
  for (const check of checks) {
    const name = check.provider ?? check.dependency ?? 'Dependency';
    const login = check.authenticated === undefined ? '' : check.authenticated ? ' (logged in)' : ' (not logged in)';
    lines.push(field(name, check.error ? `Not ready: ${check.error.message}` : `${check.version ?? 'Available'}${login}`));
  }
  lines.push('', field('Workspaces', workspaces), field('State directory', stateDir), field('Approval', 'Automatic for both agents'));
  if (!workspaces) lines.push('', ...setupHint(command));
  return lines.join('\n');
}
