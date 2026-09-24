import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TaskRowView, WorkspaceView } from '../src/shared/ipc.js';
import { filterTaskSearchRows, TaskSearchPalette } from '../src/renderer/views/task-search.js';

const NOW = 2_000_000_000_000;

function task(over: Partial<TaskRowView> & Pick<TaskRowView, 'id'>): TaskRowView {
  const { id, ...rest } = over;
  return {
    id,
    title: over.title ?? id,
    status: over.status ?? 'completed',
    timeLabel: over.timeLabel ?? '刚刚',
    updatedAt: over.updatedAt ?? NOW,
    sectionId: over.sectionId ?? 'recent',
    ...rest,
  };
}

const workspaces: readonly WorkspaceView[] = [
  { id: 'w1', name: 'Alpha', path: '/work/alpha' },
  { id: 'w2', name: 'Beta', path: '/work/beta' },
];

describe('任务高级搜索', () => {
  it('状态、项目和时间条件共同过滤', () => {
    const rows = [
      {
        task: task({
          id: 'match',
          status: 'running',
          cwd: '/work/alpha/reports',
          updatedAt: NOW - 1_000,
        }),
        snippet: '',
      },
      {
        task: task({ id: 'old', status: 'running', cwd: '/work/alpha', updatedAt: NOW - 9e8 }),
        snippet: '',
      },
      {
        task: task({ id: 'wrong-project', status: 'running', cwd: '/work/beta' }),
        snippet: '',
      },
    ];
    expect(
      filterTaskSearchRows(
        rows,
        { status: 'running', workspacePath: '/work/alpha', updatedWithin: 'week' },
        NOW,
      ).map((row) => row.task.id),
    ).toEqual(['match']);
  });

  it('面板可组合筛选并清除', () => {
    render(
      <TaskSearchPalette
        tasks={[
          task({ id: 'a', title: 'Alpha 运行任务', status: 'running', cwd: '/work/alpha' }),
          task({ id: 'b', title: 'Beta 完成任务', status: 'completed', cwd: '/work/beta' }),
        ]}
        workspaces={workspaces}
        onSearch={vi.fn(async () => [])}
        onOpenTask={vi.fn()}
        onNewChat={vi.fn()}
        onOpenFolder={vi.fn()}
        onSearchFiles={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '筛选' }));
    fireEvent.change(screen.getByLabelText('按状态筛选'), { target: { value: 'running' } });
    fireEvent.change(screen.getByLabelText('按项目筛选'), {
      target: { value: '/work/alpha' },
    });
    expect(screen.getByText('Alpha 运行任务')).toBeTruthy();
    expect(screen.queryByText('Beta 完成任务')).toBeNull();
    expect(screen.getByRole('button', { name: '筛选 2' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(screen.getByText('Beta 完成任务')).toBeTruthy();
  });
});
