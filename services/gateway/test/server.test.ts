/**
 * HTTP 层：真 socket、真 SSE。
 *
 * 这一层的测试回答一个具体问题：**内核能不能真的跟它说话**。
 * 内核侧的行为是确定的（`{base_url}/responses` + SSE + 标准 JSON-RPC 之外的普通 HTTP），
 * 所以这里用真实的 `fetch` 打真实的端口，而不是调 handler 函数 ——
 * 后者测不出 header、状态码、流式是否被缓冲这几件真正会出问题的事。
 */
import type { AddressInfo } from 'node:net';

import { createLogger, memorySink } from '@evowork/logging';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createModelRegistry, type ModelRegistryEntry } from '../src/capabilities.js';
import { createGatewayServer } from '../src/server.js';
import type { Provider } from '../src/providers/types.js';

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
    reasoning: false,
    promptCache: false,
    imageInput: false,
    maxContextTokens: 8_000,
  },
};

function provider(lines: readonly string[]): Provider {
  return {
    id: 'fake',
    async send() {
      return {
        status: 200,
        headers: {},
        lines: (async function* () {
          for (const line of lines) yield line;
        })(),
      };
    },
    mapError: (_status, body) => ({ message: String(body) }),
  };
}

let baseUrl: string;
let close: () => Promise<void>;
const sink = memorySink();

async function start(
  opts: {
    readonly lines?: readonly string[];
    readonly authenticate?: (a?: string) => boolean;
  } = {},
) {
  const server = createGatewayServer({
    models: createModelRegistry([MODEL]),
    providers: { deepseek: provider(opts.lines ?? []) },
    configFor: () => ({ baseUrl: 'https://upstream.invalid/v1', apiKey: 'sk-test' }),
    logger: createLogger({ service: 'gateway', sink }),
    authenticate: opts.authenticate ?? ((auth) => auth === 'Bearer good-token'),
    newResponseId: () => 'resp_test',
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
}

beforeEach(() => {
  sink.records.length = 0;
});

afterEach(async () => {
  await close?.();
});

describe('端点与鉴权', () => {
  it('健康检查不需要鉴权（部署探活要用）', async () => {
    await start();
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('**默认拒绝所有请求** —— 误部署到公网时别人用不了我们的额度', async () => {
    const server = createGatewayServer({
      models: createModelRegistry([MODEL]),
      providers: { deepseek: provider([]) },
      configFor: () => ({ baseUrl: 'x', apiKey: 'y' }),
      // 不提供 authenticate
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('鉴权失败 → 401', async () => {
    await start();
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: JSON.stringify({ model: MODEL.id, input: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('未知端点 → 404（而不是把它当成 responses 请求）', async () => {
    await start();
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('能力声明端点透出 verified 与用户可见文案（D2 的落点）', async () => {
    await start();
    const res = await fetch(`${baseUrl}/v1/evowork/models`, {
      headers: { authorization: 'Bearer good-token' },
    });
    const body = (await res.json()) as {
      data: {
        id: string;
        verified: boolean;
        notices: string[];
        capabilities: { reasoning: boolean };
      }[];
    };
    const entry = body.data.find((m) => m.id === MODEL.id);
    expect(entry?.verified).toBe(false);
    expect(entry?.capabilities.reasoning).toBe(false);
    // 缺失能力有给用户看的话（03 §4.5 / §8）
    expect(entry?.notices.join('\n')).toContain('没有可展示的推理过程');
  });
});

describe('POST /v1/responses —— 内核唯一会调的端点', () => {
  it('返回 SSE，且带上关掉代理缓冲的头（否则流式会被攒成一整块）', async () => {
    await start({
      lines: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: '好的' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } })}`,
        'data: [DONE]',
      ],
    });

    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL.id,
        instructions: '你可以动手。',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const text = await res.text();
    // 内核按 SSE 解析：`data: {...}\n\n`
    expect(text).toContain('data: {"type":"response.created"');
    expect(text).toContain('"type":"response.output_text.delta"');
    expect(text).toContain('"type":"response.completed"');
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
  });

  it('事件顺序：created 最先、completed 最后（内核依赖这个顺序）', async () => {
    await start({
      lines: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c0', function: { name: 'shell', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}`,
        'data: [DONE]',
      ],
    });
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: JSON.stringify({ model: MODEL.id, input: [], stream: true }),
    });
    const text = await res.text();
    const types = text
      .split('\n\n')
      .map((block) => block.replace(/^data: /, '').trim())
      .filter((p) => p.length > 0 && p !== '[DONE]')
      .map((p) => (JSON.parse(p) as { type: string }).type);

    expect(types[0]).toBe('response.created');
    expect(types.at(-1)).toBe('response.completed');
    // function_call 的 done 在 completed 之前（丢了 agent 就卡住）
    const doneIdx = types.lastIndexOf('response.output_item.done');
    expect(doneIdx).toBeLessThan(types.length - 1);
  });

  it('坏 JSON 请求体 → 400，不是 500', async () => {
    await start();
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: '{不是 JSON',
    });
    expect(res.status).toBe(400);
  });

  it('缺 model / input → 400 且说清缺什么', async () => {
    await start();
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: JSON.stringify({ stream: true }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('model');
  });

  it('未配置的模型 → 400 + 可操作的提示，**不回落到别的模型**', async () => {
    await start();
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: JSON.stringify({ model: 'evowork/nope', input: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string; code: string } };
    expect(body.error.code).toBe('model_not_found');
    expect(body.error.message).toContain('设置里选择');
  });

  it('请求体超限 → 413（上下文可以很大，但不该无上限）', async () => {
    const server = createGatewayServer({
      models: createModelRegistry([MODEL]),
      providers: { deepseek: provider([]) },
      configFor: () => ({ baseUrl: 'x', apiKey: 'y' }),
      authenticate: () => true,
      maxBodyBytes: 64,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: 'POST',
      body: JSON.stringify({ model: MODEL.id, input: [], padding: 'x'.repeat(500) }),
    });
    expect(res.status).toBe(413);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('HTTP 层的日志里也没有正文（Q14 覆盖到端点，不只是管道）', async () => {
    const secret = '把 data/ 下的三张表合并，重点讲鹏程公司的欠款风险';
    await start({
      lines: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: '好的' }, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
      ],
    });
    await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: JSON.stringify({
        model: MODEL.id,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: secret }] }],
        stream: true,
      }),
    });

    const logText = sink.text();
    expect(logText).not.toContain('鹏程');
    expect(logText).not.toContain('三张表');
    expect(logText).toContain('gateway.request.completed');
  });
});
