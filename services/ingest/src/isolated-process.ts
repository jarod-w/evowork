/** Local parsers never inherit account/model credentials. macOS enforcement is fail closed. */
import { spawn, execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class ParserProcessError extends Error {
  constructor(
    readonly code:
      | 'SANDBOX_UNAVAILABLE'
      | 'CANCELLED'
      | 'TIMEOUT'
      | 'OUTPUT_LIMIT'
      | 'MEMORY_LIMIT'
      | 'PROCESS_FAILED',
  ) {
    super(code);
  }
}

export interface IsolatedProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly readPaths: readonly string[];
  readonly writeDirectory: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly onStdout?: ((chunk: string) => void) | undefined;
  readonly maxResidentBytes?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export function parserEnvironment(workDirectory: string): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: workDirectory,
    TMPDIR: workDirectory,
    LANG: 'en_US.UTF-8',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    OMP_THREAD_LIMIT: '1',
  };
}

export function parserSandboxProfile(readPaths: readonly string[], writeDirectory: string): string {
  const quoted = (path: string): string => JSON.stringify(realpathSync(resolve(path)));
  const roots = readPaths.map((path) => `(subpath ${quoted(path)})`).join(' ');
  return `(version 1)
(deny default)
(allow process-fork)
(allow process-exec)
(allow sysctl-read)
(allow mach-lookup)
(allow file-read-metadata)
; Apple dyld-support.sb: libignition opens / as an openat root. literal is not subpath.
(allow file-read-data (literal "/"))
(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/Library/Apple") (subpath "/Library/Fonts") (literal "/dev/null") ${roots} (subpath ${quoted(writeDirectory)}))
(allow file-write* (literal "/dev/null") (subpath ${quoted(writeDirectory)}))
(deny network*)`;
}

export async function runIsolatedProcess(options: IsolatedProcessOptions): Promise<string> {
  if (process.platform !== 'darwin') throw new ParserProcessError('SANDBOX_UNAVAILABLE');
  if (options.signal?.aborted) throw new ParserProcessError('CANCELLED');
  const outputLimit = options.maxOutputBytes ?? 64 * 1024;
  const profile = parserSandboxProfile(
    [dirname(realpathSync(options.executable)), ...options.readPaths],
    options.writeDirectory,
  );
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      '/usr/bin/sandbox-exec',
      ['-p', profile, options.executable, ...options.args],
      {
        cwd: options.writeDirectory,
        env: parserEnvironment(options.writeDirectory),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let reason: ParserProcessError['code'] | undefined;
    let bytes = 0;
    const stdout: Buffer[] = [];
    const stop = (code: ParserProcessError['code']): void => {
      reason ??= code;
      if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    let closed = false,
      checkingMemory = false;
    // macOS RLIMIT_AS/RSS do not reliably cap ImageIO/PDFium allocations. Supervise the whole
    // owned process group from the host and terminate it when sampled resident memory exceeds 512 MiB.
    const memoryTimer = setInterval(() => {
      if (closed || checkingMemory || !child.pid) return;
      checkingMemory = true;
      execFile(
        '/bin/ps',
        ['-axo', 'pid=,pgid=,rss='],
        { timeout: 1000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin' } },
        (error, output) => {
          checkingMemory = false;
          if (closed) return;
          if (error) {
            stop('PROCESS_FAILED');
            return;
          }
          let bytes = 0;
          for (const row of output.trim().split('\n')) {
            const values = row.trim().split(/\s+/u).map(Number);
            if (values[1] === child.pid) bytes += (values[2] ?? 0) * 1024;
          }
          if (bytes > (options.maxResidentBytes ?? 512 * 1024 * 1024)) stop('MEMORY_LIMIT');
        },
      );
    }, 250);
    const timer = setTimeout(() => stop('TIMEOUT'), options.timeoutMs);
    const abort = (): void => stop('CANCELLED');
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > outputLimit) stop('OUTPUT_LIMIT');
      else {
        stdout.push(data);
        options.onStdout?.(data.toString('utf8'));
      }
    });
    child.stderr.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes > outputLimit) stop('OUTPUT_LIMIT');
    });
    const cleanup = (): void => {
      closed = true;
      clearInterval(memoryTimer);
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    };
    child.on('error', () => {
      cleanup();
      reject(new ParserProcessError(reason ?? 'PROCESS_FAILED'));
    });
    child.on('close', (code) => {
      cleanup();
      if (reason || code !== 0) reject(new ParserProcessError(reason ?? 'PROCESS_FAILED'));
      else resolveResult(Buffer.concat(stdout).toString('utf8'));
    });
  });
}
