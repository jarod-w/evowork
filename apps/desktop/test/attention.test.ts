/**
 * 跨任务待办：人离开当前对话后，仍能看见等批准、超预算、被拦住和已暂停的自动化。
 * 已完成任务上的旧拦截不再占这一列。
 */
import { describe, expect, it } from 'vitest';

import { newestActiveTask, summarizeWork, type AttentionTask } from '../src/renderer/attention.js';

function task(over: Partial<AttentionTask> & Pick<AttentionTask, 'id' | 'status'>): AttentionTask {
  return {
    title: over.id,
    updatedAt: 1,
    ...over,
  };
}

describe('跨任务待办', () => {
  it('另一条任务上的批准会单独成行，不要求人正停在那条对话里', () => {
    const summary = summarizeWork({
      tasks: [
        task({ id: 'here', status: 'idle', title: '当前' }),
        task({ id: 'there', status: 'pending', title: '报销单', updatedAt: 5 }),
      ],
      approvals: [{ threadId: 'there', impact: '将运行一条本机命令 · 需要联网' }],
      goals: [],
      audits: [],
      automations: [],
    });
    expect(summary.items.map((item) => item.title)).toEqual(['报销单']);
    expect(summary.items[0]).toMatchObject({
      kind: 'approval',
      threadId: 'there',
      detail: '将运行一条本机命令 · 需要联网',
    });
    expect(summary.pulse.waiting).toBe(1);
  });

  it('已有批准卡的任务不再重复一条「待你确认」', () => {
    const summary = summarizeWork({
      tasks: [task({ id: 'there', status: 'pending', title: '报销单' })],
      approvals: [{ threadId: 'there', reason: '会改工作空间外的文件' }],
      goals: [],
      audits: [],
      automations: [],
    });
    expect(summary.items).toHaveLength(1);
  });

  it('没有批准卡、但状态仍是待确认的任务也留在待办里', () => {
    const summary = summarizeWork({
      tasks: [task({ id: 'ask', status: 'pending', title: '还在问' })],
      approvals: [],
      goals: [],
      audits: [],
      automations: [],
    });
    expect(summary.items[0]?.detail).toBe('任务停在需要你确认的地方');
  });

  it('进行中的任务保留最近一次被拦住的位置类别，已完成的旧记录退出待办', () => {
    const summary = summarizeWork({
      tasks: [
        task({ id: 'live', status: 'running', title: '还在跑' }),
        task({ id: 'done', status: 'completed', title: '做过了' }),
      ],
      approvals: [],
      goals: [],
      audits: [
        {
          occurredAt: 1,
          action: 'path.blocked',
          threadId: 'live',
          pathKind: '/Users/li/.ssh/id_rsa',
        },
        {
          occurredAt: 2,
          action: 'path.blocked',
          threadId: 'live',
          pathKind: 'credentials',
        },
        {
          occurredAt: 9,
          action: 'path.blocked',
          threadId: 'done',
          pathKind: 'credentials',
        },
        { occurredAt: 3, action: 'budget.exceeded', threadId: 'done' },
      ],
      automations: [],
    });
    expect(summary.items.map((item) => `${item.kind}:${item.title}`)).toEqual(['blocked:还在跑']);
    expect(summary.items[0]?.detail).toBe('已拦住对密钥与凭据的访问');
    expect(summary.items[0]?.detail.includes('id_rsa')).toBe(false);
  });

  it('仍在进行的任务用预算数字说明为什么停下，已完成的目标不再算待办', () => {
    const summary = summarizeWork({
      tasks: [task({ id: 'budget', status: 'interrupted', title: '周报' })],
      approvals: [],
      goals: [{ threadId: 'budget', status: 'budgetLimited', tokenBudget: 1000, tokensUsed: 1000 }],
      audits: [],
      automations: [],
    });
    expect(summary.items[0]).toMatchObject({
      kind: 'budget',
      detail: '预算已用完（1000 / 1000）',
    });
  });

  it('自动暂停和手动暂停都出现，说法分开', () => {
    const summary = summarizeWork({
      tasks: [],
      approvals: [],
      goals: [],
      audits: [],
      automations: [
        { id: 'a', name: '晨报', status: 'PAUSED', consecutiveFailures: 3 },
        { id: 'b', name: '周会', status: 'PAUSED' },
        { id: 'c', name: '还在跑', status: 'ACTIVE' },
      ],
    });
    expect(summary.items.map((item) => item.detail)).toEqual([
      '连续失败 3 次后自动暂停',
      '已暂停，不会按计划运行',
    ]);
    expect(summary.pulse).toMatchObject({
      hasHistory: true,
      running: 0,
      waiting: 0,
      pausedAutomations: 2,
    });
  });

  it('没有任务也没有自动化时，首页仍是第一次打开', () => {
    expect(
      summarizeWork({ tasks: [], approvals: [], goals: [], audits: [], automations: [] }).pulse
        .hasHistory,
    ).toBe(false);
  });

  it('进行中点进去的是最近一条，不是子任务', () => {
    const chosen = newestActiveTask([
      task({ id: 'old', status: 'running', updatedAt: 1, title: '旧的' }),
      task({
        id: 'child',
        status: 'running',
        updatedAt: 9,
        title: '子任务',
        parentThreadId: 'new',
      }),
      task({ id: 'new', status: 'planning', updatedAt: 4, title: '新的' }),
    ]);
    expect(chosen?.id).toBe('new');
  });
});
