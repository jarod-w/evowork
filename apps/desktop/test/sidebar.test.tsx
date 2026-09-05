/**
 * 任务列表侧边栏（04 §3）。
 *
 * 四条会被用户直接撞上的规则：子任务不进顶层列表、筛选生效时有重置入口、
 * 删除确认必须说清不删工作空间文件、可见页上报必须有界。
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  EMPTY_FILTER,
  isFilterActive,
  PINNED_SECTION,
  rowMenuItems,
  Sidebar,
  type SidebarProps,
  type TaskRow,
} from '../src/renderer/views/sidebar.js';

function task(over: Partial<TaskRow> & { id: string }): TaskRow {
  return {
    title: `任务 ${over.id}`,
    status: 'completed',
    timeLabel: '1天前',
    sectionId: 'ungrouped',
    ...over,
  };
}

function renderSidebar(over: Partial<SidebarProps> = {}) {
  const props: SidebarProps = {
    tasks: [task({ id: 't1' })],
    sections: [],
    ...over,
  };
  return { ...render(<Sidebar {...props} />), props };
}

describe('分组结构（04 §3.1）', () => {
  it('置顶分区排在最前并带图钉', () => {
    renderSidebar({
      tasks: [
        task({ id: 't1', title: '普通任务' }),
        task({ id: 't2', title: '重要任务', sectionId: PINNED_SECTION }),
      ],
    });
    const groups = [...document.querySelectorAll('.ew-task-group-name')];
    expect(groups[0]?.textContent).toContain('置顶');
    expect(screen.getByLabelText('已置顶')).toBeTruthy();
  });

  it('用户分区按传入顺序排，未分组垫底', () => {
    renderSidebar({
      sections: [{ id: 'weekly', name: '周报' }],
      tasks: [
        task({ id: 't1', sectionId: 'ungrouped' }),
        task({ id: 't2', sectionId: 'weekly' }),
        task({ id: 't3', sectionId: PINNED_SECTION }),
      ],
    });
    const names = [...document.querySelectorAll('.ew-task-group-name')].map((n) => n.textContent);
    expect(names).toEqual(['📌 置顶', '周报', '未分组']);
  });

  it('**子任务不出现在顶层列表**（04 §3.2）', () => {
    renderSidebar({
      tasks: [
        task({ id: 't1', title: '父任务' }),
        task({ id: 't2', title: '子任务', parentThreadId: 't1' }),
      ],
    });
    expect(screen.getByText('父任务')).toBeTruthy();
    expect(screen.queryByText('子任务')).toBeNull();
    // 计数也要不含子任务，否则「任务 (2)」与看到的一行对不上
    expect(screen.getByText('(1)')).toBeTruthy();
  });
});

describe('搜索与筛选（04 §3.4）', () => {
  const tasks = [
    task({ id: 't1', title: '季度汇报', status: 'running', cwd: '/w/a' }),
    task({ id: 't2', title: '周报', status: 'completed', cwd: '/w/b' }),
    task({ id: 't3', title: '发票整理', status: 'failed', cwd: '/w/a' }),
  ];

  it('筛选生效时标题变成「(命中 / 总数)」并出现**重置入口**（清单 §4.2）', () => {
    renderSidebar({ tasks });
    fireEvent.click(screen.getByLabelText('打开搜索框'));
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '报' } });

    expect(screen.getByText('(2 / 3)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重置筛选' }));
    expect(screen.getByText('(3)')).toBeTruthy();
  });

  it('状态是多选', () => {
    renderSidebar({ tasks });
    fireEvent.click(screen.getByLabelText('筛选任务'));
    fireEvent.click(screen.getByRole('checkbox', { name: '进行中' }));
    expect(screen.getByText('(1 / 3)')).toBeTruthy();

    fireEvent.click(screen.getByRole('checkbox', { name: '失败' }));
    expect(screen.getByText('(2 / 3)')).toBeTruthy();
  });

  it('工作空间筛选来自实际出现过的 cwd（不是写死的清单）', () => {
    renderSidebar({ tasks });
    fireEvent.click(screen.getByLabelText('筛选任务'));
    fireEvent.click(screen.getByRole('checkbox', { name: '/w/a' }));
    expect(screen.getByText('(2 / 3)')).toBeTruthy();
  });

  it('筛空时的空态给出下一步，不写「暂无数据」', () => {
    renderSidebar({ tasks });
    fireEvent.click(screen.getByLabelText('打开搜索框'));
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: 'zzz' } });
    expect(screen.getByText(/改一下筛选条件，或者重置/)).toBeTruthy();
    expect(screen.queryByText(/暂无/)).toBeNull();
  });

  it('isFilterActive 覆盖六组条件（漏一组就会让重置入口不出现）', () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    expect(isFilterActive({ ...EMPTY_FILTER, statuses: ['failed'] })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, range: '7d' })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, cwd: '/w' })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, modelProvider: 'evowork' })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, hasArtifacts: true })).toBe(true);
    expect(isFilterActive({ ...EMPTY_FILTER, source: 'automation' })).toBe(true);
  });

  it('内容命中单独分组显示（`thread/search` 与标题匹配是两层数据）', () => {
    renderSidebar({
      contentMatches: [{ id: 't9', title: '上周复盘', excerpt: '…提到了季度汇报…' }],
    });
    expect(screen.getByText('对话内容命中')).toBeTruthy();
    expect(screen.getByText('…提到了季度汇报…')).toBeTruthy();
  });
});

describe('可见页上报（04 §3.4 第②步）', () => {
  it('**只报可见页**，不报全部命中 —— 否则「筛出 800 条」会变成 800 个 thread/read', () => {
    const onVisibleChange = vi.fn();
    const many = Array.from({ length: 100 }, (_, i) => task({ id: `t${i}` }));
    renderSidebar({ tasks: many, onVisibleChange, pageSize: 30 });

    const reported = onVisibleChange.mock.calls.at(-1)?.[0] as string[];
    expect(reported).toHaveLength(30);
    expect(screen.getByText('还有 70 条，滚动加载')).toBeTruthy();
  });
});

describe('行操作（04 §3.3）', () => {
  it('菜单把「分享」与「复制链接」区分开 —— 一个上传，一个不上传（Q10）', () => {
    const items = rowMenuItems(task({ id: 't1' }));
    const share = items.find((i) => i.id === 'share');
    const copy = items.find((i) => i.id === 'copy-link');
    expect(share?.description).toContain('授权');
    expect(copy?.description).toContain('不上传');
  });

  it('已置顶的行显示「取消置顶」', () => {
    expect(rowMenuItems(task({ id: 't1', sectionId: PINNED_SECTION }))[0]?.id).toBe('unpin');
    expect(rowMenuItems(task({ id: 't1' }))[0]?.id).toBe('pin');
  });

  it('删除是危险项，且**二次确认说清不删工作空间文件**', () => {
    const onRowAction = vi.fn();
    renderSidebar({ tasks: [task({ id: 't1', title: '季度汇报', cwd: '/w/a' })], onRowAction });

    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    const menu = screen.getByRole('menu', { name: '季度汇报 的操作' });
    expect(within(menu).getByRole('menuitem', { name: '删除' }).getAttribute('data-danger')).toBe(
      'true',
    );
    fireEvent.click(within(menu).getByRole('menuitem', { name: '删除' }));

    // 点了删除**还没删**
    expect(onRowAction).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: '删除任务' });
    expect(dialog.textContent).toContain('工作空间里的文件不会被删除');
    expect(dialog.textContent).toContain('/w/a');

    fireEvent.click(screen.getByRole('button', { name: '删除任务' }));
    expect(onRowAction).toHaveBeenCalledWith('delete', 't1');
  });

  it('其余行操作直接往上传', () => {
    const onRowAction = vi.fn();
    renderSidebar({ tasks: [task({ id: 't1', title: '季度汇报' })], onRowAction });
    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    fireEvent.click(screen.getByRole('menuitem', { name: '从中途分叉' }));
    expect(onRowAction).toHaveBeenCalledWith('fork', 't1');
  });
});

describe('本机磁盘占用（Q17：不是云配额）', () => {
  it('动作是「清理」而不是「升级」', () => {
    const onCleanup = vi.fn();
    renderSidebar({ diskUsageLabel: '本机占用 3.2 GB', diskUsagePercent: 40, onCleanup });
    expect(screen.getByText('本机占用 3.2 GB')).toBeTruthy();
    expect(screen.queryByText(/升级/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '清理' }));
    expect(onCleanup).toHaveBeenCalled();
  });

  it('超过 80% / 95% 换色（01 §5.27）', () => {
    const { rerender } = render(
      <Sidebar tasks={[]} sections={[]} diskUsageLabel="x" diskUsagePercent={85} />,
    );
    expect(document.querySelector('.ew-quota-bar')?.getAttribute('data-level')).toBe('warning');
    rerender(<Sidebar tasks={[]} sections={[]} diskUsageLabel="x" diskUsagePercent={97} />);
    expect(document.querySelector('.ew-quota-bar')?.getAttribute('data-level')).toBe('danger');
  });
});
