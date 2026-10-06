#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
if (args.includes('--version')) { console.log('fixture 0.160.1'); process.exit(0); }
if (args.includes('--help')) { console.log('--permission-prompts "auto" --effort'); process.exit(0); }
if (args[0] === 'login') { console.log('Logged in'); process.exit(0); }
if (args[0] === 'auth') { send({ loggedIn: true }); process.exit(0); }
if (args[0] === 'app-server') {
  let thread = '';
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    const p = request.params ?? {};
    const reply = result => send({ id: request.id, result });
    if (request.method === 'initialize') reply({ userAgent: 'fixture' });
    if (request.method === 'model/list') reply({ data: [{ model: 'test-model', displayName: 'Test model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }], serviceTiers: [{ id: 'priority' }] }], nextCursor: null });
    if (['thread/start','thread/resume'].includes(request.method)) {
      if (p.approvalsReviewer !== 'auto_review' || p.approvalPolicy !== 'on-request' || p.sandbox !== 'workspace-write') throw new Error('Incorrect automatic policy');
      thread = p.threadId ?? randomUUID();
      reply({ thread: { id: thread }, model: p.model, reasoningEffort: p.config.model_reasoning_effort, serviceTier: p.serviceTier, approvalsReviewer: p.approvalsReviewer, approvalPolicy: p.approvalPolicy, sandbox: { type: 'workspaceWrite' } });
    }
    if (request.method === 'turn/start') {
      if (p.approvalsReviewer !== 'auto_review' || p.effort !== 'high') throw new Error('Invalid turn policy/effort');
      const prompt = p.input[0].text;
      const id = randomUUID();
      reply({ turn: { id, status: 'inProgress' } });
      if (prompt === 'hang') return;
      if (prompt === 'malformed') { process.stdout.write('not json\n'); return; }
      if (prompt === 'input') { send({ id: 900, method: 'item/tool/requestUserInput', params: { threadId: thread } }); return; }
      setTimeout(() => {
        send({ method: 'item/completed', params: { threadId: thread, item: { type: 'reasoning', content: ['PRIVATE_REASONING'] } } });
        send({ method: 'item/completed', params: { threadId: thread, item: { type: 'agentMessage', text: `Reply: ${prompt}`, phase: 'final_answer' } } });
        send({ method: 'turn/completed', params: { threadId: thread, turn: { id, status: prompt === 'fail' ? 'failed' : 'completed', error: prompt === 'fail' ? { message: 'fixture failed' } : null } } });
      }, 30);
    }
  });
} else {
  if (args[args.indexOf('--permission-mode') + 1] !== 'auto' || args[args.indexOf('--permission-prompts') + 1] !== 'none') throw new Error('Incorrect Claude policy');
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const id = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : randomUUID();
  send({ type: 'system', subtype: 'init', permissionMode: input === 'wrong-policy' ? 'manual' : 'auto', session_id: id, model: args[args.indexOf('--model') + 1] });
  if (input === 'malformed') { console.log('invalid'); setInterval(() => {}, 1000); }
  else if (input === 'hang') setInterval(() => {}, 1000);
  else {
    send({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING' }, { type: 'text', text: `Reply: ${input}` }] } });
    send({ type: 'result', subtype: input === 'fail' ? 'error_during_execution' : 'success', is_error: input === 'fail', result: `Reply: ${input}`, total_cost_usd: 0.01, usage: { input_tokens: 1 } });
  }
}
