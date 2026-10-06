import { join, isAbsolute, relative } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { configSchema, type Config } from './schema.js';
import { readJson, writeJson, privateDirectory } from './storage.js';
import { AgentError } from './errors.js';

export async function loadConfig(directory: string): Promise<Config> {
  return configSchema.parse(await readJson(join(directory, 'config.json')) ?? {});
}
async function existingFolder(path: string): Promise<string> {
  const full = await realpath(path).catch(() => { throw new AgentError('INVALID_CONFIG', `${path} does not exist.`); });
  if (!(await stat(full)).isDirectory()) throw new AgentError('INVALID_CONFIG', `${full} is not a folder.`);
  return full;
}
export async function saveConfig(directory: string, value: Config): Promise<void> {
  const config = configSchema.parse(value);
  await privateDirectory(directory);
  const state = await realpath(directory);
  const ids = new Set<string>();
  const roots: string[] = [];
  for (const workspace of config.workspaces) {
    if (ids.has(workspace.id)) throw new AgentError('INVALID_CONFIG', 'Workspace IDs must be unique.');
    ids.add(workspace.id);
    workspace.path = await existingFolder(workspace.path);
    if (roots.some(root => contains(root, workspace.path) || contains(workspace.path, root))) {
      throw new AgentError('INVALID_CONFIG', 'Workspaces cannot be inside each other. Add the outer folder with workspace add-folder instead.');
    }
    roots.push(workspace.path);
  }
  const folders: string[] = [];
  for (const folder of config.folders) {
    const full = await existingFolder(folder);
    if (contains(state, full)) throw new AgentError('INVALID_CONFIG', 'A folder cannot be inside the AgentGo state directory.');
    if (folders.some(other => contains(other, full) || contains(full, other))) throw new AgentError('INVALID_CONFIG', 'Folders cannot be inside each other.');
    folders.push(full);
  }
  config.folders = folders;
  await writeJson(join(directory, 'config.json'), config);
}
export function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('../') && rel !== '..' && !isAbsolute(rel));
}
export async function readToken(directory: string): Promise<string> {
  const saved = await readJson<{ token: string }>(join(directory, 'credentials.json'));
  if (!saved || !/^[A-Za-z0-9_-]{43,}$/.test(saved.token)) throw new AgentError('INVALID_TOKEN', 'No connection password yet. Run agentgo token rotate to create one.');
  return saved.token;
}
export async function rotateToken(directory: string): Promise<string> {
  await privateDirectory(directory);
  const token = randomBytes(32).toString('base64url');
  await writeJson(join(directory, 'credentials.json'), { token });
  return token;
}
export async function ensureToken(directory: string): Promise<string> {
  if (await readJson(join(directory, 'credentials.json'))) return readToken(directory);
  return rotateToken(directory);
}
