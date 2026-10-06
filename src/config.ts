import { join, isAbsolute, relative } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { configSchema, type Config } from './schema.js';
import { readJson, writeJson, privateDirectory } from './storage.js';
import { AgentError } from './errors.js';

export async function loadConfig(directory: string): Promise<Config> {
  return configSchema.parse(await readJson(join(directory, 'config.json')) ?? {});
}
export async function saveConfig(directory: string, value: Config): Promise<void> {
  const config = configSchema.parse(value);
  const ids = new Set<string>();
  const roots: string[] = [];
  for (const workspace of config.workspaces) {
    if (ids.has(workspace.id)) throw new AgentError('INVALID_CONFIG', 'Workspace IDs must be unique.');
    ids.add(workspace.id);
    workspace.path = await realpath(workspace.path).catch(() => { throw new AgentError('INVALID_CONFIG', `${workspace.path} does not exist.`); });
    if (!(await stat(workspace.path)).isDirectory()) throw new AgentError('INVALID_CONFIG', `${workspace.path} is not a folder.`);
    if (roots.some(root => contains(root, workspace.path) || contains(workspace.path, root))) {
      throw new AgentError('INVALID_CONFIG', 'Workspaces cannot be inside each other. Add the outer folder once instead.');
    }
    roots.push(workspace.path);
  }
  await privateDirectory(directory);
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
