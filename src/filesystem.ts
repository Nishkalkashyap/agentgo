import { constants } from 'node:fs';
import { open, realpath, lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, matchesGlob } from 'node:path';
import { execFile } from 'node:child_process';
import { contains } from './config.js';
import { AgentError } from './errors.js';
import type { Config } from './schema.js';
import { agentEnvironment } from './process.js';

const forbidden = (path: string) => path.split(/[\\/]/).some(part => /^(\.git|\.ssh|\.aws|\.gnupg|\.codex|\.claude|\.agentgo|\.agent-mcp|\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519)$/i.test(part) || /\.(pem|key|p12|pfx)$/i.test(part));
function execute(binary: string, args: string[], cwd: string, stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 10000, env: agentEnvironment() }, (error, stdout, stderr) => {
      if (error && error.code !== 1) reject(new AgentError('SEARCH_FAILED', stderr.trim().slice(0, 2000) || error.message));
      else resolve(stdout);
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdin);
  });
}
export class WorkspaceFiles {
  private roots = new Map<string, string>();
  constructor(private readonly config: Config, private readonly stateDir: string) {}
  async prepare() {
    const state = await realpath(this.stateDir);
    for (const workspace of this.config.workspaces) {
      const root = await realpath(workspace.path);
      if (!(await lstat(root)).isDirectory() || contains(root, state) || contains(state, root)) throw new AgentError('INVALID_WORKSPACE', 'Workspace and private server state must be separate directories.');
      if ([...this.roots.values()].some(other => contains(root, other) || contains(other, root))) throw new AgentError('INVALID_WORKSPACE', 'Workspace roots must not overlap.');
      if (this.roots.has(workspace.id)) throw new AgentError('INVALID_WORKSPACE', 'Duplicate workspace ID.');
      this.roots.set(workspace.id, root);
    }
  }
  list() { return { workspaces: this.config.workspaces.map(w => ({ id: w.id, label: w.label ?? w.id, approvalPolicy: 'auto-approval' })) }; }
  async resolve(workspaceId: string, path = '.', directory = false): Promise<string> {
    const root = this.roots.get(workspaceId);
    if (!root) throw new AgentError('WORKSPACE_NOT_FOUND', 'Register this workspace locally first.');
    if (isAbsolute(path) || path.includes('\0') || path.includes('\\') || forbidden(path)) throw new AgentError('PATH_DENIED', 'Use an allowed relative workspace path.');
    const full = resolve(root, path);
    if (!contains(root, full)) throw new AgentError('PATH_DENIED', 'Path escapes the workspace.');
    // Refuse symlinks at every level, including a root replaced after registration.
    let current = root;
    for (const part of ['', ...relative(root, full).split('/').filter(Boolean)]) {
      if (part) current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new AgentError('PATH_DENIED', 'Symlink traversal is disabled.');
    }
    if (!contains(root, await realpath(full))) throw new AgentError('PATH_DENIED', 'Path escapes the workspace.');
    if (directory && !(await lstat(full)).isDirectory()) throw new AgentError('NOT_DIRECTORY', 'Expected a directory.');
    return full;
  }
  async listDirectory(workspaceId: string, path = '.', cursor = '', limit = 100) {
    const full = await this.resolve(workspaceId, path, true);
    const entries = (await readdir(full, { withFileTypes: true })).filter(entry => !forbidden(entry.name)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).filter(entry => entry.name > cursor);
    const selected = entries.slice(0, limit);
    return { entries: selected.map(entry => ({ name: entry.name, path: join(path, entry.name), type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })), nextCursor: entries.length > limit ? selected.at(-1)!.name : null };
  }
  private async text(workspaceId: string, path: string): Promise<string> {
    const full = await this.resolve(workspaceId, path);
    const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new AgentError('FILE_LIMIT', 'Only regular text files up to 1 MiB are readable.');
      await this.resolve(workspaceId, path);
      const latest = await lstat(full);
      if (latest.ino !== info.ino || latest.dev !== info.dev) throw new AgentError('PATH_CHANGED', 'File changed while opening it; retry.');
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024) throw new AgentError('FILE_LIMIT', 'File exceeds 1 MiB.');
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) throw new AgentError('BINARY_FILE', 'Binary files are not supported.');
      return content.toString('utf8');
    } finally { await file.close(); }
  }
  async readFile(workspaceId: string, path: string, startLine = 1, maxLines = 200) {
    const lines = (await this.text(workspaceId, path)).split('\n');
    const selected = lines.slice(startLine - 1, startLine - 1 + maxLines).join('\n');
    const content = selected.slice(0, 16000);
    return { path, startLine, content, totalLines: lines.length, truncated: selected.length > content.length || startLine - 1 + maxLines < lines.length };
  }
  private async paths(workspaceId: string): Promise<string[]> {
    const cwd = await this.resolve(workspaceId, '.', true);
    const output = await execute(this.config.rgPath, ['--files', '--null', '--no-require-git', '--', '.'], cwd);
    const paths = output.split('\0').filter(Boolean).map(p => p.replace(/^\.\//, '')).filter(p => !forbidden(p)).sort();
    if (paths.length > 20000) throw new AgentError('SEARCH_LIMIT', 'Workspace contains over 20,000 searchable files. Register a smaller root.');
    return paths;
  }
  async globFiles(workspaceId: string, pattern: string, cursor = '', limit = 100) {
    const paths = (await this.paths(workspaceId)).filter(path => path > cursor && matchesGlob(path, pattern));
    const files: string[] = [];
    for (const path of paths) {
      try { await this.resolve(workspaceId, path); files.push(path); } catch { continue; }
      if (files.length > limit) break;
    }
    return { files: files.slice(0, limit), nextCursor: files.length > limit ? files[limit - 1] : null };
  }
  async grepFiles(workspaceId: string, pattern: string, fileGlob = '**/*', literal = false, caseSensitive = true, limit = 100) {
    const paths = (await this.paths(workspaceId)).filter(path => matchesGlob(path, fileGlob));
    let combined = '';
    let line = 1;
    let bytes = 0;
    let truncated = false;
    const ranges: Array<{ path: string; first: number; last: number }> = [];
    for (const path of paths) {
      let content: string;
      try { content = await this.text(workspaceId, path); } catch { continue; }
      bytes += Buffer.byteLength(content);
      if (bytes > 4 * 1024 * 1024) { truncated = true; break; }
      if (!content.endsWith('\n')) content += '\n';
      const count = content.split('\n').length - 1;
      ranges.push({ path, first: line, last: line + count - 1 });
      line += count; combined += content;
    }
    if (!combined) return { matches: [], truncated };
    // rg only receives already-opened and checked text, never untrusted file paths.
    const output = await execute(this.config.rgPath, ['--json', ...(literal ? ['--fixed-strings'] : []), ...(caseSensitive ? [] : ['--ignore-case']), '-e', pattern, '--'], await this.resolve(workspaceId, '.', true), combined);
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const row of output.split('\n').filter(Boolean)) {
      const entry = JSON.parse(row);
      if (entry.type !== 'match') continue;
      const range = ranges.find(range => entry.data.line_number >= range.first && entry.data.line_number <= range.last);
      if (!range) continue;
      if (matches.length >= limit) { truncated = true; break; }
      matches.push({ path: range.path, line: entry.data.line_number - range.first + 1, text: String(entry.data.lines.text ?? '').slice(0, 500) });
    }
    return { matches, truncated };
  }
}
