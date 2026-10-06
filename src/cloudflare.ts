import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { runCommand } from './commands.js';
import { AgentError } from './errors.js';
import { privateDirectory, readJson, stateDirectory, withLock, writeJson } from './storage.js';
import type { CloudflaredOptions, NamedTunnelOptions, TunnelConfig } from './hosting-types.js';

const hostname = z.string().max(253).regex(/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/);
const path = z.string().min(1).transform(value => resolve(value));
const namedTunnelSchema = z.object({ mode: z.literal('named'), hostname, tunnelId: z.uuid(), credentialsFile: path }).strict();
export const tunnelSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('quick') }).strict(),
  namedTunnelSchema,
  z.object({ mode: z.literal('token'), hostname, tokenFile: path }).strict(),
]);

interface ReleaseAsset { name: string; browser_download_url: string; digest: string | null }

/** Uses an existing executable, or installs a verified release after explicit consent. */
export async function ensureCloudflared(options: CloudflaredOptions = {}): Promise<string> {
  if (options.cloudflaredPath) {
    await runCommand(options.cloudflaredPath, ['--version']);
    return options.cloudflaredPath;
  }
  const directory = join(stateDirectory(options.stateDir), 'bin');
  const executable = join(directory, 'cloudflared');
  for (const candidate of ['cloudflared', executable]) {
    try {
      await runCommand(candidate, ['--version']);
      return candidate;
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'MISSING_DEPENDENCY') throw error;
    }
  }
  if (options.downloadCloudflared === false) {
    throw new AgentError('MISSING_DEPENDENCY', 'cloudflared is not installed and downloads are turned off. Install it, or point --cloudflared at it.');
  }
  const architectures: Record<string, string> = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' };
  const platforms: Record<string, string> = { darwin: 'darwin', linux: 'linux' };
  const architecture = architectures[process.arch];
  const platform = platforms[process.platform];
  if (!architecture || !platform) throw new AgentError('UNSUPPORTED_PLATFORM', 'There is no cloudflared download for this platform. Install it yourself.');
  if (options.downloadCloudflared !== true) {
    if (!options.confirmCloudflaredDownload) {
      throw new AgentError('DOWNLOAD_CONFIRMATION_REQUIRED', 'cloudflared is not installed. Install it, or pass --yes (downloadCloudflared: true in code) to download it.');
    }
    if (!await options.confirmCloudflaredDownload()) {
      throw new AgentError('DOWNLOAD_CANCELLED', 'cloudflared download cancelled. No tunnel was started.');
    }
  }
  const name = `cloudflared-${platform}-${architecture}${platform === 'darwin' ? '.tgz' : ''}`;
  await privateDirectory(directory);
  // Lifecycle start/setup callers hold the lock while installing.
  const releaseResponse = await fetch('https://api.github.com/repos/cloudflare/cloudflared/releases/latest', {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agentgo' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!releaseResponse.ok) throw new AgentError('DOWNLOAD_FAILED', `Could not look up the latest cloudflared release (HTTP ${releaseResponse.status}). Install cloudflared yourself.`);
  const release = await releaseResponse.json() as { assets: ReleaseAsset[] };
  const asset = release.assets.find(asset => asset.name === name);
  if (!asset || !asset.digest?.match(/^sha256:[a-f0-9]{64}$/)) {
    throw new AgentError('DOWNLOAD_FAILED', `The latest cloudflared release has no checksummed ${name}. Install cloudflared yourself.`);
  }
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new AgentError('DOWNLOAD_FAILED', `cloudflared download failed (HTTP ${response.status}).`);
  const data = Buffer.from(await response.arrayBuffer());
  if (`sha256:${createHash('sha256').update(data).digest('hex')}` !== asset.digest) {
    throw new AgentError('INTEGRITY_FAILED', 'The downloaded cloudflared does not match its published checksum.');
  }
  const temporary = await mkdtemp(join(directory, 'download-'));
  try {
    const download = join(temporary, platform === 'darwin' ? 'archive.tgz' : 'cloudflared');
    await writeFile(download, data, { mode: 0o600 });
    if (platform === 'darwin') await runCommand('tar', ['-xzf', download, '-C', temporary, 'cloudflared']);
    const binary = join(temporary, 'cloudflared');
    await chmod(binary, 0o700);
    await runCommand(binary, ['--version']);
    await rename(binary, executable);
  } finally { await rm(temporary, { recursive: true, force: true }); }
  return executable;
}

async function interactiveLogin(binary: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, ['tunnel', 'login'], { stdio: ['inherit', 2, 2] });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new AgentError('CLOUDFLARE_LOGIN_FAILED', `Cloudflare login exited with code ${code}.`)));
  });
}

/** Creates/reuses a tunnel in the user's own account and saves it as the default. */
export async function configureCloudflare(options: NamedTunnelOptions): Promise<Extract<TunnelConfig, { mode: 'named' }>> {
  const domain = hostname.parse(options.hostname).toLowerCase();
  const directory = stateDirectory(options.stateDir);
  return withLock(directory, async () => {
    const binary = await ensureCloudflared(options);
    const certificate = join(homedir(), '.cloudflared', 'cert.pem');
    try { await access(certificate); }
    catch {
      if (!options.login) throw new AgentError('CLOUDFLARE_LOGIN_REQUIRED', 'Run cloudflared tunnel login, or call configureCloudflare with login: true.');
      await interactiveLogin(binary);
    }
    const name = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
      .parse(options.tunnelName ?? `agentgo-${domain.replaceAll('.', '-')}`);
    const tunnels = JSON.parse(await runCommand(binary, ['tunnel', 'list', '--output', 'json'])) as { id: string; name: string; deleted_at?: string }[];
    let id = tunnels.find(tunnel => tunnel.name === name && (!tunnel.deleted_at || tunnel.deleted_at.startsWith('0001-')))?.id;
    const cloudflareDirectory = join(directory, 'cloudflare');
    await privateDirectory(cloudflareDirectory);
    const pending = join(cloudflareDirectory, `${randomUUID()}.json`);
    let credentialsFile: string;
    if (id) {
      const saved = await readJson<TunnelConfig>(join(directory, 'tunnel.json'));
      credentialsFile = saved?.mode === 'named' && saved.tunnelId === id
        ? saved.credentialsFile : join(cloudflareDirectory, `${id}.json`);
      try { await access(credentialsFile); }
      catch { credentialsFile = join(homedir(), '.cloudflared', `${id}.json`); }
      try { await access(credentialsFile); }
      catch { throw new AgentError('CREDENTIALS_REQUIRED', `The tunnel ${name} already exists, but its credentials are not on this computer. Create a token for it in the Cloudflare dashboard and use --tunnel-token-file.`); }
    } else {
      try {
        await runCommand(binary, ['tunnel', 'create', '--credentials-file', pending, name]);
        const credentials = JSON.parse(await readFile(pending, 'utf8')) as { TunnelID: string };
        id = z.uuid().parse(credentials.TunnelID);
        credentialsFile = join(cloudflareDirectory, `${id}.json`);
        await chmod(pending, 0o600);
        await rename(pending, credentialsFile);
      } finally { await rm(pending, { force: true }); }
    }
    // Do not overwrite an existing DNS record. Cloudflare reports conflicts.
    await runCommand(binary, ['tunnel', 'route', 'dns', id, domain]);
    const config = namedTunnelSchema.parse({ mode: 'named', hostname: domain, tunnelId: id, credentialsFile });
    await writeJson(join(directory, 'tunnel.json'), config);
    return config;
  });
}

/** Isolate quick tunnels from ~/.cloudflared/config.yml and ambient tunnel flags. */
export async function tunnelArguments(config: TunnelConfig, directory: string, localURL: string): Promise<string[]> {
  const configuration = join(directory, 'cloudflared-runtime.json');
  const args = ['tunnel', '--config', configuration, '--no-autoupdate', '--metrics', '127.0.0.1:0'];
  if (config.mode === 'quick') {
    await writeJson(configuration, {});
    return [...args, '--url', localURL];
  }
  if (config.mode === 'token') {
    await access(config.tokenFile);
    await writeJson(configuration, {});
    return [...args, 'run', '--token-file', config.tokenFile];
  }
  const credentials = JSON.parse(await readFile(config.credentialsFile, 'utf8')) as { TunnelID: string };
  if (credentials.TunnelID !== config.tunnelId) throw new AgentError('INVALID_TUNNEL', 'The credentials file belongs to a different tunnel.');
  // JSON is a valid YAML subset and safely encodes paths and hostnames.
  await writeJson(configuration, {
    tunnel: config.tunnelId,
    'credentials-file': config.credentialsFile,
    ingress: [{ hostname: config.hostname, service: localURL }, { service: 'http_status:404' }],
  });
  return [...args, 'run', config.tunnelId];
}

export function cloudflaredEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('TUNNEL_') && !key.startsWith('NO_AUTOUPDATE') && key !== 'NO_TLS_VERIFY'));
}
