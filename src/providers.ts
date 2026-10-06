import { ManagedProcess, jsonLines } from './process.js';
import { runCommand } from './commands.js';
import { AgentError } from './errors.js';
import type { Config, ModelInfo, Provider, RunEvent, RunResult, StartInput } from './schema.js';

export interface RunContext {
  input: StartInput; cwd: string; nativeId?: string; signal: AbortSignal;
  emit: (event: RunEvent) => void; onSession: (id: string) => void;
}
export interface AgentProvider {
  models(refresh?: boolean): Promise<ModelInfo[]>;
  capabilities(): Promise<Record<string, unknown>>;
  run(context: RunContext): Promise<RunResult>;
}

class CodexConnection {
  process: ManagedProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  onNotification: (method: string, params: any) => void = () => {};
  onFailure: (error: Error) => void = () => {};
  constructor(binary: string, cwd?: string) {
    this.process = new ManagedProcess(binary, ['app-server', '--listen', 'stdio://', '-c', 'approval_policy="on-request"', '-c', 'approvals_reviewer="auto_review"', '-c', 'sandbox_mode="workspace-write"'], cwd);
    const failure = (error: Error) => { this.rejectAll(error); this.onFailure(error); void this.process.stop(); };
    jsonLines(this.process, value => {
      if (value.id !== undefined && !value.method) {
        const pending = this.pending.get(value.id);
        if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(value.id);
        if (value.error) pending.reject(new AgentError('CODEX_ERROR', String(value.error.message)));
        else pending.resolve(value.result);
      } else if (value.method && value.id !== undefined) {
        // Auto-review resolves approvals internally. Never silently accept a user prompt.
        this.notify({ id: value.id, error: { code: -32000, message: 'Unattended auto-approval run cannot answer interactive input.' } });
        failure(new AgentError('INPUT_REQUIRED', `Codex requested interactive input: ${value.method}`));
      } else if (value.method) this.onNotification(value.method, value.params);
    }, failure);
    this.process.on('failure', failure);
    this.process.on('closed', () => failure(new AgentError('PROCESS_EXITED', 'Codex app-server closed.')));
  }
  private rejectAll(error: Error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  notify(value: unknown) { this.process.write(`${JSON.stringify(value)}\n`); }
  request(method: string, params: unknown, timeout = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AgentError('PROVIDER_TIMEOUT', `${method} timed out.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.notify({ id, method, params });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'agentgo', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    this.notify({ method: 'initialized', params: {} });
  }
  async close() { this.onFailure = () => {}; this.rejectAll(new AgentError('CLOSED', 'Connection closed.')); await this.process.stop(); }
}

export class CodexProvider implements AgentProvider {
  private cached?: { at: number; models: ModelInfo[] };
  constructor(private readonly binary: string) {}
  async capabilities() {
    const version = (await runCommand(this.binary, ['--version'])).trim();
    return { provider: 'codex', version, approvalPolicy: 'auto-approval', nativeApprovalMode: 'auto_review', sandbox: 'workspace-write', resume: true, modelDiscovery: 'runtime' };
  }
  async models(refresh = false): Promise<ModelInfo[]> {
    if (!refresh && this.cached && Date.now() - this.cached.at < 300_000) return this.cached.models;
    const rpc = new CodexConnection(this.binary);
    try {
      await rpc.initialize();
      const models: ModelInfo[] = [];
      let cursor: string | undefined;
      do {
        const page = await rpc.request('model/list', { limit: 100, cursor, includeHidden: false });
        for (const model of page.data) models.push({ provider: 'codex', id: model.model, displayName: model.displayName,
          efforts: model.supportedReasoningEfforts.map((e: any) => e.reasoningEffort),
          serviceTiers: (model.serviceTiers ?? []).map((t: any) => t.id), source: 'runtime', availability: 'advertised', checkedAt: new Date().toISOString() });
        cursor = page.nextCursor ?? undefined;
        if (models.length > 1000) throw new AgentError('INVALID_OUTPUT', 'Model catalog is too large.');
      } while (cursor);
      this.cached = { at: Date.now(), models };
      return models;
    } finally { await rpc.close(); }
  }
  async run(context: RunContext): Promise<RunResult> {
    const rpc = new CodexConnection(this.binary, context.cwd);
    let threadId: string | undefined;
    let turnId: string | undefined;
    let text = '';
    let usage: Record<string, unknown> | undefined;
    let resolveDone!: () => void;
    let rejectDone!: (error: Error) => void;
    const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    // Completion can precede the turn/start response. Install handlers before sending it.
    void done.catch(() => {});
    rpc.onFailure = rejectDone;
    rpc.onNotification = (method, params) => {
      if (!threadId || params?.threadId !== threadId) return;
      if (method === 'thread/tokenUsage/updated') usage = { scope: 'session', ...params.tokenUsage?.total, lastModelResponse: params.tokenUsage?.last };
      if (method === 'item/completed') {
        const item = params.item;
        if (item.type === 'agentMessage') { text = item.text; context.emit({ type: 'message', data: { text: item.text, phase: item.phase } }); }
        else if (item.type === 'commandExecution') context.emit({ type: 'command', data: { command: item.command, status: item.status, exitCode: item.exitCode, output: item.aggregatedOutput } });
        else if (item.type === 'fileChange') context.emit({ type: 'file_change', data: { status: item.status, paths: item.changes?.map((change: any) => change.path) } });
        else if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') context.emit({ type: 'tool', data: { tool: item.tool, status: item.status } });
      } else if (method === 'item/started') {
        const item = params.item;
        if (!['reasoning', 'userMessage'].includes(item.type)) context.emit({ type: 'activity', data: { kind: item.type } });
      } else if (method === 'turn/completed') {
        if (turnId && params.turn.id !== turnId) return;
        if (params.turn.status === 'completed') resolveDone();
        else rejectDone(new AgentError('PROVIDER_FAILED', params.turn.error?.message ?? `Codex turn ${params.turn.status}`));
      }
    };
    const abort = () => { rejectDone(new AgentError('ABORTED', 'Run interrupted.')); void rpc.process.stop(); };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      context.signal.throwIfAborted();
      await rpc.initialize();
      const input = context.input;
      const options = { cwd: context.cwd, model: input.model, serviceTier: input.serviceTier ?? null,
        approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write',
        config: { model_reasoning_effort: input.effort } };
      const started = await rpc.request(context.nativeId ? 'thread/resume' : 'thread/start', { ...options, ...(context.nativeId ? { threadId: context.nativeId } : {}) });
      if (started.approvalsReviewer !== 'auto_review' || started.approvalPolicy !== 'on-request') throw new AgentError('POLICY_MISMATCH', 'Codex did not accept automatic approval review.');
      if (started.sandbox?.type !== 'workspaceWrite') throw new AgentError('POLICY_MISMATCH', 'Codex did not accept the workspace-write sandbox.');
      if (started.model !== input.model || (started.reasoningEffort != null && started.reasoningEffort !== input.effort)) throw new AgentError('CONFIG_MISMATCH', 'Codex changed the requested model or effort.');
      if (input.serviceTier && started.serviceTier !== input.serviceTier) throw new AgentError('CONFIG_MISMATCH', 'Codex changed the requested service tier.');
      threadId = started.thread.id;
      context.onSession(threadId!);
      const effective = { model: started.model, effort: started.reasoningEffort ?? null, serviceTier: started.serviceTier ?? null, approvalPolicy: 'auto-approval' };
      context.emit({ type: 'configuration', data: effective });
      const turn = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: input.prompt, text_elements: [] }], model: input.model, effort: input.effort,
        serviceTier: input.serviceTier ?? null, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
      turnId = turn.turn.id;
      await done;
      return { text, usage, effective };
    } finally { context.signal.removeEventListener('abort', abort); await rpc.close(); }
  }
}

export class ClaudeProvider implements AgentProvider {
  constructor(private readonly config: Config) {}
  async capabilities() {
    const version = (await runCommand(this.config.claudePath, ['--version'])).trim();
    const help = await runCommand(this.config.claudePath, ['--help']);
    if (!help.includes('--permission-prompts') || !help.includes('"auto"')) throw new AgentError('UNSUPPORTED_CLI', 'Claude CLI must support auto mode and --permission-prompts.');
    return { provider: 'claude', version, approvalPolicy: 'auto-approval', nativeApprovalMode: 'auto', resume: true, modelDiscovery: 'configured', filesystemIsolation: 'CLI permissions; not an OS sandbox' };
  }
  async models(): Promise<ModelInfo[]> {
    return this.config.claudeModels.map(model => ({ provider: 'claude', id: model.id, displayName: model.displayName ?? model.id,
      efforts: model.efforts, serviceTiers: [], source: 'configured', availability: 'unverified', checkedAt: new Date().toISOString() }));
  }
  async run(context: RunContext): Promise<RunResult> {
    await this.capabilities();
    context.signal.throwIfAborted();
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', context.input.model, '--effort', context.input.effort,
      '--permission-mode', 'auto', '--permission-prompts', 'none'];
    if (context.nativeId) args.push('--resume', context.nativeId);
    const child = new ManagedProcess(this.config.claudePath, args, context.cwd);
    let result: RunResult | undefined;
    let error: Error | undefined;
    let effective: Record<string, unknown> = { model: null, effort: null, serviceTier: null, approvalPolicy: 'auto-approval' };
    let initialized = false;
    const fail = (failure: Error) => { error ??= failure; void child.stop(); };
    jsonLines(child, value => {
      if (value.type === 'system' && value.subtype === 'init') {
        if (value.permissionMode !== 'auto') throw new AgentError('POLICY_MISMATCH', 'Claude did not accept auto mode.');
        if (context.input.model.startsWith('claude-') && value.model !== context.input.model) throw new AgentError('CONFIG_MISMATCH', 'Claude changed the requested model.');
        initialized = true;
        if (typeof value.session_id === 'string') context.onSession(value.session_id);
        effective = { ...effective, model: value.model ?? null, effort: value.effort ?? null };
        context.emit({ type: 'configuration', data: effective });
      } else if (value.type === 'assistant') {
        for (const content of value.message?.content ?? []) {
          if (content.type === 'text') context.emit({ type: 'message', data: { text: content.text } });
          else if (content.type === 'tool_use') context.emit({ type: 'tool', data: { tool: content.name, id: content.id } });
        }
      } else if (value.type === 'system' && value.subtype === 'permission_denied') {
        context.emit({ type: 'permission_denied', data: { message: 'An action was denied by Claude auto mode.' } });
      } else if (value.type === 'result') {
        if (!initialized) throw new AgentError('INVALID_OUTPUT', 'Claude returned a result without confirming its execution mode.');
        if (value.is_error || value.subtype !== 'success') throw new AgentError('PROVIDER_FAILED', value.errors?.join('; ') || value.result || `Claude result: ${value.subtype}`);
        if (value.permission_denials?.length) context.emit({ type: 'permission_denied', data: { count: value.permission_denials.length } });
        result = { text: value.result ?? '', usage: { scope: 'provider-reported', ...(value.usage ?? {}), costUsd: value.total_cost_usd ?? null }, effective };
      }
    }, fail);
    child.on('failure', fail);
    const abort = () => { void child.stop(); };
    context.signal.addEventListener('abort', abort, { once: true });
    try {
      if (context.signal.aborted) abort();
      child.write(context.input.prompt); child.end();
      const exit = await child.wait();
      if (error) throw error;
      context.signal.throwIfAborted();
      if (exit.code !== 0 || !result) throw new AgentError('PROVIDER_FAILED', `Claude exited (${exit.code ?? exit.signal}) without a successful result. Run agentgo doctor to check login and CLI support.`);
      return result;
    } finally { context.signal.removeEventListener('abort', abort); await child.stop(); }
  }
}
export function createProviders(config: Config): Record<Provider, AgentProvider> {
  return { codex: new CodexProvider(config.codexPath), claude: new ClaudeProvider(config) };
}
