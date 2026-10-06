import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start, stop, connectAgent, configSchema } from '../dist/index.js';
import { saveConfig } from '../dist/config.js';
const root = await mkdtemp(join(tmpdir(), 'agentgo-tunnel-'));
const stateDir = join(root, 'state'); const workspace = join(root, 'workspace');
await mkdir(workspace);
let client;
try {
  await saveConfig(stateDir, configSchema.parse({ workspaces: [{ id: 'smoke', path: workspace }] }));
  const connection = await start({ stateDir, tunnel: { mode: 'quick' }, downloadCloudflared: process.argv.includes('--yes') });
  // Never print the bearer token to smoke-test logs.
  console.log(`Tunnel ready: ${connection.mcpConnectionURL}`);
  const deadline = Date.now() + 120000;
  let lastError;
  while (!client && Date.now() < deadline) {
    try {
      const health = await fetch(new URL('/health', connection.mcpConnectionURL), {
        headers: { Authorization: `Bearer ${connection.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      await health.arrayBuffer();
      if (!health.ok) throw new Error(`Public health returned ${health.status}`);
      client = await connectAgent(connection);
    } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 1000)); }
  }
  if (!client) throw new Error(`Could not connect through the tunnel: ${lastError?.message}; ${lastError?.cause?.message ?? ''}`);
  console.log(await client.listWorkspaces());
  const unauthenticated = await fetch(connection.mcpConnectionURL, { method: 'POST' });
  if (unauthenticated.status !== 401) throw new Error(`Expected 401, received ${unauthenticated.status}`);
  console.log('Authenticated MCP and unauthenticated rejection verified. No agent run started.');
} finally { await client?.close(); await stop({ stateDir }).catch(() => {}); await rm(root, { recursive: true, force: true }); }
