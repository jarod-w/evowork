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

  it('用户分区按传入顺序排，普通最近任务不再多套一层「未分组」标题', () => {
    renderSidebar({
      sections: [{ id: 'weekly', name: '周报' }],
      tasks: [
        task({ id: 't1', sectionId: 'ungrouped' }),
        task({ id: 't2', sectionId: 'weekly' }),
        task({ id: 't3', sectionId: PINNED_SECTION }),
      ],
    });
    const names = [...document.querySelectorAll('.ew-task-group-name')].map((n) => n.textContent);
    expect(names).toEqual(['📌 置顶', '周报']);
    expect(screen.getByText('任务 t1')).toBeTruthy();
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
    const many = Array.from({ length: 100 }, (_, i) => task({ id: `t${i}` }));
    renderSidebar({ tasks: many, onVisibleChange, pageSize: 30 });

    const reported = onVisibleChange.mock.calls.at(-1)?.[0] as string[];
    expect(reported).toHaveLength(30);
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

  it('项目预览每组最多上报 5 条，项目历史再多也不会触发无界 thread/read', () => {
    const onVisibleChange = vi.fn();
    const tasks = Array.from({ length: 100 }, (_, i) =>
      task({ id: `project-${i}`, cwd: '/work/evowork' }),
    );
    renderSidebar({
      tasks,
      projects: [{ id: 'p1', name: 'evowork', path: '/work/evowork' }],
      onVisibleChange,
    });

    const reported = onVisibleChange.mock.calls.at(-1)?.[0] as string[];
    expect(reported).toHaveLength(5);
  });
});

describe('行操作（04 §3.3）', () => {
  it('只显示已经接通的改名、归档与删除，不暴露无效操作', () => {
    const items = rowMenuItems(task({ id: 't1' }));
    expect(items.map((item) => item.id)).toEqual(['rename', 'archive', 'delete']);
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

  it('点「项目」后同一行提供 ⋯ 与 +，+ 直接请求创建项目', () => {
    const onNavSelect = vi.fn();
    const onProjectCreate = vi.fn();
    renderSidebar({ activeNavId: 'projects', onNavSelect, onProjectCreate });

    fireEvent.click(screen.getByRole('button', { name: '项目' }));
    expect(onNavSelect).toHaveBeenCalledWith('projects');
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

  it('项目内任务嵌在对应项目下，且不会在「最近」中重复出现', () => {
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
    expect(within(project as HTMLElement).getByText('调整侧栏布局')).toBeTruthy();
    expect(screen.getAllByText('调整侧栏布局')).toHaveLength(1);
    expect(screen.getByText('独立任务')).toBeTruthy();
  });

  it('「最近」的计数只包含未归属项目的任务，删掉最后一条后归零', () => {
    const project = { id: 'p1', name: 'evowork', path: '/work/evowork' };
    const projectTask = task({ id: 'project-task', title: '项目任务', cwd: project.path });
    const recentTask = task({ id: 'recent-task', title: '独立任务' });
    const { rerender } = renderSidebar({
      projects: [project],
      tasks: [projectTask, recentTask],
    });

    expect(screen.getByText('(1)')).toBeTruthy();

    rerender(<Sidebar projects={[project]} tasks={[projectTask]} sections={[]} />);
    expect(screen.getByText('(0)')).toBeTruthy();
    expect(screen.queryByText('独立任务')).toBeNull();
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
