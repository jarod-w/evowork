/**
 * 本机网关把 hosted 模型的请求转到云端网关（D11 / 11 §13.3）。
 *
 * **不落盘、不记正文**（11 §12 第 16 条）：Q14 对这一跳一视同仁，不开例外。
 * 日志里只有 statusCode / durationMs / model / credentialSource ——
 * 想把 prompt 写进来得先改 `packages/logging` 的字段表。
 */
import type { Logger } from '@evowork/logging';

import { DEFAULT_FIRST_CHUNK_MS } from './idle.js';

export interface ForwardRequest {
  readonly upstreamBaseUrl: string;
  readonly accessJwt: string;
  readonly body: string;
  readonly signal?: AbortSignal | undefined;
  readonly logger?: Logger | undefined;
  readonly model?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  /**
   * 等云端响应**头**的上限（默认见 `idle.ts` 的 `DEFAULT_FIRST_CHUNK_MS`）。
   *
   * 这一段是转发路径上唯一不受心跳保护的时间：头还没回来，本机网关就还没开始
   * 往内核写东西，内核那侧对"等头"**没有任何超时**（它的空闲计时器要拿到头才开始）。
   * 所以云端一个不回应的连接 = 任务永远转圈。响应体之后的空档由 `pipeForward`
   * 的看门狗接手。
   */
  readonly headersTimeoutMs?: number | undefined;
}

export interface ForwardResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: ReadableStream<Uint8Array> | null;
}

export function hostedEndpoint(upstreamBaseUrl: string, path: string): string {
  const base = upstreamBaseUrl.replace(/\/+$/, '');
  const suffix = path.replace(/^\/+/, '');
  if (base.endsWith(`/${suffix}`)) return base;
  if (base.endsWith('/v1')) return `${base}/${suffix}`;
  return `${base}/v1/${suffix}`;
}

export function hostedResponsesUrl(upstreamBaseUrl: string): string {
  return hostedEndpoint(upstreamBaseUrl, 'responses');
}

export function hostedModelsUrl(upstreamBaseUrl: string): string {
  return hostedEndpoint(upstreamBaseUrl, 'evowork/models');
}

export async function forwardHosted(req: ForwardRequest): Promise<ForwardResult> {
  const started = Date.now();
  const fetchImpl = req.fetchImpl ?? fetch;
  // 只盖"等头"这一段：拿到头就停表，之后的流由 `pipeForward` 的看门狗管
  const headers = new AbortController();
  const budget = req.headersTimeoutMs ?? DEFAULT_FIRST_CHUNK_MS;
  const timer = budget > 0 ? setTimeout(() => headers.abort(), budget) : undefined;
  timer?.unref?.();
  const signal = req.signal ? AbortSignal.any([req.signal, headers.signal]) : headers.signal;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${req.accessJwt}`,
      'content-type': 'application/json',
    },
    body: req.body,
    signal,
  };
  let res: Response;
  try {
    res = await fetchImpl(hostedResponsesUrl(req.upstreamBaseUrl), init);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  req.logger?.info('gateway.forward.completed', {
    statusCode: res.status,
    durationMs: Date.now() - started,
    credentialSource: 'hosted',
    ...(req.model ? { model: req.model } : {}),
  });
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? 'text/event-stream; charset=utf-8',
    body: res.body,
  };
}
