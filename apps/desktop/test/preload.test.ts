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
  // 标题不写数字：动作会随功能增加，写死"六个"只会让标题在某次提交后开始骗人
  it('只暴露订阅 + RENDERER_ACTIONS，**不暴露 ipcRenderer 本身**', () => {
    const { api } = install();
    expect(Object.keys(api).sort()).toEqual(
      [
        'onUiEvent',
        'onNotice',
        'onDegrade',
        'onPendingApprovals',
        // 办公扩展安装进度（08 §4）：装一次要几分钟，推送比轮询合适
        'onRuntimeProgress',
        ...RENDERER_ACTIONS,
      ].sort(),
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

  it('十个项目动作都暴露给渲染层 —— 少一个的表现是"点了没反应"，一行报错都看不到', () => {
    for (const action of [
      'listProjects',
      'createProject',
      'importProject',
      'renameProject',
      'removeProject',
      'openProjectFolder',
      'readProjectDetail',
      'listProjectDir',
      'readAgentsMemo',
      'writeAgentsMemo',
    ]) {
      expect(RENDERER_ACTIONS).toContain(action);
    }
  });

  it('八个目录动作都暴露给渲染层 —— 少一个的表现是「点了没反应」', () => {
    for (const action of [
      'getCatalog',
      'installSkill',
      'uninstallSkill',
      'addConnector',
      'trustConnector',
      'removeConnector',
      'createExpert',
      'removeExpert',
    ]) {
      expect(RENDERER_ACTIONS).toContain(action);
    }
  });
});
