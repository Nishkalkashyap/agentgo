import { createServer } from 'node:http';
import { chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentService } from './service.js';
import { createAgentHttpServer } from './server.js';
import { readToken } from './config.js';
import { maintainTunnel } from './tunnel.js';
import { writeJson } from './storage.js';
import { messageOf } from './errors.js';
import type { DaemonState, StartOptions } from './hosting-types.js';

async function main() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) throw new Error('Daemon configuration too large'); }
  const options = JSON.parse(input) as StartOptions & { stateDir: string; instanceId: string; cloudflaredPath?: string };
  const state: DaemonState = { instanceId: options.instanceId, pid: process.pid, status: 'starting', startedAt: new Date().toISOString(), adminSocket: join(options.stateDir, 'admin.sock'), tunnelStatus: options.tunnel ? 'connecting' : 'disabled' };
  const service = await AgentService.create({ stateDir: options.stateDir });
  const app = createAgentHttpServer({ service, token: () => readToken(options.stateDir) });
  let tunnel: ReturnType<typeof maintainTunnel> | undefined;
  let closing: Promise<void> | undefined;
  let persistQueue = Promise.resolve();
  const persist = () => { const snapshot = { ...state }; persistQueue = persistQueue.then(() => writeJson(join(options.stateDir, 'daemon.json'), snapshot)); return persistQueue; };
  const admin = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/status' && request.method === 'GET') response.end(JSON.stringify(state));
    else if (request.url === '/stop' && request.method === 'POST') { response.end(JSON.stringify({ instanceId: state.instanceId, stopping: true })); setImmediate(() => void close()); }
    else { response.writeHead(404); response.end('{}'); }
  });
  function close(error?: unknown): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      await tunnel?.close();
      await app.close().catch(() => {});
      await service.close();
      await new Promise<void>(resolve => { admin.close(() => resolve()); admin.closeAllConnections(); });
      await rm(state.adminSocket, { force: true });
      state.status = error ? 'failed' : 'stopped';
      if (error) state.error = messageOf(error).slice(0, 2000);
      await persist();
      process.exitCode = error ? 1 : 0;
    })();
    return closing;
  }
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
  process.once('uncaughtException', error => void close(error));
  process.once('unhandledRejection', error => void close(error));
  try {
    await rm(state.adminSocket, { force: true });
    await new Promise<void>((resolve, reject) => { admin.once('error', reject); admin.listen(state.adminSocket, () => { admin.off('error', reject); resolve(); }); });
    await chmod(state.adminSocket, 0o600);
    state.localURL = await app.listen(options.port ?? 0);
    state.status = 'running';
    if (!options.tunnel) state.mcpConnectionURL = `${state.localURL}/mcp`;
    await persist();
    if (options.tunnel && options.cloudflaredPath) {
      tunnel = maintainTunnel({ binary: options.cloudflaredPath, config: options.tunnel, stateDir: options.stateDir, localURL: state.localURL,
        onState: async (status, url) => {
          state.tunnelStatus = status;
          if (url) { state.mcpConnectionURL = `${url}/mcp`; app.setPublicURL(url); }
          else if (options.tunnel?.mode === 'quick') { delete state.mcpConnectionURL; app.setPublicURL(); }
          await persist();
        } });
      void tunnel.done.catch(error => close(error));
    }
  } catch (error) { await close(error); }
}
void main().catch(error => { console.error(messageOf(error)); process.exitCode = 1; });
