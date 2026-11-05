import { execFile, ExecFileOptions } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Internal runner allowing mocking in unit tests
let customExecutor: ((file: string, args: string[], options?: ExecFileOptions) => Promise<ExecResult>) | null = null;

export function setCustomExecutor(
  fn: ((file: string, args: string[], options?: ExecFileOptions) => Promise<ExecResult>) | null
): void {
  customExecutor = fn;
}

export async function runCommand(
  file: string,
  args: string[] = [],
  options: ExecFileOptions = {}
): Promise<ExecResult> {
  if (customExecutor) {
    return customExecutor(file, args, options);
  }

  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      maxBuffer: 20 * 1024 * 1024, // 20 MB buffer
      ...options,
    });
    return {
      stdout: stdout ? stdout.toString() : '',
      stderr: stderr ? stderr.toString() : '',
      exitCode: 0,
    };
  } catch (err: any) {
    return {
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : (err.message || ''),
      exitCode: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

export async function checkBinaryAvailable(binary: string): Promise<boolean> {
  // Use platform-appropriate lookup
  const isWindows = process.platform === 'win32';
  const checkCmd = isWindows ? 'where' : 'which';

  const res = await runCommand(checkCmd, [binary]);
  return res.exitCode === 0 && res.stdout.trim().length > 0;
}
