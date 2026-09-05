import { NOTIFICATION } from '@evowork/protocol';
import { openStore, type Store } from '@evowork/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createEventRouter, type SideEffect, type UiEvent } from '../src/events.js';
import { makeThread, makeTurn } from './fake-app-server.js';

let store: Store;
let ui: UiEvent[];
let effects: SideEffect[];
let router: ReturnType<typeof createEventRouter>;

beforeEach(() => {
  store = openStore({ path: ':memory:' });
  ui = [];
  effects = [];
  router = createEventRouter({
    store,
    onUiEvent: (e) => ui.push(e),
    onSideEffect: (e) => effects.push(e),
    now: () => 1_757_000_000_000,
  });
});

afterEach(() => {
  store.close();
});

describe('顺序：落库 → UI → 副作用（09 §3.4，"落库优先是刻意的"）', () => {
  it('副作用在落库之后才发生 —— 而且是**结构上**保证的（handler 只能返回副作用）', () => {
    router.handle(NOTIFICATION.threadStarted, { thread: makeThread({ id: 't1' }) });
    // 落库先发生
    expect(store.threads.get('t1')).toBeDefined();

    const observed: string[] = [];
    const ordered = createEventRouter({
      store,
      onUiEvent: () => observed.push('ui'),
      onSideEffect: () => observed.push('effect'),
    });
    ordered.handle(NOTIFICATION.turnCompleted, {
      threadId: 't1',
      turn: makeTurn({ id: 'turn1', status: 'completed' }),
    });
    // UI 事件全部先于副作用
    expect(observed.indexOf('effect')).toBeGreaterThan(observed.lastIndexOf('ui'));
  });

  it('UI 崩溃后能从投影表恢复 —— 这就是"落库优先"换来的东西', () => {
    router.handle(NOTIFICATION.threadStarted, { thread: makeThread({ id: 't1' }) });
    router.handle(NOTIFICATION.threadStatusChanged, {
      threadId: 't1',
      status: { active: { activeFlags: ['waitingOnApproval'] } },
    });
    // 假设此刻 UI 刷新（丢掉全部内存状态）
    ui = [];
    expect(store.threads.get('t1')?.derived_status).toBe('pending');
  });
});

describe('09 §3.4 的分发表逐行', () => {
  it('thread/started → 建行 + 侧边栏插入', () => {
    router.handle(NOTIFICATION.threadStarted, {
      thread: makeThread({ id: 't1', name: '季度汇报' }),
    });
    expect(store.threads.get('t1')?.title).toBe('季度汇报');
    expect(ui).toEqual([
      { type: 'task-created', threadId: 't1', title: '季度汇报' },
      { type: 'task-status', threadId: 't1', status: 'idle' },
    ]);
  });

  it('thread/status/changed → 更新状态，待处理时**发通知**（用户可能在别的页面）', () => {
    router.handle(NOTIFICATION.threadStarted, { thread: makeThread({ id: 't1' }) });
    effects = [];
    router.handle(NOTIFICATION.threadStatusChanged, {
      threadId: 't1',
      status: { active: { activeFlags: ['waitingOnUserInput'] } },
    });
    expect(store.threads.get('t1')?.derived_status).toBe('pending');
    expect(effects).toEqual([{ kind: 'notify', reason: 'PENDING_APPROVAL' }]);

    // 进行中不发通知（否则通知会泛滥）
    effects = [];
    router.handle(NOTIFICATION.threadStatusChanged, {
      threadId: 't1',
      status: { active: { activeFlags: [] } },
    });
    expect(effects).toEqual([]);
  });

  it('thread/name/updated → 更新标题 + 触发全文索引更新', () => {
    router.handle(NOTIFICATION.threadStarted, { thread: makeThread({ id: 't1' }) });
    effects = [];
    router.handle(NOTIFICATION.threadNameUpdated, { threadId: 't1', name: '新名字' });
    expect(store.threads.get('t1')?.title).toBe('新名字');
    expect(effects).toEqual([{ kind: 'index-title', threadId: 't1' }]);
  });

  it('turn/started 与 turn/completed 一对一地加减并发计数（Q11 的闸门数据源）', () => {
    router.handle(NOTIFICATION.threadStarted, { thread: makeThread({ id: 't1' }) });
    effects = [];
    router.handle(NOTIFICATION.turnStarted, { threadId: 't1', turn: makeTurn({ id: 'turn1' }) });
    expect(effects).toEqual([{ kind: 'concurrency', delta: 1 }]);

    effects = [];
    router.handle(NOTIFICATION.turnCompleted, {
      threadId: 't1',
      turn: makeTurn({ id: 'turn1', status: 'completed' }),
    });
    expect(effects).toEqual([
      { kind: 'concurrency', delta: -1 },
      { kind: 'notify', reason: 'TURN_DONE' },
    ]);
  });

  it('turn/completed 记 last_turn_status —— 三个终态唯一的来源（F7）', () => {
    router.handle(NOTIFICATION.threadStarted, { thread: makeThread({ id: 't1' }) });
    router.handle(NOTIFICATION.turnCompleted, {
      threadId: 't1',
      turn: makeTurn({ id: 'turn1', status: 'interrupted' }),
    });
    expect(store.threads.get('t1')?.derived_status).toBe('interrupted');
    expect(ui.at(-1)).toEqual({ type: 'task-status', threadId: 't1', status: 'interrupted' });
  });

  it('来自定时任务的回合额外产生 automation-run-finished（09 §3.4 第 7 行）', () => {
    router.handle(NOTIFICATION.threadStarted, { thread: makeThread({ id: 't1' }) });
    store.db
      .prepare(`UPDATE thread_projection SET automation_id = 'a1' WHERE thread_id = 't1'`)
      .run();
    effects = [];
    router.handle(NOTIFICATION.turnCompleted, {
      threadId: 't1',
      turn: makeTurn({ id: 'turn1', status: 'failed' }),
    });
    expect(effects).toEqual([
      { kind: 'concurrency', delta: -1 },
      { kind: 'notify', reason: 'TURN_FAILED' },
      { kind: 'automation-run-finished', threadId: 't1', status: 'failed' },
    ]);
  });

  it('turn/plan/updated → 存快照并派生「规划中」', () => {
    router.handle(NOTIFICATION.threadStarted, { thread: makeThread({ id: 't1' }) });
    store.threads.setTaskSettings('t1', { modeId: 'plan' });
    router.handle(NOTIFICATION.turnPlanUpdated, {
      threadId: 't1',
      turnId: 'turn1',
      steps: [{ step: '读表头', status: 'pending' }],
    });
    expect(store.threads.get('t1')?.derived_status).toBe('planning');
    expect(ui.map((e) => e.type)).toContain('plan-updated');
  });

  it('turn/diff/updated **不落库**（聚合 diff 可能很大，随时可再拿）', () => {
    router.handle(NOTIFICATION.turnDiffUpdated, {
      threadId: 't1',
      turnId: 'turn1',
      diff: 'x'.repeat(1000),
    });
    expect(ui).toEqual([{ type: 'diff-updated', threadId: 't1', turnId: 'turn1' }]);
    // 库里没有任何 diff 的痕迹
    const dump = JSON.stringify(store.db.prepare('SELECT * FROM item_digest').all());
    expect(dump).not.toContain('xxxx');
  });

  it('item/completed 存一行摘要（不存完整内容），FileChange 触发产物识别', () => {
    effects = [];
    router.handle(NOTIFICATION.itemCompleted, {
      threadId: 't1',
      turnId: 'turn1',
      completedAtMs: 1_757_000_000_000,
      item: { id: 'i1', type: 'fileChange', changes: [{ path: '/w/report.docx', kind: 'add' }] },
    });
    const digest = store.readItemDigest('t1');
    expect(digest).toHaveLength(1);
    expect(digest[0]?.summary).toBe('改动 1 个文件');
    // 路径不进摘要（文件名可能含客户名）
    expect(JSON.stringify(digest)).not.toContain('report.docx');
    expect(effects[0]?.kind).toBe('artifact-scan');
  });

  it('agentMessage 摘要被截断 —— 投影表不是正文仓库', () => {
    const long = '这是一段很长的回复。'.repeat(30);
    router.handle(NOTIFICATION.itemCompleted, {
      threadId: 't1',
      turnId: 'turn1',
      item: { id: 'i1', type: 'agentMessage', text: long },
    });
    const summary = store.readItemDigest('t1')[0]?.summary ?? '';
    expect(summary.length).toBeLessThanOrEqual(80);
  });

  it('流式增量**不落库**，只发 UI（04 §5.1：按 item id 合并）', () => {
    router.handle(NOTIFICATION.itemAgentMessageDelta, {
      threadId: 't1',
      itemId: 'i1',
      delta: '好的，',
    });
    router.handle(NOTIFICATION.itemReasoningTextDelta, {
      threadId: 't1',
      itemId: 'i2',
      delta: '先看表头',
    });
    expect(ui).toEqual([
      {
        type: 'item-delta',
        threadId: 't1',
        itemId: 'i1',
        channel: 'agentMessage',
        delta: '好的，',
      },
      { type: 'item-delta', threadId: 't1', itemId: 'i2', channel: 'reasoning', delta: '先看表头' },
    ]);
    expect(store.readItemDigest('t1')).toHaveLength(0);
  });

  it('tokenUsage → 累加用量并触发预算闸门检查（Q11）', () => {
    router.handle(NOTIFICATION.threadStarted, { thread: makeThread({ id: 't1' }) });
    effects = [];
    router.handle(NOTIFICATION.threadTokenUsageUpdated, {
      threadId: 't1',
      turnId: 'turn1',
      tokenUsage: { total: { inputTokens: 100, outputTokens: 50 }, last: {} },
    });
    expect(store.threads.get('t1')?.token_input).toBe(100);
    expect(effects).toEqual([{ kind: 'budget-check', threadId: 't1' }]);
  });

  it('归档 / 取消归档 / 删除', () => {
    router.handle(NOTIFICATION.threadStarted, { thread: makeThread({ id: 't1' }) });
    router.handle(NOTIFICATION.threadArchived, { threadId: 't1' });
    expect(store.threads.get('t1')?.derived_status).toBe('archived');
    router.handle(NOTIFICATION.threadUnarchived, { threadId: 't1' });
    expect(store.threads.get('t1')?.derived_status).toBe('idle');
    router.handle(NOTIFICATION.threadDeleted, { threadId: 't1' });
    expect(store.threads.get('t1')).toBeUndefined();
    expect(ui.at(-1)).toEqual({ type: 'task-removed', threadId: 't1' });
  });

  it('内核 warning 要显示给用户 —— 「不落盘」不等于「不显示」', () => {
    router.handle(NOTIFICATION.warning, { message: '工作空间里有软链接指向外部目录' });
    expect(ui).toEqual([{ type: 'kernel-warning', text: '工作空间里有软链接指向外部目录' }]);
  });
});

describe('未识别通知（R2 雷达 + 04 §5.2 最后一段）', () => {
  it('记形状（不记正文）+ 让 UI 显示一行，**绝不静默丢弃**', () => {
    router.handle('item/brandNewKind', { threadId: 't1', text: '帮我分析鹏程公司的账款' });

    const rows = store.db.prepare('SELECT method, shape FROM unknown_event').all() as {
      method: string;
      shape: string;
    }[];
    expect(rows[0]?.method).toBe('item/brandNewKind');
    expect(rows[0]?.shape).toBe('text:string|threadId:string');
    expect(JSON.stringify(rows)).not.toContain('鹏程');
    expect(ui).toEqual([{ type: 'unknown-event', method: 'item/brandNewKind' }]);
  });

  it('一条坏通知不该让整个事件流停下来', () => {
    // 缺 thread 字段
    expect(() => router.handle(NOTIFICATION.threadStarted, {})).not.toThrow();
    // params 不是对象
    expect(() => router.handle(NOTIFICATION.threadStatusChanged, null)).not.toThrow();
    // 之后仍能正常处理
    router.handle(NOTIFICATION.threadStarted, { thread: makeThread({ id: 't9' }) });
    expect(store.threads.get('t9')).toBeDefined();
  });

  it('订阅面覆盖 09 §3.4 表里的关键行', () => {
    const methods = router.methods();
    for (const required of [
      NOTIFICATION.threadStarted,
      NOTIFICATION.threadStatusChanged,
      NOTIFICATION.threadNameUpdated,
      NOTIFICATION.turnStarted,
      NOTIFICATION.turnCompleted,
      NOTIFICATION.turnPlanUpdated,
      NOTIFICATION.turnDiffUpdated,
      NOTIFICATION.itemStarted,
      NOTIFICATION.itemCompleted,
      NOTIFICATION.itemAgentMessageDelta,
      NOTIFICATION.threadQueueChanged,
      NOTIFICATION.threadTokenUsageUpdated,
      NOTIFICATION.skillsChanged,
      NOTIFICATION.mcpServerStartupStatusUpdated,
      NOTIFICATION.projectChanged,
      NOTIFICATION.accountRateLimitsUpdated,
    ]) {
      expect(methods, `缺少订阅：${required}`).toContain(required);
    }
  });
});
