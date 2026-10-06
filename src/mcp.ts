import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AgentService } from './service.js';
import { startSchema, continueSchema, providerSchema, identifier, pathSchema } from './schema.js';
import { failureOf } from './errors.js';

export const toolSchemas = {
  getAgentCapabilities: z.object({ provider: providerSchema.optional() }).strict(),
  getSupportedModels: z.object({ provider: providerSchema, refresh: z.boolean().default(false) }).strict(),
  listWorkspaces: z.object({}).strict(),
  listDirectory: z.object({ workspaceId: identifier, path: pathSchema, cursor: z.string().max(255).default(''), limit: z.number().int().min(1).max(200).default(100) }).strict(),
  readFile: z.object({ workspaceId: identifier, path: z.string().min(1).max(4096), startLine: z.number().int().min(1).default(1), maxLines: z.number().int().min(1).max(1000).default(200) }).strict(),
  globFiles: z.object({ workspaceId: identifier, pattern: z.string().min(1).max(1000), cursor: z.string().max(4096).default(''), limit: z.number().int().min(1).max(200).default(100) }).strict(),
  grepFiles: z.object({ workspaceId: identifier, pattern: z.string().min(1).max(1000), fileGlob: z.string().max(1000).default('**/*'), literal: z.boolean().default(false), caseSensitive: z.boolean().default(true), limit: z.number().int().min(1).max(100).default(50) }).strict(),
  startAgentRun: startSchema,
  continueAgentSession: continueSchema,
  getAgentRunStatus: z.object({ taskId: z.uuid() }).strict(),
  getAgentRunOutput: z.object({ taskId: z.uuid(), cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0), limit: z.number().int().min(1).max(200).default(100) }).strict(),
  listAgentRuns: z.object({ cursor: z.string().max(36).default(''), limit: z.number().int().min(1).max(100).default(50), workspaceId: identifier.optional(), status: z.enum(['queued','starting','running','succeeded','failed','cancelled','timed_out','interrupted']).optional() }).strict(),
  cancelAgentRun: z.object({ taskId: z.uuid() }).strict(),
};
export type ToolName = keyof typeof toolSchemas;
export function createAgentMcpServer(service: AgentService, owner = 'owner') {
  const mcp = new McpServer({ name: 'agentgo', version: '0.1.0' }, { supportedProtocolVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] });
  const handlers: Record<ToolName, (input: any) => unknown> = {
    getAgentCapabilities: a => service.capabilities(a.provider),
    getSupportedModels: a => service.models(a.provider, a.refresh),
    listWorkspaces: () => service.files.list(),
    listDirectory: a => service.files.listDirectory(a.workspaceId, a.path, a.cursor, a.limit),
    readFile: a => service.files.readFile(a.workspaceId, a.path, a.startLine, a.maxLines),
    globFiles: a => service.files.globFiles(a.workspaceId, a.pattern, a.cursor, a.limit),
    grepFiles: a => service.files.grepFiles(a.workspaceId, a.pattern, a.fileGlob, a.literal, a.caseSensitive, a.limit),
    startAgentRun: a => service.start(a, owner),
    continueAgentSession: a => service.continue(a, owner),
    getAgentRunStatus: a => service.status(a.taskId, owner),
    getAgentRunOutput: a => service.output(a.taskId, a.cursor, a.limit, owner),
    listAgentRuns: a => service.list(a.cursor, a.limit, a.workspaceId, a.status, owner),
    cancelAgentRun: a => service.cancel(a.taskId, owner),
  };
  const descriptions: Record<ToolName, string> = {
    getAgentCapabilities: 'Inspect local CLI availability and the fixed auto-approval mode.',
    getSupportedModels: 'Discover model-specific effort and service-tier values. Configured catalogs do not guarantee account access.',
    listWorkspaces: 'List workspace IDs registered locally by the owner.',
    listDirectory: 'List one directory inside an approved workspace; paginate with the returned cursor.',
    readFile: 'Read bounded UTF-8 text from a workspace file. Sensitive paths and symlinks are denied.',
    globFiles: 'Find files using a glob; respects ignore files and excludes sensitive paths.',
    grepFiles: 'Search bounded workspace text using ripgrep, with line numbers. Check truncated in the result.',
    startAgentRun: 'Queue local CLI work with automatic approval. Reuse identical arguments and idempotencyKey on retries. Poll status/output with the returned taskId.',
    continueAgentSession: 'Continue a finished conversation with a new task. Uses the original provider, workspace and model configuration.',
    getAgentRunStatus: 'Read task state, activity and errors. CLI completion does not certify correctness.',
    getAgentRunOutput: 'Read visible messages and tool activity after a cursor; includes final output when available.',
    listAgentRuns: 'List persisted tasks, optionally filtered by workspace and state.',
    cancelAgentRun: 'Request termination of an owned task. Does not undo completed edits or external effects.',
  };
  for (const name of Object.keys(toolSchemas) as ToolName[]) {
    const mutation = ['startAgentRun', 'continueAgentSession', 'cancelAgentRun'].includes(name);
    mcp.registerTool(name, { description: descriptions[name], inputSchema: toolSchemas[name] as z.ZodObject<any>,
      annotations: { readOnlyHint: !mutation, destructiveHint: mutation, idempotentHint: true, openWorldHint: mutation } }, async input => {
      try {
        const result = await handlers[name](toolSchemas[name].parse(input)) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(failureOf(error)) }] }; }
    });
  }
  return mcp;
}
