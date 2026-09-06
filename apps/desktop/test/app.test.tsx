/**
 * 渲染进程外壳（`app.tsx`）。
 *
 * 盯两件事：**首页不创建 Thread**（发送后才有任务、才切页），
 * 以及流式增量按 id 合并 —— 后者做错的表现是同一条消息在对话里出现两次。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ModelOptionView, RendererEvent, StartupInfo } from '../src/shared/ipc.js';
import { App, mergeItem, type EvoworkBridge } from '../src/renderer/app.js';

const STARTUP: StartupInfo = {
  appName: 'EvoWork',
  appVersion: '0.0.0',
  userName: '本机用户',
  scenarios: [{ id: 'office', name: '日常办公', chips: [], defaults: {} }],
  permissions: [{ id: 'evowork-workspace', label: 'evowork-workspace', allowed: true }],
  cases: [],
  tasks: [],
};

/** 网关目录里的两个模型。**能力位刻意不同** —— 下拉要能画出"这个不支持读图"。 */
const MODELS: readonly ModelOptionView[] = [
  {
    id: 'evowork/deepseek-v4-flash',
    label: 'deepseek/deepseek-v4-flash',
    provider: 'deepseek',
    capabilities: [
      { id: 'reasoning', label: '推理', available: true },
      { id: 'image-input', label: '读图', available: false },
      { id: 'parallel-tools', label: '并行工具', available: true },
    ],
    notices: ['这个模型不支持图片输入，可切换模型。'],
  },
  {
    id: 'evowork/kimi-k3',
    label: 'moonshot/kimi-k3',
    provider: 'moonshot',
    capabilities: [
      { id: 'reasoning', label: '推理', available: true },
      { id: 'image-input', label: '读图', available: true },
      { id: 'parallel-tools', label: '并行工具', available: true },
    ],
    notices: [],
  },
];

function fakeBridge(over: Partial<EvoworkBridge> = {}) {
  const emit: { ui?: (e: RendererEvent) => void } = {};
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
    getStartup: async () => STARTUP,
    listModels: vi.fn(async () => ({ models: MODELS })),
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

    await waitFor(() =>
      expect(bridge.send).toHaveBeenCalledWith({
        text: '做个周报',
        scenarioId: 'office',
        // 场景没给默认模型 → 用列表里第一个可用的（resolveModelChoice）
        modelId: 'evowork/deepseek-v4-flash',
      }),
    );
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
      expect(bridge.send).toHaveBeenLastCalledWith({
        threadId: 't1',
        text: '第二条',
        scenarioId: 'office',
        modelId: 'evowork/deepseek-v4-flash',
      }),
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

describe('手动选模型（03 §4.5 / §2.4）', () => {
  it('下拉里按 provider 分组列出网关给的模型，并画出缺失能力', async () => {
    const { bridge } = fakeBridge();
    render(<App bridge={bridge} />);
    await waitFor(() => screen.getByLabelText('选择模型'));

    fireEvent.click(screen.getByLabelText('选择模型'));
    expect(screen.getByRole('menuitem', { name: /deepseek\/deepseek-v4-flash/ })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /moonshot\/kimi-k3/ })).toBeTruthy();
    // D2「降级必须显式」：不支持的能力**渲染出来**（灰色划除），不隐藏
    expect(screen.getAllByLabelText('不支持读图').length).toBe(1);
  });

  /** 这条就是需求本身：选中的那个必须真的跟着消息发出去。 */
  it('选中一个模型后，发出去的消息带的是**它**，不是场景默认值', async () => {
    const { bridge } = fakeBridge();
    render(<App bridge={bridge} />);
    await waitFor(() => screen.getByLabelText('选择模型'));

    fireEvent.click(screen.getByLabelText('选择模型'));
    fireEvent.click(screen.getByRole('menuitem', { name: /moonshot\/kimi-k3/ }));

    fireEvent.change(screen.getByLabelText('需求输入'), { target: { value: '做个周报' } });
    fireEvent.keyDown(screen.getByLabelText('需求输入'), { key: 'Enter' });

    await waitFor(() =>
      expect(bridge.send).toHaveBeenCalledWith({
        text: '做个周报',
        scenarioId: 'office',
        modelId: 'evowork/kimi-k3',
      }),
    );
  });

  it('手动选过之后出现"已被你改过"的圆点（03 §2.5）', async () => {
    const { bridge } = fakeBridge();
    render(<App bridge={bridge} />);
    await waitFor(() => screen.getByLabelText('选择模型'));
    expect(screen.queryByLabelText(/模型已被你改过/)).toBeNull();

    fireEvent.click(screen.getByLabelText('选择模型'));
    fireEvent.click(screen.getByRole('menuitem', { name: /moonshot\/kimi-k3/ }));

    await waitFor(() => expect(screen.getByLabelText(/模型已被你改过/)).toBeTruthy());
  });

  /**
   * 03 §8：网关不通时**在发送之前就说**，并禁用发送。
   * 上一版的表现是：能打字、能回车、任务建出来、然后失败 —— 用户唯一能做的是再试一次。
   */
  it('网关连不上 → danger 条 + 发送按钮禁用，而不是让用户发出去再失败', async () => {
    const { bridge } = fakeBridge({
      listModels: vi.fn(async () => ({ models: [], unavailable: '连不上模型网关' })),
    });
    render(<App bridge={bridge} />);

    await waitFor(() => expect(screen.getByText('连不上模型网关')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('需求输入'), { target: { value: '做个周报' } });
    fireEvent.keyDown(screen.getByLabelText('需求输入'), { key: 'Enter' });
    expect(bridge.send).not.toHaveBeenCalled();
  });

  /**
   * 打开一个用别的模型跑过的旧任务 → 下拉必须显示**那个任务的**模型。
   *
   * 少了它，用户打开旧任务直接接着问一句，那一句会被发给当前选中的模型 ——
   * 又一次"静默换模型"，而且完全看不出来。
   */
  it('切到旧任务时，下拉跟着那个任务上次用的模型走', async () => {
    const { bridge, emit } = fakeBridge();
    render(<App bridge={bridge} />);
    // 场景没给默认模型 → 先选中列表里第一个
    await waitFor(() =>
      expect(screen.getByLabelText('选择模型').textContent).toContain('deepseek/deepseek-v4-flash'),
    );

    emit.ui?.({
      type: 'task-created',
      task: {
        id: 't-old',
        title: '上周的周报',
        status: 'completed',
        timeLabel: '2 天前',
        sectionId: 'ungrouped',
        modelId: 'evowork/kimi-k3',
      },
    });
    fireEvent.click(await screen.findByText('上周的周报'));

    await waitFor(() =>
      expect(screen.getByLabelText('选择模型').textContent).toContain('moonshot/kimi-k3'),
    );
  });

  it('「检查模型接入」重新拉一次列表 —— 用户通常是去把网关起起来了再回来点它', async () => {
    const listModels = vi.fn(async () => ({ models: [], unavailable: '连不上模型网关' }));
    const { bridge } = fakeBridge({ listModels });
    render(<App bridge={bridge} />);

    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '检查模型接入' }));
    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(2));
  });
});
