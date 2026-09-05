/**
 * Provider 适配的接口。
 *
 * 每家国内模型 ≈ 1–1.5 人周（D2）。这个接口的形状决定了那 1–1.5 人周花在哪 ——
 * 刻意做得很窄：**只负责"怎么把 Chat 请求发出去、怎么把 SSE 行读回来"**。
 * 协议语义（事件编号、工具调用重组、用量规范化）全部在 `translate/` 里共享，
 * 不允许每家各写一遍 —— 那样第二家开始就会与第一家产生细微差异，而这种差异
 * 只在真实任务里暴露（R1 的典型形态）。
 */
import type { ChatRequest } from '../translate/to-chat.js';

export interface ProviderConfig {
  readonly baseUrl: string;
  /** 从环境变量注入，**永不落盘**（Q14；.gitignore 里也挡了 .env） */
  readonly apiKey: string;
  /** 私有部署时可覆盖（Q29：保留私有 endpoint + 自定义鉴权的配置项，成本≈0） */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface UpstreamResponse {
  readonly status: number;
  /** SSE 行流。非流式上游由适配器自己包装成单行 */
  readonly lines: AsyncIterable<string>;
  readonly headers: Readonly<Record<string, string>>;
}

export interface Provider {
  readonly id: string;
  /** 发一次 Chat Completions 请求 */
  send(
    request: ChatRequest,
    config: ProviderConfig,
    signal?: AbortSignal,
  ): Promise<UpstreamResponse>;
  /**
   * 把上游错误体映射成 Responses 的 error 形状。
   *
   * 为什么每家要自己映射：内核会按 `error.code` / `error.type` 区分**限流**、
   * **上下文超限**、**配额耗尽**三类（`sse/responses.rs:427-470`），而三家的错误码
   * 各不相同。映射错了的后果是内核不重试（或错误地重试）。
   */
  mapError(status: number, body: unknown): { type?: string; code?: string; message: string };
}

/** 判断错误是否值得重试。内核自己也有重试，网关只做"明显该重试"的那部分。 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/**
 * 内核认识的三个错误语义（`sse/responses.rs`）。映射到这三个之一才能让内核正确反应；
 * 映射不上就用通用错误，**不要瞎猜**。
 */
export const KERNEL_ERROR = {
  /** → `ApiError::Retryable`，内核会退避重试 */
  rateLimit: 'rate_limit_exceeded',
  /** → `ApiError::ContextWindowExceeded`，内核会压缩上下文后重试 */
  contextWindow: 'context_length_exceeded',
  /** → `ApiError::QuotaExceeded`，内核会停下来告诉用户 */
  quota: 'insufficient_quota',
} as const;
