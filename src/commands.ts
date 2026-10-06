import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentError } from './errors.js';
import { agentEnvironment } from './process.js';

const execute = promisify(execFile);

/** Never interpolates a command through a shell. */
export async function runCommand(file: string, args: string[], timeout = 30_000): Promise<string> {
  try {
    const result = await execute(file, args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...agentEnvironment(), LC_ALL: 'C', LANG: 'C' },
    });
    return result.stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (failure.code === 'ENOENT') {
      throw new AgentError('MISSING_DEPENDENCY', `${file} is not installed or is not on PATH.`);
    }
    throw new AgentError('COMMAND_FAILED', `${file} failed: ${failure.stderr?.trim() || failure.stdout?.trim() || failure.message}`);
  }
}
