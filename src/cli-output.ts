import type { Config } from './schema.js';
import type { DaemonState } from './hosting-types.js';

const field = (label: string, value: string | number) => `  ${`${label}:`.padEnd(15)} ${value}`;

function authentication(token: string): string[] {
  return [
    field('Header name', 'Authorization'),
    field('Header value', `Bearer ${token}`),
    '',
    'The token is your AgentGo connection password.',
    'Add the header above to your MCP client, including "Bearer " before the password.',
  ];
}

export function formatConnection(result: { alreadyRunning: boolean; token: string; mcpConnectionURL?: string; tunnelStatus?: string }, command: string): string {
  const lines = ['AgentGo', '', result.alreadyRunning ? 'Server is already running.' : 'Server started.', ''];
  if (result.mcpConnectionURL) lines.push(field('MCP URL', result.mcpConnectionURL));
  else lines.push('Waiting for the tunnel to connect. Run the status command to check its progress.');
  lines.push(field('Transport', 'Streamable HTTP'), ...authentication(result.token));
  if (result.tunnelStatus === 'disabled') lines.push('', 'Local access only; no Cloudflare tunnel is running.');
  else if (result.tunnelStatus !== 'connected') lines.push('', 'The tunnel is reconnecting. Local agent runs continue.');
  lines.push('', `Check status: ${command} status`, `Stop server:  ${command} stop`);
  return lines.join('\n');
}

export function formatStatus(result: DaemonState | { status: 'stopped' | 'unreachable' }, command: string): string {
  if (result.status === 'stopped') return 'AgentGo is stopped.';
  if (!('tunnelStatus' in result)) return 'AgentGo is not responding. Check daemon.log in your state directory.';
  const labels = { starting: 'Starting', running: 'Running', failed: 'Failed' };
  const lines = ['AgentGo', '', field('Status', labels[result.status])];
  if (result.mcpConnectionURL) lines.push(field('MCP URL', result.mcpConnectionURL));
  lines.push(field('Tunnel', { disabled: 'Disabled (local access only)', connecting: 'Connecting', connected: 'Connected', reconnecting: 'Reconnecting; local agent runs continue' }[result.tunnelStatus]));
  if (result.pid) lines.push(field('Process ID', result.pid));
  if (result.error) lines.push('', result.error);
  lines.push('', `Show connection details and password: ${command} start`);
  return lines.join('\n');
}

export function formatToken(token: string): string {
  return ['AgentGo connection password updated.', '', ...authentication(token), '', 'Replace the old header value in your MCP client. The old password no longer works.'].join('\n');
}

export function formatWorkspaces(workspaces: Config['workspaces'], message?: string): string {
  const lines = workspaces.length ? ['Registered workspaces:', '', ...workspaces.map(w => `  ${w.id}${w.label ? ` (${w.label})` : ''}\n    ${w.path}`)] : ['No workspaces registered. Use workspace add <id> <path> to register a project.'];
  if (message) lines.push('', message);
  return lines.join('\n');
}

export function formatModels(models: Config['claudeModels']): string {
  return ['Configured Claude models:', '', ...models.map(model => `  ${model.id}\n    Effort: ${model.efforts.join(', ')}`), '', 'Restart a running daemon to apply model changes.'].join('\n');
}

export function formatConfig(config: Config): string {
  return [
    'AgentGo configuration', '',
    field('Codex CLI', config.codexPath), field('Claude CLI', config.claudePath), field('Ripgrep', config.rgPath),
    field('Approval', 'Automatic for both providers'),
    field('Concurrent runs', config.maxConcurrentRuns), field('Queued runs', config.maxQueuedRuns),
    field('Max run time', `${config.maxRunSeconds} seconds`),
    field('Output limit', `${config.maxRunOutputBytes} bytes per run`), field('Keep output', `${config.retentionDays} days`),
    '', formatWorkspaces(config.workspaces), '', formatModels(config.claudeModels),
  ].join('\n');
}

type DoctorCheck = { provider?: string; dependency?: string; version?: string; authenticated?: boolean; available?: boolean; error?: { message: string } };
export function formatDoctor(checks: DoctorCheck[], workspaces: number, stateDir: string): string {
  const lines = ['AgentGo diagnostics', ''];
  for (const check of checks) {
    const name = check.provider ?? check.dependency ?? 'Dependency';
    const result = check.error ? `Unavailable — ${check.error.message}` : `${check.version ?? 'Available'}${check.authenticated === undefined ? '' : check.authenticated ? ' — logged in' : ' — not logged in'}`;
    lines.push(field(name, result));
  }
  lines.push('', field('Workspaces', workspaces), field('State directory', stateDir), field('Approval', 'Automatic for both providers'));
  return lines.join('\n');
}
