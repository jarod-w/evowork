import { METHOD } from '@evowork/protocol';
import { describe, expect, it } from 'vitest';

import { KernelSession, type SessionNotice, type SessionPhase } from '../src/session.js';
import { FakeAppServer } from './fake-app-server.js';

const CLIENT_INFO = { name: 'evowork-desktop', version: '0.0.0' };

/** 立即执行的定时器：把退避与心跳的时间维度从测试里去掉，只留顺序与次数。 */
function immediateTimers() {
  const pending: (() => void)[] = [];
  const setTimeoutFn = ((fn: () => void) => {
    pending.push(fn);
    return pending.length as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  const clearTimeoutFn = (() => {}) as unknown as typeof clearTimeout;
  return {
    setTimeoutFn,
    clearTimeoutFn,
    /**
     * 跑一轮已排队的定时器，并把微任务队列抽干。
     *
     * 抽干很重要：一次重启要串起 `退避 → launch → initialize 请求 → 响应 → recover 的两次请求`，
     * 每一步都是一个 await。只 `await Promise.resolve()` 两次不足以走完，
     * 而"走不完"在测试里的表现是断言看起来随机地失败 —— 那种测试比没有测试更糟。
     */
    async flush(rounds = 1): Promise<void> {
      for (let i = 0; i < rounds; i += 1) {
        const batch = pending.splice(0, pending.length);
        for (const fn of batch) fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    get size(): number {
      return pending.length;
    },
  };
}

describe('KernelSession 握手（09 §3.2）', () => {
  it('声明 experimentalApi 并发出 `initialized` 通知（**不是** notifications/initialized，F17）', async () => {
    const server = new FakeAppServer();
    const timers = immediateTimers();
    const session = new KernelSession({
      launcher: server.launcher(),
      clientInfo: CLIENT_INFO,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    await session.start();

    expect(server.received.map((r) => r.method)).toEqual(['initialize', 'initialized']);
    expect(server.received[0]?.params).toMatchObject({
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    });
    expect(session.phase).toBe('ready');
    await session.stop();
  });

  it('不声明 experimentalApi 时实验方法会被拒 —— 这是我们的 bug 而不是降级', async () => {
    // 用假内核复刻内核的门禁行为（-32600 + "requires experimentalApi capability"）
    const server = new FakeAppServer();
    let declaredExperimental = false;
    server.handlers.set('initialize', (ctx) => {
      declaredExperimental = Boolean(
        (ctx.params.capabilities as { experimentalApi?: boolean } | undefined)?.experimentalApi,
      );
      return {};
    });
    server.handlers.set('project/list', () => {
      if (!declaredExperimental)
        throw new Error('project/list requires experimentalApi capability');
      return { data: [] };
    });

    const timers = immediateTimers();
    const session = new KernelSession({
      launcher: server.launcher(),
      clientInfo: CLIENT_INFO,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await session.start();
    // 因为 session 总是声明 experimentalApi，所以这里应当成功
    await expect(session.peer.request('project/list', {})).resolves.toEqual({ data: [] });
    expect(declaredExperimental).toBe(true);
    await session.stop();
  });
});

describe('崩溃 · 退避重启 · 会话恢复（09 §1）', () => {
  it('崩溃后按退避重启，恢复打开的会话，并**显式**通知用户', async () => {
    const server = new FakeAppServer();
    const timers = immediateTimers();
    const notices: SessionNotice[] = [];
    const phases: SessionPhase[] = [];

    const session = new KernelSession({
      launcher: server.launcher(),
      clientInfo: CLIENT_INFO,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onNotice: (n) => notices.push(n),
      onPhaseChange: (p) => phases.push(p),
      recover: async (peer) => {
        let count = 0;
        for (const threadId of session.openThreads) {
          await peer.request(METHOD.threadResume, { threadId });
          await peer.request(METHOD.threadItemsList, { threadId });
          count += 1;
        }
        return count;
      },
    });

    await session.start();
    session.openThreads.add('thread_a');
    session.openThreads.add('thread_b');
    expect(server.launches).toBe(1);

    server.crash();
    expect(session.phase).toBe('restarting');
    await timers.flush(3);

    expect(server.launches).toBe(2);
    // 恢复：两个会话各做了 resume + items/list（09 §1 第三步）
    const methods = server.received.map((r) => r.method);
    expect(methods.filter((m) => m === 'thread/resume')).toHaveLength(2);
    expect(methods.filter((m) => m === 'thread/items/list')).toHaveLength(2);

    // **不静默重启**：用户看到一条说明，且说明里有恢复了几个会话
    expect(notices).toHaveLength(1);
    expect(notices[0]?.kind).toBe('kernel-restarted');
    expect(notices[0]?.recoveredThreads).toBe(2);
    expect(notices[0]?.text).toContain('已重启');
    expect(phases).toContain('restarting');
    await session.stop();
  });

  it('重启后**审批处理器仍然有效** —— peer 被复用而不是重建（F14）', async () => {
    const server = new FakeAppServer();
    const timers = immediateTimers();
    const session = new KernelSession({
      launcher: server.launcher(),
      clientInfo: CLIENT_INFO,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });

    const handled: string[] = [];
    session.onRequest('item/commandExecution/requestApproval', (params) => {
      handled.push(String((params as { itemId?: string }).itemId));
      return { decision: 'accept' };
    });

    await session.start();
    await server.requestClient('item/commandExecution/requestApproval', { itemId: 'before' });
    expect(handled).toEqual(['before']);

    server.crash();
    await timers.flush(3);

    // 重启后内核发出的第一个审批请求必须仍然有人接。
    // 如果这里重建了 peer，这个请求会没人回复 —— 而"没人回复"的表现是任务静静地停住。
    const reply = await server.requestClient('item/commandExecution/requestApproval', {
      itemId: 'after-restart',
    });
    expect(handled).toEqual(['before', 'after-restart']);
    expect(reply).toEqual({ decision: 'accept' });
    await session.stop();
  });

  it('崩溃时 in-flight 请求被拒掉 —— UI 按钮不会永远转圈', async () => {
    const server = new FakeAppServer();
    const timers = immediateTimers();
    server.blackhole('thread/list'); // 一个永不回复的方法（长任务或管道阻塞）
    const session = new KernelSession({
      launcher: server.launcher(),
      clientInfo: CLIENT_INFO,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await session.start();

    const inflight = session.peer.request('thread/list', {});
    // 断言必须在 crash 之前挂上：否则拒绝会在 setImmediate 边界前无人处理，
    // Node 会按"未处理的拒绝"报出来 —— 那是测试写法问题，不是被测代码的问题
    const rejected = expect(inflight).rejects.toThrow(/连接已断开/);
    server.crash();
    await timers.flush(1);
    await rejected;
    await session.stop();
  });

  it('连续重启失败到上限后放弃，并明确告知用户', async () => {
    const timers = immediateTimers();
    const notices: SessionNotice[] = [];
    let launchCount = 0;
    const session = new KernelSession({
      launcher: {
        launch: () => {
          launchCount += 1;
          if (launchCount === 1) {
            const server = new FakeAppServer();
            const proc = server.launcher().launch();
            // 第一次正常启动，之后每次都抛错
            setTimeout(() => server.crash(), 0);
            return proc;
          }
          throw new Error('启动失败');
        },
      },
      clientInfo: CLIENT_INFO,
      maxRestartAttempts: 2,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onNotice: (n) => notices.push(n),
    });

    await session.start();
    // 第一次崩溃由真实 setTimeout 触发，等一拍
    await new Promise((r) => setTimeout(r, 1));
    await timers.flush(6);

    expect(session.phase).toBe('failed');
    const failed = notices.find((n) => n.kind === 'kernel-failed');
    expect(failed?.text).toContain('停止重试');
    await session.stop();
  });

  it('主动 stop 后不再重启（用户关掉后台常驻，09 §1）', async () => {
    const server = new FakeAppServer();
    const timers = immediateTimers();
    const session = new KernelSession({
      launcher: server.launcher(),
      clientInfo: CLIENT_INFO,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await session.start();
    await session.stop();
    await timers.flush(3);
    expect(server.launches).toBe(1);
    expect(session.phase).toBe('stopped');
  });
});

describe('心跳（09 §5）', () => {
  it('连续 3 次心跳失败判定失联 → 走崩溃路径并提示"正在重连"', async () => {
    const server = new FakeAppServer();
    const timers = immediateTimers();
    const notices: SessionNotice[] = [];
    const session = new KernelSession({
      launcher: server.launcher(),
      clientInfo: CLIENT_INFO,
      heartbeatIntervalMs: 1,
      heartbeatTimeoutMs: 1,
      maxHeartbeatMisses: 3,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
      onNotice: (n) => notices.push(n),
    });

    await session.start();
    server.freeze(); // 进程活着但不回应

    // 每一轮 flush 触发一次心跳
    for (let i = 0; i < 6; i += 1) await timers.flush(1);

    const lost = notices.find((n) => n.kind === 'kernel-lost');
    expect(lost?.text).toContain('正在重连');
    await session.stop();
  });

  it('心跳用稳定方法（`permissionProfile/list`），不依赖可能被降级的实验方法', async () => {
    const server = new FakeAppServer();
    const timers = immediateTimers();
    const session = new KernelSession({
      launcher: server.launcher(),
      clientInfo: CLIENT_INFO,
      heartbeatIntervalMs: 1,
      setTimeoutFn: timers.setTimeoutFn,
      clearTimeoutFn: timers.clearTimeoutFn,
    });
    await session.start();
    await timers.flush(2);
    expect(server.received.map((r) => r.method)).toContain('permissionProfile/list');
    await session.stop();
  });
});
