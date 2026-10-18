/**
 * 任务列表侧边栏（04 §3）。
 *
 * 四条会被用户直接撞上的规则：子任务不进顶层列表、筛选生效时有重置入口、
 * 删除确认必须说清不删工作空间文件、可见页上报必须有界。
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    updatedAt: Date.now(),
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

describe('项目悬浮信息卡', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('悬停显示真实目录与未筛选总数，子任务不计入，移入卡片可继续操作', () => {
    const onVisibleChange = vi.fn();
    renderSidebar({
      projects: [{ id: 'p', name: '项目一', path: '/work/project' }],
      tasks: [
        task({ id: 'one', projectId: 'p', title: '匹配' }),
        task({ id: 'two', cwd: '/work/project/src', title: '其他' }),
        task({ id: 'child', projectId: 'p', parentThreadId: 'one' }),
      ],
      onVisibleChange,
    });
    fireEvent.click(screen.getByLabelText('打开搜索框'));
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '匹配' } });
    const row = screen.getByRole('button', { name: '项目一' });
    fireEvent.mouseEnter(row);
    expect(screen.queryByRole('region', { name: '项目一 项目信息' })).toBeNull();
    act(() => vi.advanceTimersByTime(250));
    const card = screen.getByRole('region', { name: '项目一 项目信息' });
    expect(within(card).getByText('/work/project')).toBeTruthy();
    expect(within(card).getByText('2 次聊天')).toBeTruthy();
    expect(onVisibleChange.mock.calls.at(-1)?.[0]).toEqual(['one']);
    fireEvent.mouseLeave(row);
    act(() => vi.advanceTimersByTime(50));
    fireEvent.mouseEnter(card);
    act(() => vi.advanceTimersByTime(250));
    expect(screen.getByRole('region', { name: '项目一 项目信息' })).toBeTruthy();
    fireEvent.mouseLeave(card);
    act(() => vi.advanceTimersByTime(150));
    expect(screen.queryByRole('region', { name: '项目一 项目信息' })).toBeNull();
  });

  it('键盘聚焦直接显示零聊天，Esc 和点击外部可关闭，点击项目仍展开', () => {
    const onProjectSelect = vi.fn();
    renderSidebar({ projects: [{ id: 'p', name: '空项目' }], onProjectSelect });
    const row = screen.getByRole('button', { name: '空项目' });
    fireEvent.focus(row);
    expect(screen.getByText('0 次聊天')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('0 次聊天')).toBeNull();
    fireEvent.focus(row);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('0 次聊天')).toBeNull();
    fireEvent.click(row);
    expect(onProjectSelect).toHaveBeenCalledWith('p');
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  it('置顶排序在重新挂载后保留，取消置顶恢复原顺序；编辑保存真实项目 id 与名称', () => {
    const onProjectRename = vi.fn();
    const props = {
      projects: [
        { id: 'a', name: '甲' },
        { id: 'b', name: '乙' },
      ],
      onProjectRename,
    };
    const view = renderSidebar(props);
    fireEvent.focus(screen.getByRole('button', { name: '乙' }));
    fireEvent.click(screen.getByRole('button', { name: '置顶项目' }));
    view.unmount();
    renderSidebar(props);
    const rows = () =>
      [...document.querySelectorAll('.ew-sidebar-project-hover > button')].map(
        (row) => row.textContent,
      );
    expect(rows()).toEqual(['乙', '甲']);
    fireEvent.focus(screen.getByRole('button', { name: '乙' }));
    fireEvent.click(screen.getByRole('button', { name: '取消置顶项目' }));
    expect(rows()).toEqual(['甲', '乙']);
    fireEvent.click(screen.getByRole('button', { name: '编辑项目' }));
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '  新名称  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onProjectRename).toHaveBeenCalledWith('b', '新名称');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('分组结构（04 §3.1）', () => {
  it('最近按活动时间降序排列，置顶保留图钉但不改变顺序', () => {
    renderSidebar({
      tasks: [
        task({ id: 't2', title: '重要任务', sectionId: PINNED_SECTION, updatedAt: 100 }),
        task({ id: 't1', title: '普通任务', updatedAt: 200 }),
      ],
    });
    const recent = screen.getByRole('region', { name: '最近' });
    expect(
      within(recent)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([expect.stringContaining('普通任务'), expect.stringContaining('重要任务')]);
    expect(screen.getByLabelText('已置顶')).toBeTruthy();
  });

  it('不同分区统一按活动时间排序，不在最近列表内插入分区标题', () => {
    renderSidebar({
      sections: [{ id: 'weekly', name: '周报' }],
      tasks: [
        task({ id: 't1', sectionId: 'ungrouped', updatedAt: 300 }),
        task({ id: 't2', sectionId: 'weekly', updatedAt: 100 }),
        task({ id: 't3', sectionId: PINNED_SECTION, updatedAt: 200 }),
      ],
    });
    const names = [...document.querySelectorAll('.ew-task-group-name')].map((n) => n.textContent);
    expect(names).toEqual([]);
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      expect.stringContaining('任务 t1'),
      expect.stringContaining('任务 t3'),
      expect.stringContaining('任务 t2'),
    ]);
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
    expect(screen.queryByText('(2)')).toBeNull();
  });

  it('完成任务保持纯文本左对齐，只有进行中等需关注状态显示状态点', () => {
    const { container } = renderSidebar({
      tasks: [
        task({ id: 'done', title: '已完成', status: 'completed' }),
        task({ id: 'running', title: '进行中', status: 'running' }),
      ],
    });
    expect(
      screen.getByText('已完成').closest('.ew-task-item')?.querySelector('.ew-status-dot'),
    ).toBeNull();
    expect(
      screen.getByText('进行中').closest('.ew-task-item')?.querySelector('.ew-status-dot'),
    ).not.toBeNull();
    expect(container.querySelectorAll('.ew-status-dot')).toHaveLength(1);
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
    expect(screen.queryByText('(3)')).toBeNull();
    expect(screen.getByRole('button', { name: '最近' })).toBeTruthy();
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

  it('时间范围读取真实时间戳，选择后结果数量真实变化', () => {
    const now = Date.now();
    renderSidebar({
      tasks: [
        task({ id: 'recent', title: '今天的任务', updatedAt: now }),
        task({ id: 'old', title: '两周前的任务', updatedAt: now - 14 * 24 * 60 * 60 * 1000 }),
      ],
    });
    fireEvent.click(screen.getByLabelText('筛选任务'));
    fireEvent.click(screen.getByRole('checkbox', { name: '7 天' }));
    expect(screen.getByText('今天的任务')).toBeTruthy();
    expect(screen.queryByText('两周前的任务')).toBeNull();
    expect(screen.getByText('(1 / 2)')).toBeTruthy();
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
    const many = Array.from({ length: 100 }, (_, i) => task({ id: `t${i}`, updatedAt: i }));
    renderSidebar({ tasks: many, onVisibleChange, pageSize: 30 });

    const reported = onVisibleChange.mock.calls.at(-1)?.[0] as string[];
    expect(reported).toHaveLength(30);
    expect(reported[0]).toBe('t99');
    expect(reported.at(-1)).toBe('t70');
    expect(screen.getByText('还有 70 条，向下滚动继续加载')).toBeTruthy();
  });

  it('滚动到底部增量挂载下一页，并继续上报有界可见集', () => {
    const onVisibleChange = vi.fn();
    const many = Array.from({ length: 65 }, (_, i) => task({ id: `t${i}` }));
    const { container } = renderSidebar({ tasks: many, onVisibleChange, pageSize: 30 });
    const scroller = container.querySelector('.ew-sidebar-tasks') as HTMLElement;
    Object.defineProperties(scroller, {
      scrollHeight: { value: 100 },
      clientHeight: { value: 50 },
      scrollTop: { value: 50, writable: true },
    });
    fireEvent.scroll(scroller);

    const reported = onVisibleChange.mock.calls.at(-1)?.[0] as string[];
    expect(reported).toHaveLength(60);
    expect(screen.getByText('还有 5 条，向下滚动继续加载')).toBeTruthy();
  });

  it('项目每次只加载 5 条，与最近重复的可见任务只上报一次', () => {
    const onVisibleChange = vi.fn();
    const tasks = Array.from({ length: 100 }, (_, i) =>
      task({ id: `project-${i}`, cwd: '/work/evowork', updatedAt: 100 - i }),
    );
    renderSidebar({
      tasks,
      projects: [{ id: 'p1', name: 'evowork', path: '/work/evowork' }],
      onVisibleChange,
    });

    fireEvent.click(screen.getByRole('button', { name: 'evowork' }));
    expect(onVisibleChange.mock.calls.at(-1)?.[0]).toHaveLength(30);
    fireEvent.click(screen.getByRole('button', { name: '最近' }));
    expect(onVisibleChange.mock.calls.at(-1)?.[0]).toEqual(
      Array.from({ length: 5 }, (_, i) => `project-${i}`),
    );
    fireEvent.click(screen.getByRole('button', { name: '展开显示' }));
    expect(onVisibleChange.mock.calls.at(-1)?.[0]).toHaveLength(10);
  });
});

describe('行操作（04 §3.3）', () => {
  it('只显示已经接通的动作：改名、分享、归档、删除', () => {
    const items = rowMenuItems(task({ id: 't1' }));
    expect(items.map((item) => item.id)).toEqual(['rename', 'share', 'archive', 'delete']);
    // 分享带省略号：它是**过一次授权流的入口**，不是点了就传（Q10 规则 1）
    expect(items.find((item) => item.id === 'share')?.label).toBe('分享…');
  });

  /*
   * **标题是自动来的，所以必须有人工纠正入口。**
   *
   * 先从第一条消息截（`kernel-adapter/src/title.ts`），再被产物的显示名盖一次
   * （`artifacts/src/task-title.ts`）。两者都可能起错，而起错的自动标题比
   * "用户自己的原话被截断"更糟 —— 用户认不出那是自己的任务。
   */
  it('改名开对话框、预填当前标题，保存后把新名字往上传', () => {
    const onRenameTask = vi.fn();
    renderSidebar({ tasks: [task({ id: 't1', title: '季度汇报' })], onRenameTask });

    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    fireEvent.click(screen.getByRole('menuitem', { name: '改名' }));

    const input = screen.getByLabelText('名称') as HTMLInputElement;
    // 多数改名是微调一个自动起的名字，空着让用户重打一遍是白费
    expect(input.value).toBe('季度汇报');

    fireEvent.change(input, { target: { value: 'Q3 经营分析' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onRenameTask).toHaveBeenCalledWith('t1', 'Q3 经营分析');
  });

  it('空名字存不下去 —— 内核也会拒绝它', () => {
    const onRenameTask = vi.fn();
    renderSidebar({ tasks: [task({ id: 't1', title: '季度汇报' })], onRenameTask });
    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    fireEvent.click(screen.getByRole('menuitem', { name: '改名' }));

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '   ' } });
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onRenameTask).not.toHaveBeenCalled();
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
    expect(within(dialog).getByText(/归档只隐藏任务并保留历史/)).toBeTruthy();
    expect(within(dialog).getByText(/电脑操控界面文字和截图/)).toBeTruthy();
    expect(within(dialog).getByText(/项目目录中的文件不会被删除/)).toBeTruthy();
    expect(within(dialog).getByText(/外部副本也不会被撤回/)).toBeTruthy();
    expect(dialog.textContent).toContain('项目目录中的文件不会被删除');
    expect(dialog.textContent).toContain('/w/a');

    fireEvent.click(screen.getByRole('button', { name: '删除任务' }));
    expect(onRowAction).toHaveBeenCalledWith('delete', 't1');
  });

  it('其余行操作直接往上传', () => {
    const onRowAction = vi.fn();
    renderSidebar({ tasks: [task({ id: 't1', title: '季度汇报' })], onRowAction });
    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    fireEvent.click(screen.getByRole('menuitem', { name: '归档' }));
    expect(onRowAction).toHaveBeenCalledWith('archive', 't1');
  });
});

describe('项目与插件入口', () => {
  it('项目作为独立分区显示，插件使用统一名称', () => {
    const onProjectSelect = vi.fn();
    renderSidebar({ projects: [{ id: 'p1', name: '季度汇报' }], onProjectSelect });
    expect(screen.getByRole('button', { name: '插件' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '季度汇报' }));
    expect(onProjectSelect).toHaveBeenCalledWith('p1');
    expect(screen.queryByText('发现应用')).toBeNull();
  });

  it('项目目录失效时在侧栏行直接警告', () => {
    renderSidebar({ projects: [{ id: 'p1', name: '季度汇报', rootMissing: true }] });
    expect(screen.getByRole('button', { name: '季度汇报（目录不可用）' })).toBeTruthy();
  });

  it('项目标题负责折叠，同一行的 + 直接请求创建项目', () => {
    const onNavSelect = vi.fn();
    const onProjectCreate = vi.fn();
    renderSidebar({ activeNavId: 'projects', onNavSelect, onProjectCreate });

    fireEvent.click(screen.getByRole('button', { name: '项目' }));
    expect(onNavSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '项目' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.getByRole('button', { name: '项目更多操作' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    expect(onProjectCreate).toHaveBeenCalledOnce();
  });

  it('项目 ⋯ 菜单可以查看全部或导入已有文件夹', () => {
    const onNavSelect = vi.fn();
    const onProjectImport = vi.fn();
    renderSidebar({ onNavSelect, onProjectImport });

    fireEvent.click(screen.getByRole('button', { name: '项目更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '导入现有文件夹' }));
    expect(onProjectImport).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: '项目更多操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '查看所有项目' }));
    expect(onNavSelect).toHaveBeenCalledWith('projects');
  });

  it('项目任务默认收起，点击项目后展开，同时保留在最近列表中', () => {
    renderSidebar({
      projects: [
        { id: 'p1', name: 'evowork', path: '/work/evowork' },
        { id: 'p2', name: 'aigateway', path: '/work/aigateway' },
      ],
      tasks: [
        task({ id: 'project-task', title: '调整侧栏布局', cwd: '/work/evowork' }),
        task({ id: 'recent-task', title: '独立任务' }),
      ],
    });

    const project = screen
      .getByRole('button', { name: 'evowork' })
      .closest('.ew-sidebar-project-group');
    expect(project).not.toBeNull();
    expect(within(project as HTMLElement).queryByText('调整侧栏布局')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'evowork' }));
    expect(within(project as HTMLElement).getByText('调整侧栏布局')).toBeTruthy();
    expect(screen.getAllByText('调整侧栏布局')).toHaveLength(2);
    expect(screen.getByText('独立任务')).toBeTruthy();
  });

  it('默认标题不带计数，最近的筛选计数包含项目和无项目任务', () => {
    renderSidebar({
      projects: [{ id: 'p1', name: 'evowork', path: '/work/evowork' }],
      tasks: [
        task({ id: 'project-task', title: '项目任务', cwd: '/work/evowork' }),
        task({ id: 'recent-task', title: '独立任务' }),
      ],
    });
    expect(screen.getByRole('button', { name: '最近' })).toBeTruthy();
    expect(screen.queryByText('(1)')).toBeNull();
    fireEvent.click(screen.getByLabelText('打开搜索框'));
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '任务' } });
    expect(screen.getByText('(2 / 2)')).toBeTruthy();
  });

  it('项目和最近独立折叠，隐藏任务停止上报，重新展开保留选中态', () => {
    const onVisibleChange = vi.fn();
    renderSidebar({
      projects: [{ id: 'p1', name: 'evowork', path: '/work/evowork' }],
      tasks: [
        task({ id: 'project-task', title: '项目任务', cwd: '/work/evowork' }),
        task({ id: 'recent-task', title: '独立任务' }),
      ],
      selectedId: 'project-task',
      onVisibleChange,
    });
    const projectsToggle = screen.getByRole('button', { name: '项目' });
    const recentToggle = screen.getByRole('button', { name: '最近' });
    fireEvent.click(screen.getByRole('button', { name: 'evowork' }));
    expect(projectsToggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(projectsToggle);
    expect(within(screen.getByRole('region', { name: '项目' })).queryByText('项目任务')).toBeNull();
    expect(within(screen.getByRole('region', { name: '最近' })).getByText('项目任务')).toBeTruthy();
    expect(screen.getByText('独立任务')).toBeTruthy();
    expect(new Set(onVisibleChange.mock.calls.at(-1)?.[0])).toEqual(
      new Set(['project-task', 'recent-task']),
    );
    fireEvent.click(recentToggle);
    expect(screen.queryByText('独立任务')).toBeNull();
    expect(onVisibleChange.mock.calls.at(-1)?.[0]).toEqual([]);
    fireEvent.click(projectsToggle);
    expect(
      screen.getByText('项目任务').closest('.ew-task-item')?.getAttribute('data-selected'),
    ).toBe('true');
    expect(screen.queryByText('独立任务')).toBeNull();
    expect(onVisibleChange.mock.calls.at(-1)?.[0]).toEqual(['project-task']);
    fireEvent.click(recentToggle);
    expect(new Set(onVisibleChange.mock.calls.at(-1)?.[0])).toEqual(
      new Set(['project-task', 'recent-task']),
    );
  });

  it('显示全部项目，各项目独立分页，每次最多增加五条直到全部显示', () => {
    const onProjectSelect = vi.fn();
    renderSidebar({
      projects: Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `项目 ${i}` })),
      tasks: [
        ...Array.from({ length: 12 }, (_, i) =>
          task({
            id: `a${i}`,
            projectId: 'p0',
            updatedAt: i,
          }),
        ),
        task({ id: 'b', projectId: 'p5' }),
        task({ id: 'child', projectId: 'p0', parentThreadId: 'a0' }),
      ],
      onProjectSelect,
    });
    const projects = screen.getByRole('region', { name: '项目' });
    expect(within(projects).getByRole('button', { name: '项目 5' })).toBeTruthy();
    expect(within(projects).queryAllByRole('listitem')).toHaveLength(0);
    const toggle = within(projects).getByRole('button', { name: '项目 0' });
    fireEvent.click(toggle);
    expect(onProjectSelect).toHaveBeenCalledWith('p0');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const group = toggle.closest('.ew-sidebar-project-group') as HTMLElement;
    expect(
      within(group)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([11, 10, 9, 8, 7].map((i) => expect.stringContaining(`任务 a${i}`)));
    fireEvent.click(within(group).getByRole('button', { name: '展开显示' }));
    expect(within(group).getAllByRole('listitem')).toHaveLength(10);
    fireEvent.click(within(projects).getByRole('button', { name: '项目 5' }));
    expect(within(projects).getByText('任务 b')).toBeTruthy();
    expect(within(group).getAllByRole('listitem')).toHaveLength(10);
    fireEvent.click(toggle);
    expect(within(group).queryAllByRole('listitem')).toHaveLength(0);
    fireEvent.click(toggle);
    expect(within(group).getAllByRole('listitem')).toHaveLength(10);
    fireEvent.click(within(group).getByRole('button', { name: '展开显示' }));
    expect(within(group).getAllByRole('listitem')).toHaveLength(12);
    expect(within(group).queryByRole('button', { name: '展开显示' })).toBeNull();
    expect(screen.queryByText('任务 child')).toBeNull();
  });

  it('项目归属优先使用 projectId，旧任务按最长根路径匹配，最近包含所有归属', () => {
    renderSidebar({
      projects: [
        { id: 'root', name: '根项目', path: '/work' },
        { id: 'nested', name: '子项目', path: '/work/nested' },
      ],
      tasks: [
        task({ id: 'legacy', cwd: '/work/nested/src', updatedAt: 100 }),
        task({ id: 'explicit', projectId: 'root', cwd: '/work/nested', updatedAt: 300 }),
        task({ id: 'none', projectId: null, cwd: '/work/nested', updatedAt: 200 }),
        task({ id: 'unknown', projectId: 'removed', updatedAt: 400 }),
      ],
    });
    const root = screen.getByRole('button', { name: '根项目' });
    const nested = screen.getByRole('button', { name: '子项目' });
    fireEvent.click(root);
    fireEvent.click(nested);
    expect(
      within(root.closest('.ew-sidebar-project-group') as HTMLElement).getAllByRole('listitem'),
    ).toHaveLength(1);
    expect(
      within(nested.closest('.ew-sidebar-project-group') as HTMLElement).getByText('任务 legacy'),
    ).toBeTruthy();
    const recent = screen.getByRole('region', { name: '最近' });
    expect(
      within(recent)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(
      ['unknown', 'explicit', 'none', 'legacy'].map((id) => expect.stringContaining(`任务 ${id}`)),
    );
  });

  it('任务在项目和最近同时出现时，操作菜单只在点击的位置打开', () => {
    const onRenameTask = vi.fn();
    renderSidebar({
      projects: [{ id: 'p1', name: '项目一' }],
      tasks: [task({ id: 't1', projectId: 'p1', title: '会话一' })],
      onRenameTask,
    });
    fireEvent.click(screen.getByRole('button', { name: '项目一' }));
    const projects = screen.getByRole('region', { name: '项目' });
    fireEvent.click(within(projects).getByLabelText('会话一 的更多操作'));
    expect(screen.getAllByRole('menu', { name: '会话一 的操作' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('menuitem', { name: '改名' }));
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '新会话名' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onRenameTask).toHaveBeenCalledWith('t1', '新会话名');
    const recent = screen.getByRole('region', { name: '最近' });
    fireEvent.click(within(recent).getByLabelText('会话一 的更多操作'));
    expect(screen.getAllByRole('menu', { name: '会话一 的操作' })).toHaveLength(1);
    expect(within(projects).queryByRole('menu')).toBeNull();
  });

  it('没有任务时保留两个分组标题，筛空时仍提供重置提示', () => {
    renderSidebar({ tasks: [] });
    expect(screen.getByRole('button', { name: '项目' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '最近' })).toBeTruthy();
    expect(screen.queryByText('还没有任务。')).toBeNull();
    fireEvent.click(screen.getByLabelText('打开搜索框'));
    fireEvent.change(screen.getByLabelText('搜索任务'), { target: { value: '任务' } });
    expect(screen.getByText(/改一下筛选条件，或者重置/)).toBeTruthy();
  });
});

describe('手动折叠', () => {
  it('折叠按钮调用宿主，由宿主保留恢复入口', () => {
    const onToggleCollapse = vi.fn();
    renderSidebar({ onToggleCollapse });
    fireEvent.click(screen.getByRole('button', { name: '折叠侧边栏' }));
    expect(onToggleCollapse).toHaveBeenCalledOnce();
  });
});

describe('一级导航选中态（02 §2）', () => {
  it('宿主说现在在自动化页时，点亮的是「自动化」不是「新建任务」', () => {
    renderSidebar({ activeNavId: 'automations' });
    expect(screen.getByRole('button', { name: '自动化' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      screen.getByRole('button', { name: '新建任务' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('没指定导航时不擅自点亮「新建任务」—— 那是首页的事，猜错会让目录页看起来像还在首页', () => {
    renderSidebar();
    expect(
      screen.getByRole('button', { name: '新建任务' }).getAttribute('aria-current'),
    ).toBeNull();
  });
});

describe('「更多」菜单只暴露已接通能力', () => {
  it('不显示设备与同步等尚未接通的入口', () => {
    renderSidebar({ user: { name: '小王', version: 'v1' } });
    fireEvent.click(screen.getByRole('button', { name: '小王 菜单' }));
    expect(screen.queryByRole('menuitem', { name: /设备与同步/ })).toBeNull();
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
