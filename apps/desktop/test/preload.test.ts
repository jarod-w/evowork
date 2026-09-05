/**
 * preload 暴露面（K2 在前端的落点）。
 *
 * 这条测试的价值不在于"方法能不能调"，而在于**暴露面是一条可断言的事实**：
 * 有人临时加个频道时，这里会红。
 */
import { describe, expect, it, vi } from 'vitest';

import { installBridge, RENDERER_ACTIONS, RENDERER_CHANNELS } from '../src/preload/index.js';

function install() {
  const exposed: Record<string, unknown>[] = [];
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
  const ipc = {
    on: vi.fn((channel: string, handler: (e: unknown, p: unknown) => void) =>
      listeners.set(channel, handler),
    ),
    removeListener: vi.fn((channel: string) => listeners.delete(channel)),
    invoke: vi.fn(async () => 'ok'),
  };
  installBridge({ exposeInMainWorld: (_key, api) => exposed.push(api) }, ipc);
  return { api: exposed[0] as Record<string, unknown>, ipc, listeners };
}

describe('暴露面', () => {
  it('只暴露订阅 + 六个动作，**不暴露 ipcRenderer 本身**', () => {
    const { api } = install();
    expect(Object.keys(api).sort()).toEqual(
      ['onUiEvent', 'onNotice', 'onDegrade', 'onPendingApprovals', ...RENDERER_ACTIONS].sort(),
    );
    // 暴露 ipcRenderer 等于把整个 IPC 面交出去，之后任何"临时加个频道"都会绕过 preload
    expect(JSON.stringify(Object.keys(api))).not.toContain('ipc');
  });

  it('方法名里**没有一个协议方法名**（K2）', () => {
    const { api } = install();
    const names = Object.keys(api).join(' ');
    for (const protocolish of ['thread/', 'turn/', 'item/', 'project/', 'jsonrpc']) {
      expect(names).not.toContain(protocolish);
    }
  });

  it('订阅返回退订函数（组件卸载时不会泄漏监听器）', () => {
    const { api, ipc, listeners } = install();
    const off = (api.onUiEvent as (h: (p: unknown) => void) => () => void)(() => {});
    expect(listeners.has(RENDERER_CHANNELS.uiEvent)).toBe(true);
    off();
    expect(ipc.removeListener).toHaveBeenCalled();
  });

  it('动作走 invoke，频道名带 evowork: 前缀', async () => {
    const { api, ipc } = install();
    await (api.send as (p: unknown) => Promise<unknown>)({ text: '你好' });
    expect(ipc.invoke).toHaveBeenCalledWith('evowork:send', { text: '你好' });
  });
});
