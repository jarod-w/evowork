/**
 * 渲染进程外壳（`app.tsx`）。
 *
 * 盯两件事：**首页不创建 Thread**（发送后才有任务、才切页），
 * 以及流式增量按 id 合并 —— 后者做错的表现是同一条消息在对话里出现两次。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { App, mergeItem, type EvoworkBridge, type UiEventFromMain } from '../src/renderer/app.js';

function fakeBridge(over: Partial<EvoworkBridge> = {}) {
  const emit: { ui?: (e: UiEventFromMain) => void } = {};
  const bridge: EvoworkBridge = {
    onUiEvent: (handler) => {
      emit.ui = handler;
      return () => undefined;
    },
    onNotice: () => () => undefined,
    onPendingApprovals: () => () => undefined,
    onDegrade: () => () => undefined,
    send: vi.fn(async () => ({ threadId: 't1' })),
    interrupt: vi.fn(async () => undefined),
    decideApproval: vi.fn(async () => undefined),
    rowAction: vi.fn(async () => undefined),
    refreshVisible: vi.fn(async () => undefined),
    listScenarios: async () => [{ id: 'office', name: '日常办公', chips: [], defaults: {} }],
    ...over,
  };
  return { bridge, emit };
}

describe('首页不创建 Thread（03 §1）', () => {
  it('刚打开时在首页，且**还没有任何任务**', async () => {
    const { bridge } = fakeBridge();
    render(<App bridge={bridge} />);
    await waitFor(() => expect(screen.getByRole('tab', { name: '日常办公' })).toBeTruthy());
    expect(bridge.send).not.toHaveBeenCalled();
    expect(screen.getByText('EvoWork，我帮你')).toBeTruthy();
  });

  it('发送第一条消息后才建任务并切到任务页', async () => {
    const { bridge } = fakeBridge();
    render(<App bridge={bridge} />);
    await waitFor(() => screen.getByLabelText('需求输入'));

    fireEvent.change(screen.getByLabelText('需求输入'), { target: { value: '做个周报' } });
    fireEvent.keyDown(screen.getByLabelText('需求输入'), { key: 'Enter' });

    await waitFor(() => expect(bridge.send).toHaveBeenCalledWith({ text: '做个周报' }));
    // 切到任务页：首页的 Hero 不在了
    await waitFor(() => expect(screen.queryByText('EvoWork，我帮你')).toBeNull());
  });

  it('在任务页里发送带上 threadId（不会又建一个新任务）', async () => {
    const { bridge } = fakeBridge();
    render(<App bridge={bridge} />);
    await waitFor(() => screen.getByLabelText('需求输入'));
    fireEvent.change(screen.getByLabelText('需求输入'), { target: { value: '第一条' } });
    fireEvent.keyDown(screen.getByLabelText('需求输入'), { key: 'Enter' });
    await waitFor(() => expect(screen.queryByText('EvoWork，我帮你')).toBeNull());

    // 任务页底部是**同一个** Composer（03 §4.6），再发一条要带上 threadId
    fireEvent.change(screen.getByLabelText('需求输入'), { target: { value: '第二条' } });
    fireEvent.keyDown(screen.getByLabelText('需求输入'), { key: 'Enter' });
    await waitFor(() =>
      expect(bridge.send).toHaveBeenLastCalledWith({ threadId: 't1', text: '第二条' }),
    );
  });
});

describe('事件接线', () => {
  it('任务创建事件进侧边栏列表', async () => {
    const { bridge, emit } = fakeBridge();
    render(<App bridge={bridge} />);
    await waitFor(() => expect(emit.ui).toBeDefined());

    emit.ui?.({
      type: 'task-created',
      task: {
        id: 't9',
        title: '季度汇报',
        status: 'running',
        timeLabel: '刚刚',
        sectionId: 'ungrouped',
      },
    });
    await waitFor(() => expect(screen.getByText('季度汇报')).toBeTruthy());
  });

  it('可见页变化往主进程报（04 §3.4 第②步）', async () => {
    const { bridge, emit } = fakeBridge();
    render(<App bridge={bridge} />);
    await waitFor(() => expect(emit.ui).toBeDefined());
    emit.ui?.({
      type: 'task-created',
      task: { id: 't9', title: 'x', status: 'idle', timeLabel: '刚刚', sectionId: 'ungrouped' },
    });
    await waitFor(() => expect(bridge.refreshVisible).toHaveBeenCalledWith(['t9']));
  });
});

describe('流式增量按 id 合并（04 §5.1）', () => {
  it('同 id 覆盖，新 id 追加 —— 不合并的表现是同一条消息出现两次', () => {
    const a = { id: 'i1', type: 'agentMessage', text: '你' };
    const a2 = { id: 'i1', type: 'agentMessage', text: '你好' };
    const b = { id: 'i2', type: 'agentMessage', text: '第二条' };

    expect(mergeItem([], a)).toEqual([a]);
    expect(mergeItem([a], a2)).toEqual([a2]);
    expect(mergeItem([a], b)).toEqual([a, b]);
    // 覆盖时**保持原位置**，否则流式更新会让消息在列表里跳到末尾
    expect(mergeItem([a, b], a2)).toEqual([a2, b]);
  });
});
