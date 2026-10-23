/** 完整 JSON 与错误体的有界读取。SSE 增量流仍由 pipeline 的片间看门狗管理。 */
import { raceIdle, STALLED } from './idle.js';

export const ERROR_BODY_MAX_BYTES = 64 * 1024;
export const COMPLETION_BODY_MAX_BYTES = 8 * 1024 * 1024;

export class UpstreamBodyError extends Error {
  override readonly name = 'UpstreamBodyError';
  constructor(readonly reason: 'timeout' | 'too-large' | 'aborted') {
    super(`upstream-body-${reason}`);
  }
}

export async function readUpstreamBody(
  source: AsyncIterable<string>,
  options: {
    readonly maxBytes: number;
    readonly totalMs: number;
    readonly idleMs: number;
    readonly signal: AbortSignal;
  },
): Promise<string> {
  const iterator = source[Symbol.asyncIterator]();
  const deadline = options.totalMs > 0 ? Date.now() + options.totalMs : Infinity;
  const parts: string[] = [];
  let bytes = 0;
  let sawLine = false;
  try {
    for (;;) {
      if (options.signal.aborted) throw new UpstreamBodyError('aborted');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new UpstreamBodyError('timeout');
      const idle = sawLine && options.idleMs > 0 ? options.idleMs : Infinity;
      const budget = Math.min(remaining, idle);
      const step = await raceIdle(
        nextWithAbort(iterator, options.signal),
        Number.isFinite(budget) ? budget : 0,
      );
      if (step === STALLED) throw new UpstreamBodyError('timeout');
      if (step.done) return parts.join('\n');
      // Include the separator in the bound; even infinitely many empty lines consume it.
      bytes += Buffer.byteLength(step.value, 'utf8') + (sawLine ? 1 : 0);
      if (bytes > options.maxBytes) throw new UpstreamBodyError('too-large');
      parts.push(step.value);
      sawLine = true;
    }
  } finally {
    // Do not await a generator stuck inside next(); caller aborts the actual upstream socket.
    void iterator.return?.().catch(() => undefined);
  }
}

/** 每次读取独立订阅；不能在一个永不 settle 的取消 Promise 上逐行累积 race 监听。 */
async function nextWithAbort(iterator: AsyncIterator<string>, signal: AbortSignal) {
  let onAbort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new UpstreamBodyError('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    if (signal.aborted) throw new UpstreamBodyError('aborted');
    return await Promise.race([iterator.next(), cancelled]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
