// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStore, type Store } from '@evowork/store';
import type { Adapter } from '@evowork/kernel-adapter';
import { createNextActionsHost, patchNextActionsConfig } from '../src/main/next-actions-host.js';
import { makeThread } from '../../../services/kernel-adapter/test/fake-app-server.js';

let store: Store;
let host: ReturnType<typeof createNextActionsHost>;
let current: boolean;
const args = { outcome: 'delivered', actions: [{ title: '验收', prompt: '验证交付结果。' }] };
beforeEach(async () => {
  store = openStore({ path: ':memory:' });
  store.threads.upsertFromThread(makeThread({ id: 'task' }));
  current = true;
  const adapter = {
    resolveLocalToolCall: (threadId: string, server: string, tool: string, raw: unknown) =>
      current &&
      threadId === 'task' &&
      server === 'next_actions' &&
      tool === 'propose_next_actions' &&
      JSON.stringify(raw) === JSON.stringify(args)
        ? { turnId: 'turn', callId: 'call', generation: 1 }
        : undefined,
    getGoal: async () => undefined,
    listQueuedInputs: async () => [],
  } as unknown as Adapter;
  host = createNextActionsHost({ store, adapter: () => adapter, changed: vi.fn() });
  await host.ready;
});
afterEach(() => {
  host.close();
  store.close();
});
describe('本机建议 MCP 宿主', () => {
  it('需要本机令牌和真实来源，登记只暂存不发布，旧令牌失效', async () => {
    const env = host.environment;
    const body = JSON.stringify({
      threadId: 'task',
      name: 'propose_next_actions',
      arguments: args,
    });
    expect((await fetch(env.EVOWORK_NEXT_ACTIONS_ENDPOINT, { method: 'POST', body })).status).toBe(
      403,
    );
    const invoke = () =>
      fetch(env.EVOWORK_NEXT_ACTIONS_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.EVOWORK_NEXT_ACTIONS_TOKEN },
        body,
      });
    expect((await invoke()).status).toBe(200);
    expect(await host.service.list('task')).toEqual([]);
    current = false;
    expect((await invoke()).status).toBe(400);
    host.rotate();
    expect((await invoke()).status).toBe(403);
    expect(store.db.prepare('SELECT * FROM follow_up_queue').all()).toEqual([]);
  });
  it('模型自报任务身份和正文不同均不能冒用在途调用', async () => {
    await expect(host.call('other', 'propose_next_actions', args)).rejects.toThrow('来源');
    await expect(
      host.call('task', 'propose_next_actions', {
        ...args,
        actions: [{ title: '验收', prompt: '不同正文' }],
      }),
    ).rejects.toThrow('来源');
    await expect(host.call('task', 'send_request', args)).rejects.toThrow('工具');
  });
  it('注册幂等，保留其它 MCP 和权限，不在配置落盘令牌', () => {
    const original =
      '[permissions]\nactive = "workspace-write"\n[mcp_servers.browser]\ncommand = "browser"\n[mcp_servers.next_actions]\ncommand = "old"\n[mcp_servers.next_actions.env]\nOLD = "old-secret"\n';
    const once = patchNextActionsConfig(original, '/app/node', '/app/server.mjs');
    expect(patchNextActionsConfig(once, '/app/node', '/app/server.mjs')).toBe(once);
    expect(once).toContain('command = "browser"');
    expect(once).toContain('active = "workspace-write"');
    expect(once).not.toContain('old-secret');
    expect(once).not.toContain(host.environment.EVOWORK_NEXT_ACTIONS_TOKEN);
  });
});
