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
  'getStartup',
  // 模型下拉（03 §4.5「启动时 + 手动刷新」）。与 getStartup 分开是因为它是一次网络调用，
  // 失败方式与"本机服务起不来"完全不同（见 main/model-catalog.ts 的头注释）
  'listModels',
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
  /** 首次引导走完（02 §9）。落 `meta` 表，换窗口/清缓存都不该让人重走一遍 */
  'completeOnboarding',
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
  };
  for (const action of RENDERER_ACTIONS) {
    api[action] = (payload?: unknown) => ipc.invoke(`evowork:${action}`, payload);
  }

  bridge.exposeInMainWorld('evowork', api);
}
