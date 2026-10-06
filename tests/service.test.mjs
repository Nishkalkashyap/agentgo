import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { temporary, request, serviceFor, waitRun, waitFor } from './helpers.mjs';

test('Codex runs, idempotency, cursor output, session continuation and fixed approval', async () => {
  const tmp = await temporary(); const service = await serviceFor(tmp);
  try {
    const models = await service.models('codex');
    assert.deepEqual(models.models[0].serviceTiers, ['priority']);
    const [a, b] = await Promise.all([service.start(request()), service.start(request())]);
    assert.equal(a.taskId, b.taskId);
    await assert.rejects(service.start(request({ prompt: 'different' })), { code: 'IDEMPOTENCY_CONFLICT' });
    const done = await waitRun(service, a.taskId);
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    assert.equal(done.approvalPolicy, 'auto-approval');
    const output = service.output(a.taskId, 0, 1);
    assert.equal(output.events.length, 1); assert.equal(output.moreAvailable, true);
    assert.equal(service.output(a.taskId).result.text, 'Reply: hello');
    assert.ok(!JSON.stringify(service.output(a.taskId)).includes('PRIVATE_REASONING'));
    const native = service.store.session(a.sessionId).nativeId;
    const next = await service.continue({ sessionId: a.sessionId, prompt: 'next', idempotencyKey: 'followup' });
    assert.notEqual(next.taskId, a.taskId); assert.equal(next.sessionId, a.sessionId);
    assert.equal((await waitRun(service, next.taskId)).status, 'succeeded');
    assert.equal(service.store.session(a.sessionId).nativeId, native);
    await assert.rejects(service.start(request({ policy: 'bypass' })));
    await assert.rejects(service.start(request({ idempotencyKey: 'bad', effort: 'ultra' })), { code: 'UNSUPPORTED_EFFORT' });
    assert.throws(() => service.status(a.taskId, 'other'), { code: 'RUN_NOT_FOUND' });
    assert.equal(service.list().runs.length, 2);
  } finally { await service.close(); await tmp.cleanup(); }
});

test('Claude stream output, resume, unsupported tier and denied native policy', async () => {
  const tmp = await temporary(); const service = await serviceFor(tmp);
  const input = request({ provider: 'claude', serviceTier: undefined });
  try {
    await assert.rejects(service.start({ ...input, serviceTier: 'priority' }), { code: 'UNSUPPORTED_TIER' });
    const first = await service.start(input);
    assert.equal((await waitRun(service, first.taskId)).status, 'succeeded');
    const native = service.store.session(first.sessionId).nativeId;
    const second = await service.continue({ sessionId: first.sessionId, prompt: 'again', idempotencyKey: 'again' });
    assert.equal((await waitRun(service, second.taskId)).status, 'succeeded');
    assert.equal(service.store.session(second.sessionId).nativeId, native);
    assert.equal(service.output(first.taskId).result.usage.costUsd, 0.01);
    assert.ok(!JSON.stringify(service.output(first.taskId)).includes('PRIVATE_REASONING'));
    const wrong = await service.start({ ...input, prompt: 'wrong-policy', idempotencyKey: 'wrong' });
    assert.equal((await waitRun(service, wrong.taskId)).error.code, 'POLICY_MISMATCH');
  } finally { await service.close(); await tmp.cleanup(); }
});

test('workspace serialization, cancellation, timeout and malformed provider output', async () => {
  const tmp = await temporary(); const service = await serviceFor(tmp);
  try {
    const first = await service.start(request({ prompt: 'hang' }));
    const second = await service.start(request({ idempotencyKey: 'second' }));
    assert.equal(service.status(second.taskId).status, 'queued');
    service.cancel(first.taskId);
    assert.equal((await waitRun(service, first.taskId)).status, 'cancelled');
    assert.equal((await waitRun(service, second.taskId)).status, 'succeeded');
    const timed = await service.start(request({ prompt: 'hang', idempotencyKey: 'timed', limits: { wallTimeSeconds: 1 } }));
    assert.equal((await waitRun(service, timed.taskId)).status, 'timed_out');
    for (const provider of ['codex','claude']) {
      const bad = await service.start(request({ provider, serviceTier: undefined, prompt: 'malformed', idempotencyKey: provider }));
      assert.equal((await waitRun(service, bad.taskId)).status, 'failed');
    }
    const interactive = await service.start(request({ prompt: 'input', idempotencyKey: 'input' }));
    assert.equal((await waitRun(service, interactive.taskId)).error.code, 'INPUT_REQUIRED');
  } finally { await service.close(); await tmp.cleanup(); }
});

test('shutdown persists interrupted tasks and retries do not repeat work after reopening', async () => {
  const tmp = await temporary(); let service = await serviceFor(tmp);
  try {
    const running = await service.start(request({ prompt: 'hang' }));
    await waitFor(() => service.status(running.taskId), x => x.status === 'running');
    await assert.rejects(serviceFor(tmp), { code: 'ALREADY_RUNNING' });
    await service.close();
    service = await serviceFor(tmp);
    assert.equal(service.status(running.taskId).status, 'interrupted');
    assert.equal((await service.start(request({ prompt: 'hang' }))).taskId, running.taskId);
    assert.equal(service.list().runs.length, 1);
  } finally { await service.close(); await tmp.cleanup(); }
});

test('directory/read/glob/grep obey roots, sensitive exclusions, ignores, symlinks and bounds', async () => {
  const tmp = await temporary();
  await mkdir(join(tmp.workspace, 'src'));
  await writeFile(join(tmp.workspace, 'src', 'main.ts'), 'first line\nneedle appears\n');
  await writeFile(join(tmp.workspace, 'README.md'), 'needle documentation\n');
  await writeFile(join(tmp.workspace, '.env'), 'SECRET=needle');
  await writeFile(join(tmp.workspace, '.gitignore'), 'ignored.txt\n');
  await writeFile(join(tmp.workspace, 'ignored.txt'), 'needle ignored');
  await writeFile(join(tmp.root, 'outside.txt'), 'outside');
  await symlink(join(tmp.root, 'outside.txt'), join(tmp.workspace, 'link.txt'));
  const service = await serviceFor(tmp);
  try {
    const files = service.files;
    assert.match((await files.readFile('project', 'src/main.ts', 2, 1)).content, /needle/);
    assert.deepEqual((await files.globFiles('project', '**/*.ts')).files, ['src/main.ts']);
    const matches = (await files.grepFiles('project', 'needle')).matches;
    assert.deepEqual(matches.map(m => [m.path, m.line]), [['README.md', 1], ['src/main.ts', 2]]);
    for (const path of ['../outside.txt', '/etc/passwd', '.env', 'link.txt']) await assert.rejects(files.readFile('project', path), { code: 'PATH_DENIED' });
    const page = await files.listDirectory('project', '.', '', 1);
    assert.equal(page.entries.length, 1); assert.ok(page.nextCursor);
    assert.ok(!(await files.listDirectory('project')).entries.some(e => e.name === '.env'));
  } finally { await service.close(); await tmp.cleanup(); }
});

test('output limits fail the task, and retention keeps idempotency without retaining prompts', async () => {
  const tmp = await temporary(); tmp.config.maxRunOutputBytes = 1024;
  const service = await serviceFor(tmp);
  try {
    const run = await service.start(request({ prompt: 'x'.repeat(5000) }));
    const failed = await waitRun(service, run.taskId);
    assert.equal(failed.status, 'failed'); assert.equal(failed.error.code, 'OUTPUT_LIMIT');
    // The SQL created_at is immutable; use a negative test retention window to expire it.
    service.store.prune(-1);
    assert.equal(service.output(run.taskId).outputExpired, true);
    assert.equal(service.store.run(run.taskId).input.prompt, '');
    assert.equal(service.store.session(run.sessionId).input.prompt, '');
    assert.equal((await service.start(request({ prompt: 'x'.repeat(5000) }))).taskId, run.taskId);
  } finally { await service.close(); await tmp.cleanup(); }
});
