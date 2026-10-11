import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '@evowork/store';
import type { Adapter, ApprovalReply } from '@evowork/kernel-adapter';
import {
  createCommunicationHost,
  patchCommunicationConfig,
  type CommunicationHost,
} from '../src/main/thread-communication-host.js';
import { makeThread, makeTurn } from '../../../services/kernel-adapter/test/fake-app-server.js';
import { fullAccessApprovalReply } from '../src/main/renderer-bridge.js';
import type { PendingApproval } from '@evowork/kernel-adapter';

let store: Store;
let host: CommunicationHost;
let current = true;
let denied = false;
let ask: ReturnType<typeof vi.fn<(a: unknown) => Promise<ApprovalReply>>>;
let read: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  store = openStore({ path: ':memory:' });
  current = true;
  denied = false;
  for (const id of ['a', 'b']) store.threads.upsertFromThread(makeThread({ id, name: id }));
  store.db
    .prepare(
      "UPDATE thread_projection SET project_id='p',last_turn_status='inProgress',last_turn_id='turn' WHERE thread_id='a'",
    )
    .run();
  store.db.prepare("UPDATE thread_projection SET project_id='p' WHERE thread_id='b'").run();
  ask = vi.fn(async () => ({ decision: 'accept' as const, optionId: '批准本次发送' }));
  read = vi.fn(async () => [
    makeTurn({
      items: [{ type: 'agentMessage', id: 'answer', text: '已核对', phase: 'final_answer' }],
      status: 'completed',
    }),
  ]);
  const adapter = {
    communicationReady: () => true,
    communicationHistory: read,
    deliverCommunication: vi.fn(),
    resolveCommunicationToolCall: () =>
      current ? { callId: 'call', turnId: 'turn', generation: 1 } : undefined,
    requestCommunicationConsent: ask,
  } as unknown as Adapter;
  host = createCommunicationHost({
    store,
    projectOf: (threadId) => store.threads.get(threadId)?.project_id ?? null,
    adapter: () => adapter,
    denied: () => denied,
    changed: vi.fn(),
  });
  await host.ready;
});
afterEach(() => {
  host.close();
  store.close();
});
describe('MCP 的来源与逐次授权', () => {
  it('同项目发现只包含元数据，不读历史', async () => {
    expect(await host.call('a', 'list_threads', {})).toEqual({
      tasks: [{ id: 'b', title: 'b', projectId: 'p', status: 'idle' }],
    });
    expect(ask).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
  it('确认展示目标和完整正文，通过后只登记一次请求', async () => {
    await host.call('a', 'send_request', { targetThreadId: 'b', text: '交办正文' });
    expect(ask.mock.calls[0]![0]).toMatchObject({
      threadId: 'a',
      turnId: 'turn',
      params: { serverName: 'thread_communication', message: expect.stringContaining('交办正文') },
    });
    expect(host.service.list('a')).toHaveLength(1);
    await host.call('a', 'send_request', { targetThreadId: 'b', text: '交办正文' });
    expect(host.service.list('a')).toHaveLength(1);
    expect(ask).toHaveBeenCalledTimes(1);
  });
  it('拒绝不登记请求，不读取目标历史', async () => {
    ask.mockResolvedValue({ decision: 'decline' });
    await expect(
      host.call('a', 'send_request', { targetThreadId: 'b', text: '拒绝我' }),
    ).rejects.toThrow('未获批准');
    expect(host.service.list('a')).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
  it('审批期间回合结束或世代变化不能沿用授权', async () => {
    ask.mockImplementation(async () => {
      current = false;
      return { decision: 'accept', optionId: '批准本次发送' };
    });
    await expect(
      host.call('a', 'send_request', { targetThreadId: 'b', text: '交办' }),
    ).rejects.toThrow('未获批准');
    expect(host.service.list('a')).toEqual([]);
  });
  it('来源无法核对与模型自报字段拒绝，平台关闭时不调用', async () => {
    current = false;
    await expect(host.call('a', 'list_threads', {})).rejects.toThrow('核对');
    current = true;
    await expect(
      host.call('a', 'send_request', {
        targetThreadId: 'b',
        text: '交办',
        sourceThreadId: 'other',
      }),
    ).rejects.toThrow('参数');
    denied = true;
    await expect(host.call('a', 'list_threads', {})).rejects.toThrow('不可用');
    expect(() =>
      host.service.send({
        sourceThreadId: 'a',
        targetThreadId: 'b',
        text: 'blocked',
        clientId: 'blocked',
      }),
    ).toThrow('不可用');
    expect(ask).not.toHaveBeenCalled();
  });
  it('读取摘要与完整历史分别确认范围，并明确报告截断', async () => {
    ask.mockResolvedValue({ decision: 'accept', optionId: '批准本次读取' });
    expect(await host.call('a', 'read_thread', { targetThreadId: 'b' })).toMatchObject({
      scope: 'summary',
      truncated: false,
      text: expect.stringContaining('已核对'),
    });
    read.mockResolvedValue([
      makeTurn({ items: [{ type: 'agentMessage', id: 'long', text: 'x'.repeat(14000) }] }),
    ]);
    expect(
      await host.call('a', 'read_thread', { targetThreadId: 'b', fullHistory: true }),
    ).toMatchObject({ scope: 'history', truncated: true });
    expect(ask.mock.calls[1]![0]).toMatchObject({
      params: { message: expect.stringContaining('历史') },
    });
    expect(host.service.list('a')).toEqual([]);
  });
  it('未认证与旧令牌请求不能读取任何会话', async () => {
    const env = host.environment;
    const noToken = await fetch(env.EVOWORK_COMMUNICATION_ENDPOINT, { method: 'POST', body: '{}' });
    expect(noToken.status).toBe(403);
    host.rotate();
    const stale = await fetch(env.EVOWORK_COMMUNICATION_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.EVOWORK_COMMUNICATION_TOKEN },
      body: '{}',
    });
    expect(stale.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });
  it('注册是幂等的，不改变其他连接器、权限或网关', () => {
    const original =
      '[permissions]\nactive = "workspace-write"\n[mcp_servers.browser]\ncommand = "browser"\n[mcp_servers.thread_communication]\ncommand = "old"\n[mcp_servers.thread_communication.env]\nOLD = "1"\n[model_providers.evowork]\nbase_url = "http://localhost"\n';
    const once = patchCommunicationConfig(original, '/app/node', '/app/server.mjs');
    expect(patchCommunicationConfig(once, '/app/node', '/app/server.mjs')).toBe(once);
    expect(once).toContain('command = "browser"');
    expect(once).toContain('active = "workspace-write"');
    expect(once).toContain('base_url = "http://localhost"');
    expect(once).not.toContain('OLD');
  });
  it('完全访问不能代答会话发送授权', async () => {
    await host.call('a', 'send_request', { targetThreadId: 'b', text: '本次请求' });
    expect(fullAccessApprovalReply(ask.mock.calls[0]![0] as PendingApproval)).toBeUndefined();
  });
  it('读取文字历史不把内嵌图片字节变成文字上下文', async () => {
    ask.mockResolvedValue({ decision: 'accept', optionId: '批准本次读取' });
    read.mockResolvedValue([
      makeTurn({
        items: [
          {
            type: 'userMessage',
            id: 'u',
            content: [
              { type: 'text', text: '资料说明' },
              { type: 'image', imageUrl: 'data:image/png;base64,private-image-bytes' },
            ],
          },
        ],
      }),
    ]);
    const result = await host.call('a', 'read_thread', { targetThreadId: 'b', fullHistory: true });
    expect(JSON.stringify(result)).toContain('资料说明');
    expect(JSON.stringify(result)).not.toContain('private-image-bytes');
  });
});
