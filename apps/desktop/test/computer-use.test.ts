import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createComputerUseHost, type NativeHelper } from '../src/main/computer-use-host.js';
import { patchComputerUseConfig } from '../src/main/computer-use-config.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(verified = true) {
  const root = mkdtempSync(join(tmpdir(), 'ew-cu-test-'));
  roots.push(root);
  let context = {
    turnId: 'turn',
    model: 'model',
    credentialSource: 'local',
    interactive: true,
    root: true,
    imageSupported: false,
    enterpriseAllowed: true,
    persistentAllowed: true,
  };
  const window = {
    app: 'com.apple.TextEdit',
    processId: 10,
    windowId: 'w',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    scale: 1,
  };
  const helper: NativeHelper = {
    stop: vi.fn(),
    call: vi.fn(async (method: string) => {
      if (method === 'health') return { protocolVersion: 1, accessibility: true };
      if (method === 'list_apps')
        return [
          { app: window.app, name: 'TextEdit', identity: 'sig', kind: 'ordinary' },
          { app: 'com.apple.Terminal', name: 'Terminal', identity: 'sig2', kind: 'terminal' },
        ];
      if (method === 'get_app_state')
        return { window, elements: [1], text: 'PRIVATE_SCREEN', coordinateFallback: false };
      if (method === 'window_identity') return window;
      return { ok: true };
    }),
  };
  const ask = vi.fn(async (approval) => ({
    decision: 'accept' as const,
    optionId: approval.params.message.includes('凭据来源') ? 'enable' : 'always',
  }));
  const audit = vi.fn();
  const host = createComputerUseHost({
    root,
    platform: 'darwin',
    releaseVerified: verified,
    helper,
    context: () => context,
    ask,
    audit,
  });
  const call = (name: string, args: Record<string, unknown> = {}) =>
    host.call({ name, arguments: args, threadId: 'thread', sessionId: 'session' });
  return {
    host,
    call,
    helper,
    ask,
    audit,
    root,
    change: (patch: Partial<typeof context>) => {
      context = { ...context, ...patch };
    },
  };
}
describe('电脑操控宿主边界', () => {
  it('默认关闭；未验证构建不能启用且不启动 Helper', async () => {
    const s = setup(false);
    expect((await s.host.setEnabled(true)).state).toBe('unverified');
    await expect(s.call('list_apps')).rejects.toThrow('POLICY_DENIED');
    expect(s.helper.call).not.toHaveBeenCalled();
    await s.host.close();
  });
  it('授权前不能读取，持久准入只存身份；正文不写审计', async () => {
    const s = setup();
    try {
      await s.host.setEnabled(true);
      const read = await s.call('get_app_state', { app: 'com.apple.TextEdit' });
      expect(s.ask).toHaveBeenCalledTimes(2);
      const state = JSON.parse(read.content[0]!.text!);
      expect(state.text).toBe('PRIVATE_SCREEN');
      expect(readFileSync(join(s.root, 'computer-use-grants.json'), 'utf8')).not.toContain(
        'PRIVATE_SCREEN',
      );
      expect(JSON.stringify(s.audit.mock.calls)).not.toContain('PRIVATE_SCREEN');
      await s.call('click', {
        app: 'com.apple.TextEdit',
        state_id: state.state_id,
        element_index: 1,
      });
      await expect(
        s.call('click', { app: 'com.apple.TextEdit', state_id: state.state_id, element_index: 1 }),
      ).rejects.toThrow('STALE_STATE');
      expect(JSON.stringify(s.host.view())).not.toContain(
        s.host.environment.EVOWORK_CUA_SESSION_TOKEN,
      );
    } finally {
      await s.host.close();
    }
  });
  it('自动化、子任务、禁止 App 与停用回合都在读取前拒绝', async () => {
    const s = setup();
    try {
      await s.host.setEnabled(true);
      s.change({ interactive: false });
      await expect(s.call('list_apps')).rejects.toThrow('POLICY_DENIED');
      s.change({ interactive: true, root: false });
      await expect(s.call('list_apps')).rejects.toThrow('POLICY_DENIED');
      s.change({ root: true });
      await expect(s.call('get_app_state', { app: 'com.apple.Terminal' })).rejects.toThrow(
        'POLICY_DENIED',
      );
      await s.call('get_app_state', { app: 'com.apple.TextEdit' });
      s.host.stop();
      await expect(s.call('get_app_state', { app: 'com.apple.TextEdit' })).rejects.toThrow(
        'USER_STOPPED',
      );
      s.host.revoke();
      expect(s.host.view().grants).toEqual([]);
    } finally {
      await s.host.close();
    }
  });
  it('等待同意期间回合切换，不能继续读取 App', async () => {
    const s = setup();
    s.ask.mockImplementationOnce(async () => {
      s.change({ turnId: 'new-turn' });
      return { decision: 'accept', optionId: 'enable' };
    });
    try {
      await s.host.setEnabled(true);
      await expect(s.call('get_app_state', { app: 'com.apple.TextEdit' })).rejects.toThrow(
        'USER_STOPPED',
      );
      expect(s.helper.call).not.toHaveBeenCalledWith('list_apps');
    } finally {
      await s.host.close();
    }
  });
  it('连续十次动作后画面未变化，停止后续读取和操作', async () => {
    const s = setup();
    try {
      await s.host.setEnabled(true);
      for (let i = 0; i < 10; i++) {
        const read = await s.call('get_app_state', { app: 'com.apple.TextEdit' });
        const state = JSON.parse(read.content[0]!.text!);
        await s.call('click', {
          app: 'com.apple.TextEdit',
          state_id: state.state_id,
          element_index: 1,
        });
      }
      await expect(s.call('get_app_state', { app: 'com.apple.TextEdit' })).rejects.toThrow(
        'USER_STOPPED',
      );
      expect(
        vi.mocked(s.helper.call).mock.calls.filter(([method]) => method === 'click'),
      ).toHaveLength(10);
    } finally {
      await s.host.close();
    }
  });
  it('配置只写变量名、保留其它 MCP，重复写幂等', () => {
    const config = patchComputerUseConfig(
      '[mcp_servers.browser]\nenabled = true\n',
      '/App/EvoWork',
      '/App/server.mjs',
      false,
    );
    expect(config).toContain('EVOWORK_CUA_SESSION_TOKEN');
    expect(config).toContain('[mcp_servers.browser]');
    expect(config).toContain('enabled = false');
    expect(patchComputerUseConfig(config, '/App/EvoWork', '/App/server.mjs', false)).toBe(config);
  });
  it('关闭清理 socket 目录', async () => {
    const s = setup();
    await s.host.setEnabled(true);
    const socket = s.host.environment.EVOWORK_CUA_SOCKET;
    expect(existsSync(socket)).toBe(true);
    await s.host.close();
    expect(existsSync(socket)).toBe(false);
  });
});
