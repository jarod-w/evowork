/**
 * 适配层的端到端（对着假内核）。
 *
 * 这一层的测试回答的是"整条链路对不对"，而不是单个函数对不对：
 * 发一条消息真的会先 `thread/start` 再 `turn/start`、筛选真的走投影表而不是全量拉、
 * 实验方法不可用时真的走了兜底、审批真的在 start 之前就有人接。
 */
import { ERROR_CODE, EXPERIMENTAL_METHOD } from '@evowork/protocol';
import { openStore, type Store } from '@evowork/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAdapter, type Adapter } from '../src/adapter.js';
import type { CapabilityReport } from '../src/capabilities.js';
import type { UiEvent } from '../src/events.js';
import { FakeAppServer, makeThread, makeTurn } from './fake-app-server.js';

let store: Store;
let server: FakeAppServer;
let adapter: Adapter;
let ui: UiEvent[];
let degradations: CapabilityReport[];

function immediateTimers() {
  const pending: (() => void)[] = [];
  return {
    setTimeoutFn: ((fn: () => void) => {
      pending.push(fn);
      return pending.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
    async flush(rounds = 3): Promise<void> {
      for (let i = 0; i < rounds; i += 1) {
        const batch = pending.splice(0, pending.length);
        for (const fn of batch) fn();
        await new Promise((r) => setImmediate(r));
      }
    },
  };
}

let timers: ReturnType<typeof immediateTimers>;

beforeEach(() => {
  store = openStore({ path: ':memory:' });
  server = new FakeAppServer();
  ui = [];
  degradations = [];
  timers = immediateTimers();
  adapter = createAdapter({
    store,
    sessionOptions: {
      launcher: server.launcher(),
      clientInfo: { name: 'evowork-desktop', version: '0.0.0' },
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      // 心跳在这些测试里没有意义，间隔设大一点省得干扰断言
      heartbeatIntervalMs: 10 ** 9,
    },
    onUiEvent: (e) => ui.push(e),
    onDegrade: (r) => degradations.push(r),
    readInstructions: (file) => (file === 'modes/craft.md' ? '你可以动手。' : undefined),
  });
});

afterEach(async () => {
  await adapter.stop();
  store.close();
});

describe('启动序列（09 §3.2）', () => {
  it('握手 → 权限档 → 功能开关 → 能力探测；审批处理器**在 start 之前**就位', async () => {
    const catalog = await adapter.start();

    const methods = server.received.map((r) => r.method);
    expect(methods.slice(0, 2)).toEqual(['initialize', 'initialized']);
    expect(methods).toContain('permissionProfile/list');
    expect(methods).toContain('experimentalFeature/list');
    expect(methods).toContain('project/list'); // 能力探测

    // F4：allowed=false 的档位要保留在目录里（企业策略置灰，而不是隐藏）
    expect(catalog.permissionProfiles.find((p) => p.id === ':danger-full-access')?.allowed).toBe(
      false,
    );
    expect(catalog.scenarios.map((s) => s.id)).toEqual(['office', 'code', 'design']);
    expect(catalog.modes.map((m) => m.id)).toEqual(['craft', 'plan', 'ask']);
  });

  it('内核在握手后立刻发审批请求也有人接（F14 的窗口期）', async () => {
    const asked: string[] = [];
    const withApproval = createAdapter({
      store,
      sessionOptions: {
        launcher: server.launcher(),
        clientInfo: { name: 'evowork-desktop', version: '0.0.0' },
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
        heartbeatIntervalMs: 10 ** 9,
      },
      askApproval: async (a) => {
        asked.push(a.kind);
        return { decision: 'accept' };
      },
    });
    await withApproval.start();

    const reply = await server.requestClient('item/commandExecution/requestApproval', {
      threadId: 't1',
      itemId: 'i1',
    });
    expect(asked).toEqual(['command']);
    expect(reply).toEqual({ decision: 'accept' });
    await withApproval.stop();
  });

  it('没有提供 askApproval 时一律 decline —— 没人能确认时选择不做', async () => {
    await adapter.start();
    const reply = await server.requestClient('item/fileChange/requestApproval', {
      threadId: 't1',
      itemId: 'i1',
    });
    expect(reply).toEqual({ decision: 'decline' });
  });

  it('`experimentalFeature/list` 失败不阻塞启动（它只是功能开关清单，F18）', async () => {
    server.removeMethod('experimentalFeature/list');
    const catalog = await adapter.start();
    expect(catalog.experimentalFeatures).toEqual([]);
    expect(catalog.permissionProfiles.length).toBeGreaterThan(0);
  });

  it('探测发现 project/* 不可用 → 显式降级（09 §3.3）', async () => {
    server.removeMethod('project/list');
    await adapter.start();
    expect(degradations.map((d) => d.method)).toContain(EXPERIMENTAL_METHOD.projectList);
    expect(adapter.degradations()[0]?.degradation?.userVisible).toContain('项目');
  });
});

describe('新建任务（03 §4.6）', () => {
  it('thread/start → turn/start，且投影表记下 EvoWork 的初值', async () => {
    await adapter.start();
    const result = await adapter.createTask({
      input: [{ type: 'text', text: '生成一份季度汇报 pptx' }],
      scenarioId: 'office',
      overrides: { cwd: '/Users/x/work/weekly' },
    });

    const order = server.received.map((r) => r.method);
    expect(order.indexOf('thread/start')).toBeLessThan(order.indexOf('turn/start'));

    const row = store.threads.get(result.threadId);
    expect(row?.scenario_id).toBe('office');
    expect(row?.mode_id).toBe('craft');
    expect(row?.permission_id).toBe('evowork-workspace');

    // turn/start 带上了展开后的 collaborationMode（F1）
    const turnStart = server.received.find((r) => r.method === 'turn/start');
    expect(turnStart?.params.collaborationMode).toMatchObject({
      mode: 'default',
      settings: { developerInstructions: '你可以动手。' },
    });
    // F5：permissions 与 sandbox 不同传
    expect(turnStart?.params.permissions).toBe('evowork-workspace');
    expect(turnStart?.params.sandboxPolicy).toBeUndefined();
  });

  it('Ask 模式的任务：权限锁到只读，指令来自 config（无需内核补丁，F1）', async () => {
    await adapter.start();
    await adapter.createTask({
      input: [{ type: 'text', text: '这个项目是怎么组织的？' }],
      overrides: { modeId: 'ask', permissions: 'evowork-full' },
    });
    const threadStart = server.received.find((r) => r.method === 'thread/start');
    expect(threadStart?.params.permissions).toBe('evowork-ask');
  });

  it('打开的 thread 会被登记，供崩溃后恢复用（09 §1）', async () => {
    await adapter.start();
    const { threadId } = await adapter.createTask({ input: [{ type: 'text', text: 'x' }] });
    expect(adapter.session.openThreads.has(threadId)).toBe(true);
    adapter.closeTask(threadId);
    expect(adapter.session.openThreads.has(threadId)).toBe(false);
  });
});

describe('发消息与排队（04 §5.4 / §5.5）', () => {
  it('执行中发消息**入队而不是报错**', async () => {
    await adapter.start();
    const { threadId } = await adapter.createTask({ input: [{ type: 'text', text: 'x' }] });
    // 让任务处于运行中
    adapter.events.handle('thread/status/changed', {
      threadId,
      status: { active: { activeFlags: [] } },
    });
    server.handlers.set('thread/queue/add', () => ({ ok: true }));

    const result = await adapter.sendMessage({
      threadId,
      input: [{ type: 'text', text: '再加一页目录' }],
    });

    expect(result.queued).toBe(true);
    expect(server.received.map((r) => r.method)).toContain('thread/queue/add');
  });

  it('`thread/queue/*` 不可用 → 退回本机队列（09 §3.3），**不报错**', async () => {
    await adapter.start();
    const { threadId } = await adapter.createTask({ input: [{ type: 'text', text: 'x' }] });
    adapter.events.handle('thread/status/changed', {
      threadId,
      status: { active: { activeFlags: [] } },
    });
    server.removeMethod('thread/queue/add'); // → -32601

    const result = await adapter.sendMessage({
      threadId,
      input: [{ type: 'text', text: '再加一页' }],
    });

    // queued=false 表示"内核队列没接住，改由本机队列托管"
    expect(result.queued).toBe(false);
    expect(degradations.map((d) => d.method)).toContain(EXPERIMENTAL_METHOD.threadQueueAdd);
    expect(adapter.degradations().map((d) => d.degradation?.userVisible)).toContain(
      '排队仍可用（队列只在这台电脑上）。',
    );
  });

  it('「立即插话」走 turn/steer 而不是入队（默认排队，04 §5.5）', async () => {
    await adapter.start();
    const { threadId } = await adapter.createTask({ input: [{ type: 'text', text: 'x' }] });
    adapter.events.handle('thread/status/changed', {
      threadId,
      status: { active: { activeFlags: [] } },
    });

    await adapter.sendMessage({
      threadId,
      input: [{ type: 'text', text: '停一下，换个角度' }],
      steer: true,
    });
    expect(server.received.map((r) => r.method)).toContain('turn/steer');
  });

  it('空闲任务发消息 = 新的 turn，且沿用任务自身的设置（04 §4.3）', async () => {
    await adapter.start();
    const { threadId } = await adapter.createTask({
      input: [{ type: 'text', text: 'x' }],
      overrides: { modeId: 'craft' },
    });
    adapter.setTaskSettings(threadId, { modeId: 'plan' });
    adapter.events.handle('turn/completed', {
      threadId,
      turn: makeTurn({ id: 'turn1', status: 'completed' }),
    });

    await adapter.sendMessage({ threadId, input: [{ type: 'text', text: '继续' }] });

    const last = server.received.filter((r) => r.method === 'turn/start').at(-1);
    // 任务级设置生效：模式已经是 plan
    expect(last?.params.collaborationMode).toMatchObject({ mode: 'plan' });
  });

  it('中断走 turn/interrupt（04 §5.5）', async () => {
    await adapter.start();
    const { threadId } = await adapter.createTask({ input: [{ type: 'text', text: 'x' }] });
    await adapter.interrupt(threadId);
    expect(server.received.map((r) => r.method)).toContain('turn/interrupt');
  });
});

describe('任务列表与筛选（04 §3.4）', () => {
  it('筛选走投影表 —— **不是**全量拉再本地过滤（上千任务时会卡）', async () => {
    await adapter.start();
    const before = server.received.length;

    // 时间戳刻意不同：真实数据里它们几乎不会相同，而"相同时怎么排"由投影表的
    // 第二排序键（thread_id）保证稳定，不靠这里
    for (const [id, status, updatedAt] of [
      ['t-run', 'running', 3000],
      ['t-done', 'completed', 2000],
      ['t-fail', 'failed', 1000],
    ] as const) {
      store.db
        .prepare(
          `INSERT INTO thread_projection(thread_id, derived_status, updated_at, recency_at, title)
           VALUES(?,?,?,?,?)`,
        )
        .run(id, status, updatedAt, updatedAt, id);
    }

    const list = adapter.listTasks({ statuses: ['running', 'failed'] });

    expect(list.map((t) => t.threadId)).toEqual(['t-run', 't-fail']);
    // 关键：筛选**没有**产生任何协议调用
    expect(server.received.length).toBe(before);
  });

  it('第 ② 步只对可见页拉权威元数据（`thread/read`，有界）', async () => {
    await adapter.start();
    const ids = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const refreshed = await adapter.refreshAuthoritative(ids);
    const reads = server.received.filter((r) => r.method === 'thread/read');
    expect(reads).toHaveLength(30); // 默认页大小
    expect(refreshed).toBe(30);
  });

  it('对账：补齐新 thread、清理内核已删除的（09 §4.1）', async () => {
    await adapter.start();
    store.db
      .prepare(
        `INSERT INTO thread_projection(thread_id, derived_status) VALUES('stale','completed')`,
      )
      .run();
    server.handlers.set('thread/list', () => ({
      data: [makeThread({ id: 'fresh', name: '新任务' })],
      nextCursor: null,
    }));

    const result = await adapter.reconcile();

    expect(result).toEqual({ upserted: 1, removed: 1 });
    expect(store.threads.get('fresh')?.title).toBe('新任务');
    expect(store.threads.get('stale')).toBeUndefined();
    // 用 useStateDbOnly 避免全量扫 rollout（09 §4.1 明写）
    const call = server.received.find((r) => r.method === 'thread/list');
    expect(call?.params.useStateDbOnly).toBe(true);
  });
});

describe('打开任务（04 §9：< 300ms 出内容）', () => {
  it('先给缓存摘要，再用 thread/items/list 校正', async () => {
    await adapter.start();
    store.putItemDigest({
      threadId: 't1',
      seq: 1,
      itemId: 'i1',
      itemType: 'agentMessage',
      summary: '好的，我先读表头',
      createdAt: 1,
    });
    server.handlers.set('thread/items/list', () => ({
      data: [{ id: 'i1', type: 'agentMessage', text: '好的，我先读表头，然后分组计算' }],
    }));

    const { cached, items } = await adapter.openTask('t1');

    // 缓存是同步可用的
    expect(cached).toHaveLength(1);
    expect(cached[0]?.summary).toBe('好的，我先读表头');
    // 权威内容随后到达
    await expect(items).resolves.toHaveLength(1);
  });
});

describe('预算（Q11：用内核的 ThreadGoal.budget，不自建）', () => {
  it('setBudget 调 thread/goal/set 并同步投影表', async () => {
    await adapter.start();
    const { threadId } = await adapter.createTask({ input: [{ type: 'text', text: 'x' }] });
    await adapter.setBudget(threadId, 200_000);
    const call = server.received.find((r) => r.method === 'thread/goal/set');
    expect(call?.params).toMatchObject({ threadId, budget: 200_000 });
    expect(store.threads.get(threadId)?.budget_limit).toBe(200_000);
  });
});

describe('通知驱动 UI（09 §3.4 的端到端）', () => {
  it('内核发通知 → 落库 → UI 收到语义化事件（不含协议方法名）', async () => {
    await adapter.start();
    server.notify('thread/started', { thread: makeThread({ id: 't1', name: '季度汇报' }) });
    await new Promise((r) => setImmediate(r));

    expect(store.threads.get('t1')?.title).toBe('季度汇报');
    expect(ui).toEqual(
      expect.arrayContaining([{ type: 'task-created', threadId: 't1', title: '季度汇报' }]),
    );
    // UI 事件里没有任何协议方法名 —— 前端不该认识它们（K2）
    expect(JSON.stringify(ui)).not.toContain('thread/started');
  });

  it('未识别的通知记形状 + 让 UI 显示一行（R2 雷达）', async () => {
    await adapter.start();
    server.notify('item/brandNewKind', { threadId: 't1', payload: {} });
    await new Promise((r) => setImmediate(r));

    const rows = store.db.prepare('SELECT method FROM unknown_event').all() as { method: string }[];
    expect(rows.map((r) => r.method)).toContain('item/brandNewKind');
  });
});

describe('崩溃恢复的端到端（09 §1）', () => {
  it('崩溃后恢复所有打开的任务，并保留审批处理器', async () => {
    const asked: string[] = [];
    const notices: string[] = [];
    const withRecovery = createAdapter({
      store,
      sessionOptions: {
        launcher: server.launcher(),
        clientInfo: { name: 'evowork-desktop', version: '0.0.0' },
        setTimeoutFn: timers.setTimeoutFn,
        clearTimeoutFn: timers.clearTimeoutFn,
        heartbeatIntervalMs: 10 ** 9,
      },
      onNotice: (n) => notices.push(n.kind),
      askApproval: async (a) => {
        asked.push(a.itemId ?? '');
        return { decision: 'accept' };
      },
    });
    await withRecovery.start();
    const { threadId } = await withRecovery.createTask({ input: [{ type: 'text', text: 'x' }] });

    server.crash();
    await timers.flush(4);

    expect(server.launches).toBe(2);
    expect(notices).toContain('kernel-restarted');
    // 重启后审批仍然有人接
    await server.requestClient('item/commandExecution/requestApproval', {
      threadId,
      itemId: 'after',
    });
    expect(asked).toEqual(['after']);
    await withRecovery.stop();
  });
});

describe('实验方法门禁（K2）', () => {
  it('如果我们忘了声明 experimentalApi，错误会响亮地抛出而不是被当成降级', async () => {
    await adapter.start();
    server.handlers.set('thread/queue/add', () => {
      const err = new Error('thread/queue/add requires experimentalApi capability');
      (err as { code?: number }).code = ERROR_CODE.invalidRequest;
      throw err;
    });
    const { threadId } = await adapter.createTask({ input: [{ type: 'text', text: 'x' }] });
    adapter.events.handle('thread/status/changed', {
      threadId,
      status: { active: { activeFlags: [] } },
    });

    // 假内核把它作为 internalError 抛出（不是 -32601），因此不该被判成降级
    await expect(
      adapter.sendMessage({ threadId, input: [{ type: 'text', text: 'y' }] }),
    ).rejects.toThrow();
    expect(adapter.capabilities.isUsable(EXPERIMENTAL_METHOD.threadQueueAdd)).toBe(true);
  });
});
