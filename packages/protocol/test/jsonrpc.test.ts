import { describe, expect, it, vi } from 'vitest';

import {
  ERROR_CODE,
  JsonRpcCallError,
  JsonRpcPeer,
  LineFramer,
  TransportClosedError,
  type JsonRpcTransport,
} from '../src/jsonrpc.js';

/** 一个把发出的行收集起来、并能手工喂回复的假 transport。 */
function fakeTransport() {
  const sent: string[] = [];
  const transport: JsonRpcTransport = {
    send: (line) => {
      sent.push(line);
    },
  };
  return {
    transport,
    sent,
    /** 最后一条发出的消息（解析后） */
    last(): Record<string, unknown> {
      const line = sent.at(-1);
      if (!line) throw new Error('还没有发出任何消息');
      return JSON.parse(line) as Record<string, unknown>;
    },
  };
}

describe('LineFramer —— chunk 边界与消息边界无关', () => {
  it('一个 chunk 里多条消息、以及跨 chunk 的半条，都能正确拆开', () => {
    const lines: string[] = [];
    const framer = new LineFramer((l) => lines.push(l));

    framer.push('{"a":1}\n{"b":2}\n{"c":');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);

    framer.push('3}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it('正文里的换行是 JSON 转义的，不会被误当成帧边界', () => {
    const lines: string[] = [];
    const framer = new LineFramer((l) => lines.push(l));
    const payload = JSON.stringify({ text: '第一行\n第二行' });
    framer.push(`${payload}\n`);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({ text: '第一行\n第二行' });
  });

  it('单行超限时丢弃并报告，而不是把内存吃光', () => {
    const onOverflow = vi.fn();
    const framer = new LineFramer(() => {}, 16, onOverflow);
    framer.push('x'.repeat(64));
    expect(onOverflow).toHaveBeenCalledWith(64);
  });

  it('flush 交出残留半行（连接被砍断时的那半条）', () => {
    const lines: string[] = [];
    const framer = new LineFramer((l) => lines.push(l));
    framer.push('{"half":');
    framer.flush();
    expect(lines).toEqual(['{"half":']);
  });
});

describe('JsonRpcPeer —— 请求 / 通知 / 服务端请求', () => {
  it('request 发出合法的 JSON-RPC 2.0 请求并把 result 路由回 Promise', async () => {
    const t = fakeTransport();
    const peer = new JsonRpcPeer({ transport: t.transport });

    const promise = peer.request<{ ok: boolean }>('thread/list', { limit: 30 });
    const sent = t.last();
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('thread/list');
    expect(sent.params).toEqual({ limit: 30 });

    peer.handleMessage({ jsonrpc: '2.0', id: sent.id, result: { ok: true } });
    await expect(promise).resolves.toEqual({ ok: true });
    expect(peer.pendingCount).toBe(0);
  });

  it('错误响应变成 JsonRpcCallError，且能区分三种情况', async () => {
    const t = fakeTransport();
    const peer = new JsonRpcPeer({ transport: t.transport });

    // ① 上游移除了方法 → 降级信号（09 §3.3）
    const p1 = peer.request('project/list');
    peer.handleMessage({
      jsonrpc: '2.0',
      id: t.last().id,
      error: { code: ERROR_CODE.methodNotFound, message: 'unknown method' },
    });
    const e1 = await p1.catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(JsonRpcCallError);
    expect((e1 as JsonRpcCallError).isMethodNotFound).toBe(true);
    expect((e1 as JsonRpcCallError).isExperimentalGating).toBe(false);

    // ② 我们忘了声明 experimentalApi → 这是**我们的 bug**，不是降级
    const p2 = peer.request('thread/search');
    peer.handleMessage({
      jsonrpc: '2.0',
      id: t.last().id,
      error: {
        code: ERROR_CODE.invalidRequest,
        message: 'thread/search requires experimentalApi capability',
      },
    });
    const e2 = (await p2.catch((e: unknown) => e)) as JsonRpcCallError;
    expect(e2.isExperimentalGating).toBe(true);
    expect(e2.isMethodNotFound).toBe(false);

    // ③ 普通业务错误
    const p3 = peer.request('turn/start');
    peer.handleMessage({
      jsonrpc: '2.0',
      id: t.last().id,
      error: { code: ERROR_CODE.invalidParams, message: 'bad cwd' },
    });
    const e3 = (await p3.catch((e: unknown) => e)) as JsonRpcCallError;
    expect(e3.isMethodNotFound).toBe(false);
    expect(e3.isExperimentalGating).toBe(false);
  });

  it('错误对象的 message 不含内核返回的正文（Q14）', async () => {
    const t = fakeTransport();
    const peer = new JsonRpcPeer({ transport: t.transport });
    const p = peer.request('turn/start');
    peer.handleMessage({
      jsonrpc: '2.0',
      id: t.last().id,
      error: { code: -32602, message: '请求体是：帮我分析鹏程公司的逾期账款' },
    });
    const err = (await p.catch((e: unknown) => e)) as JsonRpcCallError;
    // Error.message 会进日志与崩溃上报，所以它只放方法名与码
    expect(err.message).not.toContain('鹏程');
    expect(err.message).toContain('turn/start');
    // 原文仍可被调用方读到（排查需要），但要走 errorFields() 才能入日志
    expect(err.rpcMessage).toContain('鹏程');
  });

  it('通知分发给所有订阅者；一个订阅者抛错不影响其他人', () => {
    const t = fakeTransport();
    const bad = vi.fn(() => {
      throw new Error('订阅者炸了');
    });
    const good = vi.fn();
    const onMalformedLine = vi.fn();
    const peer = new JsonRpcPeer({ transport: t.transport, onMalformedLine });

    peer.onNotification('turn/completed', bad);
    peer.onNotification('turn/completed', good);
    peer.handleMessage({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: 't1' } });

    expect(bad).toHaveBeenCalledOnce();
    expect(good).toHaveBeenCalledOnce();
    expect(onMalformedLine).toHaveBeenCalledOnce();
  });

  it('未订阅的通知不丢：交给 onUnhandledNotification（09 §3.4 的 unknown_event）', () => {
    const t = fakeTransport();
    const onUnhandledNotification = vi.fn();
    const peer = new JsonRpcPeer({ transport: t.transport, onUnhandledNotification });
    peer.handleMessage({ jsonrpc: '2.0', method: 'thread/realtime/sdp', params: { x: 1 } });
    expect(onUnhandledNotification).toHaveBeenCalledWith('thread/realtime/sdp', { x: 1 });
  });

  it('取消订阅后不再收到通知', () => {
    const t = fakeTransport();
    const handler = vi.fn();
    const peer = new JsonRpcPeer({ transport: t.transport });
    const off = peer.onNotification('item/started', handler);
    peer.handleMessage({ jsonrpc: '2.0', method: 'item/started', params: {} });
    off();
    peer.handleMessage({ jsonrpc: '2.0', method: 'item/started', params: {} });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('服务端请求（F14）被处理并回复 result', async () => {
    const t = fakeTransport();
    const peer = new JsonRpcPeer({ transport: t.transport });
    peer.onRequest('item/commandExecution/requestApproval', () => ({ decision: 'accept' }));

    peer.handleMessage({
      jsonrpc: '2.0',
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 't1', itemId: 'i1', command: 'pip install openpyxl' },
    });
    await vi.waitFor(() => expect(t.sent.length).toBeGreaterThan(0));

    const reply = t.last();
    expect(reply.id).toBe(77);
    expect(reply.result).toEqual({ decision: 'accept' });
  });

  it('**没有处理器时必须显式回错**，不能静默丢弃（否则内核永远等下去）', async () => {
    const t = fakeTransport();
    const peer = new JsonRpcPeer({ transport: t.transport });

    peer.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'item/fileChange/requestApproval',
      params: {},
    });
    await vi.waitFor(() => expect(t.sent.length).toBe(1));

    const reply = t.last();
    expect(reply.id).toBe(5);
    expect((reply.error as { code: number }).code).toBe(ERROR_CODE.methodNotFound);
    expect((reply.error as { message: string }).message).toContain('F14');
  });

  it('处理器抛错时回错误但**不泄露 message**（内核会把它记进 rollout）', async () => {
    const t = fakeTransport();
    const peer = new JsonRpcPeer({ transport: t.transport });
    peer.onRequest('item/tool/requestUserInput', () => {
      throw new Error('用户在输入框里写了：把合同改成三年期');
    });

    peer.handleMessage({ jsonrpc: '2.0', id: 9, method: 'item/tool/requestUserInput', params: {} });
    await vi.waitFor(() => expect(t.sent.length).toBe(1));

    const errMessage = (t.last().error as { message: string }).message;
    expect(errMessage).not.toContain('合同');
    expect(errMessage).toContain('Error');
  });

  it('同一个服务端请求方法不允许注册两个处理器（审批必须有唯一归属）', () => {
    const t = fakeTransport();
    const peer = new JsonRpcPeer({ transport: t.transport });
    peer.onRequest('item/tool/requestUserInput', () => ({}));
    expect(() => peer.onRequest('item/tool/requestUserInput', () => ({}))).toThrow(/唯一归属/);
  });

  it('异步处理器（等用户点按钮）也能正确回复', async () => {
    const t = fakeTransport();
    const peer = new JsonRpcPeer({ transport: t.transport });
    let resolveUser: (v: unknown) => void = () => {};
    peer.onRequest(
      'item/permissions/requestApproval',
      () => new Promise((resolve) => (resolveUser = resolve)),
    );

    peer.handleMessage({ jsonrpc: '2.0', id: 3, method: 'item/permissions/requestApproval' });
    expect(t.sent).toHaveLength(0); // 还在等用户

    resolveUser({ decision: 'decline' });
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.last().result).toEqual({ decision: 'decline' });
  });

  it('坏行不炸进程，交给 onMalformedLine（上游改帧格式也要看得见）', () => {
    const t = fakeTransport();
    const onMalformedLine = vi.fn();
    const peer = new JsonRpcPeer({ transport: t.transport, onMalformedLine });
    peer.handleLine('这不是 JSON');
    peer.handleLine('   ');
    expect(onMalformedLine).toHaveBeenCalledOnce();
  });

  it('迟到的响应（重启前发出的）被丢弃而不是报错', () => {
    const t = fakeTransport();
    const peer = new JsonRpcPeer({ transport: t.transport });
    expect(() => peer.handleMessage({ jsonrpc: '2.0', id: 999, result: {} })).not.toThrow();
  });

  it('close 把所有 in-flight 请求拒掉 —— 否则 UI 按钮永远转圈', async () => {
    const t = fakeTransport();
    const peer = new JsonRpcPeer({ transport: t.transport });
    const p1 = peer.request('thread/list');
    const p2 = peer.request('model/list');
    peer.close('内核崩溃');

    await expect(p1).rejects.toBeInstanceOf(TransportClosedError);
    await expect(p2).rejects.toBeInstanceOf(TransportClosedError);
    expect(peer.pendingCount).toBe(0);
    await expect(peer.request('thread/list')).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('resetPending 拒掉 in-flight 但保留订阅（重连复用同一个 peer）', async () => {
    const t = fakeTransport();
    const handler = vi.fn();
    const peer = new JsonRpcPeer({ transport: t.transport });
    peer.onNotification('thread/started', handler);

    const p = peer.request('thread/list');
    peer.resetPending('内核重启');
    await expect(p).rejects.toBeInstanceOf(TransportClosedError);

    // 订阅还在，且 peer 可继续用
    peer.handleMessage({ jsonrpc: '2.0', method: 'thread/started', params: {} });
    expect(handler).toHaveBeenCalledOnce();
    await expect(
      (async () => {
        const p2 = peer.request('model/list');
        peer.handleMessage({ jsonrpc: '2.0', id: t.last().id, result: { data: [] } });
        return p2;
      })(),
    ).resolves.toEqual({ data: [] });
  });

  it('请求超时是可选的，默认不超时（长任务不该被误判成断连）', async () => {
    vi.useFakeTimers();
    try {
      const t = fakeTransport();
      const noTimeout = new JsonRpcPeer({ transport: t.transport });
      const p = noTimeout.request('turn/start');
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(noTimeout.pendingCount).toBe(1); // 十分钟后仍在等，符合预期

      const withTimeout = new JsonRpcPeer({ transport: t.transport, requestTimeoutMs: 1000 });
      const p2 = withTimeout.request('model/list');
      const assertion = expect(p2).rejects.toBeInstanceOf(JsonRpcCallError);
      vi.advanceTimersByTime(1001);
      await assertion;

      noTimeout.close();
      await expect(p).rejects.toBeInstanceOf(TransportClosedError);
    } finally {
      vi.useRealTimers();
    }
  });
});
