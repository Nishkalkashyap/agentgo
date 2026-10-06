import { fork, type ChildProcess, type Serializable } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { AgentError } from './errors.js';

export function agentEnvironment(): NodeJS.ProcessEnv {
  // Keep provider login/SDK variables and shell essentials, never tunnel/server credentials.
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_ALL|TERM|CODEX_HOME|XDG_CONFIG_HOME|SSL_CERT_FILE|SSL_CERT_DIR|HTTPS_PROXY|HTTP_PROXY|NO_PROXY)$/.test(key) ||
    /^(OPENAI_|ANTHROPIC_|CLAUDE_CODE_(OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY)$|AWS_|GOOGLE_|CLOUD_ML_|AZURE_)/.test(key)));
}
export class ManagedProcess extends EventEmitter {
  private host: ChildProcess;
  private endPromise: Promise<{ code: number | null; signal: string | null }>;
  private resolveEnd!: (result: { code: number | null; signal: string | null }) => void;
  private exitResult = { code: null as number | null, signal: null as string | null };
  private stopped = false;
  error?: Error;
  constructor(file: string, args: string[], cwd?: string, env = agentEnvironment()) {
    super();
    this.endPromise = new Promise(resolve => { this.resolveEnd = resolve; });
    this.host = fork(new URL('./process-host.js', import.meta.url), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], env: agentEnvironment() });
    this.host.on('error', error => { this.error = error; this.emit('failure', error); });
    this.host.on('message', (message: any) => {
      if (message.type === 'stdout' || message.type === 'stderr') this.emit(message.type, Buffer.from(message.data, 'base64'));
      else if (message.type === 'error') { this.error = new AgentError('PROCESS_ERROR', message.message); this.emit('failure', this.error); }
      else if (message.type === 'exit') { this.exitResult = { code: message.code, signal: message.signal }; this.emit('exit', this.exitResult); }
    });
    this.host.once('close', () => { this.stopped = true; this.resolveEnd(this.exitResult); this.emit('closed', this.exitResult); });
    this.send({ type: 'start', file, args, cwd, env });
  }
  private send(value: Serializable) { if (this.host.connected) this.host.send(value, () => {}); }
  write(value: string) { this.send({ type: 'stdin', data: value }); }
  end() { this.send({ type: 'end' }); }
  wait() { return this.endPromise; }
  async stop() { if (!this.stopped) this.send({ type: 'stop' }); await this.endPromise; }
}
export function jsonLines(process: ManagedProcess, consume: (value: any) => void, fail: (error: Error) => void) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let failed = false;
  const feed = (text: string, final = false) => {
    if (failed) return;
    buffer += text;
    if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) { failed = true; fail(new AgentError('INVALID_OUTPUT', 'CLI JSON line exceeds 2 MiB.')); return; }
    const lines = buffer.split('\n');
    buffer = lines.pop()!;
    if (final && buffer.trim()) { lines.push(buffer); buffer = ''; }
    try { for (const line of lines) if (line.trim()) consume(JSON.parse(line)); }
    catch (error) { failed = true; fail(error instanceof Error ? error : new Error(String(error))); }
  };
  process.on('stdout', (chunk: Buffer) => feed(decoder.write(chunk)));
  process.on('exit', () => feed(decoder.end(), true));
}
