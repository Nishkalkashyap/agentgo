import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentService, configSchema } from '../dist/index.js';

const provider = process.argv[2] ?? 'codex';
if (!['codex','claude'].includes(provider)) throw new Error('Use codex or claude');
const root = await mkdtemp(join(tmpdir(), 'agentgo-smoke-'));
const workspace = join(root, 'workspace'); await mkdir(workspace);
const service = await AgentService.create({ stateDir: join(root, 'state'), config: configSchema.parse({ workspaces: [{ id: 'smoke', path: workspace }] }) });
async function complete(taskId) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const run = service.status(taskId);
    if (!['queued','starting','running'].includes(run.status)) {
      if (run.status !== 'succeeded') throw new Error(JSON.stringify(run));
      return service.output(taskId).result;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  service.cancel(taskId); throw new Error('Provider smoke timed out');
}
try {
  const { models } = await service.models(provider);
  const model = models[0]; if (!model) throw new Error('No models discovered');
  console.log(`Smoke: ${provider}, ${model.id}, ${model.efforts[0]}, ${model.serviceTiers[0] ?? 'provider default'}, auto-approval`);
  const run = await service.start({ provider, workspaceId: 'smoke', model: model.id, effort: model.efforts[0], serviceTier: model.serviceTiers[0],
    prompt: 'In the current directory, create smoke.txt containing only the word apricot. Use your file editing tool. Do not change anything else or run commands. Remember that word and reply SMOKE_OK when done.', idempotencyKey: 'smoke-1', limits: { wallTimeSeconds: 120 } });
  console.log('First turn:', await complete(run.taskId));
  if ((await readFile(join(workspace, 'smoke.txt'), 'utf8')).trim() !== 'apricot') throw new Error('Agent file edit was not completed');
  const followup = await service.continue({ sessionId: run.sessionId, prompt: 'What word did I ask you to remember? Reply only that word. Do not use tools.', idempotencyKey: 'smoke-2', limits: { wallTimeSeconds: 120 } });
  const result = await complete(followup.taskId);
  if (!result.text.toLowerCase().includes('apricot')) throw new Error('Session memory was not preserved');
  console.log('Resume:', result);
} finally { await service.close(); await rm(root, { recursive: true, force: true }); }
