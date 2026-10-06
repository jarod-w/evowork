import { describe, expect, it } from 'vitest';
import { activityKinds, activityState, describeActivity } from '../src/shared/activity.js';
import { mergeTurnViews } from '../src/shared/turn-view.js';

describe('操作摘要', () => {
  it('复合命令按结构化动作归类，未知命令保持原文，不猜测读写', () => {
    expect(
      activityKinds({
        type: 'commandExecution',
        commandActions: [
          { type: 'read', name: 'report.md' },
          { type: 'search', query: '收入' },
          { type: 'unknown' },
        ],
      }),
    ).toEqual(['读取文件', '搜索文件', '运行命令']);
    expect(
      describeActivity({
        type: 'commandExecution',
        commandActions: [{ type: 'read', name: 'report.md' }],
        completed: true,
      }),
    ).toBe('已读取 report.md');
    expect(
      describeActivity({
        type: 'commandExecution',
        command: 'python business.py',
        completed: true,
      }),
    ).toBe('已运行 python business.py');
  });
  it('等待批准、失败与中断不能伪装成正常完成', () => {
    expect(activityState({ type: 'commandExecution', completed: true, exitCode: 1 })).toBe(
      'failed',
    );
    expect(activityState({ type: 'commandExecution', completed: true, interrupted: true })).toBe(
      'interrupted',
    );
    expect(activityState({ type: 'mcpToolCall', status: 'pending' })).toBe('pending');
    expect(activityKinds({ type: 'mcpToolCall', tool: 'browser_search' })).toEqual(['搜索网页']);
  });
});

describe('回合恢复竞态', () => {
  it('在途历史不能覆盖实时完成态或抹掉已知开始时间', () => {
    const live = [
      { id: 'turn', status: 'completed' as const, durationMs: 12_300, startedAtMs: undefined },
    ];
    const history = [{ id: 'turn', status: 'inProgress' as const, startedAtMs: 100_000 }];
    expect(mergeTurnViews(live, history)).toEqual([
      { id: 'turn', status: 'completed', durationMs: 12_300, startedAtMs: 100_000 },
    ]);
  });
  it('历史完成态纠正丢失的完成事件，并保留正在运行的新回合', () => {
    expect(
      mergeTurnViews(
        [
          { id: 'old', status: 'inProgress' },
          { id: 'new', status: 'inProgress' },
        ],
        [{ id: 'old', status: 'completed', durationMs: 1_000 }],
      ),
    ).toEqual([
      { id: 'old', status: 'completed', durationMs: 1_000 },
      { id: 'new', status: 'inProgress' },
    ]);
  });
});
