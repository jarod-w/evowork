import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextActionStore, openStore, type Store } from '@evowork/store';
import type { ThreadGoal } from '@evowork/protocol';
import type { Adapter, QueuedInput } from '../src/adapter.js';
import { createNextActions, type NextActions } from '../src/next-actions.js';
import { makeThread } from './fake-app-server.js';

let store: Store;
let service: NextActions;
let bound: boolean;
let turnId: string;
let goal: ThreadGoal | undefined;
let queue: readonly QueuedInput[];
let adapter: Adapter;
const args = {
  outcome: 'delivered',
  actions: [{ title: '验证线上页面', prompt: '验证刚部署的页面是否正常。', reason: '已完成部署' }],
};
function running(id = 'one') {
  turnId = id;
  store.db
    .prepare(
      "UPDATE thread_projection SET last_turn_id=?,last_turn_status='inProgress',derived_status='running' WHERE thread_id='a'",
    )
    .run(id);
  service.onEvent({ type: 'turn-started', threadId: 'a', turnId: id });
}
function complete(status: 'completed' | 'failed' | 'interrupted' = 'completed', id = turnId) {
  store.db
    .prepare('UPDATE thread_projection SET last_turn_status=?,derived_status=? WHERE thread_id=?')
    .run(status, status, 'a');
  service.onEvent({ type: 'turn-completed', threadId: 'a', turnId: id, status });
}
beforeEach(() => {
  store = openStore({ path: ':memory:' });
  store.threads.upsertFromThread(makeThread({ id: 'a' }));
  bound = true;
  goal = undefined;
  queue = [];
  adapter = {
    resolveLocalToolCall: vi.fn(() =>
      bound ? { callId: 'call', turnId, generation: 1 } : undefined,
    ),
    getGoal: vi.fn(async () => goal),
    listQueuedInputs: vi.fn(async () => queue),
  } as unknown as Adapter;
  service = createNextActions({ store, adapter: () => adapter, changed: vi.fn() });
  running();
});
afterEach(() => store.close());
describe('下一步建议与执行队列分离', () => {
  it('缺少标题时指出每个字段，不保存半组候选、不触发补报重试', async () => {
    const raw = {
      outcome: 'delivered',
      actions: [{ prompt: '对比两天行情' }, { prompt: '核对事件时间' }],
    };
    expect(() => service.propose('a', raw)).toThrow(
      'actions[0].title 必须是 1–80 字符的非空字符串；actions[1].title 必须是 1–80 字符的非空字符串',
    );
    expect(new NextActionStore(store).get('a')).toBeUndefined();
    expect(await service.checkStop('a', 'one', false)).toEqual({});
    complete();
    expect(await service.list('a')).toEqual([]);
  });
  it.each([
    [null, 'arguments 必须是对象'],
    [{}, 'outcome 必须是 delivered 或 needs_input'],
    [{ ...args, actions: {} }, 'actions 必须是最多 3 条的数组'],
    [{ ...args, actions: Array(4).fill(args.actions[0]) }, 'actions 必须是最多 3 条的数组'],
    [{ ...args, actions: [null] }, 'actions[0] 必须是对象'],
    [{ ...args, actions: [{ title: ' ', prompt: '验证' }] }, 'actions[0].title'],
    [{ ...args, actions: [{ title: '验证', prompt: '' }] }, 'actions[0].prompt'],
    [{ ...args, actions: [{ title: '验证', prompt: '验证', reason: 3 }] }, 'actions[0].reason'],
    [{ ...args, outcome: 'needs_input' }, 'needs_input 时 actions 必须为空数组'],
  ])('非法参数给出具体字段且不写入候选 %#', (raw, field) => {
    expect(() => service.propose('a', raw)).toThrow(field);
    expect(new NextActionStore(store).get('a')).toBeUndefined();
  });
  it('额外字段只报告固定路径，不把未知键或用户正文放进错误', () => {
    const privateText = 'PRIVATE_CONTENT_SENTINEL';
    let message = '';
    try {
      service.propose('a', {
        ...args,
        [privateText]: privateText,
        actions: [{ ...args.actions[0], [privateText]: privateText }],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('arguments 包含不支持的字段');
    expect(message).toContain('actions[0] 包含不支持的字段');
    expect(message).not.toContain(privateText);
  });
  it('纯文本遗漏登记时只提醒一次，同回合重入与并发检查不能无限续跑', async () => {
    const results = await Promise.all([
      service.checkStop('a', 'one', false),
      service.checkStop('a', 'one', false),
    ]);
    expect(results.filter((result) => result.decision === 'block')).toHaveLength(1);
    expect(results.find((result) => result.decision === 'block')?.reason).toContain('needs_input');
    expect(await service.checkStop('a', 'one', true)).toEqual({});
    expect(await service.checkStop('a', 'one', false)).toEqual({});
    expect(store.db.prepare('SELECT * FROM follow_up_queue').all()).toEqual([]);
    expect(new NextActionStore(store).get('a')).toBeUndefined();
  });
  it('已提交空列表或已尝试失败的工具都不触发结束提醒', async () => {
    service.propose('a', { outcome: 'needs_input', actions: [] });
    expect(await service.checkStop('a', 'one', false)).toEqual({});
    running('two');
    service.onEvent({
      type: 'item-started',
      threadId: 'a',
      turnId: 'two',
      item: {
        type: 'mcpToolCall',
        id: 'failed',
        server: 'next_actions',
        tool: 'propose_next_actions',
      } as never,
    });
    expect(await service.checkStop('a', 'two', false)).toEqual({});
  });
  it('旧回合、非根任务、重建服务、活动目标和未知状态不能唤醒建议循环', async () => {
    expect(await service.checkStop('a', 'old', false)).toEqual({});
    expect(await service.checkStop('missing', 'one', false)).toEqual({});
    expect(await service.checkStop('a', 'one', true)).toEqual({});
    for (const [field, value, reset] of [
      ['archived', 1, 0],
      ['parent_thread_id', 'parent', null],
      ['automation_id', 'cron', null],
      ['last_turn_status', 'completed', 'inProgress'],
    ] as const) {
      store.db.prepare(`UPDATE thread_projection SET ${field}=? WHERE thread_id='a'`).run(value);
      expect(await service.checkStop('a', 'one', false)).toEqual({});
      store.db.prepare(`UPDATE thread_projection SET ${field}=? WHERE thread_id='a'`).run(reset);
    }
    goal = { status: 'budgetLimited' } as ThreadGoal;
    expect(await service.checkStop('a', 'one', false)).toEqual({});
    goal = undefined;
    queue = [{ id: 'pending', input: [] }];
    expect(await service.checkStop('a', 'one', false)).toEqual({});
    queue = [];
    vi.mocked(adapter.getGoal).mockRejectedValueOnce(new Error('offline'));
    expect(await service.checkStop('a', 'one', false)).toEqual({});
    service.interrupted();
    expect(await service.checkStop('a', 'one', false)).toEqual({});
    service = createNextActions({ store, adapter: () => adapter, changed: vi.fn() });
    expect(await service.checkStop('a', 'one', false)).toEqual({});
  });
  it('异步检查期间新回合开始，旧提醒不能作用到新回合', async () => {
    vi.mocked(adapter.getGoal).mockImplementationOnce(async () => {
      running('two');
      return undefined;
    });
    expect(await service.checkStop('a', 'one', false)).toEqual({});
    expect(await service.checkStop('a', 'two', false)).toMatchObject({ decision: 'block' });
  });
  it('回合结束前不可见，成功后只展示第一条，采纳只改变建议状态', async () => {
    service.propose('a', {
      ...args,
      actions: [...args.actions, { title: '汇总结果', prompt: '汇总验证结果。' }],
    });
    expect(await service.list('a')).toEqual([]);
    complete();
    const [suggestion] = await service.list('a');
    expect(suggestion).toMatchObject({
      threadId: 'a',
      sourceTurnId: 'one',
      prompt: args.actions[0]!.prompt,
    });
    expect(await service.list('a')).toHaveLength(1);
    expect(await service.act('a', suggestion!.id, 'accepted')).toEqual(suggestion);
    expect(await service.list('a')).toEqual([]);
    expect(store.db.prepare('SELECT * FROM follow_up_queue').all()).toEqual([]);
    await expect(service.act('a', suggestion!.id, 'accepted')).rejects.toThrow('失效');
  });
  it.each(['failed', 'interrupted'] as const)(
    '%s 不发布；新回合及旧完成通知不能复活建议',
    async (status) => {
      service.propose('a', args);
      complete(status);
      expect(await service.list('a')).toEqual([]);
      running('two');
      service.propose('a', args);
      service.onEvent({
        type: 'turn-completed',
        threadId: 'a',
        turnId: 'one',
        status: 'completed',
      });
      expect(await service.list('a')).toEqual([]);
      complete();
      expect(await service.list('a')).toHaveLength(1);
      running('three');
      expect(await service.list('a')).toEqual([]);
    },
  );
  it('无建议、等待输入、非法嵌套正文和未核对来源不生成可用建议', async () => {
    bound = false;
    expect(() => service.propose('a', args)).toThrow('来源');
    bound = true;
    for (const raw of [
      { ...args, threadId: 'foreign' },
      { ...args, actions: [{ ...args.actions[0], prompt: ' ' }] },
      { ...args, actions: [{ ...args.actions[0], targetThreadId: 'foreign' }] },
      { ...args, actions: Array(4).fill(args.actions[0]) },
      { ...args, outcome: 'needs_input' },
    ])
      expect(() => service.propose('a', raw)).toThrow();
    service.propose('a', { outcome: 'needs_input', actions: [] });
    complete();
    expect(await service.list('a')).toEqual([]);
  });
  it.each(['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited'] as const)(
    '目标 %s 时隐藏',
    async (status) => {
      service.propose('a', args);
      complete();
      goal = { status } as ThreadGoal;
      expect(await service.list('a')).toEqual([]);
      goal = { status: 'complete' } as ThreadGoal;
      expect(await service.list('a')).toHaveLength(1);
    },
  );
  it('队列、待审批、归档、子任务和自动化均不展示', async () => {
    service.propose('a', args);
    complete();
    queue = [{ id: 'pending', input: [] }];
    expect(await service.list('a')).toEqual([]);
    queue = [];
    for (const [field, value, reset] of [
      ['derived_status', 'pending', 'completed'],
      ['archived', 1, 0],
      ['parent_thread_id', 'parent', null],
      ['automation_id', 'cron', null],
    ] as const) {
      store.db.prepare(`UPDATE thread_projection SET ${field}=? WHERE thread_id='a'`).run(value);
      expect(await service.list('a')).toEqual([]);
      store.db.prepare(`UPDATE thread_projection SET ${field}=? WHERE thread_id='a'`).run(reset);
    }
    expect(await service.list('a')).toHaveLength(1);
  });
  it('查询目标时新回合开始，迟到响应不发布；目标未知不伪装成无目标', async () => {
    service.propose('a', args);
    complete();
    vi.mocked(adapter.getGoal).mockImplementation(async () => {
      running('new');
      return undefined;
    });
    expect(await service.list('a')).toEqual([]);
    service.propose('a', args);
    complete();
    vi.mocked(adapter.getGoal).mockRejectedValue(new Error('goal unavailable'));
    await expect(service.list('a')).rejects.toThrow('goal unavailable');
  });
  it('同时采纳与关闭只成功一次，不复活已经消费的建议', async () => {
    service.propose('a', args);
    complete();
    const [candidate] = await service.list('a');
    const results = await Promise.allSettled([
      service.act('a', candidate!.id, 'accepted'),
      service.act('a', candidate!.id, 'dismissed'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await service.list('a')).toEqual([]);
  });
  it('重建服务保留可用/关闭状态，丢弃未完成提案；删除清理正文', async () => {
    service.propose('a', args);
    complete();
    service = createNextActions({ store, adapter: () => adapter, changed: vi.fn() });
    const [candidate] = await service.list('a');
    await service.act('a', candidate!.id, 'dismissed');
    service = createNextActions({ store, adapter: () => adapter, changed: vi.fn() });
    expect(await service.list('a')).toEqual([]);
    running('new');
    service.propose('a', args);
    service.interrupted();
    complete();
    expect(await service.list('a')).toEqual([]);
    service.onEvent({ type: 'task-removed', threadId: 'a' });
    expect(new NextActionStore(store).get('a')).toBeUndefined();
  });
});
