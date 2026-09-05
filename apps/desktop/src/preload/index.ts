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

/** 渲染进程能调用的动作。**这就是它能做的全部事情**。 */
export const RENDERER_ACTIONS = Object.freeze([
  'send',
  'interrupt',
  'decideApproval',
  'rowAction',
  'refreshVisible',
  'listScenarios',
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
