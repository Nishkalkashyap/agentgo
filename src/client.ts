import { Client, StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client';
import type { z } from 'zod';
import { toolSchemas, type ToolName } from './mcp.js';
import { AgentError } from './errors.js';
import type { AgentService } from './service.js';
import type { WorkspaceFiles } from './filesystem.js';

type Results = {
  getAgentCapabilities: Awaited<ReturnType<AgentService['capabilities']>>;
  getSupportedModels: Awaited<ReturnType<AgentService['models']>>;
  listWorkspaces: ReturnType<WorkspaceFiles['list']>;
  listDirectory: Awaited<ReturnType<WorkspaceFiles['listDirectory']>>;
  readFile: Awaited<ReturnType<WorkspaceFiles['readFile']>>;
  globFiles: Awaited<ReturnType<WorkspaceFiles['globFiles']>>;
  grepFiles: Awaited<ReturnType<WorkspaceFiles['grepFiles']>>;
  startAgentRun: Awaited<ReturnType<AgentService['start']>>;
  continueAgentSession: Awaited<ReturnType<AgentService['continue']>>;
  getAgentRunStatus: ReturnType<AgentService['status']>;
  getAgentRunOutput: ReturnType<AgentService['output']>;
  listAgentRuns: ReturnType<AgentService['list']>;
  cancelAgentRun: ReturnType<AgentService['cancel']>;
};
export type ClientOptions = { mcpConnectionURL: string; token: string; transport?: never } | { transport: Transport; mcpConnectionURL?: never; token?: never };
export class AgentClient {
  private constructor(private readonly client: Client) {}
  static async connect(options: ClientOptions) {
    let transport = options.transport;
    if (!transport) {
      const url = new URL(options.mcpConnectionURL!);
      if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname)))) throw new AgentError('INVALID_URL', 'Use HTTPS, or HTTP on loopback.');
      transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${options.token}` }, redirect: 'error' } });
    }
    const client = new Client({ name: 'agentgo-client', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
    try { await client.connect(transport); } catch (error) { await client.close(); throw error; }
    return new AgentClient(client);
  }
  async call<N extends ToolName>(name: N, input: z.input<typeof toolSchemas[N]>): Promise<Results[N]> {
    const result = await this.client.callTool({ name, arguments: toolSchemas[name].parse(input) });
    const text = result.content?.find(item => item.type === 'text');
    const value = result.structuredContent ?? (text?.type === 'text' ? JSON.parse(text.text) : undefined);
    if (result.isError) throw new AgentError(value?.code ?? 'TOOL_ERROR', value?.message ?? 'MCP tool failed.');
    if (!value) throw new AgentError('INVALID_RESPONSE', 'MCP tool returned no result.');
    return value as Results[N];
  }
  startAgentRun(input: z.input<typeof toolSchemas.startAgentRun>) { return this.call('startAgentRun', input); }
  continueAgentSession(input: z.input<typeof toolSchemas.continueAgentSession>) { return this.call('continueAgentSession', input); }
  getAgentRunStatus(taskId: string) { return this.call('getAgentRunStatus', { taskId }); }
  getAgentRunOutput(taskId: string, cursor = 0) { return this.call('getAgentRunOutput', { taskId, cursor }); }
  cancelAgentRun(taskId: string) { return this.call('cancelAgentRun', { taskId }); }
  getSupportedModels(provider: 'codex' | 'claude', refresh = false) { return this.call('getSupportedModels', { provider, refresh }); }
  listWorkspaces() { return this.call('listWorkspaces', {}); }
  close() { return this.client.close(); }
}
export const connectAgent = (options: ClientOptions) => AgentClient.connect(options);
