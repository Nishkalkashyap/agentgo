import { tunnelArguments, cloudflaredEnvironment } from './cloudflare.js';
import { ManagedProcess } from './process.js';
import type { TunnelConfig } from './hosting-types.js';

export function maintainTunnel(options: { binary: string; config: TunnelConfig; stateDir: string; localURL: string; onState: (status: 'connecting' | 'connected' | 'reconnecting', url?: string) => Promise<void> }) {
  let stopped = false;
  let process: ManagedProcess | undefined;
  let wake: (() => void) | undefined;
  const ready = (async () => {
    let attempts = 0;
    while (!stopped) {
      await options.onState(attempts === 0 ? 'connecting' : 'reconnecting');
      try {
        const args = await tunnelArguments(options.config, options.stateDir, options.localURL);
        if (stopped) break;
        process = new ManagedProcess(options.binary, args, undefined, cloudflaredEnvironment());
        let buffer = '';
        let url = options.config.mode === 'quick' ? undefined : `https://${options.config.hostname}`;
        let connected = false;
        let notification: Promise<void> = Promise.resolve();
        const consume = (chunk: Buffer) => {
          buffer = (buffer + chunk.toString()).slice(-16_384);
          url = options.config.mode === 'quick' ? buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0] ?? url : url;
          if (!connected && url && buffer.includes('Registered tunnel connection')) {
            connected = true; attempts = 0;
            notification = options.onState('connected', url);
            void notification.catch(() => { void process?.stop(); });
          }
        };
        process.on('stdout', consume); process.on('stderr', consume);
        const timeout = setTimeout(() => { if (!connected) void process?.stop(); }, 90_000);
        try { await process.wait(); await notification; } finally { clearTimeout(timeout); }
      } catch { /* Keep agent execution alive and retry tunnel startup. */ }
      if (stopped) break;
      attempts++;
      await options.onState('reconnecting');
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, Math.min(30_000, 500 * 2 ** Math.min(attempts, 6))); wake = () => { clearTimeout(timer); resolve(); }; });
    }
  })();
  return { done: ready, async close() { stopped = true; wake?.(); await process?.stop(); await ready; } };
}
