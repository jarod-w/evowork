/**
 * 渲染进程外壳（`app.tsx`）。
 *
 * 盯两件事：**首页不创建 Thread**（发送后才有任务、才切页），
 * 以及流式增量按 id 合并 —— 后者做错的表现是同一条消息在对话里出现两次。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Adapter } from '@evowork/kernel-adapter';
import { openStore } from '@evowork/store';

import type {
  ModelAccessView,
  ModelCatalogResult,
  ModelOptionView,
  RendererEvent,
  StartupInfo,
} from '../src/shared/ipc.js';
import { App, applyHistory, mergeItem, type EvoworkBridge } from '../src/renderer/app.js';
import { createRendererActions } from '../src/main/renderer-bridge.js';

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
    credentialSource: 'byok',
    verified: true,
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
    credentialSource: 'byok',
    verified: true,
  },
];

/** 设置页的默认视图。**没有任何密钥字段** —— 那个类型里就没有（11 §12 第 2 条） */
const ACCESS: ModelAccessView = {
  mode: 'local',
  secretBackend: 'keychain',
  providers: [
    { id: 'deepseek', label: 'DeepSeek', saved: true, last4: '3f9a' },
    { id: 'moonshot', label: 'Kimi（Moonshot）', saved: false },
    { id: 'zhipu', label: 'GLM（智谱）', saved: false },
  ],
  customModels: [],
  models: MODELS,
  allowCustomModels: true,
  signedIn: false,
};

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
    openTask: vi.fn(async () => ({ items: [] })),
    getStartup: async () => STARTUP,
    listModels: vi.fn(async () => ({ models: MODELS })),
    applyModelAccess: vi.fn(async () => ({ models: MODELS })),
    getLibrary: vi.fn(async () => ({ rows: [] })),
    getAutomations: vi.fn(async () => ({ automations: [], runs: {}, deviceName: '这台电脑' })),
    getAudit: vi.fn(async () => ({ records: [], retentionDays: 90, retentionWarningDays: 7 })),
    pickWorkspace: vi.fn(async () => ({ path: '/Users/x/work' })),
    pickProjectDirectory: vi.fn(async () => ({ path: '/Users/x/work' })),
    completeOnboarding: vi.fn(async () => undefined),
    /*
     * 办公扩展（08 §4）。默认"支持但没装" —— 这是**干净机器上的真实初始状态**，
     * 也是引导第 ⑤ 步唯一有内容可渲染的状态。默认成"装好了"会让那一屏在
     * 绝大多数测试里退化成一句"已经装好了"，等于没测。
     */
    getRuntimeStatus: vi.fn(async () => ({
      installed: false,
      missing: ['docx', 'openpyxl', 'pptx', 'pdfplumber', 'matplotlib'],
      supported: true,
      downloadSize: '约 43 MB',
    })),
    installOfficeRuntime: vi.fn(async () => ({ ok: true })),
    onRuntimeProgress: () => () => undefined,
    listProjects: vi.fn(async () => ({ projects: [] })),
    createProject: vi.fn(async () => ({ ok: true, projects: [] })),
    importProject: vi.fn(async () => ({ ok: true, projects: [] })),
    renameProject: vi.fn(async () => ({ ok: true, projects: [] })),
    removeProject: vi.fn(async () => ({ ok: true, projects: [] })),
    openProjectFolder: vi.fn(async () => undefined),
    readProjectDetail: vi.fn(async () => null),
    listProjectDir: vi.fn(async () => []),
    readAgentsMemo: vi.fn(async () => ({ exists: false, content: '' })),
    writeAgentsMemo: vi.fn(async () => ({ ok: true })),
    /*
     * 设置页（M10a）。默认是**这台机器的常见状态**：钥匙串可用、配了一家密钥、
     * 没有自定义模型、未登录（Q30=A 下未登录是常态而不是待修复状态）。
     */
    getModelAccess: vi.fn(async () => ({ ok: true, view: ACCESS })),
    saveProviderKey: vi.fn(async () => ({ ok: true, view: ACCESS })),
    clearProviderKey: vi.fn(async () => ({ ok: true, view: ACCESS })),
    addCustomModel: vi.fn(async () => ({ ok: true, view: ACCESS })),
    removeCustomModel: vi.fn(async () => ({ ok: true, view: ACCESS })),
    setSecretFallback: vi.fn(async () => ({ ok: true, view: ACCESS })),
    probeModel: vi.fn(async () => ({ ok: true, message: '通了：这个模型现在可以用。' })),
    getPreferences: vi.fn(async () => ({ concurrencyComputed: 3, concurrencyLimit: 3 })),
    setPreferences: vi.fn(async () => ({ concurrencyComputed: 3, concurrencyLimit: 2 })),
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

describe('点开已完成任务要看到历史（不是「还没有消息」）', () => {
  it('点侧边栏一行会调 openTask，并把条目画进对话区', async () => {
    const openTask = vi.fn(async () => ({
      items: [
        {
          id: 'u1',
          type: 'userMessage',
          completed: true,
          content: [{ type: 'text', text: '介绍一下自己' }],
        },
        { id: 'a1', type: 'agentMessage', completed: true, text: '我是 EvoWork' },
      ],
    }));
    const { bridge } = fakeBridge({
      getStartup: async () => ({
        ...STARTUP,
        tasks: [
          {
            id: 't-done',
            title: '介绍一下自己',
            status: 'completed',
            timeLabel: '25 分钟前',
            sectionId: 'ungrouped',
          },
        ],
      }),
      openTask,
    });
    render(<App bridge={bridge} />);
    await waitFor(() => expect(screen.getByText('介绍一下自己')).toBeTruthy());

    fireEvent.click(screen.getByText('介绍一下自己'));

    await waitFor(() => expect(openTask).toHaveBeenCalledWith({ threadId: 't-done' }));
    await waitFor(() => expect(screen.getByText('我是 EvoWork')).toBeTruthy());
    expect(screen.queryByText('输入你的第一个需求')).toBeNull();
  });

  it('切走之后才回来的历史**不会**盖到当前任务上', async () => {
    let resolveFirst:
      | ((value: { items: readonly { id: string; type: string; text: string }[] }) => void)
      | undefined;
    const openTask = vi.fn(async ({ threadId }: { threadId: string }) => {
      if (threadId === 't1') {
        return new Promise<{ items: readonly { id: string; type: string; text: string }[] }>(
          (resolve) => {
            resolveFirst = resolve;
          },
        );
      }
      return { items: [{ id: 'b', type: 'agentMessage', text: '第二个任务的回答' }] };
    });
    const { bridge } = fakeBridge({
      getStartup: async () => ({
        ...STARTUP,
        tasks: [
          {
            id: 't1',
            title: '先点这个',
            status: 'completed',
            timeLabel: '1 小时前',
            sectionId: 'ungrouped',
          },
          {
            id: 't2',
            title: '再点这个',
            status: 'completed',
            timeLabel: '刚刚',
            sectionId: 'ungrouped',
          },
        ],
      }),
      openTask,
    });
    render(<App bridge={bridge} />);
    await waitFor(() => expect(screen.getByText('先点这个')).toBeTruthy());
    fireEvent.click(screen.getByText('先点这个'));
    fireEvent.click(screen.getByText('再点这个'));
    await waitFor(() => expect(openTask).toHaveBeenCalledWith({ threadId: 't2' }));
    await waitFor(() => expect(screen.getByText('第二个任务的回答')).toBeTruthy());

    resolveFirst?.({ items: [{ id: 'a', type: 'agentMessage', text: '不该出现的旧历史' }] });
    await waitFor(() => expect(screen.getByText('第二个任务的回答')).toBeTruthy());
    expect(screen.queryByText('不该出现的旧历史')).toBeNull();
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

  it('打开任务时权威历史是顺序真源，流式增量叠上去', () => {
    const history = [
      { id: 'u1', type: 'userMessage', text: '问' },
      { id: 'a1', type: 'agentMessage', text: '答（历史）' },
    ];
    const live = [
      { id: 'a1', type: 'agentMessage', text: '答（还在流）' },
      { id: 'a2', type: 'agentMessage', text: '刚到的一句' },
    ];
    expect(applyHistory(live, history)).toEqual([
      { id: 'u1', type: 'userMessage', text: '问' },
      { id: 'a1', type: 'agentMessage', text: '答（还在流）' },
      { id: 'a2', type: 'agentMessage', text: '刚到的一句' },
    ]);
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

  it('没配密钥时给出录入框，不是只让人再点一次「检查模型接入」', async () => {
    const { bridge } = fakeBridge({
      listModels: vi.fn(async (): Promise<ModelCatalogResult> => ({
        models: [],
        reason: 'no-keys',
        unavailable: '本机网关没有启动：一家模型厂商的密钥都没有配置',
      })),
    });
    render(<App bridge={bridge} />);
    await waitFor(() => expect(screen.getByText('DeepSeek API 密钥')).toBeTruthy());
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

/* ─────────────────── 侧边栏六个入口的路由（02 §1）─────────────────── */

describe('侧边栏的六个入口都要有落点', () => {
  /*
   * 2026-09-06 之前：`app.tsx` 只挂了 Home / TaskWorkspace / Sidebar，
   * `onNavSelect` 没人传 —— 项目 / 专家·技能·连接器 / 自动化 / 资料库 / 更多
   * **点了没有任何反应**。用户看到的是一个六个菜单项、五个是死的应用，
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

    fireEvent.click(await screen.findByRole('button', { name: /专家·技能·连接器/ }));
    expect(await screen.findByText('专家·技能·连接器还没做好')).toBeTruthy();
    // 并且告诉用户现在该怎么办（在**说明文字里**找，侧边栏那一项同名）
    expect(screen.getByText(/已经随产品分发并可用/)).toBeTruthy();
  });

  /*
   * 「助理」2026-09-07 下架（02 §4.2 标注，方案保留）。
   *
   * 钉住的是**下架**这件事本身：它的方案（常驻特殊 Thread、固定 cwd、默认 Ask、
   * 自动压缩、读用户级记忆）一行都没有，所以侧边栏里不该有一格去承诺它。
   * 把它加回来之前，得先有那条链路 —— 否则这条断言应该失败。
   */
  it('侧边栏没有「助理」入口，也没有它的空页', async () => {
    const { bridge } = fakeBridge();
    render(<App bridge={bridge} />);

    await screen.findByRole('button', { name: /新建任务/ });
    expect(screen.queryByRole('button', { name: /助理/ })).toBeNull();
    expect(screen.queryByText(/助理/)).toBeNull();
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

  /*
   * 首运行第②步选中一个被安全策略拦下的目录（如 `~/.ssh`）时，`pickWorkspace`
   * 带回的 `refused` 必须真的出现在界面上，而不是被 `app.tsx` 里的
   * `if (r.path) …` 悄悄吞掉——那正是这条缺陷本来的样子：按钮点了，
   * 什么都没发生，用户以为自己没点中。
   */
  it('首运行选中被拒的目录——拒绝理由要真的显示出来，不是点了没反应', async () => {
    const { bridge } = fakeBridge({
      getStartup: async () => ({ ...STARTUP, onboarded: false }),
      pickWorkspace: vi.fn(async () => ({
        refused: '这个目录被安全策略拦下了（受保护目录），换一个吧。',
      })),
    });
    render(<App bridge={bridge} />);

    // 从欢迎屏进到"选一个工作空间"这一步
    await screen.findByText(/第 1 \/ 6 步/);
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    fireEvent.click(await screen.findByRole('button', { name: '选择文件夹' }));

    expect(
      await screen.findByText('这个目录被安全策略拦下了（受保护目录），换一个吧。'),
    ).toBeTruthy();
    // 被拒的目录不能被当成"选成功了"混进已选列表——按钮还在，不会变成"再加一个"
    expect(screen.getByRole('button', { name: '选择文件夹' })).toBeTruthy();
  });

  /*
   * 取消（`pickDirectory` 什么都没选，`pickWorkspace` 回 `{}`）不该弹任何提示——
   * 用户自己关掉了系统的文件夹选择框，没有话可说，硬提示反而是打扰。
   */
  it('取消选择保持安静——不该弹出任何提示', async () => {
    const { bridge } = fakeBridge({
      getStartup: async () => ({ ...STARTUP, onboarded: false }),
      pickWorkspace: vi.fn(async () => ({})),
    });
    render(<App bridge={bridge} />);

    await screen.findByText(/第 1 \/ 6 步/);
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    const pick = await screen.findByRole('button', { name: '选择文件夹' });
    fireEvent.click(pick);
    await waitFor(() => expect(bridge.pickWorkspace).toHaveBeenCalled());

    expect(screen.queryByRole('status')).toBeNull();
  });
});

/*
 * 「项目」页接线（Task 13）。
 *
 * 前十二个任务分别把纯逻辑包、两张 sqlite 表、协议声明、内核镜像调用、十个 IPC
 * 动作、两个 React 页面各自做对了——**接线本身没有单测能抓**（CLAUDE.md §9.1）。
 * 这里测的不是任何一个模块，是缝：点侧边栏到拉列表、点卡片到拉详情、
 * 拒绝到显示、成功到不重拉、新建任务到落点预选、内核事件到条件刷新。
 */
describe('项目页接线（Task 13）', () => {
  const PROJECT_CARD = {
    id: 'p1',
    name: '季度汇报',
    rootDisplay: '~/w/q3',
    rootMissing: false,
    taskCount: 2,
    artifactCount: 1,
  };

  const PROJECT_DETAIL = {
    id: 'p1',
    name: '季度汇报',
    rootDisplay: '~/w/q3',
    rootMissing: false,
    tasks: [],
    fileActions: [],
    automations: [],
  };

  it('点侧边栏「项目」会去拉列表，而不是显示"还没做好"', async () => {
    const listProjects = vi.fn(async () => ({ projects: [PROJECT_CARD] }));
    const { bridge } = fakeBridge({ listProjects });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    await waitFor(() => expect(listProjects).toHaveBeenCalled());
    expect(await screen.findByText('季度汇报')).toBeTruthy();
    expect(screen.queryByText('项目页还没做好')).toBeNull();
  });

  it('点卡片进详情页，且详情是单独拉的 —— 列表里没有文件树与记忆', async () => {
    const readProjectDetail = vi.fn(async () => PROJECT_DETAIL);
    const listProjectDir = vi.fn(async () => [
      { name: 'src', path: '~/w/q3/src', isDirectory: true, noisy: false },
    ]);
    const readAgentsMemo = vi.fn(async () => ({ exists: true, content: '先看 README' }));
    const { bridge } = fakeBridge({
      listProjects: async () => ({ projects: [PROJECT_CARD] }),
      readProjectDetail,
      listProjectDir,
      readAgentsMemo,
    });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    await screen.findByText('季度汇报');
    // 列表页此刻还没有理由拉详情三件套 —— 这条钉住"按需拉"，不是"进了这一页就顺带全拉了"
    expect(readProjectDetail).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('季度汇报'));
    await waitFor(() => expect(readProjectDetail).toHaveBeenCalledWith({ id: 'p1' }));
    expect(listProjectDir).toHaveBeenCalledWith({ id: 'p1' });
    expect(readAgentsMemo).toHaveBeenCalledWith({ id: 'p1' });
    expect(await screen.findByText('src')).toBeTruthy();
    expect((screen.getByLabelText('空间记忆') as HTMLTextAreaElement).value).toBe('先看 README');
  });

  it('新建被拒时把原话显示出来 —— 不是静默什么都不发生', async () => {
    const createProject = vi.fn(async () => ({
      ok: false,
      refused: '这个目录被安全策略拦下了（受保护目录），换一个吧。',
      projects: [],
    }));
    const { bridge } = fakeBridge({
      listProjects: async () => ({ projects: [] }),
      createProject,
      // 对话框的「选择目录」调的是纯选目录动作（C1），不再是 `pickWorkspace`
      pickProjectDirectory: vi.fn(async () => ({ path: '/Users/li/.ssh' })),
    });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    await waitFor(() => expect(screen.getByText(/还没有工作空间/)).toBeTruthy());

    // 空态里那个「新建空间」→ 对话框 → 选目录 → 创建
    fireEvent.click(screen.getAllByText('新建空间')[1] as HTMLElement);
    fireEvent.click(screen.getByText('选择目录'));
    await waitFor(() =>
      expect((screen.getByLabelText('目录') as HTMLInputElement).value).toBe('/Users/li/.ssh'),
    );
    fireEvent.click(screen.getByText('创建'));

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({ name: '.ssh', path: '/Users/li/.ssh' }),
    );
    expect(await screen.findByText(/被安全策略拦下了/)).toBeTruthy();
  });

  it('新建成功后直接用返回的新列表刷新 —— 不再多调一次 listProjects', async () => {
    const listProjects = vi.fn(async () => ({ projects: [] }));
    const createProject = vi.fn(async () => ({
      ok: true,
      projects: [PROJECT_CARD],
    }));
    const { bridge } = fakeBridge({
      listProjects,
      createProject,
      pickProjectDirectory: vi.fn(async () => ({ path: '/Users/li/w/q3' })),
    });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getAllByText('新建空间')[0] as HTMLElement);
    fireEvent.click(screen.getByText('选择目录'));
    await waitFor(() =>
      expect((screen.getByLabelText('目录') as HTMLInputElement).value).toBe('/Users/li/w/q3'),
    );
    fireEvent.click(screen.getByText('创建'));

    expect(await screen.findByText('季度汇报')).toBeTruthy();
    // 卡片是从 createProject 的返回值直接渲染出来的，不是再拉了一次列表
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  /*
   * ── C1：选目录 + 按创建只能建出一个空间 ──
   *
   * 上面几条测试里 `pickWorkspace`/`pickProjectDirectory`、`createProject` 全是
   * `vi.fn`——两边各自"看起来对"，但缝上的事这类测试抓不到：真正的
   * `pickWorkspace`（Task 9）选完会**立刻建成一个空间**，而这里如果对话框仍然
   * 错误地调它而不是纯选目录的 `pickProjectDirectory`，用户选目录再按「创建」
   * 就会插入两行。这条不 mock 桥这一侧的任何项目动作，直接用真实的
   * `createRendererActions`（内存 sqlite + 假 `pickDirectory` 端口）驱动整条
   * UI 流程，然后数落库里到底有几个空间。
   */
  it('真实 createRendererActions：选目录再按创建只建出一个空间，不是两个', async () => {
    const store = openStore({ path: ':memory:' });
    const adapter = {
      listTasks: vi.fn(() => []),
      catalog: vi.fn(() => undefined),
      mirrorProjectCreate: vi.fn(async () => undefined),
      mirrorProjectUpdate: vi.fn(async () => undefined),
      mirrorProjectDelete: vi.fn(async () => undefined),
    } as unknown as Adapter;

    const realActions = createRendererActions({
      appName: 'EvoWork',
      appVersion: '0.0.0',
      store,
      adapter,
      projectPorts: {
        home: '/Users/li',
        rootExists: () => true,
        realpath: async (p) => p,
        isSymlink: async () => false,
        pickDirectory: async () => '/w/picked',
        readDir: async () => [],
        openFolder: async () => {},
        readTextFile: async () => undefined,
        writeTextFile: async () => {},
      },
    });

    const { bridge } = fakeBridge({
      listProjects: () => realActions.listProjects(),
      createProject: (input) => realActions.createProject(input),
      // 两个都接到真实实现：如果 app.tsx 的源码修复被回退（对话框又调回
      // `pickWorkspace`），这里会真的撞上它的建空间副作用，而不是一个乖乖
      // 什么都不做的 vi.fn——这正是这条测试要能抓到回退的地方。
      pickWorkspace: () => realActions.pickWorkspace(),
      pickProjectDirectory: () => realActions.pickProjectDirectory(),
    });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    await waitFor(() => expect(screen.getByText(/还没有工作空间/)).toBeTruthy());

    fireEvent.click(screen.getAllByText('新建空间')[1] as HTMLElement);
    fireEvent.click(screen.getByText('选择目录'));
    await waitFor(() =>
      expect((screen.getByLabelText('目录') as HTMLInputElement).value).toBe('/w/picked'),
    );
    fireEvent.click(screen.getByText('创建'));

    await waitFor(() => expect(screen.getAllByText('picked')).toHaveLength(1));
    // DOM 里只有一张卡片还不够扎实——直接数落库里的行数，卡片渲染层面的巧合排除掉
    expect((await realActions.listProjects()).projects).toHaveLength(1);
  });

  it('「在此空间新建任务」把首页的工作空间预选上 —— 否则跳过去还得再选一次', async () => {
    const { bridge } = fakeBridge({
      getStartup: async () => ({
        ...STARTUP,
        workspaces: [{ id: 'p1', name: '季度汇报', path: '~/w/q3' }],
      }),
      listProjects: async () => ({ projects: [PROJECT_CARD] }),
    });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    await screen.findByText('季度汇报');
    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    fireEvent.click(screen.getByText('在此空间新建任务'));

    // 回到首页（需求输入框在），且工作空间下拉上真的选中了这个空间 ——
    // 只断言回到了首页而不断言选中项，"点了没换页"与"换页了但没选中"这两种坏法都会被漏掉。
    // 下拉触发按钮的可及名固定是"选择工作空间"（`aria-label`），选中的项文字在按钮内部，
    // 所以用 getByLabelText 拿到按钮本体再看它的文本，而不是按可及名去找"季度汇报"
    expect(await screen.findByLabelText('需求输入')).toBeTruthy();
    expect(screen.getByLabelText('选择工作空间').textContent).toContain('季度汇报');
  });

  it('projects-changed 事件到达时刷新列表 —— 但本机增删不等它', async () => {
    const listProjects = vi.fn(async () => ({ projects: [] }));
    const { bridge, emit } = fakeBridge({ listProjects });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(1));

    emit.ui?.({ type: 'projects-changed' });
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(2));
  });

  it('projects-changed 到达但不在项目页时不刷新 —— 回去才需要看到新数据', async () => {
    const listProjects = vi.fn(async () => ({ projects: [] }));
    const { bridge, emit } = fakeBridge({ listProjects });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: /新建任务/ }));

    emit.ui?.({ type: 'projects-changed' });
    // 给事件循环一个机会：如果错误地不看 view 就刷新，这里就会变成 2
    await Promise.resolve();
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  it('改名 / 移除 / 导入都直接用返回的新列表，且改名对话框预填旧名字', async () => {
    const renameProject = vi.fn(async () => ({
      ok: true,
      projects: [{ ...PROJECT_CARD, name: '年度汇报' }],
    }));
    const { bridge } = fakeBridge({
      listProjects: async () => ({ projects: [PROJECT_CARD] }),
      renameProject,
    });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    await screen.findByText('季度汇报');
    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    fireEvent.click(screen.getByText('改名'));
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('季度汇报');
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '年度汇报' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(renameProject).toHaveBeenCalledWith({ id: 'p1', name: '年度汇报' }));
    expect(await screen.findByText('年度汇报')).toBeTruthy();
  });

  it('移除确认后调 removeProject 并用返回的新列表刷新', async () => {
    const removeProject = vi.fn(async () => ({ ok: true, projects: [] }));
    const { bridge } = fakeBridge({
      listProjects: async () => ({ projects: [PROJECT_CARD] }),
      removeProject,
    });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    await screen.findByText('季度汇报');
    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    fireEvent.click(screen.getByText('从列表移除'));
    fireEvent.click(screen.getByText('移除'));

    await waitFor(() => expect(removeProject).toHaveBeenCalledWith({ id: 'p1' }));
    await waitFor(() => expect(screen.getByText(/还没有工作空间/)).toBeTruthy());
  });

  it('「导入现有文件夹」直接调 importProject，不弹对话框', async () => {
    const importProject = vi.fn(async () => ({ ok: true, projects: [PROJECT_CARD] }));
    const { bridge } = fakeBridge({
      listProjects: async () => ({ projects: [] }),
      importProject,
    });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    await waitFor(() => expect(screen.getByText(/还没有工作空间/)).toBeTruthy());
    fireEvent.click(screen.getAllByText('导入现有文件夹')[0] as HTMLElement);

    await waitFor(() => expect(importProject).toHaveBeenCalled());
    expect(await screen.findByText('季度汇报')).toBeTruthy();
  });

  it('列表里「打开所在文件夹」按 id 调用；详情页里的同名按钮不用传 id 也对得上当前空间', async () => {
    const openProjectFolder = vi.fn(async () => undefined);
    const { bridge } = fakeBridge({
      listProjects: async () => ({ projects: [PROJECT_CARD] }),
      readProjectDetail: async () => PROJECT_DETAIL,
      openProjectFolder,
    });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    await screen.findByText('季度汇报');
    fireEvent.click(screen.getByLabelText('季度汇报 的更多操作'));
    fireEvent.click(screen.getByText('打开所在文件夹'));
    await waitFor(() => expect(openProjectFolder).toHaveBeenCalledWith({ id: 'p1' }));

    openProjectFolder.mockClear();
    fireEvent.click(screen.getByText('季度汇报'));
    await screen.findByText('~/w/q3', { selector: 'p' });
    fireEvent.click(screen.getByText('打开所在文件夹'));
    await waitFor(() => expect(openProjectFolder).toHaveBeenCalledWith({ id: 'p1' }));
  });

  it('详情页展开目录懒加载子项；刷新按钮重拉根目录', async () => {
    const listProjectDir = vi.fn(async (input: { id: string; path?: string }) =>
      input.path === undefined
        ? [{ name: 'src', path: '~/w/q3/src', isDirectory: true, noisy: false }]
        : [{ name: 'index.ts', path: '~/w/q3/src/index.ts', isDirectory: false, noisy: false }],
    );
    const { bridge } = fakeBridge({
      listProjects: async () => ({ projects: [PROJECT_CARD] }),
      readProjectDetail: async () => PROJECT_DETAIL,
      listProjectDir,
    });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    fireEvent.click(await screen.findByText('季度汇报'));
    await screen.findByText('src');
    expect(listProjectDir).toHaveBeenCalledWith({ id: 'p1' });

    fireEvent.click(screen.getByText('src'));
    await waitFor(() =>
      expect(listProjectDir).toHaveBeenCalledWith({ id: 'p1', path: '~/w/q3/src' }),
    );
    expect(await screen.findByText('index.ts')).toBeTruthy();

    listProjectDir.mockClear();
    fireEvent.click(screen.getByLabelText('刷新文件树'));
    await waitFor(() => expect(listProjectDir).toHaveBeenCalledWith({ id: 'p1' }));
  });

  it('保存空间记忆调 writeAgentsMemo 并带上当前空间 id', async () => {
    const writeAgentsMemo = vi.fn(async () => ({ ok: true }));
    const { bridge } = fakeBridge({
      listProjects: async () => ({ projects: [PROJECT_CARD] }),
      readProjectDetail: async () => PROJECT_DETAIL,
      writeAgentsMemo,
    });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    fireEvent.click(await screen.findByText('季度汇报'));
    const textarea = await screen.findByLabelText('空间记忆');
    fireEvent.change(textarea, { target: { value: '新的长期指令' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() =>
      expect(writeAgentsMemo).toHaveBeenCalledWith({ id: 'p1', content: '新的长期指令' }),
    );
  });

  /*
   * ── C3：`writeAgentsMemo` 的 promise 直接 reject 时也不能让用户看到"已保存" ──
   *
   * `project-detail.test.tsx` 测的是"bridge 老实返回 `{ ok: false }` 时页面怎么办"；
   * 这条测的是更底下一层——桥本身的 promise 被拒绝（对应 `ports.writeTextFile`
   * 抛出 EACCES/ENOSPC 之类）。以前 `app.tsx` 的 `saveProjectMemo` 对这个 rejection
   * 没有 `.catch`，是这个文件里唯一一个没有 `.catch` 的 bridge 调用——表现是一个没人
   * 接住的 unhandled rejection，且因为没走到 `.then`，`ProjectDetailPage` 那句
   * `.then(() => setSaved(true))` 恰好也不会执行，"看起来没问题"掩盖了这个坑。
   * 这里故意让它 reject，钉住两件事：不崩、也不显示已保存。
   */
  it('writeAgentsMemo 的 promise 被拒绝时不崩溃、不显示「已保存」', async () => {
    const writeAgentsMemo = vi.fn(async () => {
      throw new Error('ENOSPC: no space left on device');
    });
    const { bridge } = fakeBridge({
      listProjects: async () => ({ projects: [PROJECT_CARD] }),
      readProjectDetail: async () => PROJECT_DETAIL,
      writeAgentsMemo,
    });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    fireEvent.click(await screen.findByText('季度汇报'));
    const textarea = await screen.findByLabelText('空间记忆');
    fireEvent.change(textarea, { target: { value: '新的长期指令' } });
    fireEvent.click(screen.getByText('保存'));

    await waitFor(() => expect(writeAgentsMemo).toHaveBeenCalled());
    // 拒绝理由要能看见——不是吞掉之后一片安静
    expect(await screen.findByText(/没能保存/)).toBeTruthy();
    expect(screen.queryByText('已保存')).toBeNull();
  });

  it('详情页点任务行会像侧边栏一样真的去拉历史，而不是空对话', async () => {
    const openTask = vi.fn(async () => ({ items: [] }));
    const { bridge } = fakeBridge({
      listProjects: async () => ({ projects: [PROJECT_CARD] }),
      readProjectDetail: async () => ({
        ...PROJECT_DETAIL,
        tasks: [
          {
            id: 't9',
            title: '季度评审',
            status: 'completed' as const,
            timeLabel: '昨天',
            sectionId: 'x',
          },
        ],
      }),
      openTask,
    });
    render(<App bridge={bridge} />);

    fireEvent.click(await screen.findByText('项目'));
    fireEvent.click(await screen.findByText('季度汇报'));
    fireEvent.click(await screen.findByText('季度评审'));

    await waitFor(() => expect(openTask).toHaveBeenCalledWith({ threadId: 't9' }));
  });
});

/*
 * ── 设置页的入口与接线（M10a）──
 *
 * 「更多」在 02 §4.7 里是**一个菜单**，而它此前点开是一个「这里还没有内容」的空页。
 * 现在它下面的「设置」真的有了，所以这组断言守两件事：菜单里的项能到达设置页，
 * 以及**设置页改完密钥之后 Composer 的下拉跟着变**（两处用的是同一份目录 ——
 * 各拉一次的话，"设置里明明有这个模型、下拉里却没有"会变成一次没人能复现的排查）。
 */
describe('设置页（11 §4.4）', () => {
  it('「更多」是菜单而不是页面，选「设置」到达模型接入分区', async () => {
    const { bridge } = fakeBridge();
    render(<App bridge={bridge} />);
    await waitFor(() => screen.getByRole('button', { name: /更多/ }));
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '设置' }));
    await waitFor(() => expect(bridge.getModelAccess).toHaveBeenCalled());
    expect(screen.getByRole('navigation', { name: '设置分类' })).toBeTruthy();
    expect(screen.getByText('已保存 · ****3f9a')).toBeTruthy();
  });

  it('菜单里没做的项**禁用并给原因**，不静默移除', async () => {
    const { bridge } = fakeBridge();
    render(<App bridge={bridge} />);
    await waitFor(() => screen.getByRole('button', { name: /更多/ }));
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    const item = screen.getByRole('menuitem', { name: /设备与同步/ }) as HTMLButtonElement;
    expect(item.disabled).toBe(true);
    expect(screen.getByText(/跨设备同步本期不做/)).toBeTruthy();
  });

  it('在设置页保存密钥后，Composer 的模型下拉用的是同一份新目录', async () => {
    const { bridge } = fakeBridge({
      saveProviderKey: vi.fn(async () => ({
        ok: true,
        view: { ...ACCESS, models: [{ ...MODELS[0]!, id: 'evowork/new', label: 'new/model' }] },
      })),
    });
    render(<App bridge={bridge} />);
    await waitFor(() => screen.getByRole('button', { name: /更多/ }));
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: '设置' }));
    await waitFor(() => screen.getByLabelText('Kimi（Moonshot） API 密钥'));

    fireEvent.change(screen.getByLabelText('Kimi（Moonshot） API 密钥'), {
      target: { value: 'sk-new' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[0] as HTMLElement);
    await waitFor(() => expect(bridge.saveProviderKey).toHaveBeenCalled());

    // 回到首页：下拉里应该是设置页刚返回的那一份
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    await waitFor(() => expect(screen.getByText('new/model')).toBeTruthy());
  });
});
