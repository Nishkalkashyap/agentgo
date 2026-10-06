import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ensureCloudflared, tunnelSchema } from './cloudflare.js';
import { ensureToken, readToken } from './config.js';
import { AgentError } from './errors.js';
import { adminRequest } from './admin.js';
import { stateDirectory, privateDirectory, readJson, writeJson, withLock, processExists, delay } from './storage.js';
import type { DaemonState, StartOptions, TunnelConfig } from './hosting-types.js';

export async function status(options: { stateDir?: string } = {}): Promise<DaemonState | { status: 'stopped' | 'unreachable' }> {
  const directory = stateDirectory(options.stateDir);
  const saved = await readJson<DaemonState>(join(directory, 'daemon.json'));
  if (!saved || ['stopped', 'failed'].includes(saved.status) || !processExists(saved.pid)) return { status: 'stopped' };
  try {
    const current = await adminRequest(saved.adminSocket, '/status');
    if (current.instanceId !== saved.instanceId) throw new Error('Daemon identity mismatch');
    return current;
  } catch { return { status: 'unreachable' }; }
}
export async function start(options: StartOptions = {}) {
  const directory = stateDirectory(options.stateDir);
  await privateDirectory(directory);
  return withLock(join(directory, 'lifecycle'), async () => {
    const current = await status({ stateDir: directory });
    if (current.status === 'running') return { ...current, token: await readToken(directory), alreadyRunning: true };
    if (current.status !== 'stopped') throw new AgentError('DAEMON_BUSY', 'Existing daemon is starting or unreachable; inspect status before starting another.');
    const previous = await readJson<StartOptions>(join(directory, 'last-start.json'));
    const tunnelValue = options.tunnel !== undefined ? options.tunnel : previous?.tunnel !== undefined ? previous.tunnel : await readJson<TunnelConfig>(join(directory, 'tunnel.json')) ?? { mode: 'quick' };
    const tunnel = tunnelValue === null ? null : tunnelSchema.parse(tunnelValue);
    const port = options.port ?? previous?.port ?? 0;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new AgentError('INVALID_PORT', 'Port must be between 0 and 65535.');
    if (tunnel?.mode === 'token' && !port) throw new AgentError('PORT_REQUIRED', 'Use --port matching the token tunnel dashboard origin.');
    const cloudflaredPath = tunnel ? await ensureCloudflared({ ...options, stateDir: directory, cloudflaredPath: options.cloudflaredPath ?? previous?.cloudflaredPath }) : undefined;
    const token = await ensureToken(directory);
    const instanceId = randomUUID();
    const config = { stateDir: directory, instanceId, port, tunnel, cloudflaredPath };
    const log = await open(join(directory, 'daemon.log'), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./daemon.js', import.meta.url))], { detached: true, stdio: ['pipe', log.fd, log.fd], cwd: directory });
    await log.close();
    let error: Error | undefined;
    child.on('error', failure => { error = failure; });
    child.stdin!.on('error', failure => { error = failure; });
    await writeJson(join(directory, 'daemon.json'), { instanceId, pid: child.pid ?? 0, status: 'starting', adminSocket: join(directory, 'admin.sock'), startedAt: new Date().toISOString(), tunnelStatus: tunnel ? 'connecting' : 'disabled' });
    child.stdin!.end(JSON.stringify(config)); child.unref();
    await writeJson(join(directory, 'last-start.json'), { port, tunnel, cloudflaredPath });
    const deadline = Date.now() + (options.startupTimeoutMs ?? 95_000);
    while (Date.now() < deadline) {
      if (error) throw error;
      const state = await readJson<DaemonState>(join(directory, 'daemon.json'));
      if (state?.instanceId !== instanceId) throw new AgentError('STATE_CONFLICT', 'Daemon identity changed during startup.');
      if (state.status === 'running' && state.mcpConnectionURL) return { ...state, token, alreadyRunning: false };
      if (['failed','stopped'].includes(state.status) || !processExists(state.pid)) throw new AgentError('START_FAILED', `Daemon failed to start. See ${join(directory, 'daemon.log')}.`);
      await delay(100);
    }
    throw new AgentError('TUNNEL_NOT_READY', 'Daemon started but the tunnel is not ready. It will keep reconnecting; check status or stop it locally.');
  });
}
export async function stop(options: { stateDir?: string } = {}) {
  const directory = stateDirectory(options.stateDir);
  return withLock(join(directory, 'lifecycle'), async () => {
    const current = await status({ stateDir: directory });
    if (current.status === 'stopped') return { status: 'stopped' };
    if (!('adminSocket' in current)) throw new AgentError('DAEMON_UNREACHABLE', 'Cannot verify daemon identity. Refusing to signal a stale PID.');
    const response = await adminRequest(current.adminSocket, '/stop', 'POST');
    if (response.instanceId !== current.instanceId) throw new AgentError('STATE_CONFLICT', 'Daemon identity changed.');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if ((await status({ stateDir: directory })).status === 'stopped') return { status: 'stopped' };
      await delay(100);
    }
    throw new AgentError('STOP_TIMEOUT', 'Daemon has not finished stopping. Check status.');
  });
}
export async function restart(options: StartOptions = {}) { await stop(options); return start(options); }
export { configureCloudflare, ensureCloudflared } from './cloudflare.js';
