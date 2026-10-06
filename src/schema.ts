import { z } from 'zod';

export const providerSchema = z.enum(['codex', 'claude']);
export type Provider = z.infer<typeof providerSchema>;
export const identifier = z.string().min(1).max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
export const pathSchema = z.string().max(4096).refine(s => !s.includes('\0'), 'NUL is not allowed').default('.');
export const promptSchema = z.string().min(1).refine(s => Buffer.byteLength(s) <= 65536, 'Prompt exceeds 64 KiB');
export const limitsSchema = z.object({ wallTimeSeconds: z.number().int().min(1).max(86400).default(1800) }).strict().default({ wallTimeSeconds: 1800 });
export const startSchema = z.object({
  provider: providerSchema, model: identifier, effort: identifier,
  serviceTier: identifier.optional(), workspaceId: identifier, cwd: pathSchema,
  prompt: promptSchema, idempotencyKey: z.string().min(1).max(128), limits: limitsSchema,
}).strict();
export const continueSchema = z.object({ sessionId: z.uuid(), prompt: promptSchema, idempotencyKey: z.string().min(1).max(128), limits: limitsSchema }).strict();
export type StartInput = z.infer<typeof startSchema>;
export type ContinueInput = z.infer<typeof continueSchema>;
export const modelSchema = z.object({ id: identifier, displayName: z.string().optional(), efforts: z.array(identifier).min(1), serviceTiers: z.array(identifier).default([]) }).strict();
export const configSchema = z.object({
  workspaces: z.array(z.object({ id: identifier, path: z.string().min(1), label: z.string().optional() }).strict()).default([]),
  codexPath: z.string().min(1).default('codex'), claudePath: z.string().min(1).default('claude'), rgPath: z.string().min(1).default('rg'),
  claudeModels: z.array(modelSchema).default([
    { id: 'sonnet', displayName: 'Claude Sonnet (CLI alias)', efforts: ['low', 'medium', 'high'], serviceTiers: [] },
    { id: 'opus', displayName: 'Claude Opus (CLI alias)', efforts: ['low', 'medium', 'high'], serviceTiers: [] },
  ]),
  maxConcurrentRuns: z.number().int().min(1).max(8).default(2),
  maxQueuedRuns: z.number().int().min(1).max(1000).default(100),
  maxRunSeconds: z.number().int().min(1).max(86400).default(3600),
  maxRunOutputBytes: z.number().int().min(1024).max(100 * 1024 * 1024).default(10 * 1024 * 1024),
  retentionDays: z.number().int().min(1).max(365).default(30),
}).strict();
export type Config = z.infer<typeof configSchema>;
export type ModelInfo = { provider: Provider; id: string; displayName: string; efforts: string[]; serviceTiers: string[]; source: 'runtime' | 'configured'; availability: 'advertised' | 'unverified'; checkedAt: string };
export type RunStatus = 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export const terminal = (state: RunStatus) => !['queued', 'starting', 'running'].includes(state);
export type RunEvent = { type: string; data: Record<string, unknown> };
export type RunResult = { text: string; usage?: Record<string, unknown>; effective?: Record<string, unknown> };
export type Run = {
  taskId: string; sessionId: string; owner: string; input: StartInput; resolvedCwd: string;
  status: RunStatus; createdAt: string; startedAt?: string; finishedAt?: string; updatedAt: string;
  cancelReason?: 'cancelled' | 'timed_out' | 'interrupted';
  result?: RunResult; error?: { code: string; message: string }; outputBytes: number; outputExpired?: boolean;
};
export type Session = { sessionId: string; owner: string; provider: Provider; workspaceId: string; cwd: string; nativeId?: string; input: StartInput };
