import { mkdtemp, mkdir, rm, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { configSchema } from '../dist/schema.js';
import { AgentService } from '../dist/service.js';
export const fixture = resolve('tests/fixtures/agent.mjs');
export async function temporary() {
  const root = await mkdtemp(join(tmpdir(), 'agentgo-test-'));
  const stateDir = join(root, 'state');
  const workspace = join(root, 'workspace');
  await mkdir(stateDir); await mkdir(workspace); await chmod(fixture, 0o700);
  const config = configSchema.parse({ workspaces: [{ id: 'project', path: workspace }], codexPath: fixture, claudePath: fixture,
    claudeModels: [{ id: 'test-model', efforts: ['high'] }] });
  return { root, stateDir, workspace, config, cleanup: () => rm(root, { recursive: true, force: true }) };
}
export const request = (extra = {}) => ({ provider: 'codex', model: 'test-model', effort: 'high', serviceTier: 'priority', workspaceId: 'project', prompt: 'hello', idempotencyKey: 'request-1', ...extra });
export async function waitFor(work, predicate, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await work(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('Timed out waiting for condition');
}
export const waitRun = (service, id) => waitFor(() => service.status(id), value => !['queued','starting','running'].includes(value.status));
export async function serviceFor(tmp) { return AgentService.create({ stateDir: tmp.stateDir, config: tmp.config }); }
