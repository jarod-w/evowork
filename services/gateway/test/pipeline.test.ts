/**
 * 整条链路（脱离 HTTP 层）+ **Q14 的不落盘断言**。
 *
 * 后者是 M0 必须拿到的三个结论之一（总纲 §10.2 第 2 条：网关不落盘承诺的可审计手段）。
 * 它是三个结论里**唯一不依赖真实 API key 的**，所以在这里就能拿到 ——
 * 见 work-priority §10 的 U 表。
 */
import { assertNoLeak, createLogger, memorySink } from '@evowork/logging';
import { describe, expect, it } from 'vitest';

import { createModelRegistry, type ModelRegistryEntry } from '../src/capabilities.js';
import { ModelNotConfiguredError, runPipeline } from '../src/pipeline.js';
import { EVENT, type ResponsesRequest } from '../src/protocol.js';
import { KERNEL_ERROR, type Provider } from '../src/providers/types.js';

/** 一个可脚本化的上游：给它 SSE 行，它就照着回。 */
function fakeProvider(script: {
  readonly status?: number;
  readonly lines?: readonly string[];
  readonly throwOnSend?: boolean;
  readonly onRequest?: (body: unknown) => void;
}): Provider {
  return {
    id: 'fake',
    async send(request) {
      script.onRequest?.(request);
      if (script.throwOnSend) throw new Error('ECONNREFUSED');
      return {
        status: script.status ?? 200,
        headers: {},
        lines: (async function* () {
          for (const line of script.lines ?? []) yield line;
        })(),
      };
    },
    mapError: (status, body) => {
      const message =
        typeof body === 'object' && body !== null
          ? String((body as { error?: { message?: string } }).error?.message ?? 'upstream error')
          : String(body);
      if (status === 429) return { code: KERNEL_ERROR.rateLimit, message };
      if (status === 402) return { code: KERNEL_ERROR.quota, message };
      return { code: 'invalid_prompt', message };
    },
  };
}

const MODEL: ModelRegistryEntry = {
  id: 'evowork/test-model',
  provider: 'deepseek',
  upstreamModel: 'test-upstream',
  displayName: 'Test',
  tier: 'standard',
  verified: false,
  unverified: [],
  notes: 'test',
  capabilities: {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: true,
    reasoning: true,
    promptCache: true,
    imageInput: false,
    maxContextTokens: 8_000,
  },
};

const TASK = {
  prompt: '把 data/ 下的三张表合并，按季度对比毛利率，重点讲鹏程公司的欠款风险',
  instructions: '你可以动手：读写工作空间内的文件、执行命令。产物优先用 pptx。',
  reply: '好的，我先读取三张表的表头，然后按季度分组计算毛利率。',
  toolArgs: '{"cmd":"python3 merge.py 鹏程公司-2026Q2.xlsx"}',
};

function request(over: Partial<ResponsesRequest> = {}): ResponsesRequest {
  return {
    model: MODEL.id,
    instructions: TASK.instructions,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: TASK.prompt }] },
    ],
    stream: true,
    ...over,
  };
}

async function collect(gen: AsyncGenerator<{ type: string; [k: string]: unknown }>) {
  const events = [];
  for await (const event of gen) events.push(event);
  return events;
}

function deps(provider: Provider, models = createModelRegistry([MODEL])) {
  return {
    models,
    providers: { deepseek: provider },
    configFor: () => ({ baseUrl: 'https://upstream.invalid/v1', apiKey: 'sk-test' }),
    newResponseId: () => 'resp_test',
  };
}

describe('完整链路', () => {
  it('文本回复：请求被翻译成 Chat，响应被翻译成 Responses 事件', async () => {
    let sent: unknown;
    const provider = fakeProvider({
      onRequest: (body) => {
        sent = body;
      },
      lines: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: '好的，' } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: '我先读表头。' }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_cache_hit_tokens: 40 } })}`,
        'data: [DONE]',
      ],
    });

    const events = await collect(runPipeline(request(), { requestId: 'req_1' }, deps(provider)));

    // 上游收到的是 Chat 形状，且 instructions 变成了 system
    expect((sent as { model: string }).model).toBe('test-upstream');
    expect((sent as { messages: { role: string }[] }).messages[0]?.role).toBe('system');

    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EVENT.created);
    expect(types).toContain(EVENT.outputTextDelta);
    expect(types.at(-1)).toBe(EVENT.completed);

    const completed = events.at(-1) as unknown as {
      response: {
        usage?: { input_tokens: number; input_tokens_details: { cached_tokens: number } };
      };
    };
    expect(completed.response.usage?.input_tokens).toBe(120);
    expect(completed.response.usage?.input_tokens_details.cached_tokens).toBe(40);
  });

  it('上游 HTTP 错误 → response.failed，且错误码被映射到内核认识的语义', async () => {
    const provider = fakeProvider({
      status: 429,
      lines: [JSON.stringify({ error: { message: 'too many requests' } })],
    });
    const events = await collect(runPipeline(request(), { requestId: 'req_1' }, deps(provider)));
    const failed = events.find((e) => e.type === EVENT.failed) as unknown as {
      response: { error: { code: string } };
    };
    expect(failed.response.error.code).toBe(KERNEL_ERROR.rateLimit);
  });

  it('上游在流里内联报错（有些实现不用状态码）也能识别', async () => {
    const provider = fakeProvider({
      lines: [
        `data: ${JSON.stringify({ error: { message: 'ctx too long', code: 'context_length_exceeded' } })}`,
      ],
    });
    const events = await collect(runPipeline(request(), { requestId: 'req_1' }, deps(provider)));
    expect(events.some((e) => e.type === EVENT.failed)).toBe(true);
  });

  it('上游不可达 → 显式失败并给用户能看懂的话（不静默换模型）', async () => {
    const provider = fakeProvider({ throwOnSend: true });
    const events = await collect(runPipeline(request(), { requestId: 'req_1' }, deps(provider)));
    const failed = events.find((e) => e.type === EVENT.failed) as unknown as {
      response: { error: { message: string; code: string } };
    };
    expect(failed.response.error.code).toBe('server_is_overloaded');
    expect(failed.response.error.message).toContain('稍后重试');
  });

  it('未配置的模型 → 抛错，**不回落到别的模型**（03 §8）', async () => {
    const provider = fakeProvider({});
    await expect(
      collect(
        runPipeline(request({ model: 'evowork/不存在' }), { requestId: 'req_1' }, deps(provider)),
      ),
    ).rejects.toBeInstanceOf(ModelNotConfiguredError);
  });

  it('坏帧被跳过，不让整个回合失败', async () => {
    const provider = fakeProvider({
      lines: [
        'data: {这不是合法 JSON',
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
      ],
    });
    const events = await collect(runPipeline(request(), { requestId: 'req_1' }, deps(provider)));
    expect(events.at(-1)?.type).toBe(EVENT.completed);
  });

  it('带图片但模型不支持 → 显式失败（不静默丢图）', async () => {
    const provider = fakeProvider({});
    const events = await collect(
      runPipeline(
        request({
          input: [
            {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: '看看这张图' },
                { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
              ],
            },
          ],
        }),
        { requestId: 'req_1' },
        deps(provider),
      ),
    );
    const failed = events.find((e) => e.type === EVENT.failed) as unknown as {
      response: { error: { message: string } };
    };
    expect(failed.response.error.message).toContain('不支持图片输入');
  });

  it('下一轮请求把上一轮思维链挂回 Chat assistant（thinking 模式强制回传）', async () => {
    let sent: unknown;
    const provider = fakeProvider({
      onRequest: (body) => {
        sent = body;
      },
      lines: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: '好的' }, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
      ],
    });

    await collect(
      runPipeline(
        request({
          input: [
            {
              type: 'message',
              role: 'user',
              content: [{ type: 'input_text', text: '你能做什么' }],
            },
            {
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: '先说明能力再问下一步' }],
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '我能写代码' }],
            },
            { type: 'message', role: 'user', content: [{ type: 'input_text', text: TASK.prompt }] },
          ],
        }),
        { requestId: 'req_1' },
        deps(provider),
      ),
    );

    const messages = (sent as { messages: { role: string; reasoning_content?: string }[] })
      .messages;
    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant?.reasoning_content).toBe('先说明能力再问下一步');
  });
});

describe('上游不说话时，发现它的必须是网关', () => {
  /**
   * 一个会"卡住"的上游：先按脚本吐几行，然后一直挂着，直到被 abort 才抛。
   *
   * 最后那段是照 undici 的真实行为写的：`fetch` 的流在 abort 之后会 reject。
   * 这条测试因此同时守着一件不显眼的事 —— 看门狗放弃那一片之后**必须接住它的拒绝**，
   * 否则就是一个没人接的 promise rejection，而那在 Node 里是直接把网关进程带走。
   */
  function stallingProvider(script: {
    readonly lines?: readonly string[];
    readonly gapMs?: number;
    readonly seen?: (signal: AbortSignal | undefined) => void;
  }): Provider {
    return {
      id: 'stall',
      async send(_request, _config, signal) {
        script.seen?.(signal);
        return {
          status: 200,
          headers: {},
          lines: (async function* () {
            for (const line of script.lines ?? []) {
              if (script.gapMs) await new Promise((r) => setTimeout(r, script.gapMs));
              yield line;
            }
            await new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
          })(),
        };
      },
      mapError: (_status, body) => ({ message: String(body) }),
    };
  }

  it('上游一个字都不回 → 网关自己判失败，给的是**能显示给用户的中文原因**，不是内核那句 idle timeout', async () => {
    let signal: AbortSignal | undefined;
    const provider = stallingProvider({
      seen: (s) => {
        signal = s;
      },
    });

    const events = await collect(
      runPipeline(
        request(),
        { requestId: 'req_1' },
        { ...deps(provider), upstreamFirstChunkMs: 20, upstreamIdleMs: 20 },
      ),
    );

    const failed = events.find((e) => e.type === EVENT.failed) as unknown as {
      response: { error: { code: string; message: string } };
    };
    expect(failed).toBeDefined();
    /*
     * **这个 code 决定的是"用户能不能看到上一行那句话"**，不是我们内部怎么分类。
     * `invalid_prompt` 是内核唯一"终止 + 原样显示 message"的通道（见管道里的长注释）；
     * 换成 `server_is_overloaded` 的话用户看到的是内核那句
     * "Selected model is at capacity. Please try a different model."，
     * 一次上游卡死会被说成"模型满了，换一个吧"。
     */
    expect(failed.response.error.code).toBe('invalid_prompt');
    expect(failed.response.error.message).toContain('中断');
    expect(failed.response.error.message).toContain('重试');
    // 上游必须被真的掐断：只报失败不掐，那条请求还在上游那边计费
    expect(signal?.aborted).toBe(true);
  });

  it('首片的预算比流中途宽 —— 慢的首个 token 不该被当成"连接死了"', async () => {
    const provider = stallingProvider({
      lines: [`data: ${JSON.stringify({ choices: [{ delta: { content: '好的' } }] })}`],
      gapMs: 40,
    });

    const events = await collect(
      runPipeline(
        request(),
        { requestId: 'req_1' },
        // 首片给 2 秒、流中途只给 10ms：第一片等了 40ms 仍然要收下
        { ...deps(provider), upstreamFirstChunkMs: 2_000, upstreamIdleMs: 10 },
      ),
    );

    expect(events.map((e) => e.type)).toContain(EVENT.outputTextDelta);
    // 第一片之后上游就哑了 → 这时才轮到那个 10ms 的预算
    expect(events.at(-1)?.type).toBe(EVENT.failed);
  });

  it('看门狗关掉（0）时行为与从前一致：一直等下去', async () => {
    const provider = stallingProvider({
      lines: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: '好的' }, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
      ],
      gapMs: 30,
    });

    const events = await collect(
      runPipeline(
        request(),
        { requestId: 'req_1' },
        { ...deps(provider), upstreamFirstChunkMs: 0, upstreamIdleMs: 0 },
      ),
    );
    expect(events.at(-1)?.type).toBe(EVENT.completed);
  });

  it('提前离开时上游迭代器被关掉（`for await` 本来替我们做的那一下）', async () => {
    let closed = false;
    const provider: Provider = {
      id: 'closes',
      async send() {
        return {
          status: 200,
          headers: {},
          lines: (async function* () {
            try {
              yield `data: ${JSON.stringify({ choices: [{ delta: { content: '好的' } }] })}`;
              // 上游还有的是话要说，但我们会在 [DONE] 那一帧提前离开
              yield 'data: [DONE]';
              yield `data: ${JSON.stringify({ choices: [{ delta: { content: '还没完' } }] })}`;
            } finally {
              closed = true;
            }
          })(),
        };
      },
      mapError: (_status, body) => ({ message: String(body) }),
    };

    await collect(runPipeline(request(), { requestId: 'req_1' }, deps(provider)));

    /*
     * 关不掉的后果不是报错，是**慢性泄漏**：每一次提前离开都留一条还开着的上游连接
     * （真实 provider 里那是一个没取消的 fetch body）。
     */
    expect(closed).toBe(true);
  });

  it('停掉之后日志里记的是原因与等了多久，没有正文', async () => {
    const sink = memorySink();
    const logger = createLogger({ service: 'gateway', level: 'debug', sink });
    await collect(
      runPipeline(
        request(),
        { requestId: 'req_1' },
        { ...deps(stallingProvider({})), logger, upstreamFirstChunkMs: 20, upstreamIdleMs: 20 },
      ),
    );
    const text = sink.text();
    expect(text).toContain('gateway.stream.stalled');
    expect(text).toContain('UPSTREAM_IDLE');
    expect(text).not.toContain('鹏程');
  });
});

describe('Q14：不落盘 prompt 与响应体（M0 §10.2 第 2 条的可审计手段）', () => {
  it('一次完整请求跑完，日志里查不到 prompt / instructions / 回复 / 工具参数的 8 字片段', async () => {
    const sink = memorySink();
    const logger = createLogger({ service: 'gateway', level: 'debug', sink });

    const provider = fakeProvider({
      lines: [
        `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '先看表头，再分组计算毛利率。' } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: TASK.reply } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'shell', arguments: TASK.toolArgs } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } })}`,
        'data: [DONE]',
      ],
    });

    await collect(runPipeline(request(), { requestId: 'req_1' }, { ...deps(provider), logger }));

    const logText = sink.text();
    // 四段敏感文本逐一断言
    assertNoLeak(logText, [TASK.prompt, TASK.instructions, TASK.reply, TASK.toolArgs], '网关日志');

    // 反面：该记的确实记了 —— 不是靠"什么都不记"通过的
    expect(logText).toContain('gateway.request.started');
    expect(logText).toContain('gateway.request.completed');
    expect(logText).toContain('"tokensIn":120');
    expect(logText).toContain('"promptDigest"');
    expect(logText).toContain('"ttfbMs"');
  });

  it('上游把请求 echo 进错误消息时，日志里也不出现它（最常见的泄露形态）', async () => {
    const sink = memorySink();
    const logger = createLogger({ service: 'gateway', sink });
    const echoed = `400 invalid_request: {"messages":[{"content":"${TASK.prompt}"}]}`;
    const provider = fakeProvider({
      status: 400,
      lines: [JSON.stringify({ error: { message: echoed } })],
    });

    const events = await collect(
      runPipeline(request(), { requestId: 'req_1' }, { ...deps(provider), logger }),
    );

    assertNoLeak(sink.text(), [TASK.prompt], '网关日志（上游错误路径）');
    // 但错误本身要如实传给内核（内核需要它来判断该不该重试）——
    // 「不落盘」不等于「不转发」，这个区分很重要
    const failed = events.find((e) => e.type === EVENT.failed) as unknown as {
      response: { error: { message: string } };
    };
    expect(failed.response.error.message).toContain('invalid_request');
  });

  it('日志字段只有注册过的那些（结构上就写不进正文）', async () => {
    const sink = memorySink();
    const logger = createLogger({ service: 'gateway', level: 'debug', sink, onViolation: 'throw' });
    const provider = fakeProvider({
      lines: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
      ],
    });
    // onViolation: 'throw' —— 如果链路上有任何一处试图记未注册字段，这个测试会炸
    await collect(runPipeline(request(), { requestId: 'req_1' }, { ...deps(provider), logger }));
    expect(sink.records.length).toBeGreaterThan(0);
  });
});
