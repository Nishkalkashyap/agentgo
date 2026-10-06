import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { AgentService, type ServiceOptions } from './service.js';
import { createAgentMcpServer } from './mcp.js';

export async function serveAgentStdio(options: ServiceOptions) {
  const service = await AgentService.create(options);
  const mcp = createAgentMcpServer(service);
  const transport = new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 512 * 1024 });
  let closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.resolve().then(async () => { await mcp.close(); await service.close(); });
  mcp.server.onclose = () => { void close(); };
  try { await mcp.connect(transport); }
  catch (error) { await service.close(); throw error; }
  return { service, close };
}
