/**
 * D2 语义矩阵逐行测。
 *
 * 矩阵有六行（流式事件序列 / 工具调用 / reasoning / prompt cache / 多模态 / token 用量），
 * 每一行"缺一项都会在真实任务里暴露"（D2 原话）。这个文件就是那六行的可执行版本。
 */
import { describe, expect, it } from 'vitest';

import { P0_MODELS, type ModelCapabilities } from '../src/capabilities.js';
import { EVENT } from '../src/protocol.js';
import {
  chunksFromCompletion,
  createTranslator,
  type ChatChunk,
} from '../src/translate/from-chat.js';
import { toChatRequest, UnsupportedInputError } from '../src/translate/to-chat.js';
import { normalizeUsage } from '../src/translate/usage.js';

const FULL: ModelCapabilities = {
  streaming: true,
  toolCalls: true,
  parallelToolCalls: true,
  reasoning: true,
  promptCache: true,
  imageInput: true,
  maxContextTokens: 128_000,
};

const LIGHT: ModelCapabilities = {
  ...FULL,
  parallelToolCalls: false,
  reasoning: false,
  promptCache: false,
  imageInput: false,
};

function run(chunks: readonly ChatChunk[], capabilities = FULL) {
  const t = createTranslator({ responseId: 'resp_1', capabilities });
  const events = chunks.flatMap((c) => t.push(c));
  return { events: [...events, ...t.finish()], translator: t };
}

// ─────────────────────── 矩阵第 1 行：流式事件序列 ───────────────────────

describe('① 流式事件序列：item_id / output_index 由网关自行编号（D2）', () => {
  it('文本流：created → item_added → 多个 delta → item_done → completed', () => {
    const { events } = run([
      { choices: [{ delta: { content: '好的，' } }] },
      { choices: [{ delta: { content: '我先读表头。' } }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    ]);

    expect(events.map((e) => e.type)).toEqual([
      EVENT.created,
      EVENT.outputItemAdded,
      EVENT.outputTextDelta,
      EVENT.outputTextDelta,
      EVENT.outputItemDone,
      EVENT.completed,
    ]);
    // 能力齐全时不发降级事件（发了反而是噪音）
    expect(events.some((e) => e.type === EVENT.evoworkDegraded)).toBe(false);

    // 编号：同一个 item 的 delta 共享 item_id 与 output_index
    const deltas = events.filter((e) => e.type === EVENT.outputTextDelta) as {
      item_id: string;
      output_index: number;
    }[];
    expect(deltas[0]?.item_id).toBe(deltas[1]?.item_id);
    expect(deltas[0]?.output_index).toBe(0);

    // 收尾的 item 带完整文本（内核用它构造消息，delta 只用于 UI 流式）
    const done = events.find((e) => e.type === EVENT.outputItemDone) as unknown as {
      item: { content: { text: string }[] };
    };
    expect(done.item.content[0]?.text).toBe('好的，我先读表头。');
  });

  it('`response.created` 一定先发（内核靠它开始一次响应）', () => {
    const t = createTranslator({ responseId: 'resp_1', capabilities: FULL });
    const first = t.push({ choices: [{ delta: { content: 'x' } }] });
    expect(first[0]?.type).toBe(EVENT.created);
    // 只发一次
    const second = t.push({ choices: [{ delta: { content: 'y' } }] });
    expect(second.map((e) => e.type)).not.toContain(EVENT.created);
  });

  it('非流式上游可被切成事件流（重试路径要用）', () => {
    const chunks = chunksFromCompletion({
      id: 'up_1',
      choices: [{ message: { content: '一次性回复' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    });
    const { events } = run(chunks);
    const done = events.find((e) => e.type === EVENT.outputItemDone) as unknown as {
      item: { content: { text: string }[] };
    };
    expect(done.item.content[0]?.text).toBe('一次性回复');
  });

  it('流被掐断（没有 finish_reason）也会收尾 —— 已产生的内容不该丢', () => {
    const { events } = run([{ choices: [{ delta: { content: '半句话' } }] }]);
    expect(events.map((e) => e.type)).toContain(EVENT.outputItemDone);
    expect(events.at(-1)?.type).toBe(EVENT.completed);
  });
});

// ─────────────────────── 矩阵第 2 行：工具调用 ───────────────────────

describe('② 工具调用：增量 arguments 重组 + 并行降级（D2）', () => {
  it('**按 index 累加**而不是按到达顺序拼 —— 一个字符一片也要拼对', () => {
    const { events } = run([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'shell' } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"cmd' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '":"ls' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    const call = events.find(
      (e) =>
        e.type === EVENT.outputItemDone &&
        (e as { item: { type: string } }).item.type === 'function_call',
    ) as { item: { name: string; arguments: string; call_id: string } };

    expect(call.item.name).toBe('shell');
    // Responses 要求 arguments 是**完整字符串**
    expect(call.item.arguments).toBe('{"cmd":"ls"}');
    expect(call.item.call_id).toBe('call_a');
  });

  it('多个并行 call 各自成 item，且按 output_index 升序发出', () => {
    const { events } = run([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'c0', function: { name: 'read', arguments: '{"p":"a"}' } },
                { index: 1, id: 'c1', function: { name: 'read', arguments: '{"p":"b"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);

    const calls = events.filter(
      (e) =>
        e.type === EVENT.outputItemDone &&
        (e as { item: { type: string } }).item.type === 'function_call',
    ) as { output_index: number; item: { call_id: string } }[];
    expect(calls.map((c) => c.item.call_id)).toEqual(['c0', 'c1']);
    expect(calls[0]!.output_index).toBeLessThan(calls[1]!.output_index);
  });

  it('上游声明不支持并行却回了多个 call → **全部转发**并记降级（丢一个 agent 就卡住）', () => {
    const { events, translator } = run(
      [
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'c0', function: { name: 'read', arguments: '{}' } },
                  { index: 1, id: 'c1', function: { name: 'read', arguments: '{}' } },
                ],
              },
            },
          ],
        },
      ],
      LIGHT,
    );
    const calls = events.filter(
      (e) =>
        e.type === EVENT.outputItemDone &&
        (e as { item: { type: string } }).item.type === 'function_call',
    );
    expect(calls).toHaveLength(2);
    expect(translator.degradations()).toContain('PARALLEL_TOOLS_SERIALIZED');
  });

  it('**工具调用的 item_done 必须在 completed 之前** —— 否则那次调用会丢', () => {
    const { events } = run([
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'c0', function: { name: 'x', arguments: '{}' } }],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const doneIdx = events.findIndex(
      (e) =>
        e.type === EVENT.outputItemDone &&
        (e as { item: { type: string } }).item.type === 'function_call',
    );
    const completedIdx = events.findIndex((e) => e.type === EVENT.completed);
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeLessThan(completedIdx);
  });

  it('arguments 为空时补 `{}` —— 空字符串会让内核的 JSON 解析失败', () => {
    const { events } = run([
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'noargs' } }] } },
        ],
      },
    ]);
    const call = events.find(
      (e) =>
        e.type === EVENT.outputItemDone &&
        (e as { item: { type: string } }).item.type === 'function_call',
    ) as { item: { arguments: string } };
    expect(call.item.arguments).toBe('{}');
  });

  it('`finish_reason: tool_calls` 时 end_turn = false（回合还没结束）', () => {
    const { events } = run([{ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }]);
    const completed = events.find((e) => e.type === EVENT.completed) as unknown as {
      response: { end_turn?: boolean };
    };
    expect(completed.response.end_turn).toBe(false);
  });
});

// ─────────────────────── 矩阵第 3 行：reasoning ───────────────────────

describe('③ reasoning：有就映射，**没有就留空，不得伪造**（D2）', () => {
  it('有思维链 → reasoning item + summary delta', () => {
    const { events } = run([
      { choices: [{ delta: { reasoning_content: '先看表头，' } }] },
      { choices: [{ delta: { reasoning_content: '再分组。' } }] },
      { choices: [{ delta: { content: '好的' }, finish_reason: 'stop' }] },
    ]);

    const summaryDeltas = events.filter((e) => e.type === EVENT.reasoningSummaryTextDelta);
    expect(summaryDeltas).toHaveLength(2);

    const reasoningDone = events.find(
      (e) =>
        e.type === EVENT.outputItemDone &&
        (e as { item: { type: string } }).item.type === 'reasoning',
    ) as unknown as { item: { summary: { text: string }[]; encrypted_content: null } };
    expect(reasoningDone.item.summary[0]?.text).toBe('先看表头，再分组。');
    // **不伪造 encrypted_content**：编一个会让上游在下一轮拒绝整个请求
    expect(reasoningDone.item.encrypted_content).toBeNull();
  });

  it('没有思维链 → **一个 reasoning 事件都不发**（不留空壳）', () => {
    const { events } = run(
      [{ choices: [{ delta: { content: '好的' }, finish_reason: 'stop' }] }],
      LIGHT,
    );
    expect(events.some((e) => e.type.startsWith('response.reasoning'))).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === EVENT.outputItemDone &&
          (e as { item: { type: string } }).item.type === 'reasoning',
      ),
    ).toBe(false);
  });

  it('能力表说没有但上游给了 → 按上游为准不显示，并记一笔让人去修表', () => {
    const { events, translator } = run(
      [{ choices: [{ delta: { reasoning_content: '意外的思维链' }, finish_reason: 'stop' }] }],
      LIGHT,
    );
    expect(events.some((e) => e.type.startsWith('response.reasoning'))).toBe(false);
    expect(translator.degradations()).toContain('NO_REASONING');
  });
});

// ─────────────────────── 矩阵第 4 行 + 第 6 行：cache 与用量 ───────────────────────

describe('④⑥ 用量与 cache：三条会让整条流失败的硬约束', () => {
  it('给了 usage 就必须齐三个总数 + details 必须带各自的必填字段', () => {
    const { usage } = normalizeUsage(
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_cache_hit_tokens: 30 },
      { supportsPromptCache: true, supportsReasoning: true },
    );
    expect(usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      // 硬约束 1：details 一旦出现必须带 cached_tokens（内核该字段无 serde default）
      input_tokens_details: { cached_tokens: 30 },
      // 硬约束 2：同理
      output_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it('total 缺失时用 input + output 补 —— 但 input/output 缺一个就整体省略', () => {
    expect(
      normalizeUsage(
        { prompt_tokens: 10, completion_tokens: 4 },
        { supportsPromptCache: true, supportsReasoning: false },
      ).usage?.total_tokens,
    ).toBe(14);

    // 半个 usage 会让内核 `failed to parse ResponseCompleted` → 整个回合失败，
    // 比"用量少记一次"严重得多
    const partial = normalizeUsage(
      { prompt_tokens: 10 },
      { supportsPromptCache: true, supportsReasoning: false },
    );
    expect(partial.usage).toBeUndefined();
    expect(partial.degradations).toContain('NO_USAGE_REPORTED');
  });

  it('**不支持 cache 的模型如实报 0**，不猜不估（10 §5.2）', () => {
    const { usage, degradations } = normalizeUsage(
      { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_cache_hit_tokens: 80 },
      { supportsPromptCache: false, supportsReasoning: false },
    );
    // 即使上游报了 80，能力表说不支持就记 0 —— 口径失真会直接影响向用户结算的配额
    expect(usage?.input_tokens_details?.cached_tokens).toBe(0);
    expect(degradations).toContain('NO_PROMPT_CACHE');
  });

  it('上游完全不报用量 → **省略 usage 而不是编一个**', () => {
    const { usage, degradations } = normalizeUsage(undefined, {
      supportsPromptCache: true,
      supportsReasoning: true,
    });
    expect(usage).toBeUndefined();
    expect(degradations).toEqual(['NO_USAGE_REPORTED']);
  });

  it('嵌套形状（prompt_tokens_details.cached_tokens）也能读', () => {
    const { usage } = normalizeUsage(
      {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 25 },
        completion_tokens_details: { reasoning_tokens: 12 },
      },
      { supportsPromptCache: true, supportsReasoning: true },
    );
    expect(usage?.input_tokens_details?.cached_tokens).toBe(25);
    expect(usage?.output_tokens_details?.reasoning_tokens).toBe(12);
  });

  it('负数与非数字被当作缺失，不会写进用量', () => {
    const { usage } = normalizeUsage(
      { prompt_tokens: -1, completion_tokens: 5, total_tokens: 5 },
      { supportsPromptCache: true, supportsReasoning: true },
    );
    expect(usage).toBeUndefined();
  });
});

// ─────────────────────── 矩阵第 5 行：多模态 ───────────────────────

describe('⑤ 多模态：不支持时**明确报错**，不静默丢图（D2）', () => {
  const imageRequest = {
    model: 'evowork/glm-flash',
    input: [
      {
        type: 'message' as const,
        role: 'user',
        content: [
          { type: 'input_text' as const, text: '看看这张图' },
          { type: 'input_image' as const, image_url: 'data:image/png;base64,AAA' },
        ],
      },
    ],
  };

  it('不支持图片 → 抛 UnsupportedInputError，带用户能看懂的话', () => {
    let thrown: unknown;
    try {
      toChatRequest(imageRequest, 'glm-5.3-flash', LIGHT);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnsupportedInputError);
    expect((thrown as UnsupportedInputError).reason).toBe('IMAGE_INPUT_UNSUPPORTED');
    expect((thrown as UnsupportedInputError).userMessage).toContain('不支持图片输入');
    // 错误 message 里不带图片数据（Q14）
    expect((thrown as UnsupportedInputError).message).not.toContain('base64');
  });

  it('支持图片 → 转成 Chat 的 image_url 结构', () => {
    const { request } = toChatRequest(imageRequest, 'kimi-vl', FULL);
    const content = request.messages[0]?.content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as unknown as { type: string }[]).map((p) => p.type)).toEqual([
      'text',
      'image_url',
    ]);
  });
});

// ─────────────────────── Responses → Chat 的三个坑 ───────────────────────

describe('Responses → Chat：instructions / 工具结果 / 未知条目', () => {
  it('instructions 变成 system 且排在最前（丢了它 Ask 模式就失效，D8）', () => {
    const { request } = toChatRequest(
      {
        model: 'm',
        instructions: '只回答与解释，不要修改任何文件。',
        input: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '这个项目怎么组织的' }],
          },
        ],
      },
      'upstream',
      FULL,
    );
    expect(request.messages[0]).toEqual({
      role: 'system',
      content: '只回答与解释，不要修改任何文件。',
    });
  });

  it('function_call + function_call_output → assistant(tool_calls) + tool(tool_call_id)', () => {
    const { request } = toChatRequest(
      {
        model: 'm',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '列目录' }] },
          { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'call_1' },
          { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\nb.txt' },
        ],
      },
      'upstream',
      FULL,
    );

    expect(request.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(request.messages[1]?.tool_calls?.[0]?.id).toBe('call_1');
    // tool_call_id 必须对得上 —— 对不上模型会重复调用同一个工具（表现为 agent 卡在循环里）
    expect(request.messages[2]?.tool_call_id).toBe('call_1');
  });

  it('连续多个 function_call 合并到同一条 assistant 消息（Chat 的要求）', () => {
    const { request } = toChatRequest(
      {
        model: 'm',
        input: [
          { type: 'function_call', name: 'a', arguments: '{}', call_id: 'c1' },
          { type: 'function_call', name: 'b', arguments: '{}', call_id: 'c2' },
          { type: 'function_call_output', call_id: 'c1', output: 'x' },
        ],
      },
      'upstream',
      FULL,
    );
    expect(request.messages[0]?.tool_calls).toHaveLength(2);
    expect(request.messages[1]?.role).toBe('tool');
  });

  it('历史 reasoning 不回传上游（Chat 没有对应字段，塞进 content 会污染上下文）', () => {
    const { request } = toChatRequest(
      {
        model: 'm',
        input: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: '内部思考' }] },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
        ],
      },
      'upstream',
      FULL,
    );
    expect(request.messages).toHaveLength(1);
    expect(JSON.stringify(request)).not.toContain('内部思考');
  });

  it('未知条目类型被跳过而不是抛错（R2：上游会不断新增条目类型）', () => {
    const { request } = toChatRequest(
      {
        model: 'm',
        input: [
          { type: 'some_future_item', id: 'x', payload: {} },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
        ],
      },
      'upstream',
      FULL,
    );
    expect(request.messages).toHaveLength(1);
  });

  it('不支持并行时**显式传 false**，而不是不传', () => {
    const { request, degradations } = toChatRequest(
      {
        model: 'm',
        input: [],
        parallel_tool_calls: true,
        tools: [{ type: 'function', name: 'x' }],
      },
      'upstream',
      LIGHT,
    );
    expect(request.parallel_tool_calls).toBe(false);
    expect(degradations).toContain('PARALLEL_TOOLS_SERIALIZED');
  });

  it('要求流式用量（stream_options.include_usage）—— 否则流式响应里没有 usage', () => {
    const { request } = toChatRequest({ model: 'm', input: [] }, 'upstream', FULL);
    expect(request.stream).toBe(true);
    expect(request.stream_options).toEqual({ include_usage: true });
  });
});

// ─────────────────────── 能力声明的诚实性 ───────────────────────

/*
 * 下面这组的形状不是想出来的，是 2026-09-05 用 `scripts/verify-provider.mjs`
 * 对着 api.deepseek.com 实测抄回来的（只抄形状，不抄正文 —— Q14）。
 *
 * 它们的价值在于：这些地方**与 OpenAI 的形状不一样**，而不一样的地方正是
 * "照着 OpenAI 文档写的翻译层"会静默出错的地方。
 */
describe('真实上游形状（DeepSeek，2026-09-05 实测）', () => {
  it('**usage 帧同时带 choices 与 finish_reason** —— OpenAI 那里 choices 是空数组', () => {
    // 实测：65 帧的流里，最后一帧既有 usage，也有 delta.content 与 finish_reason。
    // 先取 usage 再遍历 choices（而不是"看到 usage 就 continue"）才不会丢最后一段文本
    const { events } = run([
      { choices: [{ index: 0, delta: { content: '你' } }] },
      {
        choices: [{ index: 0, delta: { content: '好' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      },
    ]);
    const text = events
      .filter((e) => e.type === EVENT.outputTextDelta)
      .map((e) => (e as { delta: string }).delta)
      .join('');
    expect(text, '最后一帧的文本不能因为它带了 usage 就被跳过').toBe('你好');

    const completed = events.at(-1) as { response?: { usage?: { input_tokens: number } } };
    expect(completed.response?.usage?.input_tokens).toBe(9);
  });

  it('**三家给了三种 cache 写法**，少认一种的表现是"这家永远 0 命中"', () => {
    const cases = [
      {
        name: 'DeepSeek',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_cache_hit_tokens: 64,
        },
      },
      {
        name: 'GLM',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_tokens_details: { cached_tokens: 64 },
        },
      },
      {
        name: 'Kimi',
        usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, cached_tokens: 64 },
      },
    ];
    for (const { name, usage } of cases) {
      const { events } = run([
        { choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }], usage },
      ]);
      const completed = events.at(-1) as {
        response?: { usage?: { input_tokens_details?: { cached_tokens: number } } };
      };
      // 0 是"不支持 cache"的合法取值，所以漏读一种写法不会有人发现
      expect(completed.response?.usage?.input_tokens_details?.cached_tokens, name).toBe(64);
    }
  });

  it('cache 口径走 prompt_cache_hit_tokens / prompt_cache_miss_tokens（不是 OpenAI 的 details）', () => {
    const { events } = run([
      {
        choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          total_tokens: 105,
          prompt_cache_hit_tokens: 64,
          prompt_cache_miss_tokens: 36,
        },
      },
    ]);
    const completed = events.at(-1) as {
      response?: { usage?: { input_tokens_details?: { cached_tokens: number } } };
    };
    expect(completed.response?.usage?.input_tokens_details?.cached_tokens).toBe(64);
  });

  it('工具调用：**首帧带 id 与 name，后续帧只带 arguments 片段**（实测如此）', () => {
    const { events } = run([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }] } },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const done = events.find(
      (e) => (e as { item?: { type?: string } }).item?.type === 'function_call',
    ) as { item: { name: string; arguments: string } } | undefined;
    expect(done?.item.name).toBe('get_weather');
    expect(done?.item.arguments).toBe('{"city":"北京"}');
  });

  it('并行工具调用按 index 分开累积（实测 index 0/1 两个函数）', () => {
    const { events } = run([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{}' } },
                { index: 1, id: 'c2', function: { name: 'get_time', arguments: '{}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const names = events
      .map((e) => (e as { item?: { type?: string; name?: string } }).item)
      .filter((item) => item?.type === 'function_call')
      .map((item) => item?.name);
    expect(names).toEqual(['get_weather', 'get_time']);
  });
});

describe('能力声明（Q16 三家）', () => {
  it('P0 名单覆盖 Q16 决策的三家，DeepSeek 有三个型号', () => {
    expect(P0_MODELS.map((m) => m.provider).sort()).toEqual([
      'deepseek',
      'deepseek',
      'deepseek',
      'moonshot',
      'zhipu',
    ]);
  });

  /**
   * 2026-09-05 拿到 DeepSeek key 后，这条从"全部必须是 false"改成了
   * "**验过的要说清验了什么，没验的一项都不许标 true**"。
   *
   * 前一版的写法有个隐患：它把"还没拿到 key"这个临时状态钉成了不变量。
   * key 到了之后，唯一能让测试变绿的改法是把断言删掉 —— 而删掉之后就没人守这件事了。
   */
  it('没验过的模型 verified 必须是 false，且 unverified 列全六项', () => {
    for (const model of P0_MODELS.filter((m) => !m.verified)) {
      expect(model.verifiedAt, `${model.id} 没验过就不该有 verifiedAt`).toBeUndefined();
      expect(
        model.unverified.length,
        `${model.id} 一项都没验就该整组列出来`,
      ).toBeGreaterThanOrEqual(7);
      expect(model.notes.length).toBeGreaterThan(0);
    }
  });

  it('**Q16 的三家全部实测过**（2026-09-05 三把 key 到位后）', () => {
    const providers = new Set(P0_MODELS.filter((m) => m.verified).map((m) => m.provider));
    expect([...providers].sort()).toEqual(['deepseek', 'moonshot', 'zhipu']);
  });

  it('验过的模型必须给日期，并如实列出仍未实测的能力键', () => {
    const verified = P0_MODELS.filter((m) => m.verified);
    expect(verified.length, '三个 DeepSeek 型号 + Kimi + GLM').toBe(5);
    for (const model of verified) {
      expect(model.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // 上下文长度要塞满才能测，探针不做 —— 所以它必须还在未验证列表里
      expect(model.unverified, `${model.id}`).toContain('maxContextTokens');
      expect(model.notes).toContain('实测');
    }
  });

  it('**deepseek-v4-flash 是推理模型** —— 名字里的 flash 骗过了第一版能力表', () => {
    const flash = P0_MODELS.find((m) => m.id === 'evowork/deepseek-v4-flash');
    // 实测 18 帧里 15 帧是 reasoning_content。标成 false 会让 from-chat 把推理段整块丢掉
    expect(flash?.capabilities.reasoning).toBe(true);
    expect(flash?.capabilities.parallelToolCalls).toBe(true);
  });

  it('deepseek-reasoner 的并行工具调用是 true（实测订正了原表的 false）', () => {
    const reasoner = P0_MODELS.find((m) => m.id === 'evowork/deepseek-reasoner');
    expect(reasoner?.capabilities.parallelToolCalls).toBe(true);
    expect(reasoner?.notes).toContain('订正');
  });

  it('GLM-5.3-flash 标为 light 档，且 notes 里写清它为什么在 P0 名单里（R4）', () => {
    const glm = P0_MODELS.find((m) => m.id === 'evowork/glm-flash');
    expect(glm?.tier).toBe('light');
    expect(glm?.notes).toContain('下限');
    // 协议语义验过了**不等于**产物质量验过了 —— U1 还开着
    expect(glm?.notes).toContain('产物质量本身仍未评估');
  });

  /**
   * 2026-09-05 三把 key 全到位后最反直觉的一条：**三家的当前主力型号全是推理模型**。
   *
   * 原表里三行写着 reasoning: false，依据是"旗舰档才推理、flash 是轻量档"这种直觉。
   * 实测下来 kimi-k3、glm-5.3-flash、deepseek-v4-flash 都吐 reasoning_content，
   * 而且占了绝大多数帧（GLM 是 65 帧里 64 帧）。
   *
   * 标错不会报错：`from-chat.ts` 会走"上游给了思维链但能力表说没有"分支，
   * **推理段整块不显示**，用户只觉得这模型不动脑子。
   */
  it('三家当前主力型号都是推理模型（实测推翻了按名字猜的那一版）', () => {
    for (const id of ['evowork/kimi-k3', 'evowork/glm-flash', 'evowork/deepseek-v4-flash']) {
      const model = P0_MODELS.find((m) => m.id === id);
      expect(model?.capabilities.reasoning, `${id} 实测吐 reasoning_content`).toBe(true);
    }
  });

  /**
   * imageInput 的三种结局正好是 D2「降级必须显式」的三个档：
   * Kimi / GLM 真能看图；deepseek-v4-flash **接受请求但看不见**（HTTP 200 + "无法识别"）。
   * 第三种最危险 —— 它不报错，所以只能靠能力表拦在前面。
   */
  it('deepseek-v4-flash 的 imageInput 是 false：它不报错，但看不见', () => {
    const flash = P0_MODELS.find((m) => m.id === 'evowork/deepseek-v4-flash');
    expect(flash?.capabilities.imageInput).toBe(false);
    expect(flash?.notes).toContain('看不见');
    expect(P0_MODELS.find((m) => m.id === 'evowork/kimi-k3')?.capabilities.imageInput).toBe(true);
    expect(P0_MODELS.find((m) => m.id === 'evowork/glm-flash')?.capabilities.imageInput).toBe(true);
  });
});
