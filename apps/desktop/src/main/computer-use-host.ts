import { randomBytes, timingSafeEqual, randomUUID, createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  ComputerUseError,
  ComputerUseSession,
  FrameDecoder,
  encodeFrame,
  validateToolCall,
  type WindowIdentity,
  type McpHostCall,
  type McpContent,
} from '@evowork/computer-use';
import { decideComputerUseAccess, type ComputerUseAppKind } from '@evowork/policy';
import type { ApprovalReply, PendingApproval } from '@evowork/kernel-adapter';

export interface NativeApp {
  app: string;
  name: string;
  identity: string;
  kind: ComputerUseAppKind;
}
export interface NativeState {
  window: WindowIdentity;
  elements: number[];
  text: string;
  screenshot?: string;
  coordinateFallback: boolean;
}
export interface NativeHelper {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  stop(): void;
}
export interface ComputerUseView {
  enabled: boolean;
  state:
    | 'disabled'
    | 'unsupported'
    | 'unverified'
    | 'permission-required'
    | 'ready'
    | 'active'
    | 'component-error';
  message: string;
  grants: { appId: string; allowed: boolean }[];
  activeApp?: string;
}
interface Context {
  turnId: string;
  model: string;
  credentialSource: string;
  interactive: boolean;
  root: boolean;
  imageSupported: boolean;
  enterpriseAllowed: boolean;
  persistentAllowed: boolean;
}
interface Grant {
  identity: string;
  allowed: boolean;
}
export interface ComputerUseHostOptions {
  root: string;
  platform: string;
  releaseVerified: boolean;
  helper: NativeHelper;
  context: (threadId: string) => Context | undefined;
  ask: (approval: PendingApproval) => Promise<ApprovalReply>;
  enabledChanged?: (enabled: boolean) => void;
  cancelApprovals?: () => void;
  changed?: (view: ComputerUseView) => void;
  audit?: (record: {
    threadId: string;
    turnId: string;
    toolName: string;
    resultCode: string;
    hadScreenshot: boolean;
  }) => void;
}
/** 宿主是唯一准入边界；这里从不相信工具 arguments 内的来源、许可或模型信息。 */
export function createComputerUseHost(options: ComputerUseHostOptions) {
  const token = randomBytes(32).toString('hex');
  // macOS 的 Unix socket 路径有约 104 字节上限；用户目录及测试 tmpdir 可能很长。
  // 随机隔离由目录权限和启动 token 共同保护，不需要在路径里放完整 UUID。
  const sessionDirectory = `ew-cua-${process.pid}-${randomBytes(6).toString('hex')}`;
  const preferred = join(options.root, 'run', sessionDirectory);
  const directory =
    Buffer.byteLength(join(preferred, 'cua.sock')) < 104
      ? preferred
      : join('/tmp', sessionDirectory);
  const socketPath = join(directory, 'cua.sock');
  const grantsPath = join(options.root, 'computer-use-grants.json');
  let grants: Record<string, Grant> = Object.create(null) as Record<string, Grant>;
  try {
    const saved: unknown = JSON.parse(readFileSync(grantsPath, 'utf8'));
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [key, value] of Object.entries(saved)) {
        if (
          value &&
          typeof value === 'object' &&
          typeof value.identity === 'string' &&
          typeof value.allowed === 'boolean'
        )
          grants[key] = { identity: value.identity, allowed: value.allowed };
      }
    }
  } catch {
    /* 缺失/损坏都不给授权。 */
  }
  let enabled = false;
  let busy = false;
  let active:
    | {
        threadId: string;
        turnId: string;
        app: string;
        session: ComputerUseSession;
        fingerprint?: string;
        awaitingChange?: boolean;
      }
    | undefined;
  const taskGrants = new Map<string, Set<string>>();
  const disclosures = new Map<string, string>();
  const refused = new Set<string>();
  const stoppedTurns = new Set<string>();
  const sockets = new Set<Socket>();
  const lastSequences = new Map<string, number>();
  const pending = new Map<string, (reply: ApprovalReply) => void>();
  let server: ReturnType<typeof createServer> | undefined;
  let state: ComputerUseView['state'] =
    options.platform !== 'darwin'
      ? 'unsupported'
      : !options.releaseVerified
        ? 'unverified'
        : 'disabled';
  let message =
    state === 'unsupported'
      ? '电脑操控仅支持 macOS 14.4 及以上。'
      : state === 'unverified'
        ? '此构建尚未完成原生签名、历史删除与用户中断验收，暂不能启用。'
        : '电脑操控未启用。';
  function view(): ComputerUseView {
    return {
      enabled,
      state,
      message,
      grants: Object.entries(grants).map(([appId, grant]) => ({ appId, allowed: grant.allowed })),
      ...(active ? { activeApp: active.app } : {}),
    };
  }
  function changed() {
    options.changed?.(view());
  }
  function saveGrants() {
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    const temporary = `${grantsPath}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(grants), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, grantsPath);
  }
  function stop() {
    options.cancelApprovals?.();
    if (active) {
      active.session.stop();
      stoppedTurns.add(`${active.threadId}:${active.turnId}`);
    }
    active = undefined;
    for (const resolve of pending.values()) resolve({ decision: 'cancel' });
    pending.clear();
    options.helper.stop();
    for (const socket of sockets) socket.destroy();
    if (enabled) {
      state = 'ready';
      message = '控制已停止；需要重新发起回合才能继续。';
    }
    changed();
  }
  async function ask(
    threadId: string,
    turnId: string,
    text: string,
    choices: string[],
  ): Promise<string | undefined> {
    const id = `cua_${randomUUID()}`;
    const approval: PendingApproval = {
      id,
      kind: 'mcp',
      threadId,
      turnId,
      receivedAtMs: Date.now(),
      unattended: false,
      params: {
        mode: 'form',
        serverName: 'cua_repl',
        message: text,
        requestedSchema: {
          type: 'object',
          properties: { scope: { type: 'string', enum: choices } },
          required: ['scope'],
        },
      },
    };
    try {
      const reply = await Promise.race([
        options.ask(approval),
        new Promise<ApprovalReply>((resolve) => pending.set(id, resolve)),
      ]);
      return reply.decision === 'accept' && reply.optionId && choices.includes(reply.optionId)
        ? reply.optionId
        : undefined;
    } finally {
      pending.delete(id);
    }
  }
  async function call(
    request: McpHostCall,
    signal?: AbortSignal,
  ): Promise<{ content: McpContent[]; isError?: boolean }> {
    if (busy || !enabled || !options.releaseVerified) throw new ComputerUseError('POLICY_DENIED');
    const args = validateToolCall(request.name, request.arguments);
    const context = options.context(request.threadId);
    if (!context || !context.interactive || !context.root || !context.enterpriseAllowed)
      throw new ComputerUseError('POLICY_DENIED');
    const turnKey = `${request.threadId}:${context.turnId}`;
    if (stoppedTurns.has(turnKey)) throw new ComputerUseError('USER_STOPPED');
    if (active && (active.threadId !== request.threadId || active.turnId !== context.turnId))
      throw new ComputerUseError('POLICY_DENIED');
    const current = () => {
      const next = options.context(request.threadId);
      if (
        !enabled ||
        signal?.aborted ||
        stoppedTurns.has(turnKey) ||
        !next ||
        next.turnId !== context.turnId ||
        !next.interactive ||
        !next.root ||
        !next.enterpriseAllowed ||
        next.model !== context.model ||
        next.credentialSource !== context.credentialSource
      )
        throw new ComputerUseError('USER_STOPPED');
    };
    busy = true;
    const onAbort = () => stop();
    signal?.addEventListener('abort', onAbort, { once: true });
    let hadScreenshot = false;
    try {
      current();
      const disclosureKey = `${context.model}:${context.credentialSource}`;
      if (disclosures.get(request.threadId) !== disclosureKey) {
        if (refused.has(request.threadId)) throw new ComputerUseError('APP_DENIED');
        const scope = await ask(
          request.threadId,
          context.turnId,
          `EvoWork 将读取你允许的应用窗口。界面文字和必要截图会发送给模型 ${context.model}（凭据来源：${context.credentialSource}），并保存在此任务本机历史中。归档会保留内容；真正删除任务才会清除。删除本机任务不能撤回模型提供方已收到的数据。`,
          ['enable'],
        );
        current();
        if (scope !== 'enable') {
          refused.add(request.threadId);
          throw new ComputerUseError('APP_DENIED');
        }
        disclosures.set(request.threadId, disclosureKey);
      }
      // list_apps 仅元数据，禁止应用在原生层与宿主层双重过滤。
      const apps = (await options.helper.call('list_apps')) as NativeApp[];
      current();
      const permitted = (app: NativeApp, taskGranted: boolean) =>
        decideComputerUseAccess({
          enabled,
          enterpriseEnabled: context.enterpriseAllowed,
          source: 'interactive',
          disclosed: true,
          locked: false,
          appId: app.app,
          appKind: app.kind,
          identityVerified: Boolean(app.identity),
          taskGranted,
          persistentIdentityMatches: grants[app.app]?.identity === app.identity,
          allowPersistentApproval: context.persistentAllowed,
          browserFallbackApproved: false,
          ...(grants[app.app]
            ? { userAccess: grants[app.app]!.allowed ? ('allow' as const) : ('deny' as const) }
            : {}),
        });
      if (request.name === 'list_apps')
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                apps
                  .filter((app) => permitted(app, true) === 'allow')
                  .map((app) => ({ app: app.app, name: app.name })),
              ),
            },
          ],
        };
      const app = apps.find((app) => app.app === args.app);
      if (!app || permitted(app, true) === 'POLICY_DENIED')
        throw new ComputerUseError('POLICY_DENIED');
      const taskKey = `${app.app}:${app.identity}`;
      if (permitted(app, taskGrants.get(request.threadId)?.has(taskKey) ?? false) !== 'allow') {
        if (grants[app.app]?.allowed === false) throw new ComputerUseError('APP_DENIED');
        const scope = await ask(
          request.threadId,
          context.turnId,
          `允许 EvoWork 读取并操作 ${app.name}？应用准入不会跳过动作审批。`,
          context.persistentAllowed ? ['task', 'always', 'deny'] : ['task', 'deny'],
        );
        current();
        if (!scope || scope === 'deny') {
          if (scope === 'deny') {
            grants[app.app] = { identity: app.identity, allowed: false };
            saveGrants();
          }
          throw new ComputerUseError('APP_DENIED');
        }
        if (scope === 'always') {
          grants[app.app] = { identity: app.identity, allowed: true };
          saveGrants();
        }
        const allowed = taskGrants.get(request.threadId) ?? new Set<string>();
        allowed.add(taskKey);
        taskGrants.set(request.threadId, allowed);
      }
      current();
      const session = active?.session ?? new ComputerUseSession(request.threadId, context.turnId);
      active = {
        ...active,
        threadId: request.threadId,
        turnId: context.turnId,
        app: app.app,
        session,
      };
      state = 'active';
      message = `EvoWork 正在使用 ${app.name}`;
      changed();
      if (request.name === 'get_app_state') {
        const screenshot = args.include_screenshot === true;
        if (screenshot && !context.imageSupported)
          throw new ComputerUseError('MODEL_IMAGE_UNSUPPORTED');
        const result = (await options.helper.call('get_app_state', {
          app: app.app,
          identity: app.identity,
          include_screenshot: screenshot,
        })) as NativeState;
        current();
        const fingerprint = createHash('sha256')
          .update(JSON.stringify([result.window, result.text]))
          .digest('hex');
        if (active?.awaitingChange) session.complete(fingerprint !== active.fingerprint);
        if (active) {
          active.fingerprint = fingerprint;
          active.awaitingChange = false;
        }
        const stateId = session.observe(result.window, result.elements, result.coordinateFallback);
        hadScreenshot = Boolean(result.screenshot);
        const content: McpContent[] = [
          {
            type: 'text',
            text: JSON.stringify({
              state_id: stateId,
              text: result.text,
              window: result.window,
              full: true,
              reason: 'FULL_SNAPSHOT',
              requires_screenshot: result.coordinateFallback,
            }),
          },
        ];
        if (result.screenshot)
          content.push({ type: 'image', mimeType: 'image/png', data: result.screenshot });
        options.audit?.({
          threadId: request.threadId,
          turnId: context.turnId,
          toolName: request.name,
          resultCode: 'OK',
          hadScreenshot,
        });
        return { content };
      }
      // 所有原生写操作再次绑定窗口和元素；不把授权等待之前的状态当作当前状态。
      const window = (await options.helper.call('window_identity', {
        app: app.app,
        identity: app.identity,
      })) as WindowIdentity;
      current();
      const budget = session.consume(String(args.state_id), window, args);
      try {
        await options.helper.call(request.name, { ...args, identity: app.identity });
        current();
        if (active) active.awaitingChange = true;
      } catch (error) {
        session.complete(false, error instanceof ComputerUseError ? error.code : 'INTERNAL');
        throw error;
      }
      options.audit?.({
        threadId: request.threadId,
        turnId: context.turnId,
        toolName: request.name,
        resultCode: 'OK',
        hadScreenshot: false,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              message: '已完成，请重新获取应用状态',
              requires_refresh: true,
              ...(budget.warnBudget ? { warning: 'ACTION_BUDGET_NEAR_LIMIT' } : {}),
            }),
          },
        ],
      };
    } catch (error) {
      const resultCode = error instanceof ComputerUseError ? error.code : 'INTERNAL';
      options.audit?.({
        threadId: request.threadId,
        turnId: context.turnId,
        toolName: request.name,
        resultCode,
        hadScreenshot,
      });
      if (resultCode === 'USER_STOPPED') stop();
      throw error;
    } finally {
      busy = false;
      signal?.removeEventListener('abort', onAbort);
    }
  }
  async function start() {
    if (server) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    server = createServer((socket) => {
      sockets.add(socket);
      const decoder = new FrameDecoder();
      let seq = 0;
      let invalid = 0;
      let inFlight = false;
      const abort = new AbortController();
      socket.on('close', () => {
        sockets.delete(socket);
        abort.abort();
      });
      socket.on('error', () => socket.destroy());
      socket.setTimeout(60000, () => socket.destroy());
      socket.on('data', (chunk: Buffer) => {
        try {
          for (const raw of decoder.push(chunk)) {
            const r = raw as { token?: unknown; sequence?: unknown; payload?: McpHostCall };
            const candidate = typeof r?.token === 'string' ? Buffer.from(r.token) : Buffer.alloc(0);
            if (
              candidate.length !== token.length ||
              !timingSafeEqual(candidate, Buffer.from(token)) ||
              !Number.isSafeInteger(r.sequence) ||
              Number(r.sequence) <= seq ||
              !r.payload ||
              typeof r.payload.threadId !== 'string' ||
              typeof r.payload.sessionId !== 'string' ||
              Number(r.sequence) <= (lastSequences.get(r.payload.sessionId) ?? 0)
            ) {
              socket.write(encodeFrame({ ok: false }));
              if (++invalid >= 3) socket.destroy();
              continue;
            }
            seq = Number(r.sequence);
            lastSequences.set(r.payload.sessionId, seq);
            if (inFlight) {
              socket.destroy();
              break;
            }
            inFlight = true;
            void call(r.payload, abort.signal)
              .then((result) => {
                if (!socket.destroyed) socket.write(encodeFrame({ ok: true, result }));
              })
              .catch((error) => {
                if (!socket.destroyed)
                  socket.write(
                    encodeFrame({
                      ok: true,
                      result: {
                        isError: true,
                        content: [
                          {
                            type: 'text',
                            text: JSON.stringify({
                              ok: false,
                              code: error instanceof ComputerUseError ? error.code : 'INTERNAL',
                            }),
                          },
                        ],
                      },
                    }),
                  );
              })
              .finally(() => {
                inFlight = false;
              });
          }
        } catch {
          socket.destroy();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(socketPath, () => {
        chmodSync(socketPath, 0o600);
        resolve();
      });
    });
  }
  return {
    view,
    call,
    start,
    stop,
    environment: { EVOWORK_CUA_SOCKET: socketPath, EVOWORK_CUA_SESSION_TOKEN: token },
    async setEnabled(value: boolean): Promise<ComputerUseView> {
      if (!value) {
        options.enabledChanged?.(false);
        enabled = false;
        stop();
        state = 'disabled';
        message = '电脑操控未启用。';
        changed();
        return view();
      }
      if (options.platform !== 'darwin' || !options.releaseVerified) return view();
      try {
        const health = (await options.helper.call('health')) as {
          protocolVersion: number;
          accessibility: boolean;
        };
        if (health.protocolVersion !== 1) throw new Error('VERSION_MISMATCH');
        if (!health.accessibility) {
          state = 'permission-required';
          message = '请在系统设置中手动授予辅助功能权限后重试。';
        } else {
          await start();
          options.enabledChanged?.(true);
          enabled = true;
          refused.clear();
          state = 'ready';
          message = '已启用；每个任务仍需确认内容传输和应用准入。';
        }
      } catch {
        state = 'component-error';
        message = '组件缺失、签名无效或版本不匹配，请修复安装。';
      }
      changed();
      return view();
    },
    revoke(appId?: string) {
      stop();
      if (appId) delete grants[appId];
      else grants = Object.create(null) as Record<string, Grant>;
      taskGrants.clear();
      saveGrants();
      changed();
      return view();
    },
    endThread(threadId: string) {
      if (active?.threadId === threadId) stop();
      taskGrants.delete(threadId);
      disclosures.delete(threadId);
      refused.delete(threadId);
    },
    endTurn(threadId: string) {
      if (active?.threadId === threadId) stop();
    },
    async close() {
      options.enabledChanged?.(false);
      enabled = false;
      stop();
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
export type ComputerUseHost = ReturnType<typeof createComputerUseHost>;
