import { execFile } from 'node:child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a binary and collect its output.
 *
 * Hard rules this enforces for the whole codebase:
 *  - `shell` is never enabled, so nothing in `args` can be interpreted as
 *    shell syntax. User-supplied paths are therefore inert here.
 *  - `binary` must be an absolute path the caller already resolved.
 *
 * On Windows this means `binary` must be a real executable: since Node 18.20 /
 * 20.12, spawning a `.cmd` or `.bat` without a shell is refused outright
 * (CVE-2024-27980). `resolveExecutable()` in detect.ts is what turns an npm
 * shim into a spawnable `.exe`.
 */
export function runBinary(
  binary: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<ExecResult> {
  const timeout = opts.timeoutMs ?? 20_000;
  return new Promise<ExecResult>((resolve) => {
    let timedOut = false;
    const child = execFile(
      binary,
      args,
      {
        timeout,
        cwd: opts.cwd,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        shell: false,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException).code === 'number'
            ? ((error as unknown as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut,
        });
      },
    );
    child.on('error', () => {
      /* resolved by the execFile callback */
    });
    // execFile's `timeout` kills the child; flag it so callers can distinguish
    // "slow/hung binary" from "binary said no".
    const timer = setTimeout(() => {
      timedOut = true;
    }, timeout);
    timer.unref?.();
    child.on('exit', () => clearTimeout(timer));
  });
}
