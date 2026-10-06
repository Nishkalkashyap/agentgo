export class AgentError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'AgentError';
  }
}
export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const failureOf = (error: unknown) => ({ code: error instanceof AgentError ? error.code : 'INTERNAL_ERROR', message: messageOf(error).slice(0, 4000) });
