export type TunnelConfig =
  | { mode: 'quick' }
  | { mode: 'named'; hostname: string; tunnelId: string; credentialsFile: string }
  | { mode: 'token'; hostname: string; tokenFile: string };
export interface CloudflaredOptions {
  stateDir?: string; cloudflaredPath?: string; downloadCloudflared?: boolean;
  confirmCloudflaredDownload?: () => Promise<boolean>;
}
export interface NamedTunnelOptions extends CloudflaredOptions { hostname: string; tunnelName?: string; login?: boolean }
export interface StartOptions extends CloudflaredOptions { tunnel?: TunnelConfig | null; port?: number; startupTimeoutMs?: number }
export type DaemonState = {
  instanceId: string; pid: number; status: 'starting' | 'running' | 'stopped' | 'failed';
  localURL?: string; mcpConnectionURL?: string; adminSocket: string; startedAt: string;
  tunnelStatus: 'disabled' | 'connecting' | 'connected' | 'reconnecting'; error?: string;
};
