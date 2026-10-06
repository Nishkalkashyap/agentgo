import { constants, type Dirent } from 'node:fs';
import { open, realpath, lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, matchesGlob } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { contains } from './config.js';
import { AgentError } from './errors.js';
import type { Config } from './schema.js';
import { agentEnvironment } from './process.js';

const SEARCH_FILE_LIMIT = 100_000;
const SEARCH_TIMEOUT_MS = 10_000;
const forbidden = (path: string) => path.split(/[\\/]/).some(part => /^(\.git|\.ssh|\.aws|\.gnupg|\.codex|\.claude|\.agentgo|\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519)$/i.test(part) || /\.(pem|key|p12|pfx)$/i.test(part));
// The same names as forbidden(), so ripgrep never opens them in the first place.
const secretGlobs = ['.git', '.ssh', '.aws', '.gnupg', '.codex', '.claude', '.agentgo', '.env', '.env.*', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519', '*.pem', '*.key', '*.p12', '*.pfx'];
export const workspacesHint = 'No workspaces yet. Ask the owner to run "agentgo workspace add-folder <folder>" on their computer, for example "agentgo workspace add-folder ~/code". Every project inside that folder becomes a workspace, and no restart is needed.';
// Folder names become workspace IDs: "My App" becomes "My-App".
const folderId = (name: string) => name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '').slice(0, 100);
const byName = (a: Dirent, b: Dirent) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

function ripgrepFailure(error: Error & { code?: unknown }, stderr: string): AgentError {
  if (error.code === 'ENOENT') return new AgentError('MISSING_DEPENDENCY', 'ripgrep (rg) is not installed on the computer running AgentGo.');
  return new AgentError('SEARCH_FAILED', stderr.trim().slice(0, 2000) || error.message);
}
function listFiles(binary: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: SEARCH_TIMEOUT_MS, env: agentEnvironment() }, (error, stdout, stderr) => {
      // ripgrep exits with 1 when nothing matched.
      if (error && error.code !== 1) reject(ripgrepFailure(error, stderr));
      else resolve(stdout);
    });
  });
}

export class WorkspaceFiles {
  private roots = new Map<string, { path: string; label: string }>();
  constructor(private readonly config: Config, private readonly stateDir: string) {}
  async prepare() {
    const state = await realpath(this.stateDir);
    const roots = new Map<string, { path: string; label: string }>();
    for (const workspace of this.config.workspaces) {
      // A project that was deleted or moved drops out of the list instead of breaking every tool.
      const root = await realpath(workspace.path).catch(() => undefined);
      if (!root || !(await lstat(root)).isDirectory()) continue;
      if (contains(root, state) || contains(state, root)) throw new AgentError('INVALID_WORKSPACE', 'A workspace cannot contain, or be inside, the AgentGo state directory.');
      if ([...roots.values()].some(other => contains(root, other.path) || contains(other.path, root))) throw new AgentError('INVALID_WORKSPACE', 'Workspaces cannot be inside each other.');
      if (roots.has(workspace.id)) throw new AgentError('INVALID_WORKSPACE', 'Duplicate workspace ID.');
      roots.set(workspace.id, { path: root, label: workspace.label ?? workspace.id });
    }
    for (const folder of this.config.folders) {
      const base = await realpath(folder).catch(() => undefined);
      const entries = base ? await readdir(base, { withFileTypes: true }).catch(() => []) : [];
      for (const entry of entries.sort(byName)) {
        const id = folderId(entry.name);
        if (!entry.isDirectory() || entry.name.startsWith('.') || forbidden(entry.name) || !id || roots.has(id)) continue;
        const root = join(base!, entry.name);
        if ([...roots.values()].some(other => other.path === root) || contains(root, state) || contains(state, root)) continue;
        roots.set(id, { path: root, label: entry.name });
      }
    }
    this.roots = roots;
  }
  /** Includes each workspace's full path, which the MCP tools don't reveal. */
  all() { return [...this.roots].map(([id, root]) => ({ id, label: root.label, path: root.path })); }
  list() {
    const workspaces = [...this.roots].map(([id, root]) => ({ id, label: root.label }));
    return workspaces.length ? { workspaces } : { workspaces, hint: workspacesHint };
  }
  async resolve(workspaceId: string, path = '.', directory = false): Promise<string> {
    const root = this.roots.get(workspaceId)?.path;
    if (!root) throw new AgentError('WORKSPACE_NOT_FOUND', this.roots.size ? 'No workspace has this ID. Call listWorkspaces to see the IDs.' : workspacesHint);
    if (isAbsolute(path) || path.includes('\0') || path.includes('\\') || forbidden(path)) throw new AgentError('PATH_DENIED', 'Use a relative path inside the workspace. Secrets such as .env files and keys are blocked.');
    const full = resolve(root, path);
    if (!contains(root, full)) throw new AgentError('PATH_DENIED', 'That path is outside the workspace.');
    // Refuse symlinks at every level, including a root replaced after registration.
    let current = root;
    for (const part of ['', ...relative(root, full).split('/').filter(Boolean)]) {
      if (part) current = join(current, part);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new AgentError('PATH_DENIED', 'Symlinks are not followed.');
    }
    if (!contains(root, await realpath(full))) throw new AgentError('PATH_DENIED', 'That path is outside the workspace.');
    if (directory && !(await lstat(full)).isDirectory()) throw new AgentError('NOT_DIRECTORY', 'That path is not a folder.');
    return full;
  }
  async listDirectory(workspaceId: string, path = '.', cursor = '', limit = 100) {
    const full = await this.resolve(workspaceId, path, true);
    const entries = (await readdir(full, { withFileTypes: true }))
      .filter(entry => !forbidden(entry.name) && entry.name > cursor)
      .sort(byName);
    const selected = entries.slice(0, limit);
    const type = (entry: Dirent) => entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
    return {
      entries: selected.map(entry => ({ name: entry.name, path: join(path, entry.name), type: type(entry) })),
      nextCursor: entries.length > limit ? selected.at(-1)!.name : null,
    };
  }
  private async text(workspaceId: string, path: string): Promise<string> {
    const full = await this.resolve(workspaceId, path);
    const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 1024 * 1024) throw new AgentError('FILE_LIMIT', 'Only regular text files up to 1 MiB can be read.');
      await this.resolve(workspaceId, path);
      const latest = await lstat(full);
      if (latest.ino !== info.ino || latest.dev !== info.dev) throw new AgentError('PATH_CHANGED', 'The file changed while it was being opened. Try again.');
      const buffer = Buffer.alloc(1024 * 1024 + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 1024 * 1024) throw new AgentError('FILE_LIMIT', 'The file is larger than 1 MiB.');
      const content = buffer.subarray(0, bytesRead);
      if (content.includes(0)) throw new AgentError('BINARY_FILE', 'This looks like a binary file, so it cannot be read as text.');
      return content.toString('utf8');
    } finally { await file.close(); }
  }
  async readFile(workspaceId: string, path: string, startLine = 1, maxLines = 200) {
    const lines = (await this.text(workspaceId, path)).split('\n');
    const selected = lines.slice(startLine - 1, startLine - 1 + maxLines).join('\n');
    const content = selected.slice(0, 16000);
    return { path, startLine, content, totalLines: lines.length, truncated: selected.length > content.length || startLine - 1 + maxLines < lines.length };
  }
  // ripgrep respects .gitignore (even outside a Git repo), skips hidden files and never follows symlinks.
  private searchArgs(): string[] {
    return [
      '--no-require-git',
      ...secretGlobs.flatMap(glob => ['--iglob', `!${glob}`]),
      ...this.config.searchExclude.flatMap(name => ['--glob', `!${name}`]),
    ];
  }
  private async paths(workspaceId: string): Promise<string[]> {
    const cwd = await this.resolve(workspaceId, '.', true);
    const output = await listFiles(this.config.rgPath, ['--files', '--null', ...this.searchArgs(), '--', '.'], cwd);
    const paths = output.split('\0').filter(Boolean).map(p => p.replace(/^\.\//, '')).filter(p => !forbidden(p));
    if (paths.length > SEARCH_FILE_LIMIT) throw new AgentError('SEARCH_LIMIT', `This workspace has more than ${SEARCH_FILE_LIMIT.toLocaleString('en-US')} searchable files. Add a smaller folder as its own workspace, or exclude more folders with searchExclude.`);
    return paths.sort();
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
    const cwd = await this.resolve(workspaceId, '.', true);
    // Sorting by path makes ripgrep single-threaded, but keeps results stable when they are cut off at the limit.
    const args = ['--json', '--sort', 'path', '--max-filesize', '1M', ...this.searchArgs(),
      ...(literal ? ['--fixed-strings'] : []), ...(caseSensitive ? [] : ['--ignore-case']), '-e', pattern, '--', '.'];
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let truncated = false;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.config.rgPath, args, { cwd, env: agentEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
      const stop = () => { truncated = true; child.kill(); };
      const timer = setTimeout(stop, SEARCH_TIMEOUT_MS);
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
      createInterface({ input: child.stdout }).on('line', line => {
        if (truncated) return;
        let entry;
        try { entry = JSON.parse(line); } catch { return; }
        if (entry.type !== 'match') return;
        const path = String(entry.data.path?.text ?? '').replace(/^\.\//, '');
        if (!path || forbidden(path) || !matchesGlob(path, fileGlob)) return;
        if (matches.length >= limit) return stop();
        matches.push({ path, line: entry.data.line_number, text: String(entry.data.lines?.text ?? '').replace(/\r?\n$/, '').slice(0, 500) });
      });
      child.once('error', error => { clearTimeout(timer); reject(ripgrepFailure(error, stderr)); });
      child.once('close', code => {
        clearTimeout(timer);
        // Exit code 2 can also mean some files were unreadable while others matched.
        if (code === 2 && !matches.length && !truncated) reject(ripgrepFailure(new Error('ripgrep failed.'), stderr));
        else resolve();
      });
    });
    return { matches, truncated };
  }
}
