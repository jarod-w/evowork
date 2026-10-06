import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createComputerUseHost,
  type NativeHelper,
  type ComputerUseContext,
} from '../src/main/computer-use-host.js';
import { patchComputerUseConfig } from '../src/main/computer-use-config.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(verified = true, nestedRoot = '', contextCheck?: () => Promise<void>) {
  const temporary = mkdtempSync(join(tmpdir(), 'ew-cu-test-'));
  roots.push(temporary);
  const root = join(temporary, nestedRoot);
  let context: ComputerUseContext = {
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
      if (method === 'inspect_action')
        return {
          window,
          text: 'PRIVATE_SCREEN',
          target: { app: window.app, role: 'AXTextArea', label: '', editable: true },
        };
      return { ok: true };
    }),
  };
  const ask = vi.fn(async (approval) => ({
    decision: 'accept' as const,
    optionId: approval.params.message.includes('凭据来源')
      ? 'enable'
      : approval.params.message.includes('动作类别')
        ? 'confirm'
        : 'always',
  }));
  const audit = vi.fn();
  const host = createComputerUseHost({
    root,
    platform: 'darwin',
    releaseVerified: verified,
    helper,
    context: async () => {
      await contextCheck?.();
      return context;
    },
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
  it('应用始终允许也不能代答发送；拒绝时原生写动作零调用', async () => {
    const s = setup();
    const original = s.helper.call;
    s.helper.call = vi.fn(async (method, params) =>
      method === 'inspect_action'
        ? {
            window: await original('window_identity'),
            text: 'PRIVATE_SCREEN',
            target: { app: 'com.apple.TextEdit', role: 'AXButton', label: '发送', editable: false },
          }
        : original(method, params),
    );
    try {
      await s.host.setEnabled(true);
      const read = await s.call('get_app_state', { app: 'com.apple.TextEdit' });
      s.ask.mockImplementationOnce(async () => ({ decision: 'decline' as never, optionId: '' }));
      await expect(
        s.call('click', {
          app: 'com.apple.TextEdit',
          state_id: JSON.parse(read.content[0]!.text!).state_id,
          element_index: 1,
        }),
      ).rejects.toThrow('APP_DENIED');
      expect(vi.mocked(s.helper.call).mock.calls.some(([method]) => method === 'click')).toBe(
        false,
      );
      expect(s.ask.mock.calls.at(-1)?.[0].params.message).toContain('发送或提交内容');
      expect(JSON.stringify(s.audit.mock.calls)).not.toContain('PRIVATE_SCREEN');
    } finally {
      await s.host.close();
    }
  });
  it('提交确认显示原生完整字段，不用截断的模型快照代替；正文不进审计', async () => {
    const s = setup(),
      original = s.helper.call;
    const full = 'x'.repeat(4096) + 'CONFIRMATION_TAIL';
    s.helper.call = vi.fn(async (method, params) =>
      method === 'inspect_action'
        ? {
            window: await original('window_identity'),
            text: 'PRIVATE_SCREEN',
            confirmationText: full,
            target: { app: 'com.apple.TextEdit', role: 'AXButton', label: '发送', editable: false },
          }
        : original(method, params),
    );
    try {
      await s.host.setEnabled(true);
      const read = await s.call('get_app_state', { app: 'com.apple.TextEdit' });
      await s.call('click', {
        app: 'com.apple.TextEdit',
        state_id: JSON.parse(read.content[0]!.text!).state_id,
        element_index: 1,
      });
      expect(s.ask.mock.calls.at(-1)?.[0].params.message).toContain(full);
      expect(JSON.stringify(s.audit.mock.calls)).not.toContain('CONFIRMATION_TAIL');
    } finally {
      await s.host.close();
    }
  });
  it('确认期间界面改变，不把许可移到新目标；必须重读', async () => {
    const s = setup();
    const original = s.helper.call;
    let text = 'PRIVATE_SCREEN';
    s.helper.call = vi.fn(async (method, params) =>
      method === 'inspect_action'
        ? {
            window: await original('window_identity'),
            text,
            target: { app: 'com.apple.TextEdit', role: 'AXButton', label: '发送', editable: false },
          }
        : original(method, params),
    );
    try {
      await s.host.setEnabled(true);
      const read = await s.call('get_app_state', { app: 'com.apple.TextEdit' });
      s.ask.mockImplementationOnce(async () => {
        text = 'CHANGED_SCREEN';
        return { decision: 'accept', optionId: 'confirm' };
      });
      await expect(
        s.call('click', {
          app: 'com.apple.TextEdit',
          state_id: JSON.parse(read.content[0]!.text!).state_id,
          element_index: 1,
        }),
      ).rejects.toThrow('STALE_STATE');
      expect(vi.mocked(s.helper.call).mock.calls.some(([method]) => method === 'click')).toBe(
        false,
      );
    } finally {
      await s.host.close();
    }
  });
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
  it('认不出的应用 id 回 APP_NOT_FOUND（能改正），硬禁止的仍是 POLICY_DENIED（该停下）', async () => {
    const s = setup();
    try {
      await s.host.setEnabled(true);
      // 2026-10-05 MiMo flash：把 list_apps 的显示名当 id 传进来
      await expect(s.call('get_app_state', { app: 'TextEdit' })).rejects.toThrow('APP_NOT_FOUND');
      await expect(s.call('get_app_state', { app: 'com.apple.Terminal' })).rejects.toThrow(
        'POLICY_DENIED',
      );
      expect(
        vi.mocked(s.helper.call).mock.calls.some(([method]) => method === 'get_app_state'),
      ).toBe(false);
    } finally {
      await s.host.close();
    }
  });
  it('用户点「停止控制」进审计，之后被挡下的调用也进；回合正常结束不算用户停止', async () => {
    const s = setup();
    try {
      await s.host.setEnabled(true);
      await s.call('get_app_state', { app: 'com.apple.TextEdit' });
      s.host.stop('user');
      await expect(s.call('get_app_state', { app: 'com.apple.TextEdit' })).rejects.toThrow(
        'USER_STOPPED',
      );
      const records = s.audit.mock.calls.map(([record]) => record);
      expect(records).toContainEqual(
        expect.objectContaining({ toolName: 'stop_control', resultCode: 'USER_STOPPED' }),
      );
      expect(records.filter((record) => record.resultCode === 'USER_STOPPED')).toHaveLength(2);
      expect(JSON.stringify(records)).not.toContain('PRIVATE_SCREEN');
    } finally {
      await s.host.close();
    }
    const quiet = setup();
    try {
      await quiet.host.setEnabled(true);
      await quiet.call('get_app_state', { app: 'com.apple.TextEdit' });
      quiet.host.endTurn('thread');
      expect(quiet.audit.mock.calls.some(([record]) => record.toolName === 'stop_control')).toBe(
        false,
      );
    } finally {
      await quiet.host.close();
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
  it('用户数据路径过长时仍能启动短路径私有 socket', async () => {
    const s = setup(true, 'long-user-profile-'.repeat(5));
    try {
      expect(s.host.environment.EVOWORK_CUA_SOCKET).toMatch(/^\/tmp\/ew-cua-/);
      expect((await s.host.setEnabled(true)).state).toBe('ready');
      expect(existsSync(s.host.environment.EVOWORK_CUA_SOCKET)).toBe(true);
    } finally {
      await s.host.close();
    }
    expect(existsSync(s.host.environment.EVOWORK_CUA_SOCKET)).toBe(false);
  });
});

describe('P2 权限恢复与企业准入', () => {
  it('AX-only 能启用；撤销辅助功能立即停止并注销工具，重新授权后可检查和启用', async () => {
    const s = setup();
    let accessibility = true;
    const original = s.helper.call;
    s.helper.call = vi.fn(async (method, params) =>
      method === 'health'
        ? { protocolVersion: 1, accessibility, screenRecording: false }
        : original(method, params),
    );
    try {
      expect((await s.host.setEnabled(true)).enabled).toBe(true);
      expect(s.host.view().permissions?.screenRecording).toBe(false);
      await s.call('get_app_state', { app: 'com.apple.TextEdit' });
      accessibility = false;
      await expect(s.call('get_app_state', { app: 'com.apple.TextEdit' })).rejects.toThrow(
        'PERMISSION_REQUIRED',
      );
      expect(s.host.view().enabled).toBe(false);
      expect(s.host.view().state).toBe('permission-required');
      expect(s.host.view().activeApp).toBeUndefined();
      accessibility = true;
      expect((await s.host.refresh()).state).toBe('disabled');
      expect((await s.host.setEnabled(true)).state).toBe('ready');
    } finally {
      await s.host.close();
    }
  });
  it('策略应用 deny 覆盖始终允许，不弹准入卡且原生读取零调用', async () => {
    const s = setup();
    try {
      await s.host.setEnabled(true);
      await s.call('get_app_state', { app: 'com.apple.TextEdit' });
      s.helper.call = vi.fn(s.helper.call);
      s.ask.mockClear();
      s.change({
        requirements: {
          enabled: true,
          persistentAllowed: false,
          appAccess: { 'com.apple.textedit': 'deny' },
        },
        persistentAllowed: false,
      });
      await expect(s.call('get_app_state', { app: 'com.apple.TextEdit' })).rejects.toThrow(
        'APP_DENIED',
      );
      expect(s.ask).not.toHaveBeenCalled();
      expect(
        vi.mocked(s.helper.call).mock.calls.some(([method]) => method === 'get_app_state'),
      ).toBe(false);
    } finally {
      await s.host.close();
    }
  });
  it('失败的写动作也计入尝试次数，状态条不把失败说成成功', async () => {
    const s = setup();
    try {
      await s.host.setEnabled(true);
      const read = await s.call('get_app_state', { app: 'com.apple.TextEdit' });
      const original = s.helper.call;
      s.helper.call = vi.fn(async (method, params) => {
        if (method === 'set_value') throw new Error('failure');
        return original(method, params);
      });
      await expect(
        s.call('set_value', {
          app: 'com.apple.TextEdit',
          state_id: JSON.parse(read.content[0]!.text!).state_id,
          element_index: 1,
          value: 'x',
        }),
      ).rejects.toThrow('failure');
      expect(s.host.view().actionCount).toBe(1);
    } finally {
      await s.host.close();
    }
  });
  it.each(['win32', 'linux'])(
    '平台 %s 不注册或调用原生能力，原因指明驱动缺失',
    async (platform) => {
      const s = setup();
      const host = createComputerUseHost({
        root: s.root,
        platform,
        releaseVerified: true,
        helper: s.helper,
        context: () => undefined,
        ask: s.ask,
      });
      expect((await host.setEnabled(true)).state).toBe('unsupported');
      expect(host.view().message).toContain('驱动尚未提供');
      expect(s.helper.call).not.toHaveBeenCalled();
      await host.close();
      await s.host.close();
    },
  );
});

describe('控制停止状态', () => {
  it('打开设置重新检查健康状态，不覆盖用户已经停止的说明', async () => {
    const s = setup();
    try {
      await s.host.setEnabled(true);
      await s.call('get_app_state', { app: 'com.apple.TextEdit' });
      s.host.stop('user');
      expect((await s.host.refresh()).message).toBe('控制已停止；需要重新发起回合才能继续。');
    } finally {
      await s.host.close();
    }
  });
});

describe('异步策略读取不扩大控制生命周期', () => {
  it('等待可信上下文时点停止，返回后不得继续告知或读取', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const s = setup(true, '', () => gate);
    try {
      await s.host.setEnabled(true);
      s.helper.call = vi.fn(s.helper.call);
      const result = s.call('list_apps');
      s.host.stop('user');
      release();
      await expect(result).rejects.toThrow('USER_STOPPED');
      await expect(s.call('list_apps')).rejects.toThrow('USER_STOPPED');
      expect(s.ask).not.toHaveBeenCalled();
      expect(s.helper.call).not.toHaveBeenCalled();
    } finally {
      release();
      await s.host.close();
    }
  });
  it('动作执行期间打开设置不与 Helper 争用，不能误报组件损坏或停止动作', async () => {
    const s = setup();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    try {
      await s.host.setEnabled(true);
      const read = await s.call('get_app_state', { app: 'com.apple.TextEdit' });
      const original = s.helper.call;
      s.helper.call = vi.fn(async (method, params) => {
        if (method === 'set_value') {
          entered();
          await gate;
        }
        return original(method, params);
      });
      const write = s.call('set_value', {
        app: 'com.apple.TextEdit',
        state_id: JSON.parse(read.content[0]!.text!).state_id,
        element_index: 1,
        value: 'x',
      });
      await started;
      const before = vi.mocked(s.helper.call).mock.calls.length;
      expect((await s.host.refresh()).state).toBe('active');
      expect(vi.mocked(s.helper.call).mock.calls.length).toBe(before);
      release();
      await write;
      expect(s.host.view().enabled).toBe(true);
    } finally {
      release();
      await s.host.close();
    }
  });
});

describe('权限重新检查的并发', () => {
  it('多个状态读取共用一次健康检查，避免把组件忙误判为损坏', async () => {
    const s = setup();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started = new Promise<void>((r) => {
      entered = r;
    });
    let probing = false;
    s.helper.call = vi.fn(async (method) => {
      if (method !== 'health') throw new Error('unexpected');
      if (probing) throw new Error('BUSY');
      probing = true;
      entered();
      await gate;
      return { protocolVersion: 1, accessibility: true, screenRecording: false };
    });
    try {
      const first = s.host.refresh();
      await started;
      const second = s.host.refresh();
      release();
      const views = await Promise.all([first, second]);
      expect(s.helper.call).toHaveBeenCalledTimes(1);
      expect(views.every((view) => view.component === 'connected')).toBe(true);
    } finally {
      release();
      await s.host.close();
    }
  });
});
