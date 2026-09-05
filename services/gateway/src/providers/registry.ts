/**
 * 三家 P0 provider 的适配（Q16：DeepSeek 基准 · Kimi · GLM-5.3-flash）。
 *
 * 每家只有两件事要写：怎么发请求、怎么把错误映射到内核认识的语义。
 * 其余全部共享（`translate/`）—— 见 `types.ts` 的头注释解释为什么这样切。
 *
 * ## 错误映射为什么重要（实测的内核行为）
 *
 * 内核按 `error.code` 分流（`codex-api/src/sse/responses.rs:427-471`，2026-09-05 二次核对）：
 *
 * | `error.code` | 内核的反应 |
 * |---|---|
 * | `context_length_exceeded` | 压缩上下文后重试 |
 * | `insufficient_quota` | 停下来告诉用户（不重试） |
 * | `rate_limit_exceeded` | `RateLimitExceeded`，按 `resets_at` 退避 |
 * | `server_is_overloaded` / `slow_down` | `ServerOverloaded` |
 * | **`invalid_prompt` / `bio_policy`** | **`InvalidRequest{message}` —— 永久错误，不重试，把 message 给用户** |
 * | `misalignment_policy_violation` | 策略违规，专用文案 |
 * | 其他 | `Retryable` —— **会重试** |
 *
 * 倒数第二行是这段代码存在的理由：**映射不上的错误会被内核当成"可重试"**。
 * 于是一个"模型不存在"的永久性错误会被重试到上限，用户看到的是任务卡了很久然后失败。
 *
 * （`invalid_prompt` 这一行是 2026-09-05 补上的：上一版注释里没有它，
 * 于是"映射到 invalid_prompt"看起来像是聊胜于无的兜底，实际上它是**唯一**
 * 能让内核把错误当成永久错误并把消息透给用户的通道。`responses.rs:454`。）
 */
import {
  KERNEL_ERROR,
  isRetryableStatus,
  type Provider,
  type ProviderConfig,
  type UpstreamResponse,
} from './types.js';
import type { ChatRequest } from '../translate/to-chat.js';

/** 从上游错误体里挖出 message / code，容忍三家各自的嵌套形状。 */
function extractError(body: unknown): { message: string; code?: string; type?: string } {
  if (typeof body === 'string') return { message: body.slice(0, 500) };
  if (typeof body !== 'object' || body === null) return { message: '上游返回了无法解析的错误' };
  const record = body as Record<string, unknown>;
  const err = (record.error ?? record) as Record<string, unknown>;
  const message =
    typeof err.message === 'string'
      ? err.message
      : typeof record.message === 'string'
        ? record.message
        : '上游返回了错误但没有 message';
  const type = typeof err.type === 'string' ? err.type : undefined;
  /*
   * `code` 缺失时退回 `type`。
   *
   * 2026-09-05 实测 Kimi：未知模型返回 `{error:{message, type:"resource_not_found_error"}}`,
   * **没有 code 字段** —— 语义整个装在 `type` 里。原来的实现只看 code，
   * 于是这个永久错误一路落到"映射不上"，被内核当成可重试。
   * DeepSeek 与 GLM 都给 code，所以只看 code 在那两家上不会暴露。
   */
  const code = typeof err.code === 'string' ? err.code : type;
  return { message, ...(code ? { code } : {}), ...(type ? { type } : {}) };
}

/**
 * 共享的错误映射。三家的具体 code 各异，但**状态码语义是一致的**，
 * 所以先按 code 精确匹配，再按状态码兜底 —— 兜底比"落到内核的 Retryable"好得多。
 */
function mapCommonError(
  status: number,
  body: unknown,
  vendorCodes: Readonly<Record<string, string>>,
): { type?: string; code?: string; message: string } {
  const { message, code, type } = extractError(body);

  const mapped = code ? vendorCodes[code] : undefined;
  if (mapped) return { code: mapped, message, ...(type ? { type } : {}) };

  // 按 code 里的关键字兜底：三家的 code 命名不同但词根往往一致
  if (code) {
    const lower = code.toLowerCase();
    if (lower.includes('context') || lower.includes('too_long') || lower.includes('length')) {
      return { code: KERNEL_ERROR.contextWindow, message };
    }
    if (lower.includes('quota') || lower.includes('balance') || lower.includes('insufficient')) {
      return { code: KERNEL_ERROR.quota, message };
    }
    if (lower.includes('rate') || lower.includes('too_many') || lower.includes('frequency')) {
      return { code: KERNEL_ERROR.rateLimit, message };
    }
  }

  if (status === 429) return { code: KERNEL_ERROR.rateLimit, message };
  if (status === 402) return { code: KERNEL_ERROR.quota, message };
  if (PERMANENT_STATUSES.has(status)) {
    // 永久性错误：**必须显式映射**，否则内核会一路重试到上限（见头注释）。
    // 401/403 落到 invalid_prompt 语义上不完全贴切，但它是唯一能让内核
    // ①不重试 ②把 message 原样给用户 的通道 —— 而"密钥无效"这条消息用户必须看到
    return { code: 'invalid_prompt', message };
  }
  if (isRetryableStatus(status)) return { code: 'server_is_overloaded', message };
  return { message, ...(code ? { code } : {}), ...(type ? { type } : {}) };
}

/** 用 fetch 发请求并把响应体切成行（SSE 与非 SSE 都走这条）。 */
async function postChat(
  url: string,
  request: ChatRequest,
  config: ProviderConfig,
  signal?: AbortSignal,
): Promise<UpstreamResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 300_000);
  const composite = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
        accept: request.stream ? 'text/event-stream' : 'application/json',
        ...config.extraHeaders,
      },
      body: JSON.stringify(request),
      signal: composite,
    });
  } finally {
    clearTimeout(timeout);
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    // 只留少数诊断头。**不透传上游的其他头** —— 有些上游会在头里回显请求信息
    if (['retry-after', 'x-request-id', 'content-type'].includes(key.toLowerCase())) {
      headers[key.toLowerCase()] = value;
    }
  });

  return { status: response.status, headers, lines: iterateLines(response) };
}

/** 把 Response body 切成行。SSE 的 `data:` 前缀由调用方处理。 */
async function* iterateLines(response: Response): AsyncIterable<string> {
  const body = response.body;
  if (!body) return;
  const decoder = new TextDecoder();
  let buffer = '';
  // Node 的 ReadableStream 实现了 async iterator（web 标准里还没有），
  // 所以这里显式转型而不是依赖 DOM 类型
  const stream = body as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      yield buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) yield buffer;
}

const DEEPSEEK_CODES: Readonly<Record<string, string>> = {
  // DeepSeek 的余额不足是 402 + 无 code，主要靠状态码兜底；这里放已知的几个
  invalid_request_error: 'invalid_prompt',
  rate_limit_reached: KERNEL_ERROR.rateLimit,
};

/**
 * 重试没有意义的状态码。
 *
 * 400/422 一开始就在这里；401/403/404 是 2026-09-05 实测 Kimi 时补的 ——
 * 未知模型返回 **404**，而 404 原先落到最后那个"原样返回"的分支，
 * 也就是被内核当成可重试：一个永远不会成功的请求会被重试到上限。
 */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422]);

const MOONSHOT_CODES: Readonly<Record<string, string>> = {
  // 实测：未知模型 404 + type=resource_not_found_error（无 code 字段）
  resource_not_found_error: 'invalid_prompt',
  exceeded_current_quota_error: KERNEL_ERROR.quota,
  rate_limit_reached_error: KERNEL_ERROR.rateLimit,
  invalid_request_error: 'invalid_prompt',
  // Kimi 对超长上下文的报法：内容长度超限
  content_too_long: KERNEL_ERROR.contextWindow,
};

const ZHIPU_CODES: Readonly<Record<string, string>> = {
  '1113': KERNEL_ERROR.quota,
  '1301': 'invalid_prompt',
  '1302': KERNEL_ERROR.rateLimit,
  '1303': KERNEL_ERROR.rateLimit,
  '1305': KERNEL_ERROR.rateLimit,
};

export const DEEPSEEK: Provider = {
  id: 'deepseek',
  send: (request, config, signal) =>
    postChat(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, request, config, signal),
  mapError: (status, body) => mapCommonError(status, body, DEEPSEEK_CODES),
};

export const MOONSHOT: Provider = {
  id: 'moonshot',
  send: (request, config, signal) =>
    postChat(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, request, config, signal),
  mapError: (status, body) => mapCommonError(status, body, MOONSHOT_CODES),
};

export const ZHIPU: Provider = {
  id: 'zhipu',
  send: (request, config, signal) =>
    postChat(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, request, config, signal),
  mapError: (status, body) => mapCommonError(status, body, ZHIPU_CODES),
};

/**
 * 私有 endpoint（Q29：按"无自建推理服务"处理，但**保留配置项**，成本≈0）。
 * 它与三家的唯一区别是鉴权头可自定义。
 */
export const PRIVATE: Provider = {
  id: 'private',
  send: (request, config, signal) =>
    postChat(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, request, config, signal),
  mapError: (status, body) => mapCommonError(status, body, {}),
};

export const PROVIDERS: Readonly<Record<string, Provider>> = Object.freeze({
  deepseek: DEEPSEEK,
  moonshot: MOONSHOT,
  zhipu: ZHIPU,
  private: PRIVATE,
});

/** 默认 base url。可被环境变量覆盖（企业私有部署，Q14）。 */
export const DEFAULT_BASE_URL: Readonly<Record<string, string>> = Object.freeze({
  deepseek: 'https://api.deepseek.com/v1',
  moonshot: 'https://api.moonshot.cn/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  private: '',
});

export { extractError, mapCommonError };
