/**
 * Chat Completions 流 → Responses 事件流（D2 语义矩阵的前四行）。
 *
 * 这是整个网关最难的一段，也是 R1「工作量被低估」的主要来源。四件事同时发生：
 *
 * 1. **事件重排与编号**：Chat 的 chunk 只有 `delta`，没有 item 概念。
 *    `item_id` / `output_index` / `content_index` **全部由网关自行编号**（D2 原话）。
 * 2. **工具调用的增量重组**：Chat 把 `arguments` 分片吐出来（有时一个字符一片），
 *    而 Responses 的 `function_call` item 要求 `arguments` 是**完整的字符串**。
 *    分片还可能乱序到达不同 index —— 必须按 `index` 累加而不是按到达顺序拼接。
 * 3. **并行工具调用的降级**：上游不支持并行时，一次只会回一个 call；
 *    网关如实转成一个 `function_call` item 并标记降级（不假装并行成功）。
 * 4. **reasoning 的映射**：有思维链（`reasoning_content`）就映射成 reasoning item；
 *    **没有就留空，不得伪造**（D2 原话）。
 *
 * ## 一个必须守住的顺序约束
 *
 * 内核按事件顺序构造回合：`function_call` 的 `output_item.done` 必须在 `response.completed`
 * **之前**发出，否则那次工具调用会丢。测试里对此有专门断言。
 */
import type { DegradeReason, ModelCapabilities } from '../capabilities.js';
import { EVENT, type ResponseItem, type ResponsesEvent } from '../protocol.js';
import { normalizeUsage, type ChatUsage } from './usage.js';

/** Chat 流式 chunk（各家的并集）。 */
export interface ChatChunk {
  readonly id?: string;
  readonly choices?: readonly {
    readonly index?: number;
    readonly delta?: {
      readonly role?: string;
      readonly content?: string | null;
      /** DeepSeek reasoner / 部分实现：思维链正文 */
      readonly reasoning_content?: string | null;
      readonly tool_calls?: readonly {
        readonly index?: number;
        readonly id?: string;
        readonly type?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: ChatUsage | null;
}

export interface TranslatorOptions {
  readonly responseId: string;
  readonly capabilities: ModelCapabilities;
  /** 请求里声明的降级（来自 to-chat），会与流内发现的合并 */
  readonly initialDegradations?: readonly DegradeReason[];
}

interface ToolCallAccumulator {
  readonly outputIndex: number;
  readonly itemId: string;
  callId: string;
  name: string;
  /** 按上游给的 index 累加，不按到达顺序拼 */
  args: string;
}

/**
 * 一个流式翻译器。`push(chunk)` 返回这一片产生的 Responses 事件，`finish()` 收尾。
 *
 * 做成"喂一片、出一批"而不是 async generator，是为了让每一条映射规则都能被单独测 ——
 * D2 的语义矩阵有六行，逐行测才有意义，而 generator 形态很难只测其中一行。
 */
export function createTranslator(options: TranslatorOptions) {
  const { responseId, capabilities } = options;
  const degradations = new Set<DegradeReason>(options.initialDegradations ?? []);

  let nextOutputIndex = 0;
  let started = false;
  /** 当前的文本 item（可能没有：纯工具调用的回合就没有文本） */
  let textItem: { itemId: string; outputIndex: number; text: string } | undefined;
  let reasoningItem: { itemId: string; outputIndex: number; text: string } | undefined;
  const toolCalls = new Map<number, ToolCallAccumulator>();
  let usage: ChatUsage | undefined;
  let finishReason: string | undefined;
  let finished = false;

  function itemId(kind: string, index: number): string {
    // id 由网关编号（D2）。带 responseId 前缀是为了让日志里能把 item 关联回请求，
    // 又不必记任何正文
    return `${kind}_${responseId}_${index}`;
  }

  function ensureStarted(events: ResponsesEvent[]): void {
    if (started) return;
    started = true;
    events.push({ type: EVENT.created, response: { id: responseId } });
  }

  function ensureTextItem(events: ResponsesEvent[]): NonNullable<typeof textItem> {
    if (!textItem) {
      const outputIndex = nextOutputIndex++;
      textItem = { itemId: itemId('msg', outputIndex), outputIndex, text: '' };
      events.push({
        type: EVENT.outputItemAdded,
        output_index: outputIndex,
        item: {
          type: 'message',
          id: textItem.itemId,
          role: 'assistant',
          content: [],
        } satisfies ResponseItem,
      });
    }
    return textItem;
  }

  function ensureReasoningItem(events: ResponsesEvent[]): NonNullable<typeof reasoningItem> {
    if (!reasoningItem) {
      const outputIndex = nextOutputIndex++;
      reasoningItem = { itemId: itemId('rsn', outputIndex), outputIndex, text: '' };
      events.push({
        type: EVENT.reasoningSummaryPartAdded,
        item_id: reasoningItem.itemId,
        summary_index: 0,
      });
    }
    return reasoningItem;
  }

  return {
    degradations(): readonly DegradeReason[] {
      return [...degradations];
    },

    push(chunk: ChatChunk): ResponsesEvent[] {
      const events: ResponsesEvent[] = [];
      if (finished) return events;
      ensureStarted(events);

      if (chunk.usage) usage = chunk.usage;

      for (const choice of chunk.choices ?? []) {
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;

        // ① 思维链：有就映射，没有就什么都不发（**不伪造**）
        if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
          if (capabilities.reasoning) {
            const item = ensureReasoningItem(events);
            item.text += delta.reasoning_content;
            events.push({
              type: EVENT.reasoningSummaryTextDelta,
              item_id: item.itemId,
              summary_index: 0,
              delta: delta.reasoning_content,
            });
          } else {
            // 上游给了思维链但能力表说没有 → 能力表过期了。这种情况**按上游为准并记一笔**：
            // 少显示一个推理区比显示一个不存在的更安全，但表要修
            degradations.add('NO_REASONING');
          }
        }

        // ② 文本增量
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          const item = ensureTextItem(events);
          item.text += delta.content;
          events.push({
            type: EVENT.outputTextDelta,
            item_id: item.itemId,
            output_index: item.outputIndex,
            content_index: 0,
            delta: delta.content,
          });
        }

        // ③ 工具调用：按 index 累加，允许 name 与 arguments 分片到达
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0;
          let acc = toolCalls.get(index);
          if (!acc) {
            const outputIndex = nextOutputIndex++;
            acc = {
              outputIndex,
              itemId: itemId('fc', outputIndex),
              callId: call.id ?? `call_${responseId}_${index}`,
              name: '',
              args: '',
            };
            toolCalls.set(index, acc);
          }
          // id 可能只在第一片里给
          if (call.id) acc.callId = call.id;
          if (call.function?.name) acc.name += call.function.name;
          if (call.function?.arguments) acc.args += call.function.arguments;
        }
      }

      if (toolCalls.size > 1 && !capabilities.parallelToolCalls) {
        // 上游声明不支持并行却回了多个 call —— 能力表与实际不符。如实转发全部 call
        // （丢掉任何一个都会让 agent 拿不到结果并重试），同时记一笔让人去修表
        degradations.add('PARALLEL_TOOLS_SERIALIZED');
      }

      return events;
    },

    /**
     * 收尾。**顺序要求**：所有 `output_item.done` 必须在 `response.completed` 之前，
     * 否则内核会丢掉那些 item（尤其是工具调用，丢了 agent 就卡住）。
     */
    finish(): ResponsesEvent[] {
      const events: ResponsesEvent[] = [];
      if (finished) return events;
      ensureStarted(events);
      finished = true;

      // 思维链 item 收尾
      if (reasoningItem) {
        events.push({
          type: EVENT.reasoningSummaryTextDone,
          item_id: reasoningItem.itemId,
          summary_index: 0,
          text: reasoningItem.text,
        });
        events.push({
          type: EVENT.outputItemDone,
          output_index: reasoningItem.outputIndex,
          item: {
            type: 'reasoning',
            id: reasoningItem.itemId,
            summary: [{ type: 'summary_text', text: reasoningItem.text }],
            // **不伪造 encrypted_content**：内核只把它当不透明串回传，
            // 编一个只会让上游在下一轮拒绝整个请求
            encrypted_content: null,
          } satisfies ResponseItem,
        });
      }

      if (textItem) {
        events.push({
          type: EVENT.outputItemDone,
          output_index: textItem.outputIndex,
          item: {
            type: 'message',
            id: textItem.itemId,
            role: 'assistant',
            content: [{ type: 'output_text', text: textItem.text }],
          } satisfies ResponseItem,
        });
      }

      // 工具调用按 output_index 升序发出：内核按顺序构造回合，乱序会让 call 与 output 对不上
      for (const acc of [...toolCalls.values()].sort((a, b) => a.outputIndex - b.outputIndex)) {
        events.push({
          type: EVENT.outputItemDone,
          output_index: acc.outputIndex,
          item: {
            type: 'function_call',
            id: acc.itemId,
            name: acc.name,
            // arguments 必须是**完整**字符串。上游一个字符一片地给，我们在这里合成
            arguments: acc.args.length > 0 ? acc.args : '{}',
            call_id: acc.callId,
          } satisfies ResponseItem,
        });
      }

      const normalized = normalizeUsage(usage, {
        supportsPromptCache: capabilities.promptCache,
        supportsReasoning: capabilities.reasoning,
      });
      for (const reason of normalized.degradations) degradations.add(reason);

      if (degradations.size > 0) {
        // 诊断事件：内核会忽略它（兜底分支只记日志）。UI 侧的能力提示走 per-model 声明端点
        events.push({ type: EVENT.evoworkDegraded, reasons: [...degradations] });
      }

      events.push({
        type: EVENT.completed,
        response: {
          id: responseId,
          ...(normalized.usage ? { usage: normalized.usage } : {}),
          // `end_turn` 只在明确知道时给：Chat 的 finish_reason 里 `tool_calls` 表示还要继续
          ...(finishReason ? { end_turn: finishReason === 'stop' } : {}),
        },
      });
      return events;
    },

    /** 上游错误 → `response.failed`（内核据此区分限流 / 上下文超限 / 配额）。 */
    fail(error: {
      readonly type?: string;
      readonly code?: string;
      readonly message: string;
    }): ResponsesEvent[] {
      const events: ResponsesEvent[] = [];
      ensureStarted(events);
      finished = true;
      events.push({
        type: EVENT.failed,
        response: { id: responseId, error },
      });
      return events;
    },
  };
}

export type Translator = ReturnType<typeof createTranslator>;

/**
 * 非流式上游的适配（D2 第一行的极端情况）。
 *
 * 把一次性响应切成事件流，让内核完全无感。存在的理由不是"以后可能有不支持流式的模型"，
 * 而是**重试路径**：某些上游在流式失败后只允许非流式重试。
 */
export function chunksFromCompletion(completion: {
  readonly id?: string;
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: string | null;
      readonly reasoning_content?: string | null;
      readonly tool_calls?: readonly {
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }[];
    };
    readonly finish_reason?: string | null;
  }[];
  readonly usage?: ChatUsage | null;
}): ChatChunk[] {
  const choice = completion.choices?.[0];
  const message = choice?.message;
  const chunk: ChatChunk = {
    ...(completion.id ? { id: completion.id } : {}),
    choices: [
      {
        index: 0,
        delta: {
          ...(message?.content ? { content: message.content } : {}),
          ...(message?.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
          ...(message?.tool_calls
            ? {
                tool_calls: message.tool_calls.map((call, index) => ({
                  index,
                  ...(call.id ? { id: call.id } : {}),
                  type: 'function',
                  ...(call.function ? { function: call.function } : {}),
                })),
              }
            : {}),
        },
        ...(choice?.finish_reason ? { finish_reason: choice.finish_reason } : {}),
      },
    ],
    ...(completion.usage ? { usage: completion.usage } : {}),
  };
  return [chunk];
}
