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
import type { ResolvedModel } from '../src/layers.js';
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

/**
 * 服务端要的是**合并层的结果**（`layers.ts`）：目录端点必须透出 `credentialSource`。
 * 这里补上那两个字段而不是把 server 的类型放宽 —— 放宽等于让"这个模型用谁的凭据"
 * 变成一个可以缺席的字段，而 11 §4.2 要求它对用户可见。
 */
function registry(...extra: readonly ModelRegistryEntry[]) {
  const lookup = createModelRegistry(extra);
  const resolve = (m: ModelRegistryEntry): ResolvedModel => ({
    ...m,
    credentialSource: 'byok',
    layer: 'builtin',
  });
  return {
    find: (id: string) => {
      const found = lookup.find(id);
      return found ? resolve(found) : undefined;
    },
    list: () => lookup.list().map(resolve),
  };
}

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

/**
 * 一个收下请求就再也不说话的上游（直到被 abort）。模拟"上游在想 / 连接半死"。
 *
 * 手写迭代器而不是 `async function*`：一个**永远不 yield** 的 generator 写出来就是
 * `require-yield` 的 lint 错误，而"永远不 yield"正是这里要模拟的东西。
 */
function silentProvider(): Provider {
  return {
    id: 'silent',
    async send(_request, _config, signal) {
      return {
        status: 200,
        headers: {},
        lines: {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<IteratorResult<string>>((_resolve, reject) => {
                signal?.addEventListener('abort', () => reject(new Error('aborted')));
              }),
          }),
        },
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
    /** 用一个永远不说话的上游（测心跳） */
    readonly silent?: boolean;
    readonly heartbeatMs?: number;
  } = {},
) {
  const server = createGatewayServer({
    models: registry(MODEL),
    providers: { deepseek: opts.silent ? silentProvider() : provider(opts.lines ?? []) },
    configFor: () => ({ baseUrl: 'https://upstream.invalid/v1', apiKey: 'sk-test' }),
    logger: createLogger({ service: 'gateway', sink }),
    authenticate: opts.authenticate ?? ((auth) => auth === 'Bearer good-token'),
    newResponseId: () => 'resp_test',
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
    // 看门狗在这一层不该插手：这几条测的是 HTTP 层的心跳
    upstreamFirstChunkMs: 0,
    upstreamIdleMs: 0,
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
      models: registry(MODEL),
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
      models: registry(MODEL),
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

describe('心跳：内核那边的 300 秒空闲计时器', () => {
  /**
   * 这一组守的是一个**已经在真机上发生过**的失败：
   * 界面上弹出「这一回合失败了 / stream disconnected before completion: idle timeout
   * waiting for SSE」。那句话是内核发的 —— 它读 SSE 的循环是
   * `timeout(idle_timeout, stream.next())`，默认 300 秒一帧都没收到就判这一回合失败
   * （`codex-api/src/sse/responses.rs:591/612`，2026-09-26 对 `d583e73c4d` 核对）。
   *
   * 而网关有好几段"活着但一帧都不发"的时间：上游在想、思维链被能力表挡掉、
   * 工具调用参数要攒完整才发得出去。所以**必须由网关保证连接上一直有帧在走**。
   */
  it('上游一直不说话时，连接上仍然有帧在走（否则内核 300 秒后判这一回合失败）', async () => {
    await start({ silent: true, heartbeatMs: 20 });

    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: JSON.stringify({ model: MODEL.id, input: [], stream: true }),
      signal: ac.signal,
    });

    // 响应头本身也是心跳写出来的：上游还没回第一片，但内核已经知道连接活着
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('response.in_progress')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    // 内核对这个类型的处理是"显式忽略"（responses.rs:537）：不产生任何事件、
    // 到不了前端，但让 `stream.next()` 返回一次 —— 空闲计时器因此重新开始
    expect(text).toContain('"type":"response.in_progress"');
    ac.abort();
  });

  it('真的有内容时不插心跳（心跳只填空白，不污染正常的流）', async () => {
    await start({
      heartbeatMs: 5_000,
      lines: [
        `data: ${JSON.stringify({ choices: [{ delta: { content: '好的' }, finish_reason: 'stop' }] })}`,
        'data: [DONE]',
      ],
    });
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: JSON.stringify({ model: MODEL.id, input: [], stream: true }),
    });
    expect(await res.text()).not.toContain('response.in_progress');
  });

  it('心跳再快也抢不到"未配置的模型"前面 —— 那仍然是 400，不是 200 + 空流', async () => {
    await start({ silent: true, heartbeatMs: 1 });
    const res = await fetch(`${baseUrl}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: JSON.stringify({ model: 'evowork/nope', input: [] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('hosted 转发（D11）', () => {
  const HOSTED: ModelRegistryEntry = { ...MODEL, id: 'evowork/hosted-flash' };

  function hostedLookup() {
    const resolve = (m: ModelRegistryEntry): ResolvedModel => ({
      ...m,
      credentialSource: 'hosted',
      layer: 'tenant',
    });
    return {
      find: (id: string) => (id === HOSTED.id ? resolve(HOSTED) : undefined),
      list: () => [resolve(HOSTED)],
    };
  }

  it('没带 JWT / 上游时 hosted 模型是 401 not_signed_in，不回落到本机 key', async () => {
    const server = createGatewayServer({
      models: hostedLookup(),
      providers: { deepseek: provider([]) },
      configFor: () => ({ baseUrl: 'https://should-not-hit.invalid/v1', apiKey: 'sk-local' }),
      authenticate: () => true,
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: JSON.stringify({
        model: HOSTED.id,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_signed_in');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('带转发配置时打到云端，不走本机 configFor', async () => {
    let hitLocal = false;
    let forwarded = false;
    const server = createGatewayServer({
      models: hostedLookup(),
      providers: { deepseek: provider([]) },
      configFor: () => {
        hitLocal = true;
        return { baseUrl: 'https://should-not-hit.invalid/v1', apiKey: 'sk-local' };
      },
      authenticate: () => true,
      hostedForward: {
        upstreamBaseUrl: 'https://cloud.example/v1',
        accessJwt: 'access-jwt',
        fetchImpl: (async () => {
          forwarded = true;
          return new Response('{"id":"resp_1"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: JSON.stringify({
        model: HOSTED.id,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
      }),
    });
    expect(res.status).toBe(200);
    expect(forwarded).toBe(true);
    expect(hitLocal).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /**
   * **心跳与看门狗必须一起上。**
   *
   * 2026-09-26 补心跳时只给了本机直连那条路看门狗，转发这条靠内核的 300 秒兜底。
   * 心跳一上，那个兜底就没了 —— 云端停在半路时本机网关会一直跳心跳，
   * 回合**永远转圈**。这条测的就是那个洞：云端不说话时，这一侧要自己收尾。
   */
  it('云端停在半路 → 本机网关自己收尾（心跳把内核的 300 秒兜底拆掉了，这里得补上）', async () => {
    const server = createGatewayServer({
      models: hostedLookup(),
      providers: { deepseek: provider([]) },
      configFor: () => ({ baseUrl: 'https://should-not-hit.invalid/v1', apiKey: 'sk-local' }),
      authenticate: () => true,
      heartbeatMs: 10,
      upstreamIdleMs: 30,
      upstreamFirstChunkMs: 30,
      hostedForward: {
        upstreamBaseUrl: 'https://cloud.example/v1',
        accessJwt: 'access-jwt',
        fetchImpl: (async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                // 先给一帧真的，再也不说话 —— 云端"连接还开着但死了"的样子
                controller.enqueue(
                  new TextEncoder().encode('data: {"type":"response.created"}\n\n'),
                );
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          )) as typeof fetch,
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: JSON.stringify({ model: HOSTED.id, input: [], stream: true }),
    });

    // 关键断言是**这一行会返回** —— 没有看门狗时它永远读不完
    const text = await res.text();
    expect(text).toContain('"type":"response.failed"');
    expect(text).toContain('云端网关');
    // 终止且能显示给用户的那条通道（见 pipeline.ts 的长注释）
    expect(text).toContain('invalid_prompt');
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('本机 registry 没有的模型，有上游时仍转发（private 客户网关的目录）', async () => {
    let forwardedTo = '';
    const server = createGatewayServer({
      models: {
        find: () => undefined,
        list: () => [],
      },
      providers: { deepseek: provider([]) },
      configFor: () => ({ baseUrl: 'https://should-not-hit.invalid/v1', apiKey: 'sk-local' }),
      authenticate: () => true,
      hostedForward: {
        upstreamBaseUrl: 'https://gw.corp.example/v1',
        accessJwt: 'corp-token',
        fetchImpl: (async (url) => {
          forwardedTo = String(url);
          return new Response('{"id":"resp_corp"}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }) as typeof fetch,
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer good-token' },
      body: JSON.stringify({
        model: 'corp/default-flash',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '你好' }] }],
      }),
    });
    expect(res.status).toBe(200);
    expect(forwardedTo).toBe('https://gw.corp.example/v1/responses');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('目录把上游的条目合进来，丢掉带 apiKey 的', async () => {
    const server = createGatewayServer({
      models: {
        find: () => undefined,
        list: () => [],
      },
      providers: { deepseek: provider([]) },
      configFor: () => ({ baseUrl: 'https://should-not-hit.invalid/v1', apiKey: 'sk-local' }),
      authenticate: () => true,
      hostedForward: {
        upstreamBaseUrl: 'https://gw.corp.example/v1',
        accessJwt: 'corp-token',
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'corp/default-flash',
                  displayName: '默认',
                  provider: 'deepseek',
                  upstreamModel: 'deepseek-v4-flash',
                  tier: 'standard',
                  capabilities: MODEL.capabilities,
                  verified: false,
                  unverified: [],
                  notes: '',
                  notices: [],
                  credentialSource: 'byok',
                  layer: 'builtin',
                },
                {
                  id: 'corp/leak',
                  displayName: '漏',
                  provider: 'deepseek',
                  upstreamModel: 'x',
                  capabilities: MODEL.capabilities,
                  apiKey: 'sk-no',
                },
              ],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )) as typeof fetch,
      },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${address.port}/v1/evowork/models`, {
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: readonly { id: string; credentialSource: string; layer: string }[];
    };
    expect(body.data.map((e) => e.id)).toEqual(['corp/default-flash']);
    expect(body.data[0]?.credentialSource).toBe('hosted');
    expect(body.data[0]?.layer).toBe('tenant');
    expect(JSON.stringify(body)).not.toContain('apiKey');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
