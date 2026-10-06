import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AgentService } from './service.js';
import { startSchema, continueSchema, providerSchema, identifier, pathSchema } from './schema.js';
import { failureOf } from './errors.js';
import { version } from './version.js';

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
  const mcp = new McpServer({ name: 'agentgo', version }, { supportedProtocolVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] });
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
    getAgentCapabilities: 'Show which coding agents (codex, claude) are installed on this computer, their versions, and how they approve their own actions.',
    getSupportedModels: 'List the models you can pass to startAgentRun, with the effort and serviceTier values each accepts. Codex reports its list live; the Claude list is set by the owner and may include models their account cannot use.',
    listWorkspaces: 'List the projects the owner has allowed agents to work in. Use an id as workspaceId in other tools. Only the owner can add projects, by running agentgo on their computer; if the list is empty, the result says how.',
    listDirectory: 'List the files and folders at one path in a workspace. If nextCursor is set, pass it back as cursor for the next page.',
    readFile: 'Read lines from a UTF-8 text file in a workspace (files up to 1 MiB). Secrets such as .env files and private keys, and symlinks, are blocked.',
    globFiles: 'Find workspace files whose paths match a glob such as src/**/*.ts. Skips files ignored by .gitignore, dependency and build folders such as node_modules and dist, and secrets.',
    grepFiles: 'Search workspace files with ripgrep and return matching lines with line numbers. Skips the same files as globFiles. If truncated is true, narrow the search.',
    startAgentRun: 'Start Codex or Claude Code on a task in a workspace. It runs in the background and approves its own actions. Several runs can work at once, even in the same workspace, so give parallel runs separate parts of the code. Returns a taskId to poll with getAgentRunStatus and getAgentRunOutput. If this call fails, retry with the same arguments and idempotencyKey; that never starts a second run.',
    continueAgentSession: 'Send a follow-up prompt to the conversation of a finished run, using its sessionId. Keeps the same agent, model, workspace and folder. Returns a new taskId.',
    getAgentRunStatus: "Get a run's state, timing, token usage and error. succeeded means the agent finished, not that its work is correct.",
    getAgentRunOutput: "Read a run's messages, commands, tool calls and file changes after cursor, plus the final response once it has finished.",
    listAgentRuns: 'List runs, optionally filtered by workspace and status.',
    cancelAgentRun: 'Stop a queued or running run. Changes it already made are not undone.',
  };
  for (const name of Object.keys(toolSchemas) as ToolName[]) {
    const mutation = ['startAgentRun', 'continueAgentSession', 'cancelAgentRun'].includes(name);
    mcp.registerTool(name, { description: descriptions[name], inputSchema: toolSchemas[name] as z.ZodObject<any>,
      annotations: { readOnlyHint: !mutation, destructiveHint: mutation, idempotentHint: true, openWorldHint: mutation } }, async input => {
      try {
        await service.refresh();
        const result = await handlers[name](toolSchemas[name].parse(input)) as Record<string, unknown>;
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(failureOf(error)) }] }; }
    });
  }
  return mcp;
}
