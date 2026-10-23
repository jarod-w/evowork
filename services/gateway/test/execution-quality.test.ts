import { describe, expect, it } from 'vitest';

import { type ModelCapabilities, type ProviderId } from '../src/capabilities.js';
import { capabilityNotices, runPipeline } from '../src/pipeline.js';
import { createTranslator } from '../src/translate/from-chat.js';
import { toChatRequest } from '../src/translate/to-chat.js';

const capabilities: ModelCapabilities = {
  streaming: true,
  toolCalls: true,
  parallelToolCalls: true,
  reasoning: true,
  promptCache: true,
  imageInput: true,
  maxContextTokens: 32_000,
};

describe('响应结束必须有有效证据', () => {
  it.each([undefined, 'length', 'content_filter', 'unexpected'])(
    '%s 不得被标成完成或执行残缺调用',
    (reason) => {
      const translator = createTranslator({ responseId: 'test', capabilities });
      translator.push({
        choices: [
          {
            delta: {
              content: '保留已经流出的文字',
              tool_calls: [
                { index: 0, id: 'c', function: { name: 'shell', arguments: '{"cmd":"' } },
              ],
            },
            ...(reason ? { finish_reason: reason } : {}),
          },
        ],
      });
      const events = translator.finish();
      expect(events.some((event) => event.type === 'response.completed')).toBe(false);
      expect(events.some((event) => event.type === 'response.failed')).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === 'response.output_item.done' &&
            (event as { item: { type: string } }).item.type === 'function_call',
        ),
      ).toBe(false);
      expect(
        events.some(
          (event) =>
            event.type === 'response.output_item.done' &&
            (event as { item: { type: string } }).item.type === 'message',
        ),
      ).toBe(true);
    },
  );

  it.each(['{"cmd":', '[]', 'null', '"text"'])(
    '即使声明 tool_calls 结束也不能提交 %s',
    (argumentsText) => {
      const translator = createTranslator({ responseId: 'test', capabilities });
      translator.push({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'c', function: { name: 'shell', arguments: argumentsText } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      });
      const events = translator.finish();
      expect(events.at(-1)?.type).toBe('response.failed');
      expect(events.some((event) => event.type === 'response.output_item.done')).toBe(false);
    },
  );

  it.each([true, false])('EOF 前的正常结束（有 DONE=%s）仍能完成', async (hasDone) => {
    const model = {
      id: 'test',
      provider: 'private' as const,
      upstreamModel: 'test',
      displayName: 'Test',
      tier: 'standard' as const,
      verified: false,
      unverified: [],
      notes: '',
      capabilities,
    };
    const events = [];
    for await (const event of runPipeline(
      { model: 'test', input: [] },
      { requestId: 'test' },
      {
        models: { find: () => model, list: () => [model] },
        providers: {
          private: {
            id: 'private',
            send: async () => ({
              status: 200,
              headers: {},
              lines: (async function* () {
                yield 'data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}';
                if (hasDone) yield 'data: [DONE]';
              })(),
            }),
            mapError: () => ({ code: 'invalid_prompt', message: 'error' }),
          },
        },
        configFor: () => ({ baseUrl: 'unused', apiKey: 'unused' }),
      },
    ))
      events.push(event);
    expect(events.at(-1)?.type).toBe('response.completed');
  });
});

describe('推理强度跨网关传递', () => {
  it('非法强度明确拒绝，不能沿对象原型取出值或静默丢掉请求', () => {
    expect(() =>
      toChatRequest(
        { model: 'test', input: [], reasoning: { effort: '__proto__' } },
        'deepseek-flash',
        capabilities,
        { provider: 'deepseek' },
      ),
    ).toThrow(/REASONING_EFFORT_UNSUPPORTED/);
  });
  it('完整管道按真实 provider 适配并发送强度，不能只在独立转换函数生效', async () => {
    let received: unknown;
    const model = {
      id: 'test',
      provider: 'deepseek' as const,
      upstreamModel: 'deepseek-flash',
      displayName: 'Test',
      tier: 'standard' as const,
      verified: false,
      unverified: [],
      notes: '',
      capabilities,
    };
    for await (const event of runPipeline(
      { model: 'test', input: [], reasoning: { effort: 'low' } },
      { requestId: 'test' },
      {
        models: { find: () => model, list: () => [model] },
        providers: {
          deepseek: {
            id: 'deepseek',
            send: async (body) => {
              received = body;
              return {
                status: 200,
                headers: {},
                lines: (async function* () {
                  yield 'data: {"choices":[{"delta":{"content":"完成"},"finish_reason":"stop"}]}';
                  yield 'data: [DONE]';
                })(),
              };
            },
            mapError: () => ({ code: 'invalid_prompt', message: 'error' }),
          },
        },
        configFor: () => ({ baseUrl: 'unused', apiKey: 'unused' }),
      },
    ))
      expect(event.type).not.toBe('response.failed');
    expect(received).toHaveProperty('reasoning_effort', 'low');
  });
  const models: readonly [ProviderId, string][] = [
    ['deepseek', 'deepseek-flash'],
    ['moonshot', 'kimi-k3'],
    ['zhipu', 'glm-5.3-flash'],
  ];
  it.each(models)('%s 将不同强度发送给上游', (provider, model) => {
    for (const effort of ['low', 'high', 'max']) {
      const result = toChatRequest(
        { model: 'test', input: [], reasoning: { effort } },
        model,
        capabilities,
        { provider },
      );
      expect(result.request).toHaveProperty('reasoning_effort', effort);
    }
  });
  it.each(models)('%s 将场景 medium 映射到确实支持的 high', (provider, model) => {
    expect(
      toChatRequest(
        { model: 'test', input: [], reasoning: { effort: 'medium' } },
        model,
        capabilities,
        { provider },
      ).request,
    ).toHaveProperty('reasoning_effort', 'high');
  });
  it('表外模型不冒传参数，并把采用厂商默认值告知用户', () => {
    const result = toChatRequest(
      { model: 'test', input: [], reasoning: { effort: 'high' } },
      'unknown',
      capabilities,
      { provider: 'private' },
    );
    expect(result.request).not.toHaveProperty('reasoning_effort');
    expect(result.degradations).toContain('REASONING_EFFORT_UNSUPPORTED');
    const notices = capabilityNotices({
      provider: 'private',
      upstreamModel: 'unknown',
      capabilities,
    });
    expect(notices.join(' ')).toContain('推理强度');
    expect(notices.join(' ')).toContain('默认');
  });
});
