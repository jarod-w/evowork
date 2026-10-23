import { describe, expect, it, vi } from 'vitest';
import { createModelRegistry, type ModelRegistryEntry } from '../src/capabilities.js';
import { runPipeline } from '../src/pipeline.js';
import { PRIVATE } from '../src/providers/registry.js';
import type { Provider } from '../src/providers/types.js';
import type { ResponsesEvent } from '../src/protocol.js';

const model: ModelRegistryEntry = {
  id: 'test',
  provider: 'private',
  upstreamModel: 'test',
  displayName: 'Test',
  tier: 'standard',
  verified: false,
  unverified: [],
  notes: '',
  capabilities: {
    streaming: false,
    toolCalls: true,
    parallelToolCalls: true,
    reasoning: true,
    promptCache: true,
    imageInput: false,
    maxContextTokens: 32000,
  },
};
const completion = {
  choices: [
    {
      message: {
        content: '结果是42',
        reasoning_content: '已核对',
        tool_calls: [{ id: 'c1', function: { name: 'shell', arguments: '{"cmd":"echo 42"}' } }],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
};
function setup(status: number, lines: AsyncIterable<string>, streaming = false) {
  let signal: AbortSignal | undefined;
  const provider: Provider = {
    id: 'private',
    send: vi.fn(async (_request, _config, upstreamSignal) => {
      signal = upstreamSignal;
      return { status, headers: {}, lines };
    }),
    mapError: PRIVATE.mapError,
  };
  const selected = { ...model, capabilities: { ...model.capabilities, streaming } };
  return {
    provider,
    getSignal: () => signal,
    deps: {
      models: createModelRegistry([selected]),
      providers: { private: provider },
      configFor: () => ({ baseUrl: 'unused', apiKey: 'unused' }),
      upstreamFirstChunkMs: 30,
      upstreamIdleMs: 20,
    },
  };
}
async function collect(deps: ReturnType<typeof setup>['deps'], signal?: AbortSignal) {
  const events: ResponsesEvent[] = [];
  for await (const event of runPipeline(
    { model: 'test', input: [] },
    { requestId: 'test', ...(signal ? { signal } : {}) },
    deps,
  ))
    events.push(event);
  return events;
}
function strings(parts: readonly string[]): AsyncIterable<string> {
  return (async function* () {
    yield* parts;
  })();
}
function hanging(first?: string) {
  let initial = first;
  const close = vi.fn(async () => ({ done: true as const, value: undefined }));
  return {
    close,
    lines: {
      [Symbol.asyncIterator]() {
        return {
          next: () => {
            if (initial !== undefined) {
              const value = initial;
              initial = undefined;
              return Promise.resolve({ done: false as const, value });
            }
            return new Promise<IteratorResult<string>>(() => undefined);
          },
          return: close,
        };
      },
    },
  };
}
async function bounded<T>(work: Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 300);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('完整响应体走真实管道', () => {
  it('非流式 JSON 的文字、思维链、工具和用量都能到达内核', async () => {
    const text = JSON.stringify(completion, null, 2);
    const { deps, provider } = setup(200, strings(text.split('\n')));
    const events = await collect(deps);
    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ stream: false }),
      expect.anything(),
      expect.anything(),
    );
    expect(events.at(-1)).toMatchObject({
      type: 'response.completed',
      response: { usage: { input_tokens: 12, output_tokens: 8 } },
    });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'response.output_text.delta', delta: '结果是42' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'response.reasoning_summary_text.delta', delta: '已核对' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'response.output_item.done',
        item: expect.objectContaining({
          type: 'function_call',
          name: 'shell',
          arguments: '{"cmd":"echo 42"}',
        }),
      }),
    );
  });
  it.each(['length', 'content_filter'])('非流式 %s 也不能交付工具', async (finish_reason) => {
    const body = { ...completion, choices: [{ ...completion.choices[0], finish_reason }] };
    const { deps } = setup(200, strings([JSON.stringify(body)]));
    const events = await collect(deps);
    expect(events.at(-1)).toMatchObject({
      type: 'response.failed',
      response: { error: { code: 'invalid_prompt' } },
    });
    expect(
      events.some(
        (e) =>
          e.type === 'response.output_item.done' &&
          (e.item as { type?: string }).type === 'function_call',
      ),
    ).toBe(false);
  });
  it('非流式的流内鉴权错误仍永久失败', async () => {
    const { deps } = setup(200, strings(['{"error":{"code":"401","message":"unauthorized"}}']));
    expect((await collect(deps)).at(-1)).toMatchObject({
      type: 'response.failed',
      response: { error: { code: 'invalid_prompt' } },
    });
  });
  it('损坏的非流式 JSON 明确失败', async () => {
    const { deps } = setup(200, strings(['{"choices":']));
    expect((await collect(deps)).at(-1)?.type).toBe('response.failed');
  });
  it.each([400, 401, 503])(
    '错误体 %s 读到一半卡死，仍及时收尾并保留 HTTP 错误语义',
    async (status) => {
      const { lines, close } = hanging('{"error":');
      const { deps, getSignal } = setup(status, lines, true);
      const events = await bounded(collect(deps));
      expect(events).not.toBeNull();
      expect(events?.at(-1)).toMatchObject({
        type: 'response.failed',
        response: { error: { code: status === 503 ? 'upstream_disconnected' : 'invalid_prompt' } },
      });
      expect(getSignal()?.aborted).toBe(true);
      expect(close).toHaveBeenCalled();
    },
  );
  it('非流式正文首字节不来，也会取消并释放上游', async () => {
    const { lines, close } = hanging();
    const { deps, getSignal } = setup(200, lines);
    const events = await bounded(collect(deps));
    expect(events?.at(-1)?.type).toBe('response.failed');
    expect(getSignal()?.aborted).toBe(true);
    expect(close).toHaveBeenCalled();
  });
  it('错误体持续滴流也不能无限延长总期限', async () => {
    let closed = false;
    const lines = (async function* () {
      try {
        while (!closed) {
          await new Promise((r) => setTimeout(r, 5));
          yield ' ';
        }
      } finally {
        closed = true;
      }
    })();
    const { deps, getSignal } = setup(503, lines, true);
    const events = await bounded(collect(deps));
    closed = true;
    expect(events).not.toBeNull();
    expect(getSignal()?.aborted).toBe(true);
  });
  it.each([200, 503])('%s 读体期间客户端取消，不等总超时', async (status) => {
    const { lines, close } = hanging();
    const { deps, getSignal } = setup(status, lines);
    deps.upstreamFirstChunkMs = 10000;
    const abort = new AbortController();
    const result = collect(deps, abort.signal);
    await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    expect(await bounded(result)).not.toBeNull();
    expect(getSignal()?.aborted).toBe(true);
    expect(close).toHaveBeenCalled();
  });
  it.each([200, 503])('%s 正文超限后取消，不把上游正文回显到日志或错误', async (status) => {
    const size = status === 200 ? 8 * 1024 * 1024 + 1 : 64 * 1024 + 1;
    const { deps, getSignal } = setup(status, strings(['x'.repeat(size)]));
    const events = await collect(deps);
    expect(events.at(-1)?.type).toBe('response.failed');
    expect(getSignal()?.aborted).toBe(true);
    expect(JSON.stringify(events).length).toBeLessThan(2000);
  });
});
