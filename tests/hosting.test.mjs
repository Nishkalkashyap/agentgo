import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { temporary, waitFor, serviceFor, request, waitRun } from './helpers.mjs';
import { maintainTunnel } from '../dist/tunnel.js';
import { start, stop, status } from '../dist/hosting.js';
import { saveConfig, rotateToken } from '../dist/config.js';
import { runCommand } from '../dist/commands.js';

test('daemon lifecycle, local-only admin socket and live token rotation', async () => {
  const tmp = await temporary();
  try {
    await saveConfig(tmp.stateDir, tmp.config);
    const started = await start({ stateDir: tmp.stateDir, tunnel: null });
    assert.equal(started.status, 'running');
    assert.equal((await status({ stateDir: tmp.stateDir })).instanceId, started.instanceId);
    assert.equal((await start({ stateDir: tmp.stateDir })).alreadyRunning, true);
    const url = started.localURL;
    assert.equal((await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${started.token}` } })).status, 200);
    const newToken = await rotateToken(tmp.stateDir);
    assert.equal((await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${started.token}` } })).status, 401);
    assert.equal((await fetch(`${url}/health`, { headers: { Authorization: `Bearer ${newToken}` } })).status, 200);
    assert.equal((await fetch(`${url}/internal/stop`, { method: 'POST', headers: { Authorization: `Bearer ${newToken}` } })).status, 404);
    assert.equal((await stop({ stateDir: tmp.stateDir })).status, 'stopped');
    assert.equal((await status({ stateDir: tmp.stateDir })).status, 'stopped');
  } finally { await stop({ stateDir: tmp.stateDir }).catch(() => {}); await tmp.cleanup(); }
});

test('tunnel exit reconnects without stopping active work', async () => {
  const tmp = await temporary(); const service = await serviceFor(tmp);
  const binary = resolve('tests/fixtures/cloudflared.mjs'); await chmod(binary, 0o700);
  const states = [];
  const tunnel = maintainTunnel({ binary, config: { mode: 'quick' }, stateDir: tmp.stateDir, localURL: 'http://127.0.0.1:12345', onState: async (status, url) => { states.push({ status, url }); } });
  try {
    const run = await service.start(request({ prompt: 'hang' }));
    await waitFor(() => states, all => all.some(s => s.url === 'https://fake-2.trycloudflare.com'));
    assert.equal(service.status(run.taskId).status, 'running');
    assert.ok(states.some(s => s.status === 'reconnecting'));
    service.cancel(run.taskId);
    assert.equal((await waitRun(service, run.taskId)).status, 'cancelled');
  } finally { await tunnel.close(); await service.close(); await tmp.cleanup(); }
});

test('guardian terminates CLI process group when owning parent dies', async () => {
  const tmp = await temporary();
  const marker = join(tmp.root, 'heartbeat');
  const script = join(tmp.root, 'parent.mjs');
  const workerCode = `const fs = require('node:fs'); setInterval(() => fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 25);`;
  await writeFile(script, `import { ManagedProcess } from ${JSON.stringify(new URL('../dist/process.js', import.meta.url).href)}; new ManagedProcess(process.execPath, ['-e', ${JSON.stringify(workerCode)}]);`);
  const child = spawn(process.execPath, [script], { stdio: 'ignore' });
  try {
    await waitFor(() => readFile(marker, 'utf8').catch(() => ''), Boolean);
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('close', resolve));
    await new Promise(resolve => setTimeout(resolve, 1200));
    const stopped = await readFile(marker, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await readFile(marker, 'utf8'), stopped);
  } finally { child.kill('SIGKILL'); await tmp.cleanup(); }
});
