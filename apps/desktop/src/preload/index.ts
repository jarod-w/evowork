/**
 * preload：渲染进程与主进程之间**唯一**的通道。
 *
 * 它暴露的接口是窄的，而且是语义化的 —— 没有一个方法名长得像协议方法（K2）。
 * `ipcRenderer` 本身绝不暴露：暴露它等于把整个 IPC 面交给渲染进程，
 * 之后任何一次"临时加个频道"都会绕过这里。
 *
 * 同样是注入式的（见 bootstrap.ts 的头注释）：`contextBridge` 与 `ipcRenderer` 由
 * M9 的入口传进来，这样"到底暴露了哪些方法"是一条可断言的事实而不是一段没人读的代码。
 */
export interface IpcRendererLike {
  on(channel: string, handler: (event: unknown, payload: unknown) => void): void;
  removeListener(channel: string, handler: (event: unknown, payload: unknown) => void): void;
  invoke(channel: string, payload?: unknown): Promise<unknown>;
}

export interface ContextBridgeLike {
  exposeInMainWorld(key: string, api: Record<string, unknown>): void;
}

/** 渲染进程能订阅的频道。与 `service-host.ts` 的 `IPC` 一一对应。 */
export const RENDERER_CHANNELS = Object.freeze({
  uiEvent: 'evowork:ui-event',
  notice: 'evowork:notice',
  degrade: 'evowork:degrade',
  pendingApprovals: 'evowork:pending-approvals',
  askApproval: 'evowork:ask-approval',
  /**
   * 办公扩展的安装进度（08 §4）。
   *
   * 是**推送**而不是让渲染层轮询：安装要几分钟，轮询要么太密（白耗）要么太疏
   * （进度条一跳一大截）。而"现在在下什么"恰恰是这几分钟里用户唯一关心的事。
   */
  runtimeProgress: 'evowork:runtime-progress',
});

/**
 * 渲染进程能调用的动作。**这就是它能做的全部事情**。
 *
 * 主进程遍历这个数组注册 handler（见 `bootstrap.ts`），所以往这里加一项
 * 就必须在 `ServiceHost['actions']` 里有同名实现，否则编译期就红 ——
 * 这条约束是被一次真实故障换来的：以前主进程只注册了审批一个 handler，
 * 而这里声明着六个，界面上的表现是"回车没反应"，一行报错都看不到。
 *
 * 每个动作**只收一个载荷参数**（形状见 `shared/ipc.ts`）。多参数会被这层悄悄丢掉，
 * 所以契约里没有多参数的动作。
 */
export const RENDERER_ACTIONS = Object.freeze([
  'send',
  'interrupt',
  'decideApproval',
  'rowAction',
  'refreshVisible',
  /**
   * 打开任务并拉历史（04 §9）。点侧边栏一行就必须调 —— 对话条目只活在当场
   * 的事件流里，重启后再点已完成任务，不调这一步就是空对话。
   */
  'openTask',
  'getStartup',
  // 模型下拉（03 §4.5「启动时 + 手动刷新」）。与 getStartup 分开是因为它是一次网络调用，
  // 失败方式与"本机服务起不来"完全不同（见 main/model-catalog.ts 的头注释）
  'listModels',
  /**
   * 把用户填的厂商密钥写入本机并拉起网关。
   * 引导第④步和首页「检查模型接入」共用 —— 装好的 App 从访达启动读不到 shell 环境。
   */
  'applyModelAccess',
  /*
   * 三个目录式页面各自一个动作，**不并进 `getStartup`**。
   *
   * `getStartup` 那条"一次给全"的理由是**数据同源**（都来自同一次内核握手）。
   * 这三个不同源，也不同步：它们读的是本机 sqlite，且只在用户真的点进那一页时
   * 才需要。并进去等于每次启动都查三张表、扫一遍磁盘占用 ——
   * 而绝大多数会话里用户根本不会打开资料库。
   */
  'getLibrary',
  'getAutomations',
  'getAudit',
  /** 选一个工作空间目录。**必须有**：首运行要求至少一个，而干净机器上一个都没有 */
  'pickWorkspace',
  /**
   * 纯选目录（C1）：「项目」页「新建空间」对话框专用，**没有副作用**——
   * 不能让这个对话框继续复用 `pickWorkspace`，那个动作选完会立刻建一个空间，
   * 对话框还要再按一次「创建」，两次相加就是两个一模一样的空间。
   */
  'pickProjectDirectory',
  /** 首次引导走完（02 §9）。落 `meta` 表，换窗口/清缓存都不该让人重走一遍 */
  'completeOnboarding',
  /**
   * 办公扩展装了没有（08 §4）。**每次问都真的去探一遍**，不缓存在渲染层：
   * 用户可能刚在别处装完，也可能刚把目录删了。
   */
  'getRuntimeStatus',
  /** 装办公扩展。进度走 `runtimeProgress` 频道，这里只返回最终结果 */
  'installOfficeRuntime',
  /*
   * 「项目」页（02 §4.3）。与 `getLibrary` 同一条理由：读的是本机 sqlite 与磁盘，
   * 只在用户真的点进那一页时才需要，**不并进 `getStartup`**。
   */
  'listProjects',
  'createProject',
  'importProject',
  'renameProject',
  'removeProject',
  /** 在访达/资源管理器里打开根目录（清单 §4.5 的四个操作之一） */
  'openProjectFolder',
  'readProjectDetail',
  /** 文件树懒加载：展开哪层读哪层（D-P5） */
  'listProjectDir',
  'readAgentsMemo',
  'writeAgentsMemo',
  /*
   * 设置页（11 §4.4，M10a）。
   *
   * **密钥只朝一个方向走**：`saveProviderKey` / `addCustomModel` 把它送进主进程，
   * 而没有任何一个动作会把密钥送回来（返回的视图里只有后四位）——
   * 渲染进程拿到密钥等于密钥进了任何一个 XSS 面（11 §12 第 2 条）。
   */
  'getModelAccess',
  'saveProviderKey',
  'clearProviderKey',
  'addCustomModel',
  'removeCustomModel',
  /** 钥匙串不可用时用户的选择（明文保存 / 不保存）。**不替他选**（11 §4.3） */
  'setSecretFallback',
  /** 连通性检查：真的发一次最小请求 —— 只看目录里有没有这个 id 证明不了密钥是对的 */
  'probeModel',
  /**
   * 账号（M10b）。**没有 password 参数**（Q33=A）：登录走系统浏览器。
   * 注销账号要再输密码，只走 WEB（Q39）。
   */
  'startLogin',
  'logout',
  'listDevices',
  'revokeDevice',
  'openAccountWeb',
  /** 单任务预算与并发上限（Q11 的阶段 1；托管额度随账号叠在视图上） */
  'getPreferences',
  'setPreferences',
] as const);

export function installBridge(bridge: ContextBridgeLike, ipc: IpcRendererLike): void {
  const subscribe =
    (channel: string) =>
    (handler: (payload: unknown) => void): (() => void) => {
      const wrapped = (_event: unknown, payload: unknown): void => handler(payload);
      ipc.on(channel, wrapped);
      return () => ipc.removeListener(channel, wrapped);
    };

  const api: Record<string, unknown> = {
    onUiEvent: subscribe(RENDERER_CHANNELS.uiEvent),
    onNotice: subscribe(RENDERER_CHANNELS.notice),
    onDegrade: subscribe(RENDERER_CHANNELS.degrade),
    onPendingApprovals: subscribe(RENDERER_CHANNELS.pendingApprovals),
    onRuntimeProgress: subscribe(RENDERER_CHANNELS.runtimeProgress),
  };
  for (const action of RENDERER_ACTIONS) {
    api[action] = (payload?: unknown) => ipc.invoke(`evowork:${action}`, payload);
  }

  bridge.exposeInMainWorld('evowork', api);
}
