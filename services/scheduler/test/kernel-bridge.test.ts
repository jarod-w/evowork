/**
 * scheduler ↔ 内核的接线。
 *
 * 盯的是**定时任务与交互式任务的三处不同**：必须先设预算再跑、审批 10 分钟自动取消、
 * 失败要分类（只有任务自身的失败才计连败）。三条都是"没有人在旁边看着"带来的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKernelBridge, type AutomationStore, type TaskRunner } from '../src/kernel-bridge.js';
import { createScheduler, type AutomationDefinition, type RunRecord } from '../src/scheduler.js';

const NOW = Date.parse('2026-09-05T09:00:00Z');

const automation: AutomationDefinition = {
  id: 'a1',
  name: '每日周报',
  prompt: '把本周的进展整理成一份周报',
  deviceId: 'laptop',
  schedule: '0 9 * * *',
  timezone: 'UTC',
  status: 'ACTIVE',
  misfirePolicy: 'FIRE_ONCE_ON_WAKE',
  catchupWindowMs: 86_400_000,
  consecutiveFailures: 0,
  budgetLimit: 50_000,
  workspaces: ['/w/weekly'],
};

function harness(over: { workspaceExists?: (path: string) => boolean } = {}) {
  const calls: string[] = [];
  const runs: (RunRecord & { startedAt: number })[] = [];
  const finished: unknown[] = [];
  const patches: unknown[] = [];
  const notices: string[] = [];

  const runner: TaskRunner = {
    createTask: vi.fn(async () => {
      calls.push('createTask');
      return { threadId: 'th_1' };
    }),
    setBudget: vi.fn(async () => {
      calls.push('setBudget');
    }),
    interrupt: vi.fn(async () => {
      calls.push('interrupt');
    }),
  };

  const store: AutomationStore = {
    insertRun: (record) => {
      runs.push(record);
      return true;
    },
    finishRun: (input) => finished.push(input),
    updateAutomation: (_id, patch) => patches.push(patch),
    listActive: () => [automation],
    get: () => automation,
  };

  const bridge = createKernelBridge({
    runner,
    store,
    deviceId: 'laptop',
    notify: (text) => notices.push(text),
    now: () => NOW,
    ...(over.workspaceExists ? { workspaceExists: over.workspaceExists } : {}),
  });
  return { bridge, runner, calls, runs, finished, patches, notices };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('起一次定时执行', () => {
  it('**先设预算再让它跑** —— 顺序反了就有一段没有预算保护的窗口', async () => {
    const { bridge, calls } = harness();
    await bridge.ports.startRun(automation, NOW);
    expect(calls).toEqual(['createTask', 'setBudget']);
    bridge.dispose();
  });

  it('prompt 作为第一条用户消息，automationId 带上（产物索引要用它归因）', async () => {
    const { bridge, runner } = harness();
    await bridge.ports.startRun(automation, NOW);
    expect(runner.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [{ type: 'text', text: '把本周的进展整理成一份周报' }],
        automationId: 'a1',
        overrides: { cwd: '/w/weekly' },
      }),
    );
    bridge.dispose();
  });

  it('预算用的是 automation 上那个硬预算（07 §8-3 强制要求）', async () => {
    const { bridge, runner } = harness();
    await bridge.ports.startRun(automation, NOW);
    expect(runner.setBudget).toHaveBeenCalledWith('th_1', 50_000);
    bridge.dispose();
  });

  it('**工作空间不在时不去起 thread**，直接判 ENVIRONMENT（不计连败）', async () => {
    const { bridge, runner, finished } = harness({ workspaceExists: () => false });
    await expect(bridge.ports.startRun(automation, NOW)).rejects.toThrow();
    expect(runner.createTask).not.toHaveBeenCalled();
    expect(finished[0]).toMatchObject({ status: 'FAILED', failureClass: 'ENVIRONMENT' });
    bridge.dispose();
  });
});

describe('**无人值守的审批 10 分钟后自动取消**（10 §3.6）', () => {
  it('超时中断 thread 并记 APPROVAL_TIMEOUT', async () => {
    const { bridge, runner, finished } = harness();
    await bridge.ports.startRun(automation, NOW);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runner.interrupt).toHaveBeenCalledWith('th_1');
    expect(finished[0]).toMatchObject({ failureClass: 'APPROVAL_TIMEOUT' });
    bridge.dispose();
  });

  it('正常结束会**清掉超时定时器**，之后不再触发', async () => {
    const { bridge, runner, finished } = harness();
    await bridge.ports.startRun(automation, NOW);
    bridge.onTurnFinished({ threadId: 'th_1', ok: true, tokenUsage: 1200 });

    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(runner.interrupt).not.toHaveBeenCalled();
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ status: 'SUCCEEDED', tokenUsage: 1200 });
    bridge.dispose();
  });
});

describe('失败分类：只有任务自身的失败才计连败', () => {
  it('模型错误 → MODEL（计数）', async () => {
    const { bridge, finished } = harness();
    await bridge.ports.startRun(automation, NOW);
    bridge.onTurnFinished({ threadId: 'th_1', ok: false, modelErrorCode: 'rate_limit_exceeded' });
    expect(finished[0]).toMatchObject({ failureClass: 'MODEL' });
    bridge.dispose();
  });

  it('超预算 → QUOTA（不计数）', async () => {
    const { bridge, finished } = harness();
    await bridge.ports.startRun(automation, NOW);
    bridge.onTurnFinished({ threadId: 'th_1', ok: false, budgetExceeded: true });
    expect(finished[0]).toMatchObject({ failureClass: 'QUOTA' });
    bridge.dispose();
  });

  it('**内核崩溃 → ENVIRONMENT** —— 算成任务失败会让一次崩溃 + 两次别的失败就自动暂停', async () => {
    const { bridge, finished } = harness();
    await bridge.ports.startRun(automation, NOW);
    bridge.onKernelExit();
    expect(finished[0]).toMatchObject({ failureClass: 'ENVIRONMENT' });
    bridge.dispose();
  });

  it('不是定时任务的 thread 不管', async () => {
    const { bridge, finished } = harness();
    await bridge.ports.startRun(automation, NOW);
    bridge.onTurnFinished({ threadId: 'th_other', ok: false });
    expect(finished).toHaveLength(0);
    bridge.dispose();
  });
});

describe('并发：SKIP 靠 isRunning，跑完才放行', () => {
  it('在跑的时候再触发 → SKIPPED / CONCURRENCY', async () => {
    const { bridge, runs } = harness();
    const scheduler = createScheduler(bridge.ports);

    await scheduler.fire(automation, NOW);
    expect(bridge.runningCount()).toBe(1);

    await scheduler.fire(automation, NOW + 86_400_000);
    expect(runs.at(-1)).toMatchObject({ status: 'SKIPPED', skipReason: 'CONCURRENCY' });

    bridge.onTurnFinished({ threadId: 'th_1', ok: true });
    expect(bridge.runningCount()).toBe(0);
    bridge.dispose();
  });
});
