/**
 * 任务工作台（04）的行为约束。
 *
 * 盯的是文档里带"必须/默认/自动"的四条：结果区默认收起且首次有产物时自动展开一次、
 * 状态文案与 01 §6.1 一致（含"已中断"这一态）、审批卡内联而非模态、
 * 空态给出下一步动作。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ApprovalViewModel } from '../src/renderer/components/approval-card.js';
import type { RenderItem } from '../src/renderer/components/item-renderers.js';
import {
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

  it('首次有产物时**自动展开一次**', () => {
    const { container } = renderWorkspace({ hasResults: true });
    expect(container.querySelector('.ew-result-pane')).not.toBeNull();
  });

  it('自动展开后**尊重用户的开合状态** —— 用户关掉就不再自动打开', () => {
    const { container, rerender, props } = renderWorkspace({ hasResults: true });
    expect(container.querySelector('.ew-result-pane')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '隐藏详情面板' }));
    expect(container.querySelector('.ew-result-pane')).toBeNull();

    // 又来了一个产物：不该把面板重新弹开（那会打断用户）
    rerender(<TaskWorkspace {...props} hasResults={true} />);
    expect(container.querySelector('.ew-result-pane')).toBeNull();
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
    const { container } = renderWorkspace();
    fireEvent.keyDown(window, { key: 'i', metaKey: true });
    expect(container.querySelector('.ew-result-pane')).not.toBeNull();
    fireEvent.keyDown(window, { key: 'i', metaKey: true });
    expect(container.querySelector('.ew-result-pane')).toBeNull();
  });

  it('无产物时的空态解释什么算产物（04 §8）', () => {
    renderWorkspace({ hasResults: true });
    expect(screen.getByText('还没有产物')).toBeTruthy();
    expect(screen.getByText(/文档、表格、幻灯片等交付物/)).toBeTruthy();
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
    renderWorkspace({ onNewTask });
    expect(screen.getByText('输入你的第一个需求')).toBeTruthy();
    expect(screen.getByText(/说清你要什么产物/)).toBeTruthy();
    expect(screen.queryByText(/暂无/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    expect(onNewTask).toHaveBeenCalled();
  });
});

describe('流式区的无障碍（01 §8.1）', () => {
  it('对话内容用 aria-live="polite"（**不用 assertive**，否则每个 token 都打断）', () => {
    const { container } = renderWorkspace();
    const column = container.querySelector('.ew-content-column');
    expect(column?.getAttribute('aria-live')).toBe('polite');
  });
});
