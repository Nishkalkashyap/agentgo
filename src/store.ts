import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { Run, RunEvent, Session, StartInput } from './schema.js';
import { AgentError } from './errors.js';

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export class RunStore {
  private db: DatabaseSync;
  constructor(directory: string) {
    const path = join(directory, 'runs.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (owner TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES runs(id), PRIMARY KEY(owner,key));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES runs(id), created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_run ON events(task_id,seq);
      CREATE INDEX IF NOT EXISTS runs_status ON runs(status);`);
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  previous(owner: string, key: string, hash: string): Run | undefined {
    const row = this.db.prepare('SELECT fingerprint,task_id FROM requests WHERE owner=? AND key=?').get(owner, key);
    if (!row) return;
    if (row.fingerprint !== hash) throw new AgentError('IDEMPOTENCY_CONFLICT', 'This idempotency key was used with different arguments.');
    return this.run(String(row.task_id), owner);
  }
  enqueue(owner: string, input: StartInput, cwd: string, hash: string, existingSession?: Session): Run {
    return this.transaction(() => {
      const previous = this.previous(owner, input.idempotencyKey, hash);
      if (previous) return previous;
      const session = existingSession ?? { sessionId: randomUUID(), owner, provider: input.provider, workspaceId: input.workspaceId, cwd, input: { ...input, prompt: '' } };
      if (!existingSession) this.saveSession(session);
      const now = new Date().toISOString();
      const run: Run = { taskId: randomUUID(), sessionId: session.sessionId, owner, input, resolvedCwd: cwd, status: 'queued', createdAt: now, updatedAt: now, outputBytes: 0 };
      this.db.prepare('INSERT INTO runs VALUES(?,?,?,?,?)').run(run.taskId, run.sessionId, run.status, now, JSON.stringify(run));
      this.db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(owner, input.idempotencyKey, hash, run.taskId);
      return run;
    });
  }
  run(id: string, owner = 'owner'): Run {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id);
    const value: Run | undefined = row ? JSON.parse(String(row.data)) : undefined;
    if (!value || value.owner !== owner) throw new AgentError('RUN_NOT_FOUND', 'Run not found.');
    return value;
  }
  session(id: string, owner = 'owner'): Session {
    const row = this.db.prepare('SELECT data FROM sessions WHERE id=?').get(id);
    const value: Session | undefined = row ? JSON.parse(String(row.data)) : undefined;
    if (!value || value.owner !== owner) throw new AgentError('SESSION_NOT_FOUND', 'Session not found.');
    return value;
  }
  saveSession(session: Session) { this.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?)').run(session.sessionId, JSON.stringify(session)); }
  save(run: Run) {
    run.updatedAt = new Date().toISOString();
    this.db.prepare('UPDATE runs SET status=?,data=? WHERE id=?').run(run.status, JSON.stringify(run), run.taskId);
  }
  active(): Run[] {
    return this.db.prepare("SELECT data FROM runs WHERE status IN ('queued','starting','running') ORDER BY created_at,id").all().map(row => JSON.parse(String(row.data)));
  }
  list(owner: string, cursor = '', limit = 50, workspaceId?: string, status?: string): { runs: Run[]; nextCursor: string | null } {
    // Opaque UUID cursor is stable because this list sorts by ID, not timestamps.
    const rows = this.db.prepare(`SELECT data FROM runs WHERE id > ? AND json_extract(data,'$.owner')=?
      AND (? IS NULL OR json_extract(data,'$.input.workspaceId')=?) AND (? IS NULL OR status=?) ORDER BY id LIMIT ?`)
      .all(cursor, owner, workspaceId ?? null, workspaceId ?? null, status ?? null, status ?? null, limit + 1);
    const matched = rows.map(row => JSON.parse(String(row.data)) as Run);
    const runs = matched.slice(0, limit);
    return { runs, nextCursor: matched.length > limit ? runs.at(-1)!.taskId : null };
  }
  event(run: Run, event: RunEvent, maxBytes: number): void {
    let data = JSON.stringify(event);
    if (Buffer.byteLength(data) > 16000) data = JSON.stringify({ type: event.type, data: { truncated: true, preview: data.slice(0, 3000) } });
    const bytes = Buffer.byteLength(data);
    if (run.outputBytes + bytes > maxBytes) throw new AgentError('OUTPUT_LIMIT', 'Run exceeded the locally configured output limit.');
    this.transaction(() => {
      this.db.prepare('INSERT INTO events(task_id,created_at,data) VALUES(?,?,?)').run(run.taskId, new Date().toISOString(), data);
      run.outputBytes += bytes;
      this.save(run);
    });
  }
  output(taskId: string, cursor = 0, limit = 100) {
    const rows = this.db.prepare('SELECT seq,created_at,data FROM events WHERE task_id=? AND seq>? ORDER BY seq LIMIT ?').all(taskId, cursor, limit + 1);
    let size = 0;
    const events: Array<{ cursor: number; createdAt: string; type: string; data: Record<string, unknown> }> = [];
    for (const row of rows.slice(0, limit)) {
      size += Buffer.byteLength(String(row.data));
      if (size > 48 * 1024 && events.length) break;
      events.push({ cursor: Number(row.seq), createdAt: String(row.created_at), ...JSON.parse(String(row.data)) });
    }
    return { events, nextCursor: events.at(-1)?.cursor ?? cursor, moreAvailable: rows.length > events.length };
  }
  recover() {
    for (const run of this.active()) { run.status = 'interrupted'; run.finishedAt = new Date().toISOString(); run.error = { code: 'DAEMON_RESTARTED', message: 'Daemon stopped before recording completion; work was not replayed.' }; this.save(run); }
  }
  prune(days: number) {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    this.transaction(() => {
      this.db.prepare("DELETE FROM events WHERE task_id IN (SELECT id FROM runs WHERE created_at < ? AND status NOT IN ('queued','starting','running'))").run(cutoff);
      const expired = this.db.prepare("SELECT data FROM runs WHERE created_at < ? AND status NOT IN ('queued','starting','running') AND json_extract(data,'$.outputExpired') IS NULL").all(cutoff);
      for (const row of expired) {
        const run: Run = JSON.parse(String(row.data));
        run.input.prompt = ''; delete run.result; run.outputExpired = true;
        this.save(run);
      }
      // Keep compact run/idempotency records: pruning output must never turn a retry into a new run.
    });
  }
  close() { this.db.close(); }
}
