/**
 * 任务工作台（04）的行为约束。
 *
 * 盯的是文档里带"必须/默认"的四条：结果区默认收起并按需打开、
 * 状态文案与 01 §6.1 一致（含"已中断"这一态）、审批卡内联而非模态、
 * 空态给出下一步动作。
 */
import { fireEvent, render, screen } from '@testing-library/react';
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
  it('**默认收起**', () => {
    const { container } = renderWorkspace();
    expect(container.querySelector('.ew-result-pane')).toBeNull();
    expect(container.querySelector('.ew-task-workspace')?.getAttribute('data-result-open')).toBe(
      'false',
    );
  });

  it('有结果时仍保持收起，并提供明确入口', () => {
    const { container } = renderWorkspace({ hasResults: true });
    expect(container.querySelector('.ew-result-pane')).toBeNull();
    expect(screen.getByRole('button', { name: '打开结果' })).toBeTruthy();
  });

  it('用户打开和关闭结果区，不被内容变化抢开', () => {
    const { container, rerender, props } = renderWorkspace({ hasResults: true });
    fireEvent.click(screen.getByRole('button', { name: '打开结果' }));
    expect(container.querySelector('.ew-result-pane')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '关闭结果' }));
    expect(container.querySelector('.ew-result-pane')).toBeNull();

    // 又来了一个产物：不该把面板重新弹开（那会打断用户）
    rerender(<TaskWorkspace {...props} hasResults={true} />);
    expect(container.querySelector('.ew-result-pane')).toBeNull();
  });

  it('结果区四视图用**浅色**分段控件（01 §5.10：决定已装内容怎么看）', () => {
    const { container } = renderWorkspace({ hasResults: true });
    fireEvent.click(screen.getByRole('button', { name: '打开结果' }));
    const segmented = container.querySelector('.ew-segmented');
    expect(segmented?.getAttribute('data-variant')).toBe('light');
    for (const label of ['产物', '文件', '变更', '浏览器']) {
      expect(screen.getByRole('tab', { name: label })).toBeTruthy();
    }
  });

  it('⌘I 切换结果区（02 §6）', () => {
    const { container } = renderWorkspace({ hasResults: true });
    fireEvent.keyDown(window, { key: 'i', metaKey: true });
    expect(container.querySelector('.ew-result-pane')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'i', metaKey: true });
    expect(container.querySelector('.ew-result-pane')).toBeNull();
  });

  it('无产物时的空态解释什么算产物（04 §8）', () => {
    renderWorkspace({ hasResults: true });
    fireEvent.click(screen.getByRole('button', { name: '打开结果' }));
    expect(screen.getByText('还没有产物')).toBeTruthy();
    expect(screen.getByText(/文档、表格、幻灯片等交付物/)).toBeTruthy();
  });

  it('没有可展示结果时不显示空面板入口，快捷键也不会打开', () => {
    const { container } = renderWorkspace();
    expect(screen.queryByRole('button', { name: '打开结果' })).toBeNull();
    fireEvent.keyDown(window, { key: 'i', metaKey: true });
    expect(container.querySelector('.ew-result-pane')).toBeNull();
  });

  it('顶栏不展示重命名、分叉、归档、删除；归档删除仍在侧栏任务菜单', () => {
    renderWorkspace({ hasResults: true, title: '季度汇报 PPT' });
    expect(screen.getByRole('heading', { name: '季度汇报 PPT' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '打开结果' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重命名' })).toBeNull();
    expect(screen.queryByRole('button', { name: '分叉' })).toBeNull();
    expect(screen.queryByRole('button', { name: '归档' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull();
  });
});

describe('思考与执行过程（04 §5.1–§5.2）', () => {
  it('同一回合的思考、操作与中间回复收成一个过程组，点开前不挂载细节', () => {
    const { container } = renderWorkspace({
      items: [
        {
          id: 'reasoning-1',
          type: 'reasoning',
          completed: true,
          durationSeconds: 2,
          content: ['先分析表结构'],
        },
        {
          id: 'note-1',
          type: 'agentMessage',
          completed: true,
          text: '先看看工作空间里有什么可用的项目信息。',
        },
        {
          id: 'command-1',
          type: 'commandExecution',
          completed: true,
          command: 'python render.py',
          output: 'rendered 12 slides',
          exitCode: 0,
        },
        {
          id: 'answer-1',
          type: 'agentMessage',
          completed: true,
          text: 'PPT 已完成',
        },
      ],
    });

    const process = screen.getByRole('button', { name: /处理过程/ });
    expect(screen.getAllByRole('button', { name: /处理过程/ })).toHaveLength(1);
    expect(process.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /思考与计划/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /操作/ })).toBeNull();
    expect(screen.queryByText('先看看工作空间里有什么可用的项目信息。')).toBeNull();
    expect(screen.getByText('PPT 已完成')).toBeTruthy();
    expect(container.querySelector('[data-kind="reasoning"]')).toBeNull();
    expect(container.querySelector('[data-kind="commandExecution"]')).toBeNull();
    expect(screen.queryByText(/rendered 12 slides/)).toBeNull();

    fireEvent.click(process);
    expect(screen.getByText('先看看工作空间里有什么可用的项目信息。')).toBeTruthy();
    expect(container.querySelector('[data-kind="reasoning"]')).not.toBeNull();
    expect(container.querySelector('[data-kind="commandExecution"]')).not.toBeNull();
    // 命令自己的输出仍保持第二层折叠，不会因展开过程组直接灌满屏幕。
    expect(screen.queryByText(/rendered 12 slides/)).toBeNull();
  });

  it('没有后续过程时，助手回复始终直接显示', () => {
    const { container } = renderWorkspace({
      items: [
        { id: 'reasoning-1', type: 'reasoning', completed: true },
        { id: 'command-1', type: 'commandExecution', completed: true, command: 'open result' },
        { id: 'answer-1', type: 'agentMessage', completed: true, text: 'PPT 已完成' },
      ],
    });

    expect(screen.getByText('PPT 已完成')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /处理过程/ })).toHaveLength(1);
    expect(container.querySelector('[data-kind="commandExecution"]')).toBeNull();
  });

  it('groupTimelineItems 把中间回复留在过程组里，只把最后的结论铺开', () => {
    const entries = groupTimelineItems([
      { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '整理文档' }] },
      { id: 'r1', type: 'reasoning', completed: true },
      { id: 'n1', type: 'agentMessage', completed: true, text: '先看目录' },
      { id: 'c1', type: 'commandExecution', completed: true, command: 'ls' },
      { id: 'a1', type: 'agentMessage', completed: true, text: '这是结论' },
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(['item', 'process', 'item']);
    expect(entries[1]?.kind === 'process' ? entries[1].items.map((item) => item.id) : []).toEqual([
      'r1',
      'n1',
      'c1',
    ]);
    expect(entries[2]?.kind === 'item' ? entries[2].item.id : '').toBe('a1');
  });

  it('模型无推理能力或企业隐藏策略时，不留下空的过程组', () => {
    const { container } = renderWorkspace({
      items: [
        { id: 'reasoning-1', type: 'reasoning', completed: true },
        { id: 'hook-1', type: 'hookPrompt', completed: true, text: '内部策略' },
      ],
      itemContext: { reasoningAvailable: false, hidePolicyPrompts: true },
    });

    expect(container.querySelector('.ew-process-group')).toBeNull();
    expect(screen.queryByRole('button', { name: /思考|处理过程/ })).toBeNull();
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

describe('2.7.3–2.7.5 补齐项', () => {
  it('同一回合的过程事件收成一个折叠行，并保留当前动作与状态', () => {
    renderWorkspace({
      items: [
        { id: 'r', type: 'reasoning', completed: true, content: ['分析需求'] },
        { id: 'c', type: 'commandExecution', completed: false, command: 'pnpm test' },
        { id: 'f', type: 'fileChange', completed: true, changes: [{ path: 'a.ts' }] },
        { id: 's', type: 'subAgentActivity', completed: true, agentRole: '研究员' },
        { id: 'i', type: 'imageGeneration', completed: true, prompt: '封面' },
      ],
    });

    const process = screen.getByRole('button', { name: /处理过程.*生成图片.*进行中/ });
    expect(screen.getAllByRole('button', { name: /处理过程/ })).toHaveLength(1);
    expect(process.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('button', { name: /思考与计划/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^操作/ })).toBeNull();
  });

  it('回合失败留在时间线并提供重试和设置入口；停止显示可继续分隔线', () => {
    const onRetry = vi.fn();
    const onOpenSettings = vi.fn();
    renderWorkspace({
      status: 'interrupted',
      turnFailure: { summary: '模型暂时不可用', onRetry, onOpenSettings },
    });

    expect(screen.getByText('已停止，可在下方继续')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('模型暂时不可用');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    fireEvent.click(screen.getByRole('button', { name: '打开模型设置' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onOpenSettings).toHaveBeenCalledOnce();
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
    const trigger = screen.getByRole('button', { name: '打开结果' });
    fireEvent.click(trigger);
    const separator = screen.getByRole('separator', { name: '调整结果区宽度' });
    expect(separator.getAttribute('aria-valuenow')).toBe('560');
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator.getAttribute('aria-valuenow')).toBe('584');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('separator', { name: '调整结果区宽度' })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
