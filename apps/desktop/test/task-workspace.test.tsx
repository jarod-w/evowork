/**
 * 任务工作台（04）的行为约束。
 *
 * 盯的是文档里带"必须/默认"的四条：有结果时默认显示且可手动收起、
 * 状态文案与 01 §6.1 一致（含"已中断"这一态）、审批卡内联而非模态、
 * 空态给出下一步动作。
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ApprovalViewModel } from '../src/renderer/components/approval-card.js';
import type { RenderItem } from '../src/renderer/components/item-renderers.js';
import {
  groupTimelineItems,
  STATUS_VIEW,
  TaskWorkspace,
  type TaskStatus,
} from '../src/renderer/views/task-workspace.js';

const ITEM_CTX = { reasoningAvailable: true };

describe('来源的分组与分页接线', () => {
  it('来源条目未挂载时仍能引用；展开旧消息后也不能用后来的来源给它背书', () => {
    const source = {
      id: 'web_0123456789abcdef',
      url: 'https://example.test/report',
      title: '官方报告',
      kind: 'page',
      retrievedAt: '2026-10-06T04:00:00.000Z',
      excerpt: '已读正文',
      truncated: false,
    };
    const { container } = renderWorkspace({
      status: 'completed',
      items: [
        { id: 'early', type: 'agentMessage', text: `早期回答[[cite:${source.id}]]` },
        {
          id: 'research',
          type: 'mcpToolCall',
          server: 'browser',
          tool: 'browser_read_page',
          status: 'completed',
          completed: true,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ evoworkWeb: 1, ok: true, kind: 'page', sources: [source] }),
              },
            ],
          },
        },
        ...Array.from({ length: 130 }, (_, index) => ({
          id: `filler-${index}`,
          type: 'userMessage',
          text: `历史消息${index}`,
        })),
        { id: 'late', type: 'agentMessage', text: `后期回答[[cite:${source.id}]]` },
      ],
    });
    expect(container.querySelector('[data-task-item-id="research"]')).toBeNull();
    expect(screen.getAllByRole('link', { name: '[example.test]' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /更早/ }));
    expect(screen.getByText('[来源不可用]')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: '[example.test]' })).toHaveLength(1);
  });
});

function renderWorkspace(over: Partial<Parameters<typeof TaskWorkspace>[0]> = {}) {
  const props = {
    title: '季度汇报 PPT',
    status: 'running' as TaskStatus,
    items: [] as readonly RenderItem[],
    pendingApprovals: [] as readonly ApprovalViewModel[],
    onDecide: vi.fn(),
    itemContext: ITEM_CTX,
    ...over,
  };
  return { ...render(<TaskWorkspace {...props} />), props };
}

describe('状态视觉规范（01 §6.1）', () => {
  it('无预算的长任务也显示目标，实际计划步骤和当前动作可见', () => {
    renderWorkspace({
      goal: {
        threadId: 't1',
        objective: '完成季度报告',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 12,
        timeUsedSeconds: 3,
        createdAt: 1,
        updatedAt: 2,
      },
      items: [
        {
          id: 'plan',
          type: 'plan',
          steps: [
            { step: '收集资料', status: 'completed' },
            { step: '生成报告', status: 'inProgress' },
          ],
        },
      ],
    });
    const progress = screen.getByRole('region', { name: '持续目标' });
    expect(progress.textContent).toContain('完成季度报告');
    expect(progress.textContent).toContain('已完成 1/2 步 · 当前：生成报告');
    expect(progress.textContent).toContain('持续推进中');
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('中断提供继续入口；恢复期间禁用，避免再次追加', () => {
    const onContinue = vi.fn();
    const { rerender, props } = renderWorkspace({
      status: 'interrupted',
      onContinue,
      continueDisabled: true,
    });
    const button = screen.getByRole('button', { name: '继续任务' });
    fireEvent.click(button);
    expect(onContinue).not.toHaveBeenCalled();
    rerender(<TaskWorkspace {...props} continueDisabled={false} />);
    fireEvent.click(button);
    expect(onContinue).toHaveBeenCalledOnce();
  });
  it('六态 + 已中断 + idle 都有文案，且「待你确认」用第二人称', () => {
    expect(STATUS_VIEW.pending.label).toBe('待你确认');
    expect(STATUS_VIEW.running.label).toBe('进行中');
    expect(STATUS_VIEW.planning.label).toBe('规划中');
    expect(STATUS_VIEW.completed.label).toBe('已完成');
    expect(STATUS_VIEW.failed.label).toBe('失败');
    expect(STATUS_VIEW.archived.label).toBe('已归档');
    // 04 §2.2：清单没有这一态，但用户会遇到；映射到"已完成"会误导，"失败"会让人以为出错
    expect(STATUS_VIEW.interrupted.label).toBe('已中断，可继续');
  });

  it('进行中与待处理带呼吸，其余不带（01 §6.1）', () => {
    expect(STATUS_VIEW.running.breathing).toBe(true);
    expect(STATUS_VIEW.pending.breathing).toBe(true);
    expect(STATUS_VIEW.completed.breathing).toBe(false);
    expect(STATUS_VIEW.failed.breathing).toBe(false);
  });

  it('渲染时状态点 + 文字 Badge 同时出现（状态不靠颜色单传，01 §8.1）', () => {
    const { container } = renderWorkspace({ status: 'pending' });
    expect(screen.getByText('待你确认')).toBeTruthy();
    const dot = container.querySelector('.ew-status-dot');
    expect(dot).not.toBeNull();
    // 点被定义为**冗余装饰**（6px 撑不到 3:1），所以对屏幕阅读器隐藏
    expect(dot?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('结果区（04 §1）', () => {
  it('没有可展示结果时默认不显示', () => {
    const { container } = renderWorkspace();
    expect(container.querySelector('.ew-result-pane')).toBeNull();
    expect(container.querySelector('.ew-task-workspace')?.getAttribute('data-result-open')).toBe(
      'false',
    );
  });

  it('有结果时默认显示，并提供明确的收起入口', () => {
    const { container } = renderWorkspace({ hasResults: true });
    expect(container.querySelector('.ew-result-pane')).not.toBeNull();
    expect(screen.getByRole('button', { name: '关闭结果' })).toBeTruthy();
  });

  it('用户关闭和重新打开结果区，关闭后不被内容变化抢开', () => {
    const { container, rerender, props } = renderWorkspace({ hasResults: true });
    fireEvent.click(screen.getByRole('button', { name: '关闭结果' }));
    expect(container.querySelector('.ew-result-pane')).toBeNull();

    // 又来了一个产物：不该把面板重新弹开（那会打断用户）
    rerender(<TaskWorkspace {...props} hasResults={true} />);
    expect(container.querySelector('.ew-result-pane')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '打开结果' }));
    expect(container.querySelector('.ew-result-pane')).not.toBeNull();
  });

  it('结果区四视图用**浅色**分段控件（01 §5.10：决定已装内容怎么看）', () => {
    const { container } = renderWorkspace({ hasResults: true });
    const segmented = container.querySelector('.ew-segmented');
    expect(segmented?.getAttribute('data-variant')).toBe('light');
    for (const label of ['产物', '文件', '变更', '浏览器']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    }
  });

  it('⌘I 切换结果区（02 §6）', () => {
    const { container } = renderWorkspace({ hasResults: true });
    fireEvent.keyDown(window, { key: 'i', metaKey: true });
    expect(container.querySelector('.ew-result-pane')).toBeNull();
    fireEvent.keyDown(window, { key: 'i', metaKey: true });
    expect(container.querySelector('.ew-result-pane')).not.toBeNull();
  });

  it('无产物时的空态解释什么算产物（04 §8）', () => {
    renderWorkspace({ hasResults: true });
    expect(screen.getByText('还没有产物')).toBeTruthy();
    expect(screen.getByText(/文档、表格、幻灯片等交付物/)).toBeTruthy();
  });

  it('没有可展示结果时不显示空面板入口，快捷键也不会打开', () => {
    const { container } = renderWorkspace();
    expect(screen.queryByRole('button', { name: '打开结果' })).toBeNull();
    fireEvent.keyDown(window, { key: 'i', metaKey: true });
    expect(container.querySelector('.ew-result-pane')).toBeNull();
  });

  it('目标、分叉和旁聊收进更多菜单，归档删除仍在侧栏任务菜单', () => {
    const onGoalSave = vi.fn();
    const onFork = vi.fn();
    renderWorkspace({ hasResults: true, title: '季度汇报 PPT', onGoalSave, onFork });
    expect(screen.getByRole('heading', { name: '季度汇报 PPT' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '关闭结果' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重命名' })).toBeNull();
    expect(screen.queryByRole('button', { name: '分叉' })).toBeNull();
    expect(screen.queryByRole('button', { name: '归档' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
    expect(screen.queryByText('设置目标')).toBeNull();
    expect(screen.queryByText('旁聊')).toBeNull();

    const more = screen.getByRole('button', { name: '任务更多操作' });
    fireEvent.click(more);
    const goal = screen.getByRole('menuitem', { name: '设置目标' });
    expect(document.activeElement).toBe(goal);
    fireEvent.keyDown(goal, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '分叉' }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
    expect(screen.getByRole('button', { name: '关闭结果' })).toBeTruthy();

    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: '设置目标' }));
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '任务目标' }), {
      target: { value: '完成季度报告' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onGoalSave).toHaveBeenCalledWith({ objective: '完成季度报告', tokenBudget: null });

    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: '分叉' }));
    expect(onFork).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(more);
    fireEvent.click(screen.getByRole('menuitem', { name: '旁聊' }));
    expect(onFork).toHaveBeenLastCalledWith(true);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(more);
    fireEvent.mouseDown(screen.getByRole('heading', { name: '季度汇报 PPT' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('说明与操作交错显示', () => {
  it('后续操作到达不会移动或隐藏已经显示的进度说明', () => {
    const items: RenderItem[] = [
      { id: 'u', type: 'userMessage', _turnId: 't', content: [{ type: 'text', text: '整理文档' }] },
      {
        id: 'n',
        type: 'agentMessage',
        _turnId: 't',
        phase: 'commentary',
        completed: true,
        text: '先看目录',
      },
    ];
    const { rerender, props, container } = renderWorkspace({ items });
    rerender(
      <TaskWorkspace
        {...props}
        items={[
          ...items,
          { id: 'c', type: 'commandExecution', _turnId: 't', command: 'ls', completed: false },
          {
            id: 'a',
            type: 'agentMessage',
            _turnId: 't',
            phase: 'final_answer',
            completed: true,
            text: '这是结论',
          },
        ]}
      />,
    );
    expect(screen.getByText('先看目录')).toBeTruthy();
    expect(screen.getByText('这是结论')).toBeTruthy();
    expect(
      [...container.querySelectorAll('[data-task-item-id]')].map((node) =>
        node.getAttribute('data-task-item-id'),
      ),
    ).toEqual(['u', 'n', 'a']);
    const group = screen.getByRole('button', { name: /操作记录/ });
    expect(group.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByLabelText('当前动作').textContent).toContain('ls');
    fireEvent.click(group);
    expect(container.querySelector('[data-task-item-id="c"]')).not.toBeNull();
  });

  it('只合并同回合相邻操作，未知阶段的说明也始终保留', () => {
    const entries = groupTimelineItems([
      { id: 'c1', type: 'commandExecution', _turnId: 'one' },
      { id: 'c2', type: 'webSearch', _turnId: 'one' },
      { id: 'n', type: 'agentMessage', _turnId: 'one', text: '已确认资料' },
      { id: 'c3', type: 'commandExecution', _turnId: 'one' },
      { id: 'c4', type: 'commandExecution', _turnId: 'two' },
      { id: 'unknown', type: 'futureEvent', _turnId: 'two' },
    ]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'process',
      'item',
      'process',
      'process',
      'item',
    ]);
    expect(entries[0]?.kind === 'process' ? entries[0].items.map((item) => item.id) : []).toEqual([
      'c1',
      'c2',
    ]);
  });

  it('完成后保留用户展开选择，输出仍需主动打开', () => {
    const command = {
      id: 'c',
      type: 'commandExecution',
      command: 'python render.py',
      output: 'rendered 12 slides',
    };
    const { rerender, props, container } = renderWorkspace({ items: [command] });
    fireEvent.click(screen.getByRole('button', { name: /操作记录/ }));
    rerender(<TaskWorkspace {...props} items={[{ ...command, completed: true, exitCode: 0 }]} />);
    expect(screen.getByRole('button', { name: /操作记录/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    expect(container.querySelector('[data-kind="commandExecution"]')).not.toBeNull();
    expect(screen.queryByText('rendered 12 slides')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /已运行 python/ }));
    expect(screen.getByText('rendered 12 slides')).toBeTruthy();
  });

  it('长操作组追加事件后保留展开选择，操作详情分页挂载', () => {
    const commands = Array.from({ length: 130 }, (_, index) => ({
      id: `c${index}`,
      type: 'commandExecution',
      _turnId: 't',
      completed: true,
      command: `cmd${index}`,
    }));
    const { rerender, props, container } = renderWorkspace({ items: commands });
    fireEvent.click(screen.getByRole('button', { name: /操作记录/ }));
    expect(container.querySelectorAll('[data-kind="commandExecution"]')).toHaveLength(120);
    rerender(
      <TaskWorkspace
        {...props}
        items={[
          ...commands,
          { id: 'c130', type: 'commandExecution', _turnId: 't', command: 'new command' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: /操作记录/ }).getAttribute('aria-expanded')).toBe(
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: /加载更早操作/ }));
    expect(container.querySelectorAll('[data-kind="commandExecution"]')).toHaveLength(131);
  });

  it('失败操作在摘要中可见，不把成功回合标成失败', () => {
    renderWorkspace({
      status: 'completed',
      items: [
        { id: 'c', type: 'commandExecution', command: 'try first', completed: true, exitCode: 1 },
        { id: 'a', type: 'agentMessage', text: '报告已生成', completed: true },
      ],
    });
    expect(screen.getByRole('button', { name: /操作记录/ }).textContent).toContain('1 项操作失败');
    expect(screen.getByText('报告已生成')).toBeTruthy();
    expect(screen.queryByLabelText('当前动作')).toBeNull();
  });

  it('推理单独折叠，运行时显示真实片段；无能力时不留空壳', () => {
    const { rerender, props, container } = renderWorkspace({
      items: [{ id: 'r', type: 'reasoning', text: '正在核对资料' }],
    });
    expect(screen.getByText('正在核对资料')).toBeTruthy();
    expect(container.querySelector('.ew-reasoning-body')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /思考中/ }));
    expect(container.querySelector('.ew-reasoning-body')?.textContent).toContain('正在核对资料');
    rerender(
      <TaskWorkspace
        {...props}
        itemContext={{ reasoningAvailable: false, hidePolicyPrompts: true }}
      />,
    );
    expect(container.querySelector('[data-kind="reasoning"]')).toBeNull();
  });

  it('回复先到也保持原顺序，不把晚到的过程移到答案上方', () => {
    const entries = groupTimelineItems([
      { id: 'a', type: 'agentMessage', text: '结论' },
      { id: 'c', type: 'commandExecution', completed: true },
    ]);
    expect(entries[0]?.kind === 'item' ? entries[0].item.id : '').toBe('a');
  });
});

describe('回合处理时间', () => {
  it('实时计时在终态固定，恢复后使用回合时间而不是工具耗时之和', () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    try {
      const { rerender, props } = renderWorkspace({
        turns: [{ id: 't', status: 'inProgress', startedAtMs: 90_000 }],
        items: [{ id: 'a', type: 'agentMessage', _turnId: 't', text: '正在处理' }],
      });
      expect(screen.getByLabelText('回合处理时间').textContent).toBe('已处理 10 秒');
      act(() => vi.advanceTimersByTime(2_000));
      expect(screen.getByLabelText('回合处理时间').textContent).toBe('已处理 12 秒');
      rerender(
        <TaskWorkspace {...props} turns={[{ id: 't', status: 'completed', durationMs: 72_000 }]} />,
      );
      act(() => vi.advanceTimersByTime(20_000));
      expect(screen.getByLabelText('回合处理时间').textContent).toBe('已处理 1 分钟 12 秒');
    } finally {
      vi.useRealTimers();
    }
  });

  it('等待首条输出或仅有用户消息的失败回合，也显示计时与真实状态', () => {
    const { container, rerender, props } = renderWorkspace({
      turns: [{ id: 't', status: 'inProgress', startedAtMs: Date.now() - 2_000 }],
      items: [
        {
          id: 'u',
          type: 'userMessage',
          _turnId: 't',
          content: [{ type: 'text', text: '开始工作' }],
        },
      ],
    });
    expect(screen.getByLabelText('回合处理时间').textContent).toMatch(/已处理/);
    const user = container.querySelector('[data-task-item-id="u"]');
    expect(user?.nextElementSibling?.getAttribute('aria-label')).toBe('回合处理时间');
    rerender(
      <TaskWorkspace {...props} turns={[{ id: 't', status: 'failed', durationMs: 2_000 }]} />,
    );
    expect(screen.getByLabelText('回合处理时间').textContent).toBe('已处理 2 秒 · 失败');
  });

  it('历史回合各有独立时间，缺失时间不编造；停止与断线区分', () => {
    renderWorkspace({
      turns: [
        { id: 'one', status: 'completed', durationMs: 12_000 },
        { id: 'two', status: 'interrupted' },
        { id: 'three', status: 'disconnected', startedAtMs: 10_000, completedAtMs: 20_000 },
      ],
      items: [
        { id: 'a', type: 'agentMessage', _turnId: 'one', text: '第一轮' },
        { id: 'b', type: 'agentMessage', _turnId: 'two', text: '第二轮' },
        { id: 'c', type: 'agentMessage', _turnId: 'three', text: '第三轮' },
      ],
    });
    expect(screen.getAllByLabelText('回合处理时间').map((node) => node.textContent)).toEqual([
      '已处理 12 秒',
      '处理记录 · 已停止',
      '已处理 10 秒 · 连接中断',
    ]);
  });
});

describe('审批：**内联在时间线上，不是模态**（04 §5.3）', () => {
  const approval: ApprovalViewModel = {
    id: 'apv_1',
    kind: 'command',
    threadId: 't1',
    reason: '会联网安装软件包',
    command: 'pip install openpyxl',
    allowAcceptForSession: true,
  };

  it('审批卡出现在对话区内容列里，且顶部有吸顶条', () => {
    const { container } = renderWorkspace({ pendingApprovals: [approval] });
    const card = container.querySelector('.ew-content-column .ew-approval-card');
    expect(card, '审批卡应在内容列里（内联），不是挂在 body 上的模态').not.toBeNull();
    expect(screen.getByText('有 1 项待你确认')).toBeTruthy();
  });

  it('决定沿着 onDecide 往上传（带 approval id）', () => {
    const onDecide = vi.fn();
    renderWorkspace({ pendingApprovals: [approval], onDecide });
    fireEvent.click(screen.getByRole('button', { name: '允许这一次' }));
    expect(onDecide).toHaveBeenCalledWith('apv_1', 'accept');
  });

  it('有待审批时不显示"输入第一个需求"的空态（那会盖住真正要做的事）', () => {
    renderWorkspace({ pendingApprovals: [approval] });
    expect(screen.queryByText('输入你的第一个需求')).toBeNull();
  });
});

describe('顶部提示条（04 §8）', () => {
  it('断连提示用 warning 并带动作', () => {
    const onAction = vi.fn();
    renderWorkspace({
      notices: [
        {
          tone: 'warning',
          text: '与执行内核的连接中断，正在重连…',
          actionLabel: '查看日志',
          onAction,
        },
      ],
    });
    expect(screen.getByText('与执行内核的连接中断，正在重连…')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看日志' }));
    expect(onAction).toHaveBeenCalled();
  });

  it('danger 级提示用 role=alert（会打断屏幕阅读器，符合它的紧急程度）', () => {
    const { container } = renderWorkspace({
      notices: [{ tone: 'danger', text: '工作空间路径已失效' }],
    });
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe('长任务控制面', () => {
  const goal = {
    threadId: 't1',
    objective: '完成季度报告',
    status: 'active' as const,
    tokenBudget: 10_000,
    tokensUsed: 8_200,
    timeUsedSeconds: 120,
    createdAt: 1,
    updatedAt: 2,
  };

  it('没有预算也常驻展示目标、中文状态及用量', () => {
    renderWorkspace({
      goal: { ...goal, tokenBudget: null, status: 'blocked' },
      onGoalSave: vi.fn(),
      onGoalStatus: vi.fn(),
      goalPanelRequest: 1,
    });
    expect(screen.getByLabelText('持续目标').textContent).toContain('等待解除阻塞');
    expect(screen.getByLabelText('持续目标').textContent).toContain('完成季度报告');
    expect(screen.queryByLabelText('Token 预算使用比例')).toBeNull();
    expect(screen.getByRole('button', { name: '继续' })).toHaveProperty('disabled', false);
  });

  it('目标预算持续显示进度，超过 80% 使用 warning', () => {
    const { container } = renderWorkspace({ goal, onGoalSave: vi.fn() });
    expect(screen.getByLabelText('Token 预算使用比例').getAttribute('value')).toBe('82');
    expect(container.querySelector('.ew-goal-progress')?.getAttribute('data-tone')).toBe('warning');
  });

  it('预算耗尽提供追加预算与结束任务两个动作', () => {
    const onGoalSave = vi.fn();
    const onGoalStatus = vi.fn();
    renderWorkspace({
      goal: { ...goal, status: 'budgetLimited', tokensUsed: 10_000 },
      onGoalSave,
      onGoalStatus,
    });
    fireEvent.click(screen.getByRole('button', { name: '追加预算' }));
    expect(onGoalSave).toHaveBeenCalledWith({
      objective: '完成季度报告',
      tokenBudget: 12_500,
      status: 'active',
    });
    fireEvent.click(screen.getByRole('button', { name: '结束任务' }));
    expect(onGoalStatus).toHaveBeenCalledWith('complete');
  });

  it('子任务从侧滑详情进入对应任务', () => {
    const onOpenSubtask = vi.fn();
    renderWorkspace({
      subtasks: [{ id: 'child-1', title: '整理数据', status: 'running', timeLabel: '刚刚' }],
      onOpenSubtask,
    });
    fireEvent.click(screen.getByRole('button', { name: '子任务 1' }));
    expect(screen.getByRole('complementary', { name: '子任务详情' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /整理数据/ }));
    expect(onOpenSubtask).toHaveBeenCalledWith('child-1');
  });

  it('子代理时间线明确只读，并把继续交代说明为根任务协作路由', () => {
    const onOpenRoot = vi.fn();
    renderWorkspace({
      subagentContext: {
        parentThreadId: 'parent-1',
        rootThreadId: 'root-1',
        rootTitle: '总任务',
        onOpenRoot,
      },
    });
    expect(screen.getByText(/子代理的只读时间线/)).toBeTruthy();
    expect(screen.getByText(/根任务「总任务」/)).toBeTruthy();
    expect(screen.getByText(/上下文不会自动持续共享/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '返回根任务' }));
    expect(onOpenRoot).toHaveBeenCalledOnce();
  });
});

describe('空态（01 §4.3：文案必须给出下一步动作）', () => {
  it('新任务的空态给出下一步，而不是"暂无数据"', () => {
    const onNewTask = vi.fn();
    renderWorkspace({ onNewTask, status: 'idle' });
    expect(screen.getByText('输入你的第一个需求')).toBeTruthy();
    expect(screen.getByText(/说清你要什么产物/)).toBeTruthy();
    expect(screen.queryByText(/暂无/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    expect(onNewTask).toHaveBeenCalled();
  });

  it('已完成任务在条目到达前不显示「还没有消息」—— 那是刚创建的空态', () => {
    renderWorkspace({ status: 'completed', historyLoading: true });
    expect(screen.queryByText('输入你的第一个需求')).toBeNull();
  });
});

describe('流式区的无障碍（01 §8.1）', () => {
  it('对话内容用 aria-live="polite"（**不用 assertive**，否则每个 token 都打断）', () => {
    const { container } = renderWorkspace();
    const column = container.querySelector('.ew-content-column');
    expect(column?.getAttribute('aria-live')).toBe('polite');
  });
});

describe('流式输出跟随', () => {
  it('同一个 item id 的正文增长时仍滚到底部', () => {
    const first = [{ id: 'a1', type: 'agentMessage', text: '你' }];
    const view = renderWorkspace({ items: first });
    const scroller = view.container.querySelector('.ew-conversation-scroll') as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 640 });
    scroller.scrollTop = 0;
    view.rerender(
      <TaskWorkspace {...view.props} items={[{ id: 'a1', type: 'agentMessage', text: '你好' }]} />,
    );
    expect(scroller.scrollTop).toBe(640);
  });
});

describe('生成中的 Composer 定位', () => {
  it('输入框在滚动区外独立占位，流式内容增高不会把它上下推动', () => {
    const { container } = renderWorkspace({
      composer: <div data-testid="composer">Composer</div>,
      items: [{ id: 'r1', type: 'reasoning', text: '正在生成报告' }],
    });
    const conversation = container.querySelector('.ew-conversation');
    const scroller = container.querySelector('.ew-conversation-scroll');
    const composer = container.querySelector('.ew-conversation-composer');

    expect(scroller).not.toBeNull();
    expect(conversation?.children).toContain(scroller);
    expect(conversation?.children).toContain(composer);
    expect(scroller?.contains(composer)).toBe(false);
  });
});

describe('2.7.3–2.7.5 补齐项', () => {
  it('操作收成组，计划、文件变更和产物保持独立可见', () => {
    const { container } = renderWorkspace({
      items: [
        { id: 'c', type: 'commandExecution', completed: false, command: 'pnpm test' },
        { id: 'f', type: 'fileChange', completed: true, changes: [{ path: 'a.ts' }] },
        { id: 'i', type: 'imageGeneration', completed: true, prompt: '封面' },
      ],
    });
    expect(
      screen.getByRole('button', { name: /操作记录.*进行中/ }).getAttribute('aria-expanded'),
    ).toBe('false');
    expect(screen.getByLabelText('当前动作').textContent).toContain('pnpm test');
    expect(container.querySelector('[data-kind="imageGeneration"]')).not.toBeNull();
    expect(screen.getByText('a.ts')).toBeTruthy();
  });

  it('回合失败留在时间线并提供重试和设置入口；停止显示可继续分隔线', () => {
    const onRetry = vi.fn();
    const onOpenSettings = vi.fn();
    renderWorkspace({
      status: 'interrupted',
      turnFailure: { text: '模型暂时不可用', onRetry, onOpenSettings },
    });

    expect(screen.getByText('已停止，可在下方继续')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('模型暂时不可用');

    // 只有人话、没有原文时，不该凭空冒出一个空的「详情」
    expect(screen.queryByText('详情')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    fireEvent.click(screen.getByRole('button', { name: '打开模型设置' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
  });

  it('重试中是一行状态，不是失败卡 —— 回合还在跑，读屏也不该被打断', () => {
    renderWorkspace({ status: 'running', turnRetry: { attempt: 2, maxAttempts: 5 } });

    const line = screen.getByRole('status');
    expect(line.textContent).toContain('上游断了，正在尝试重新连接');
    // 次数是给用户的"它在推进、而且有尽头"——没有它，五分钟的转圈和死机没区别
    expect(line.textContent).toContain('2/5');
    // **不能**是 alert：那会让读屏打断当前朗读，而且这不是错误
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('解不出次数时只说事，不编数字', () => {
    renderWorkspace({ status: 'running', turnRetry: {} });
    expect(screen.getByRole('status').textContent).toBe('上游断了，正在尝试重新连接');
  });

  it('长时间线先只挂载末尾分段，可按需加载更早内容', () => {
    const items = Array.from({ length: 130 }, (_, index): RenderItem => ({
      id: `m-${index}`,
      type: 'agentMessage',
      completed: true,
      text: `消息 ${index}`,
    }));
    renderWorkspace({ items });
    expect(screen.queryByText('消息 0')).toBeNull();
    expect(screen.getByText('消息 129')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /加载更早内容/ }));
    expect(screen.getByText('消息 0')).toBeTruthy();
  });

  it('结果区可用键盘调宽，Esc 关闭后焦点回到入口', () => {
    renderWorkspace({ hasResults: true });
    const trigger = screen.getByRole('button', { name: '关闭结果' });
    const separator = screen.getByRole('separator', { name: '调整结果区宽度' });
    expect(separator.getAttribute('aria-valuenow')).toBe('560');
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator.getAttribute('aria-valuenow')).toBe('584');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('separator', { name: '调整结果区宽度' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
