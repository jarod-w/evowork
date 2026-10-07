import type { IncomingMessage, ServerResponse } from 'node:http';

export const IMAGE_MODELS = [
  { id: 'doubao-seedream-5-0-flash-260915', name: 'Seedream 5.0 Flash' },
  { id: 'doubao-seedream-5-0-pro-260628', name: 'Seedream 5.0 Pro' },
] as const;
export const IMAGE_API_BASE = 'https://ark.cn-beijing.volces.com/api/v3/';
export const IMAGE_MAX_BYTES = 32 * 1024 * 1024;
const MAX_JSON = Math.ceil((IMAGE_MAX_BYTES * 4) / 3) + 1024 * 1024;

export interface ImageProviderConfig {
  baseUrl: string;
  apiKey: string;
  denied?: boolean;
  disabledModelIds?: readonly string[];
  fetchImpl?: typeof fetch;
}
export interface ImageRequest {
  model: string;
  prompt: string;
  image?: string;
}
export interface ImageResponse {
  b64: string;
  model: string;
  generatedImages: number;
  requestId?: string;
}
export class ImageApiError extends Error {
  constructor(
    readonly code: string,
    readonly outcomeUnknown = false,
  ) {
    super(code);
    this.name = 'ImageApiError';
  }
}
export function imageModelId(value: string): string {
  const aliases: Record<string, string> = {
    'Doubao-Seedream-5.0-flash': IMAGE_MODELS[0].id,
    'Doubao-Seedream-5.0-pro': IMAGE_MODELS[1].id,
  };
  const id = aliases[value] ?? value;
  if (!IMAGE_MODELS.some((m) => m.id === id)) throw new ImageApiError('IMAGE_MODEL_UNSUPPORTED');
  return id;
}
export function imageBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
  )
    throw new ImageApiError('IMAGE_ENDPOINT_INVALID');
  return url.href.replace(/\/+$/, '') + '/';
}
export async function boundedImageJson(response: Response): Promise<unknown> {
  if (!response.body) throw new ImageApiError('IMAGE_EMPTY_RESPONSE', true);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_JSON) throw new ImageApiError('IMAGE_RESPONSE_TOO_LARGE', true);
      parts.push(next.value);
    }
    return JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
export function validateImageRequest(raw: unknown): ImageRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ImageApiError('IMAGE_REQUEST_INVALID');
  const o = raw as Record<string, unknown>;
  if (
    Object.keys(o).some((k) => !['model', 'prompt', 'image'].includes(k)) ||
    typeof o.model !== 'string' ||
    typeof o.prompt !== 'string' ||
    !o.prompt.trim() ||
    o.prompt.length > 8000 ||
    (o.image !== undefined &&
      (typeof o.image !== 'string' ||
        o.image.length > 14 * 1024 * 1024 ||
        !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(o.image)))
  )
    throw new ImageApiError('IMAGE_REQUEST_INVALID');
  return {
    model: imageModelId(o.model),
    prompt: o.prompt,
    ...(typeof o.image === 'string' ? { image: o.image } : {}),
  };
}
/** A paid POST is never replayed, redirected, or silently sent to another model. */
export async function generateImage(
  config: ImageProviderConfig,
  raw: unknown,
  signal: AbortSignal,
): Promise<ImageResponse> {
  if (config.denied) throw new ImageApiError('IMAGE_POLICY_DENIED');
  if (!config.apiKey) throw new ImageApiError('IMAGE_NOT_CONFIGURED');
  const input = validateImageRequest(raw);
  if (config.disabledModelIds?.includes(input.model))
    throw new ImageApiError('IMAGE_POLICY_DENIED');
  const url = new URL('images/generations', imageBaseUrl(config.baseUrl));
  let response: Response;
  try {
    response = await (config.fetchImpl ?? fetch)(url, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        ...input,
        size: '2K',
        output_format: 'png',
        response_format: 'b64_json',
        stream: false,
        watermark: true,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
    });
  } catch {
    throw new ImageApiError('IMAGE_OUTCOME_UNKNOWN', true);
  }
  if (!response.ok) {
    await response.body?.cancel();
    const codes: Record<number, string> = {
      400: 'IMAGE_PARAMETER_REJECTED',
      401: 'IMAGE_AUTH_FAILED',
      403: 'IMAGE_ACCESS_DENIED',
      404: 'IMAGE_MODEL_UNAVAILABLE',
      422: 'IMAGE_CONTENT_REJECTED',
      429: 'IMAGE_RATE_LIMITED',
    };
    throw new ImageApiError(
      codes[response.status] ?? 'IMAGE_UPSTREAM_FAILED',
      response.status >= 500,
    );
  }
  let data: unknown;
  try {
    data = await boundedImageJson(response);
  } catch (e) {
    if (e instanceof ImageApiError) throw e;
    throw new ImageApiError('IMAGE_INVALID_RESPONSE', true);
  }
  const result = data as { data?: { b64_json?: unknown }[]; usage?: { generated_images?: number } };
  const b64 = result?.data?.length === 1 ? result.data[0]?.b64_json : undefined;
  if (
    typeof b64 !== 'string' ||
    !b64 ||
    b64.length > MAX_JSON ||
    b64.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)
  )
    throw new ImageApiError('IMAGE_INVALID_RESPONSE', true);
  const bytes = Buffer.from(b64, 'base64');
  if (!bytes.length || bytes.length > IMAGE_MAX_BYTES || bytes.toString('base64') !== b64)
    throw new ImageApiError('IMAGE_INVALID_RESPONSE', true);
  const requestId = response.headers.get('x-request-id');
  return {
    b64,
    model: input.model,
    generatedImages: result.usage?.generated_images ?? 1,
    ...(requestId && /^[A-Za-z0-9_-]{1,200}$/.test(requestId) ? { requestId } : {}),
  };
}
export async function handleImageHttp(
  req: IncomingMessage,
  res: ServerResponse,
  config?: ImageProviderConfig,
): Promise<void> {
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!config?.apiKey || config.denied) {
    json(403, {
      error: {
        code: config?.denied ? 'IMAGE_POLICY_DENIED' : 'IMAGE_NOT_CONFIGURED',
        outcomeUnknown: false,
      },
    });
    return;
  }
  if (req.method === 'GET') {
    try {
      const response = await (config.fetchImpl ?? fetch)(
        new URL('models', imageBaseUrl(config.baseUrl)),
        {
          headers: { authorization: 'Bearer ' + config.apiKey },
          redirect: 'error',
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        throw new ImageApiError(
          response.status === 401
            ? 'IMAGE_AUTH_FAILED'
            : response.status === 403
              ? 'IMAGE_ACCESS_DENIED'
              : 'IMAGE_DIRECTORY_UNAVAILABLE',
        );
      }
      const directory = (await boundedImageJson(response)) as { data?: { id?: unknown }[] };
      if (!Array.isArray(directory?.data)) throw new ImageApiError('IMAGE_DIRECTORY_INVALID');
      const ids = new Set(directory.data.map((m) => m.id));
      json(200, {
        models: IMAGE_MODELS.map((m) => ({
          ...m,
          available: ids.has(m.id) && !config.disabledModelIds?.includes(m.id),
          generate: true,
          edit: true,
          evidence: 'directory',
          transparent: false,
          maxInputImages: 1,
          maxOutputImages: 1,
          credentialSource: 'byok',
        })),
      });
    } catch (e) {
      json(400, {
        error: {
          code: e instanceof ImageApiError ? e.code : 'IMAGE_DIRECTORY_UNAVAILABLE',
          outcomeUnknown: false,
        },
      });
    }
    return;
  }
  let size = 0;
  const parts: Buffer[] = [];
  const controller = new AbortController();
  req.on('aborted', () => controller.abort());
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    for await (const part of req) {
      const bytes = part as Buffer;
      size += bytes.length;
      if (size > 15 * 1024 * 1024) throw new ImageApiError('IMAGE_REQUEST_TOO_LARGE');
      parts.push(bytes);
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch {
      throw new ImageApiError('IMAGE_REQUEST_INVALID');
    }
    json(200, await generateImage(config, body, controller.signal));
  } catch (e) {
    const error = e instanceof ImageApiError ? e : new ImageApiError('IMAGE_OUTCOME_UNKNOWN', true);
    if (!res.destroyed)
      json(error.outcomeUnknown ? 502 : 400, {
        error: { code: error.code, outcomeUnknown: error.outcomeUnknown },
      });
  }
}
