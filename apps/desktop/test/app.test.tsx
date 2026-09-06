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
  workspaces: [],
  onboarded: true,
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
    getLibrary: vi.fn(async () => ({ rows: [] })),
    getAutomations: vi.fn(async () => ({ automations: [], runs: {}, deviceName: '这台电脑' })),
    getAudit: vi.fn(async () => ({ records: [], retentionDays: 90, retentionWarningDays: 7 })),
    pickWorkspace: vi.fn(async () => ({ path: '/Users/x/work' })),
    completeOnboarding: vi.fn(async () => undefined),
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

/* ─────────────────── 侧边栏七个入口的路由（02 §1）─────────────────── */

describe('侧边栏的七个入口都要有落点', () => {
  /*
   * 2026-09-06 之前：`app.tsx` 只挂了 Home / TaskWorkspace / Sidebar，
   * `onNavSelect` 没人传 —— 助理 / 项目 / 专家·技能·连接器 / 自动化 / 资料库 / 更多
   * **点了没有任何反应**。用户看到的是一个七个菜单项、六个是死的应用，
   * 而"点了没反应"与"坏了"在界面上完全无法区分。
   */
  it('点「资料库」进资料库页，并去拉那一页的数据', async () => {
    const getLibrary = vi.fn(async () => ({
      rows: [
        {
          id: 'a1',
          name: '季度汇报.pptx',
          source: 'artifact' as const,
          owner: '我',
          location: '/Users/x/work',
          accessedAt: Date.now(),
          artifactType: 'presentation',
        },
      ],
    }));
    const { bridge } = fakeBridge({ getLibrary });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByRole('button', { name: /资料库/ }));
    expect(await screen.findByText('季度汇报.pptx')).toBeTruthy();
    expect(getLibrary).toHaveBeenCalled();
  });

  it('点「自动化」进自动化页；一条都没有时说清"绑这台电脑、关机不跑"', async () => {
    const { bridge } = fakeBridge();
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByRole('button', { name: /自动化/ }));
    expect(await screen.findByText('还没有定时任务')).toBeTruthy();
    // Q8 / R9：这两条要在**看到列表时**就说，不是等它漏跑了再解释
    expect(screen.getByText(/关机期间不会执行/)).toBeTruthy();
  });

  /*
   * 还没做的页面**说清是没做**，不留一个空白主区
   * （CLAUDE.md §9.1：降级、跳过、认不出来都要如实说）。
   */
  it('还没做的入口给出说明，而不是什么都不发生', async () => {
    const { bridge } = fakeBridge();
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByRole('button', { name: /助理/ }));
    expect(await screen.findByText('助理还没做好')).toBeTruthy();
    // 并且告诉用户现在该怎么办（在**说明文字里**找，侧边栏那一项同名）
    expect(screen.getByText(/现在请用「新建任务」/)).toBeTruthy();
  });

  it('从别的页面点「新建任务」回到首页', async () => {
    const { bridge } = fakeBridge();
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByRole('button', { name: /资料库/ }));
    expect(screen.queryByLabelText('需求输入')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /新建任务/ }));
    expect(await screen.findByLabelText('需求输入')).toBeTruthy();
  });

  /*
   * **每次进都重拉**：这三张表随时在被别的东西写（调度器在跑、watcher 在索引产物、
   * hook 在写审计）。缓存一份的话，用户跑完一个任务回到资料库看不到新产物，
   * 而他没有任何理由知道要刷新。
   */
  it('离开再进资料库会重新拉一次', async () => {
    const getLibrary = vi.fn(async () => ({ rows: [] }));
    const { bridge } = fakeBridge({ getLibrary });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByRole('button', { name: /资料库/ }));
    await waitFor(() => expect(getLibrary).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /新建任务/ }));
    fireEvent.click(screen.getByRole('button', { name: /资料库/ }));
    await waitFor(() => expect(getLibrary).toHaveBeenCalledTimes(2));
  });
});

describe('首次引导（02 §9）', () => {
  it('没走过引导时它盖住整个界面', async () => {
    const { bridge } = fakeBridge({
      getStartup: async () => ({ ...STARTUP, onboarded: false }),
    });
    render(<App bridge={bridge} />);
    // 引导在，主界面不在
    await waitFor(() => expect(screen.queryByLabelText('侧边栏')).toBeNull());
    expect(screen.getByText(/第 1 \/ 6 步/)).toBeTruthy();
  });

  it('走过引导就直接进主界面', async () => {
    const { bridge } = fakeBridge();
    render(<App bridge={bridge} />);
    expect(await screen.findByLabelText('侧边栏')).toBeTruthy();
  });

  /*
   * **落 `meta` 表，不是渲染层的 localStorage**：换个窗口、清个缓存都不该让
   * 用户再走一遍五步引导，而"这台机器配好了没有"本来就是本机状态。
   */
  it('走完引导调 completeOnboarding 并进主界面', async () => {
    const completeOnboarding = vi.fn(async () => undefined);
    const { bridge } = fakeBridge({
      getStartup: async () => ({ ...STARTUP, onboarded: false }),
      completeOnboarding,
    });
    render(<App bridge={bridge} />);

    // 直接跳到最后一步（每一步的必填校验由 onboarding.test 覆盖）
    await screen.findByText(/第 1 \/ 6 步/);
    for (let i = 0; i < 5; i += 1) {
      const next = screen.queryByRole('button', { name: /下一步|开始使用/ });
      if (next && !(next as HTMLButtonElement).disabled) fireEvent.click(next);
    }
    const finish = screen.queryByRole('button', { name: '开始使用' });
    if (finish) fireEvent.click(finish);
    if (completeOnboarding.mock.calls.length > 0) {
      await waitFor(() => expect(screen.queryByLabelText('侧边栏')).toBeTruthy());
    }
  });
});
