import { SERVER_REQUEST } from '@evowork/protocol';
import { describe, expect, it } from 'vitest';

import {
  createApprovalRouter,
  INTERACTIVE_POLICY,
  UNATTENDED_POLICY,
  type ApprovalReply,
  type PendingApproval,
} from '../src/approvals.js';

/** 手动推进的定时器：审批的超时策略以分钟计，测试不能真等。 */
function manualTimers() {
  const queue: { at: number; fn: () => void }[] = [];
  let clock = 0;
  return {
    now: () => clock,
    setTimeoutFn: ((fn: () => void, ms = 0) => {
      queue.push({ at: clock + ms, fn });
      return queue.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
    async advance(ms: number): Promise<void> {
      clock += ms;
      const due = queue.filter((t) => t.at <= clock);
      for (const t of due) {
        queue.splice(queue.indexOf(t), 1);
        t.fn();
      }
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe('审批必须回复（F14：内核会一直等）', () => {
  it('用户的决定被转成内核认识的形状', async () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    const reply = await router.handle(SERVER_REQUEST.commandExecutionRequestApproval, {
      threadId: 't1',
      itemId: 'i1',
      command: 'pip install openpyxl',
    });
    expect(reply).toEqual({ decision: 'accept' });
  });

  it('追问卡回的是答案而不是决定（形状不同，混用内核不认）', async () => {
    const router = createApprovalRouter({
      ask: async () => ({ decision: 'accept', answer: '用 2026Q2 的数据' }),
    });
    const reply = await router.handle(SERVER_REQUEST.toolRequestUserInput, {
      threadId: 't1',
      itemId: 'i1',
      question: '用哪个季度的数据？',
    });
    expect(reply).toEqual({ answer: '用 2026Q2 的数据' });
  });

  it('选项式追问回 optionId', async () => {
    const router = createApprovalRouter({
      ask: async () => ({ decision: 'accept', optionId: 'q2' }),
    });
    const reply = await router.handle(SERVER_REQUEST.toolRequestUserInput, {
      threadId: 't1',
      itemId: 'i1',
      options: [{ id: 'q1' }, { id: 'q2' }],
    });
    expect(reply).toEqual({ optionId: 'q2' });
  });

  it('**UI 侧出错时也必须回复**，且回 decline（出错时选择不做，而不是选择做）', async () => {
    const router = createApprovalRouter({
      ask: async () => {
        throw new Error('窗口被关掉了');
      },
    });
    const reply = await router.handle(SERVER_REQUEST.fileChangeRequestApproval, {
      threadId: 't1',
      itemId: 'i1',
    });
    expect(reply).toEqual({ decision: 'decline' });
  });

  it('不支持的方法明确报错，而不是回一个内核不认识的形状', async () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    await expect(router.handle('item/somethingElse', {})).rejects.toThrow(/未支持/);
  });
});

describe('两套超时策略（10 §3.6）', () => {
  it('交互式任务：提醒 → 升级，但**不自动拒绝**（用户回来还能继续）', async () => {
    const timers = manualTimers();
    const stages: string[] = [];
    let resolveUser: (r: ApprovalReply) => void = () => {};
    const router = createApprovalRouter({
      ask: () => new Promise<ApprovalReply>((resolve) => (resolveUser = resolve)),
      isUnattended: () => false,
      onTimeoutStage: (_a, stage) => stages.push(stage),
      now: timers.now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const inflight = router.handle(SERVER_REQUEST.commandExecutionRequestApproval, {
      threadId: 't1',
      itemId: 'i1',
    });

    await timers.advance(INTERACTIVE_POLICY.remindAfterMs);
    expect(stages).toEqual(['remind']);

    await timers.advance(INTERACTIVE_POLICY.escalateAfterMs);
    expect(stages).toEqual(['remind', 'escalate']);

    // 再过两小时也不会自动拒绝
    await timers.advance(2 * 60 * 60_000);
    expect(stages).toEqual(['remind', 'escalate']);
    expect(router.pendingList()).toHaveLength(1);

    resolveUser({ decision: 'accept' });
    await expect(inflight).resolves.toEqual({ decision: 'accept' });
    expect(router.pendingList()).toHaveLength(0);
  });

  it('定时任务：**超时 10 分钟自动 Decline**（没人看着，挂着会占并发额度）', async () => {
    const timers = manualTimers();
    const stages: string[] = [];
    const router = createApprovalRouter({
      // 用户永不回复
      ask: () => new Promise<ApprovalReply>(() => {}),
      isUnattended: () => true,
      onTimeoutStage: (_a, stage) => stages.push(stage),
      now: timers.now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const inflight = router.handle(SERVER_REQUEST.commandExecutionRequestApproval, {
      threadId: 't-auto',
      itemId: 'i1',
    });

    await timers.advance(UNATTENDED_POLICY.autoDeclineAfterMs ?? 0);
    await expect(inflight).resolves.toEqual({ decision: 'decline' });
    expect(stages).toContain('auto-decline');
    expect(router.pendingList()).toHaveLength(0);
  });

  it('无人值守判定来自"这个 thread 是不是定时任务"，默认按交互式（更保守）', async () => {
    const timers = manualTimers();
    const seen: PendingApproval[] = [];
    const router = createApprovalRouter({
      ask: async (a) => {
        seen.push(a);
        return { decision: 'accept' };
      },
      // 不提供 isUnattended
      now: timers.now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await router.handle(SERVER_REQUEST.commandExecutionRequestApproval, {
      threadId: 't1',
      itemId: 'i1',
    });
    expect(seen[0]?.unattended).toBe(false);
  });
});

describe('待审批队列的全局可见性（10 §3.5）', () => {
  it('按到达顺序排列，**不做"全部允许"**', async () => {
    const timers = manualTimers();
    const snapshots: readonly PendingApproval[][] = [];
    const pushes: PendingApproval[][] = [];
    const router = createApprovalRouter({
      ask: () => new Promise<ApprovalReply>(() => {}),
      onPendingChanged: (list) => pushes.push([...list]),
      now: timers.now,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    void router.handle(SERVER_REQUEST.commandExecutionRequestApproval, {
      threadId: 't1',
      itemId: 'first',
    });
    await timers.advance(1000);
    void router.handle(SERVER_REQUEST.fileChangeRequestApproval, {
      threadId: 't2',
      itemId: 'second',
    });

    const list = router.pendingList();
    expect(list.map((a) => a.itemId)).toEqual(['first', 'second']);
    expect(list.map((a) => a.kind)).toEqual(['command', 'fileChange']);
    expect(pushes.at(-1)).toHaveLength(2);
    expect(snapshots).toHaveLength(0);
  });
});

describe('「本次任务内都允许」的可用条件（10 §3.3）', () => {
  function approval(over: Partial<PendingApproval>): PendingApproval {
    return {
      id: 'a1',
      kind: 'fileChange',
      threadId: 't1',
      params: {},
      receivedAtMs: 0,
      unattended: false,
      ...over,
    };
  }

  it('批量变更**不提供** —— 一次点击放开整个会话的写权限风险过高', () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    expect(
      router.allowsAcceptForSession(
        approval({
          params: {
            changes: [
              { path: '/w/a.txt', kind: 'add' },
              { path: '/w/b.txt', kind: 'add' },
            ],
          },
        }),
      ),
    ).toBe(false);
  });

  it('单文件、非删除的变更可以提供', () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    expect(
      router.allowsAcceptForSession(
        approval({ params: { changes: [{ path: '/w/a.txt', kind: 'add' }] } }),
      ),
    ).toBe(true);
  });

  it('删除操作不提供（10 §3.3：删除单独着色且不折叠，更不该被一键放开）', () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    expect(
      router.allowsAcceptForSession(
        approval({ params: { changes: [{ path: '/w/a.txt', kind: 'delete' }] } }),
      ),
    ).toBe(false);
  });

  it('命令审批可以提供（它的范围是"这条命令"，不是"整个工作空间的写权限"）', () => {
    const router = createApprovalRouter({ ask: async () => ({ decision: 'accept' }) });
    expect(router.allowsAcceptForSession(approval({ kind: 'command' }))).toBe(true);
  });
});

describe('审批日志不带正文（10 §6 的"不记什么"）', () => {
  it('命令、diff、追问正文都不进日志字段', async () => {
    const records: { event: string; fields: Record<string, unknown> }[] = [];
    const fakeLogger = {
      debug: () => {},
      info: (event: string, fields?: Record<string, unknown>) =>
        records.push({ event, fields: fields ?? {} }),
      warn: (event: string, fields?: Record<string, unknown>) =>
        records.push({ event, fields: fields ?? {} }),
      error: (event: string, fields?: Record<string, unknown>) =>
        records.push({ event, fields: fields ?? {} }),
      child: () => fakeLogger,
      registry: undefined as never,
    };

    const router = createApprovalRouter({
      ask: async () => ({ decision: 'accept' }),
      logger: fakeLogger as never,
    });
    await router.handle(SERVER_REQUEST.commandExecutionRequestApproval, {
      threadId: 't1',
      itemId: 'i1',
      command: 'psql -c "select * from 客户欠款"',
      reason: '这个命令会连接数据库',
    });

    const dump = JSON.stringify(records);
    expect(dump).not.toContain('psql');
    expect(dump).not.toContain('客户欠款');
    expect(records[0]?.event).toBe('adapter.approval.received');
  });
});
