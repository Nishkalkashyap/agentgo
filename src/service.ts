import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { configSchema, startSchema, continueSchema, terminal, type Config, type Run, type RunEvent, type Provider, type StartInput } from './schema.js';
import { createProviders, type AgentProvider } from './providers.js';
import { WorkspaceFiles } from './filesystem.js';
import { RunStore, fingerprint } from './store.js';
import { AgentError, failureOf } from './errors.js';
import { privateDirectory, readJson, writeJson, withLock, processExists, delay } from './storage.js';
import { loadConfig } from './config.js';

const configStamp = (directory: string) => stat(join(directory, 'config.json')).then(info => info.mtimeMs, () => 0);

export type ServiceOptions = { stateDir: string; config?: Config; providers?: Record<Provider, AgentProvider> };
export class AgentService {
  files: WorkspaceFiles;
  config: Config;
  providers: Record<Provider, AgentProvider>;
  readonly store: RunStore;
  private configStamp?: number;
  private refreshing?: Promise<void>;
  private readonly active = new Map<string, { run: Run; controller: AbortController; promise: Promise<void> }>();
  private closing = false;
  private closePromise?: Promise<void>;
  private pumping = false;
  private timer: NodeJS.Timeout;
  private constructor(readonly directory: string, config: Config, private readonly lockId: string, files: WorkspaceFiles,
    private readonly fixedConfig: boolean, private readonly fixedProviders?: Record<Provider, AgentProvider>) {
    this.config = config;
    this.files = files;
    this.providers = fixedProviders ?? createProviders(config);
    this.store = new RunStore(directory);
    this.store.recover();
    this.store.prune(config.retentionDays);
    this.timer = setInterval(() => { this.store.prune(this.config.retentionDays); }, 3600_000);
    this.timer.unref();
  }
  static async create(options: ServiceOptions): Promise<AgentService> {
    await privateDirectory(options.stateDir);
    const lockId = randomUUID();
    const lock = join(options.stateDir, 'runtime.lock');
    await withLock(options.stateDir, async () => {
      const old = await readJson<{ pid: number; lockId: string }>(join(lock, 'owner.json'));
      if (old && processExists(old.pid)) throw new AgentError('ALREADY_RUNNING', 'Another AgentGo server is already using this state directory.');
      if (old) { await delay(3000); await rm(lock, { recursive: true, force: true }); }
      else {
        try {
          const info = await stat(lock);
          if (Date.now() - info.mtimeMs < 30_000) throw new AgentError('BUSY', 'Another AgentGo server is starting in this state directory.');
          await rm(lock, { recursive: true, force: true });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      await mkdir(lock, { mode: 0o700 });
      await writeJson(join(lock, 'owner.json'), { pid: process.pid, lockId });
    });
    try {
      const stamp = await configStamp(options.stateDir);
      const config = configSchema.parse(options.config ?? await loadConfig(options.stateDir));
      const files = new WorkspaceFiles(config, options.stateDir);
      await files.prepare();
      const service = new AgentService(options.stateDir, config, lockId, files, Boolean(options.config), options.providers);
      service.configStamp = stamp;
      return service;
    } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
  }
  /** Picks up config.json edits and new project folders without a restart. Runs already started are unaffected. */
  refresh(): Promise<void> {
    return this.refreshing ??= this.reload().finally(() => { this.refreshing = undefined; });
  }
  private async reload() {
    const stamp = await configStamp(this.directory);
    if (!this.fixedConfig && stamp !== this.configStamp) {
      const config = await loadConfig(this.directory);
      const files = new WorkspaceFiles(config, this.directory);
      await files.prepare();
      const changed = (['codexPath', 'claudePath', 'claudeModels'] as const).some(key => JSON.stringify(config[key]) !== JSON.stringify(this.config[key]));
      if (changed && !this.fixedProviders) this.providers = createProviders(config);
      this.config = config; this.files = files; this.configStamp = stamp;
      this.pump();
      return;
    }
    const files = new WorkspaceFiles(this.config, this.directory);
    await files.prepare();
    this.files = files;
  }
  async capabilities(provider?: Provider) {
    const providers = await Promise.all((provider ? [provider] : ['codex', 'claude'] as const).map(async name => {
      try { return { ...await this.providers[name].capabilities(), available: true }; }
      catch (error) { return { provider: name, available: false, error: failureOf(error) }; }
    }));
    return { approvalPolicy: 'auto-approval', providers, maxConcurrentRuns: this.config.maxConcurrentRuns };
  }
  async models(provider: Provider, refresh = false) { return { models: await this.providers[provider].models(refresh) }; }
  private available(input: { limits: { wallTimeSeconds: number } }) {
    if (this.closing) throw new AgentError('STOPPING', 'The server is shutting down.');
    if (this.store.active().length >= this.config.maxQueuedRuns + this.config.maxConcurrentRuns) throw new AgentError('QUEUE_FULL', 'Too many runs are queued. Wait for some to finish.');
    if (input.limits.wallTimeSeconds > this.config.maxRunSeconds) throw new AgentError('TIME_LIMIT', `limits.wallTimeSeconds can be at most ${this.config.maxRunSeconds}.`);
  }
  async start(value: unknown, owner = 'owner') {
    const input = startSchema.parse(value);
    const hash = fingerprint({ operation: 'start', input });
    const previous = this.store.previous(owner, input.idempotencyKey, hash);
    if (previous) return this.publicRun(previous);
    this.available(input);
    const cwd = await this.files.resolve(input.workspaceId, input.cwd, true);
    const models = await this.providers[input.provider].models();
    const model = models.find(model => model.id === input.model);
    if (!model) throw new AgentError('UNSUPPORTED_MODEL', 'Unknown model. Call getSupportedModels to see which models are available.');
    if (!model.efforts.includes(input.effort)) throw new AgentError('UNSUPPORTED_EFFORT', `This model supports these efforts: ${model.efforts.join(', ')}.`);
    if (input.serviceTier && !model.serviceTiers.includes(input.serviceTier)) throw new AgentError('UNSUPPORTED_TIER', model.serviceTiers.length ? `This model supports these service tiers: ${model.serviceTiers.join(', ')}.` : 'This model has no service tiers. Leave serviceTier out.');
    // The awaits above let other requests in, so check again before queueing.
    this.available(input);
    const run = this.store.enqueue(owner, input, cwd, hash);
    this.pump();
    return this.publicRun(run);
  }
  async continue(value: unknown, owner = 'owner') {
    const input = continueSchema.parse(value);
    const hash = fingerprint({ operation: 'continue', input });
    const previous = this.store.previous(owner, input.idempotencyKey, hash);
    if (previous) return this.publicRun(previous);
    this.available(input);
    const session = this.store.session(input.sessionId, owner);
    if (!session.nativeId) throw new AgentError('SESSION_NOT_READY', 'This session cannot be continued: its first run ended before the agent started a conversation.');
    const startInput: StartInput = { ...session.input, prompt: input.prompt, idempotencyKey: input.idempotencyKey, limits: input.limits };
    const cwd = await this.files.resolve(session.workspaceId, startInput.cwd, true);
    if (cwd !== session.cwd) throw new AgentError('WORKSPACE_CHANGED', "The session's folder has moved. Start a new run instead.");
    // The await above lets other requests in, so check again before queueing.
    this.available(input);
    if (this.store.active().some(run => run.sessionId === input.sessionId)) throw new AgentError('SESSION_BUSY', 'This session already has a run in progress. Wait for it to finish.');
    const run = this.store.enqueue(owner, startInput, cwd, hash, session);
    this.pump();
    return this.publicRun(run);
  }
  publicRun(run: Run) {
    return { taskId: run.taskId, sessionId: run.sessionId, provider: run.input.provider, workspaceId: run.input.workspaceId,
      status: run.status, createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, lastActivityAt: run.updatedAt,
      requested: { model: run.input.model, effort: run.input.effort, serviceTier: run.input.serviceTier ?? null },
      approvalPolicy: 'auto-approval', effective: run.result?.effective ?? null, usage: run.result?.usage ?? null,
      cancellationRequested: Boolean(run.cancelReason), error: run.error ?? null, pollAfterMs: terminal(run.status) ? null : 2000 };
  }
  status(taskId: string, owner = 'owner') { return this.publicRun(this.store.run(taskId, owner)); }
  output(taskId: string, cursor = 0, limit = 100, owner = 'owner') {
    const run = this.store.run(taskId, owner);
    return { ...this.store.output(taskId, cursor, limit), status: run.status, result: run.result ?? null, error: run.error ?? null, outputExpired: run.outputExpired ?? false };
  }
  list(cursor = '', limit = 50, workspaceId?: string, status?: string, owner = 'owner') {
    const page = this.store.list(owner, cursor, limit, workspaceId, status);
    return { ...page, runs: page.runs.map(run => this.publicRun(run)) };
  }
  cancel(taskId: string, owner = 'owner') {
    const active = this.active.get(taskId);
    const stored = this.store.run(taskId, owner);
    if (terminal(stored.status)) return this.publicRun(stored);
    const run = active?.run ?? stored;
    run.cancelReason = 'cancelled';
    if (active) { this.store.save(run); active.controller.abort(); }
    else { run.status = 'cancelled'; run.finishedAt = new Date().toISOString(); this.store.save(run); }
    return this.publicRun(run);
  }
  private pump() {
    if (this.closing || this.pumping) return;
    this.pumping = true;
    try {
      for (const run of this.store.active()) {
        if (this.active.size >= this.config.maxConcurrentRuns) break;
        if (run.status !== 'queued') continue;
        const controller = new AbortController();
        run.status = 'starting'; run.startedAt = new Date().toISOString(); this.store.save(run);
        const entry = { run, controller, promise: Promise.resolve() };
        this.active.set(run.taskId, entry);
        entry.promise = this.execute(run, controller).finally(() => { this.active.delete(run.taskId); this.pump(); });
        void entry.promise.catch(() => { this.closing = true; for (const job of this.active.values()) job.controller.abort(); });
      }
    } finally { this.pumping = false; }
  }
  private async execute(run: Run, controller: AbortController) {
    const timeout = setTimeout(() => { run.cancelReason ??= 'timed_out'; controller.abort(); }, run.input.limits.wallTimeSeconds * 1000);
    try {
      const cwd = await this.files.resolve(run.input.workspaceId, run.input.cwd, true);
      if (cwd !== run.resolvedCwd) throw new AgentError('WORKSPACE_CHANGED', 'The working folder changed after the run was queued.');
      const session = this.store.session(run.sessionId, run.owner);
      controller.signal.throwIfAborted();
      run.status = 'running'; this.store.save(run);
      const emit = (event: RunEvent) => { this.store.event(run, event, this.config.maxRunOutputBytes); };
      const result = await this.providers[run.input.provider].run({ input: run.input, cwd, nativeId: session.nativeId, signal: controller.signal, emit,
        onSession: nativeId => { session.nativeId = nativeId; this.store.saveSession(session); } });
      run.result = { ...result, text: result.text.length > 32000 ? `${result.text.slice(0, 32000)}\n[Final response truncated]` : result.text };
      run.status = run.cancelReason ?? 'succeeded';
    } catch (error) { run.status = run.cancelReason ?? 'failed'; run.error = failureOf(error); }
    finally {
      clearTimeout(timeout);
      run.finishedAt = new Date().toISOString();
      this.store.save(run);
    }
  }
  close(): Promise<void> { return this.closePromise ??= this.shutdown(); }
  private async shutdown() {
    this.closing = true;
    clearInterval(this.timer);
    for (const { run, controller } of this.active.values()) { run.cancelReason ??= 'interrupted'; controller.abort(); }
    await Promise.allSettled([...this.active.values()].map(job => job.promise));
    this.store.recover();
    this.store.close();
    const lock = join(this.directory, 'runtime.lock');
    const owner = await readJson<{ lockId: string }>(join(lock, 'owner.json'));
    if (owner?.lockId === this.lockId) await rm(lock, { recursive: true, force: true });
  }
}
