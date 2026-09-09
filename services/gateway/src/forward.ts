/**
 * 本机网关把 hosted 模型的请求转到云端网关（D11 / 11 §13.3）。
 *
 * **不落盘、不记正文**（11 §12 第 16 条）：Q14 对这一跳一视同仁，不开例外。
 * 日志里只有 statusCode / durationMs / model / credentialSource ——
 * 想把 prompt 写进来得先改 `packages/logging` 的字段表。
 */
import type { Logger } from '@evowork/logging';

export interface ForwardRequest {
  readonly upstreamBaseUrl: string;
  readonly accessJwt: string;
  readonly body: string;
  readonly signal?: AbortSignal | undefined;
  readonly logger?: Logger | undefined;
  readonly model?: string | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
}

export interface ForwardResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: ReadableStream<Uint8Array> | null;
}

export function hostedResponsesUrl(upstreamBaseUrl: string): string {
  const base = upstreamBaseUrl.replace(/\/+$/, '');
  if (base.endsWith('/v1')) return `${base}/responses`;
  if (base.endsWith('/responses')) return base;
  return `${base}/v1/responses`;
}

export async function forwardHosted(req: ForwardRequest): Promise<ForwardResult> {
  const started = Date.now();
  const fetchImpl = req.fetchImpl ?? fetch;
  const res = await fetchImpl(hostedResponsesUrl(req.upstreamBaseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${req.accessJwt}`,
      'content-type': 'application/json',
    },
    body: req.body,
    signal: req.signal,
  });
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
