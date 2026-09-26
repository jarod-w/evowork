/**
 * 内核与网关之间的线上契约（Responses API 的**内核实际使用的子集**）。
 *
 * 全部形状于 2026-09-05 对照 `89a4eec6da` 的内核源码写成：
 *   · 请求：`codex-api/src/common.rs:278`（`ResponsesApiRequest`）
 *   · 端点：`codex-api/src/endpoint/responses.rs:41` → `{base_url}/responses`
 *   · 事件：`codex-api/src/sse/responses.rs:355`（`process_responses_event`）
 *   · 条目：`protocol/src/models.rs:980`（`ResponseItem`，`#[serde(tag="type", rename_all="snake_case")]`）
 *
 * ## 三个会让整条流失败的硬约束（都来自内核的反序列化要求）
 *
 * 1. **`usage.input_tokens_details` 一旦出现，就必须带 `cached_tokens`**
 *    （`sse/responses.rs:159`，该字段**没有** `#[serde(default)]`）。
 * 2. **`usage.output_tokens_details` 一旦出现，就必须带 `reasoning_tokens`**（同上，`:166`）。
 * 3. `usage` 整体可以缺省（`Option`），但**一旦给了就必须齐**：`input_tokens` / `output_tokens` /
 *    `total_tokens` 三个都是必填。
 *
 * 违反任何一条的后果不是"用量少记了一点"，而是内核报
 * `failed to parse ResponseCompleted` → **整个回合失败**。国内模型的用量字段参差不齐，
 * 这三条正是最容易被踩的地方，所以 `usage.ts` 里对它们有专门的规范化与测试。
 *
 * ## 一条设计上的重要事实
 *
 * 内核对**未知事件**是宽容的：`process_responses_event` 的兜底分支只写日志（`:548`）。
 * 这意味着网关可以安全地发自定义事件（诊断用），但也意味着**自定义事件到不了前端** ——
 * 所以"能力缺失"这件事必须走 per-model 的能力声明端点（见 `capabilities.ts`），
 * 不能指望塞在响应流里让 UI 看到（D2「降级必须显式」的落法因此是声明式而非流式）。
 */

// ─────────────────────────── 请求 ───────────────────────────

export interface ResponsesRequest {
  readonly model: string;
  readonly instructions?: string;
  readonly input: readonly ResponseItem[];
  readonly tools?: readonly ResponsesTool[];
  readonly tool_choice?: string;
  readonly parallel_tool_calls?: boolean;
  readonly reasoning?: { readonly effort?: string; readonly summary?: string } | null;
  readonly store?: boolean;
  readonly stream?: boolean;
  readonly include?: readonly string[];
  readonly service_tier?: string;
  readonly prompt_cache_key?: string;
  readonly text?: { readonly verbosity?: string; readonly format?: unknown };
  readonly client_metadata?: Readonly<Record<string, string>>;
}

export interface ResponsesTool {
  readonly type: string;
  readonly name?: string;
  readonly description?: string;
  readonly parameters?: unknown;
  readonly strict?: boolean;
}

export type ContentItem =
  | { readonly type: 'input_text'; readonly text: string }
  | { readonly type: 'input_image'; readonly image_url: string; readonly detail?: string }
  | { readonly type: 'input_audio'; readonly audio_url: string }
  | { readonly type: 'output_text'; readonly text: string };

export type ResponseItem =
  | {
      readonly type: 'message';
      readonly id?: string;
      readonly role: string;
      readonly content: readonly ContentItem[];
    }
  | {
      readonly type: 'reasoning';
      readonly id?: string;
      readonly summary: readonly { readonly type: string; readonly text: string }[];
      readonly content?: readonly { readonly type: string; readonly text: string }[] | null;
      readonly encrypted_content?: string | null;
    }
  | {
      readonly type: 'function_call';
      readonly id?: string;
      readonly name: string;
      readonly arguments: string;
      readonly call_id: string;
    }
  | {
      readonly type: 'function_call_output';
      readonly id?: string;
      readonly call_id: string;
      readonly output: unknown;
    }
  | {
      readonly type: string;
      readonly id?: string;
      readonly [key: string]: unknown;
    };

// ─────────────────────────── 用量 ───────────────────────────

export interface ResponsesUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly total_tokens: number;
  /** 一旦出现就必须带 `cached_tokens`（硬约束 1） */
  readonly input_tokens_details?: {
    readonly cached_tokens: number;
    readonly cache_write_tokens?: number;
  };
  /** 一旦出现就必须带 `reasoning_tokens`（硬约束 2） */
  readonly output_tokens_details?: { readonly reasoning_tokens: number };
}

// ─────────────────────────── 事件 ───────────────────────────

/**
 * 内核**真正消费**的事件类型（`sse/responses.rs:359-532`）。
 * 其余事件内核只记 trace 日志，因此网关不必发，但发了也无害。
 */
export const EVENT = {
  created: 'response.created',
  outputItemAdded: 'response.output_item.added',
  outputTextDelta: 'response.output_text.delta',
  reasoningSummaryPartAdded: 'response.reasoning_summary_part.added',
  reasoningSummaryTextDelta: 'response.reasoning_summary_text.delta',
  reasoningSummaryTextDone: 'response.reasoning_summary_text.done',
  reasoningTextDelta: 'response.reasoning_text.delta',
  outputItemDone: 'response.output_item.done',
  completed: 'response.completed',
  failed: 'response.failed',
  incomplete: 'response.incomplete',
  /**
   * 心跳帧。**内容上什么都不表示，存在的意义是让内核重新计时。**
   *
   * 内核读 SSE 的那个循环是 `timeout(idle_timeout, stream.next())`
   * （`codex-api/src/sse/responses.rs:591`，2026-09-26 对 `d583e73c4d` 核对）：
   * **默认 300 秒内没有收到任何一帧**就发 `idle timeout waiting for SSE`（`:612`），
   * 整个回合以「这一回合失败了」告终 —— 上游明明还活着也一样。
   *
   * 而网关有好几段"活着但一帧都不发"的时间：上游在想（思维链被能力表挡掉时）、
   * 上游在逐字吐工具调用参数（`arguments` 要攒完整才能发 `output_item.done`，
   * 见 `translate/from-chat.ts`）、上游连接半死不活。这些时间加起来超过 300 秒，
   * 用户看到的就是一句英文的 `idle timeout waiting for SSE`。
   *
   * `response.in_progress` 在内核的**显式忽略清单**里（`responses.rs:537`），
   * 走的是 `trace!` 那条分支：不产生任何 `ResponseEvent`、到不了前端、但让
   * `stream.next()` 返回一次，于是那个 300 秒的计时器从头开始。
   * 它也是 Responses API 本身就有的事件类型 —— 比自造一个 `evowork.keepalive`
   * 更不容易在上游演进中被判成畸形帧。
   */
  inProgress: 'response.in_progress',
  /** 网关自己的诊断事件。内核会忽略它（兜底分支只记日志），**到不了前端** */
  evoworkDegraded: 'evowork.degraded',
} as const;

export type ResponsesEvent =
  | { readonly type: typeof EVENT.created; readonly response: { readonly id: string } }
  | {
      readonly type: typeof EVENT.outputItemAdded;
      readonly item: ResponseItem;
      readonly output_index: number;
    }
  | {
      readonly type: typeof EVENT.outputTextDelta;
      readonly item_id: string;
      readonly output_index: number;
      readonly content_index: number;
      readonly delta: string;
    }
  | {
      readonly type: typeof EVENT.reasoningSummaryTextDelta;
      readonly item_id: string;
      readonly summary_index: number;
      readonly delta: string;
    }
  | {
      readonly type: typeof EVENT.reasoningSummaryTextDone;
      readonly item_id: string;
      readonly summary_index: number;
      readonly text: string;
    }
  | {
      readonly type: typeof EVENT.reasoningTextDelta;
      readonly item_id: string;
      readonly content_index: number;
      readonly delta: string;
    }
  | {
      readonly type: typeof EVENT.outputItemDone;
      readonly item: ResponseItem;
      readonly output_index: number;
    }
  | {
      readonly type: typeof EVENT.completed;
      readonly response: {
        readonly id: string;
        readonly usage?: ResponsesUsage;
        readonly end_turn?: boolean;
      };
    }
  | {
      readonly type: typeof EVENT.failed;
      readonly response: {
        readonly id: string;
        readonly error: {
          readonly type?: string;
          readonly code?: string;
          readonly message: string;
        };
      };
    }
  | {
      readonly type: typeof EVENT.evoworkDegraded;
      readonly reasons: readonly string[];
    }
  | { readonly type: string; readonly [key: string]: unknown };

/** 一条 SSE 行对（`data:` + 空行）。内核用标准 SSE 解析。 */
export function toSseData(event: ResponsesEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * 心跳帧（见 `EVENT.inProgress`）。
 *
 * **不能用 SSE 注释行（`: ping`）**：注释在 SSE 规范里不派发事件，内核那边
 * `stream.next()` 根本不会返回，`timeout()` 的计时器也就不会重来 ——
 * 一个看起来在发东西、实际上什么都没解决的心跳是最坏的结果。
 *
 * `responseId` 在第一帧（`response.created`）之前还不存在，这时就不带 ——
 * 内核不看这个字段，而**编一个后面会变的 id** 比不带更糟。
 */
export function keepAliveEvent(responseId?: string): ResponsesEvent {
  return responseId === undefined
    ? { type: EVENT.inProgress }
    : { type: EVENT.inProgress, response: { id: responseId } };
}
