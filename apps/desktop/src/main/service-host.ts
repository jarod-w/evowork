/**
 * 本机服务宿主（09 §1）。
 *
 * Q1=A 之后所有东西都在用户机器上，而进程边界按**崩溃域隔离**划：
 *
 * ```
 * ┌─ evowork-desktop（Electron 主进程）───────────────────────────┐
 * │  · 窗口与渲染进程（UI，L4）                                   │
 * │  · 本机服务宿主（L3，同进程内的模块，**不再拆进程**）           │
 * │      scheduler · ingest · artifacts · policy · index         │
 * └───────┬──────────────────────────────────────────────────────┘
 *         │ stdio JSON-RPC v2
 * ┌───────▼──────────────┐
 * │ codex-app-server     │（内核，L1，常驻 1 个）
 * └──────────────────────┘
 * ```
 *
 * **五个本机服务不拆进程**（09 §1 的决策）：它们加起来的状态就是一个 sqlite 加几个 watcher，
 * 拆进程要多付 IPC、崩溃恢复、双向同步三份复杂度，收益为零。
 *
 * 这个文件本身**不 import electron**：Electron 的 `app` / `BrowserWindow` 由
 * `bootstrap.ts` 注入。这样宿主的接线逻辑能在测试里跑，而不必起一个 Electron ——
 * 否则"启动顺序对不对""崩溃后有没有恢复"这类问题只能靠手点。
 */
import type { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';

import {
  createAdapter,
  createSpawnLauncher,
  type Adapter,
  type ApprovalReply,
  type PendingApproval,
  type SessionNotice,
} from '@evowork/kernel-adapter';
import { createLogger, jsonLinesSink, type Logger } from '@evowork/logging';
import { BRAND } from '@evowork/tokens';
import { createAuditRepo, openStore, type Store } from '@evowork/store';

import { ensureAuditLog, ingestAuditLog } from './audit-ingest.js';
import { startLocalGateway, type GatewayProcess } from './gateway-process.js';
import { createLocalServices, type LocalServices } from './local-services.js';
import { fetchModelCatalog, readGatewayBaseUrl } from './model-catalog.js';
import {
  createEventTranslator,
  createRendererActions,
  toApprovalView,
  type RendererActions,
} from './renderer-bridge.js';
import { BUILTIN_CASES } from './showcase.js';

/** `~/.evowork/` 的布局（09 §7）。 */
export interface EvoworkPaths {
  readonly home: string;
  readonly db: string;
  readonly config: string;
  readonly requirements: string;
  readonly modes: string;
  readonly scenarios: string;
  readonly logs: string;
  /**
   * 网关访问令牌（见 `readGatewayToken`）。
   *
   * 单独一个文件而不是写进 `config.toml`：那个文件是**内核的**配置，
   * 而令牌是 EvoWork 自己的凭据；混进去等于让内核的配置文件承载我们的密钥。
   */
  readonly gatewayToken: string;
  /**
   * hook 写审计记录的 JSONL（10 §6）。
   *
   * 中间隔一个文件而不是让 hook 直接写库 —— 理由在 `audit-ingest.ts` 的头注释里，
   * 一句话是：hook 是内核起的短命子进程，与常驻的桌面进程抢 sqlite 写锁只会
   * 让审计被静默吞掉，而那正是审计最不该发生的失败方式。
   */
  readonly auditLog: string;
  /**
   * 内核的家目录（`~/.evowork/kernel/`）。
   *
   * 宿主只知道"内核的家在这儿"，**不知道那个环境变量叫什么** ——
   * 那是适配层的知识（见 `createSpawnLauncher` 的头注释：这条边界是被 lint 规则纠正出来的）。
   */
  readonly kernelHome: string;
}

export function resolvePaths(root = join(homedir(), '.evowork')): EvoworkPaths {
  return {
    home: root,
    db: join(root, 'evowork.db'),
    config: join(root, 'config.toml'),
    requirements: join(root, 'requirements.toml'),
    modes: join(root, 'modes'),
    scenarios: join(root, 'scenarios'),
    logs: join(root, 'logs'),
    gatewayToken: join(root, 'gateway-token'),
    auditLog: join(root, 'audit.jsonl'),
    kernelHome: join(root, 'kernel'),
  };
}

/**
 * 建目录。**必须在开库与起内核之前**。
 *
 * 在此之前仓库里没有任何一处创建 `~/.evowork` —— 开发时它一直存在（是人手工建的），
 * 所以这条只在**干净机器上第一次运行**时表现出来，而那恰恰是用户走的那条路径。
 *
 * 两个依赖它的地方，失败方式都不指向原因：
 *
 *   · sqlite 库在 `~/.evowork/evowork.db`，父目录不存在时 `openStore` 直接抛；
 *   · **内核要求它的家目录已存在，它不会自己建** —— 2026-09-06 在 macOS 上对
 *     release 二进制实测：目录不存在时它往 stderr 打一行然后以退出码 1 结束。
 *     而我们默认丢弃内核 stderr（launcher.ts 里写了为什么），所以现象是
 *     "内核起不来，且什么都没说"。（那个环境变量叫什么是适配层的知识，
 *     这个文件里连提都不该提 —— service-host.test.ts 有一条测试在扫它。）
 *
 * `modes` / `scenarios` 不在这里建：它们是随产品分发的**内容**目录，
 * 读取方用 `existsSync` 兜底，凭空建一个空目录反而会掩盖"内容没装上"。
 */
export function ensurePaths(paths: EvoworkPaths): void {
  for (const dir of [paths.home, paths.logs, paths.kernelHome]) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * 首次运行时把随包的配置模板装进**内核的**家目录。
 *
 * ## 为什么这一步不能省
 *
 * `config/config.toml.template` 里的 `[permissions.*]` 四个命名 profile 是
 * `thread/start` 的 `permissions` 参数唯一的解析依据（10 §2.2 / F5）。
 * 没有它，内核对**每一次**新建任务都回
 * `failed to load configuration: default_permissions requires a \`[permissions]\` table` ——
 * 而在 UI 上，那就是"回车之后什么都没发生"。
 *
 * ## 装到哪
 *
 * `paths.kernelHome/config.toml`，即 `~/.evowork/kernel/config.toml` —— 内核只读**它自己的
 * 家目录**下的配置。模板文件的头注释原先写的是 `~/.evowork/config.toml`，那是错的，已订正。
 * （宿主只知道"内核的家在这儿"，不知道那个环境变量叫什么 —— 那是适配层的知识，
 * 见 `EvoworkPaths.kernelHome`；service-host.test.ts 有一条测试在扫这件事。）
 *
 * **已存在就不覆盖**：企业会改这个文件（私有网关地址、锁死的权限档位），
 * 每次启动盖回去等于把他们的部署改回默认值。
 */
export function ensureKernelConfig(paths: EvoworkPaths, templatePath: string): boolean {
  const target = join(paths.kernelHome, 'config.toml');
  if (existsSync(target) || !existsSync(templatePath)) return false;
  copyFileSync(templatePath, target);
  return true;
}

/**
 * 网关访问令牌 → 内核进程的环境。
 *
 * ## 为什么必须由宿主显式传
 *
 * `config.toml` 里写的是 `env_key = "EVOWORK_GATEWAY_TOKEN"` —— 内核从**它自己的进程环境**
 * 里取这个值。而从访达双击启动的应用**不继承任何 shell 环境变量**，
 * 所以在正常安装的应用里那个变量永远是空的，内核对**每一次回合**回
 * `Missing environment variable: \`EVOWORK_GATEWAY_TOKEN\`` ——
 * 在界面上就是"发了一句话，任务失败了"。2026-09-06 用户第一次真发消息时撞上的就是这条。
 *
 * ## 两个来源，顺序是刻意的
 *
 *   ① `process.env` —— 开发时从终端起、以及企业用 launchd/服务管理器注入的场景；
 *   ② `~/.evowork/gateway-token` —— GUI 启动唯一能用的路径。
 *
 * ## 这是**过渡方案**，不是终态
 *
 * 明文文件不满足"密钥不落盘"的本意。终态有两条候选（都还没决策）：
 * Electron `safeStorage` 存进系统钥匙串 + 设置页录入，或由 identity 服务签发短期令牌
 * （Q14 的原设计，但 identity 尚未开始）。**在做出决策前不要把这个文件当成正式机制**。
 */
export function readGatewayToken(
  paths: EvoworkPaths,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromEnv = env.EVOWORK_GATEWAY_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(paths.gatewayToken)) return undefined;
  const fromFile = readFileSync(paths.gatewayToken, 'utf8').split('\n')[0]?.trim();
  return fromFile ? fromFile : undefined;
}

/**
 * 首次运行时把随包的**模式指令**装进 `~/.evowork/modes/`。
 *
 * ## 少了它会发生什么（K5 的实际破口）
 *
 * `config/modes/*.md` 的第一句就是「你是 EvoWork 的执行智能体」。它们没被安装时
 * `readInstructions` 返回 undefined → `developer_instructions` 为空 →
 * **内核自带的身份原样漏出来**：用户问"介绍一下你自己"，得到的回答是
 * 「我是运行在 Codex CLI 里的一个编码代理」。2026-09-06 实测到。
 *
 * 这不是文案问题：K5 要求产品对外不出现那个品牌，而这条路径上没有任何东西会报错 ——
 * 空指令是完全合法的，只是产品变成了另一个产品。
 *
 * 逐个文件比对：企业可能只覆盖其中一份（比如 `ask.md`），整目录判断会让
 * 新增的模式文件永远装不进去。**已存在的不覆盖。**
 */
export function ensureModeInstructions(paths: EvoworkPaths, configDir: string): number {
  const from = join(configDir, 'modes');
  if (!existsSync(from)) return 0;
  mkdirSync(paths.modes, { recursive: true });
  let installed = 0;
  for (const name of readdirSync(from)) {
    if (!name.endsWith('.md')) continue;
    const target = join(paths.modes, name);
    if (existsSync(target)) continue;
    copyFileSync(join(from, name), target);
    installed += 1;
  }
  return installed;
}

export interface ServiceHostOptions {
  readonly paths: EvoworkPaths;
  /** app-server 可执行文件路径。M9 打包时随内核二进制一起分发 */
  readonly appServerPath: string;
  /**
   * 网关单文件产物（`dist/gateway/main.js`）。
   *
   * **只在 `base_url` 指向本机时才会被用到**（拓扑 A）。企业把网关部署在服务器上时
   * 这个路径存在但永远不执行 —— 判据在 `gateway-process.ts`，不在这里。
   */
  readonly gatewayEntryPath?: string | undefined;
  readonly appVersion: string;
  readonly logger?: Logger;
  /** 把 UI 事件推给渲染进程（Electron 里是 `webContents.send`） */
  readonly emitToRenderer: (channel: string, payload: unknown) => void;
  /**
   * 随包分发的 `config/` 目录（打包后在 `process.resourcesPath/config`）。
   * 给了才会在首次运行时装配置模板 —— 见 `ensureKernelConfig`。
   */
  readonly configDir?: string;
  /** 注入进程环境，便于测试 */
  readonly env?: NodeJS.ProcessEnv;
  /** 注入 spawn，便于测试（见文件头：宿主的接线逻辑必须能被测） */
  readonly spawnFn?: typeof spawn;
  /**
   * 打开系统的目录选择框（首运行第②步）。
   *
   * 由 `bootstrap` 从 electron 注入 —— 这个文件不 import electron，
   * 否则"选工作空间会发生什么"就只能靠真跑一次来验。
   * **没有它时首运行走不完**：`blockingReason` 要求至少一个工作空间，
   * 而干净机器上内核一个 project 都没有。
   */
  readonly pickDirectory?: () => Promise<string | undefined>;
}

export interface ServiceHost {
  readonly store: Store;
  readonly adapter: Adapter;
  readonly logger: Logger;
  /** 五个本机服务之间的接线（scheduler / 产物索引 / 解析运行时探测） */
  readonly services: LocalServices;
  /**
   * 渲染进程能调用的动作（`RENDERER_ACTIONS`）。**它们在这里实现、由 `bootstrap` 挂到 ipcMain 上** ——
   * 挂载与实现分开，是为了让"发一条需求会发生什么"能不起 Electron 就跑完。
   */
  readonly actions: RendererActions;
  /** 用户对某条审批的决定（F14：服务端发起的请求必须有人回复） */
  resolveApproval(id: string, reply: ApprovalReply): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 对账定时器（09 §4.1：启动时 + 每 10 分钟一次） */
  readonly reconcileIntervalMs: number;
}

/** IPC 频道名。渲染进程只认这几个，不认协议方法名（K2）。 */
export const IPC = {
  uiEvent: 'evowork:ui-event',
  notice: 'evowork:notice',
  degrade: 'evowork:degrade',
  pendingApprovals: 'evowork:pending-approvals',
  askApproval: 'evowork:ask-approval',
  /** 办公扩展安装进度（08 §4）。与 `preload` 的 `RENDERER_CHANNELS` 一一对应 */
  runtimeProgress: 'evowork:runtime-progress',
} as const;

const RECONCILE_INTERVAL_MS = 10 * 60_000;

/**
 * 启动本机服务宿主。
 *
 * 顺序是刻意的：**先建目录、再开库、最后起内核**。库开不了（权威表迁移失败）时要中止启动
 * （09 §4.6：宁可启动失败也不丢定时任务定义），此时不该已经起了一个内核进程在那儿等着。
 */
export function createServiceHost(options: ServiceHostOptions): ServiceHost {
  const logger =
    options.logger ??
    createLogger({
      service: 'desktop',
      // 生产用 drop：日志不该让业务失败
      onViolation: 'drop',
      sink: jsonLinesSink((line) => process.stdout.write(`${line}\n`)),
      base: { appVersion: options.appVersion, platform: process.platform },
    });

  // ⓪ 先建目录 —— 开库与起内核都要求它们已经存在（见 ensurePaths 的注释）
  ensurePaths(options.paths);
  if (options.configDir !== undefined) {
    const installed = ensureKernelConfig(
      options.paths,
      join(options.configDir, 'config.toml.template'),
    );
    if (installed) logger.info('desktop.kernel_config.installed', {});
    const modes = ensureModeInstructions(options.paths, options.configDir);
    if (modes > 0) logger.info('desktop.mode_instructions.installed', { itemCount: modes });
  }

  // ① 再开库。migrateAuthoritative 失败会抛错，启动就此中止（这是设计要求）
  const store = openStore({ path: options.paths.db, logger });

  const gatewayToken = readGatewayToken(options.paths, options.env);

  const readInstructions = (file: string): string | undefined => {
    // `config/modes/*.md` 随产品分发（取代原 P3 补丁，F1）
    const path = join(options.paths.home, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };

  /*
   * 挂起中的审批：内核发起请求 → 推给渲染层 → 用户点了按钮 → `decideApproval` 回到这里。
   *
   * key 用**审批自己的 id**（适配层生成的 `apv_N`），而不是宿主再编一个 ——
   * 渲染层从 `pending-approvals` 看到的就是这个 id，两边编两套 id 的话，
   * 用户点的那一条永远对不上挂起的那一条。
   */
  const approvalReplies = new Map<string, (reply: ApprovalReply) => void>();

  const translate = createEventTranslator(store, () => Date.now());

  const adapter = createAdapter({
    store,
    logger,
    readInstructions,
    sessionOptions: {
      clientInfo: { name: 'evowork-desktop', version: options.appVersion },
      logger,
      // 具体怎么起内核（可执行文件、环境变量、stdio 帧）全在适配层里 ——
      // 宿主只传路径。下一个需要起内核的地方（EvoWork CLI，Q13）复用同一个 launcher
      launcher: createSpawnLauncher({
        appServerPath: options.appServerPath,
        kernelHome: options.paths.kernelHome,
        /*
         * 内核的进程环境。hook 是**内核起的子进程**，环境从这里继承 ——
         * 所以 `EVOWORK_AUDIT_LOG` 必须在这一层给，而不是给我们自己的进程。
         * 在此之前没有任何地方设置它，于是 hook 每次都跳过审计写入，
         * `audit_log` 表一条记录都没有（10 §6 的"用户可见"从没成立过）。
         *
         * 令牌走进程环境（config.toml 的 env_key），**不落进内核的配置文件**。
         */
        extraEnv: {
          EVOWORK_AUDIT_LOG: options.paths.auditLog,
          ...(gatewayToken ? { EVOWORK_GATEWAY_TOKEN: gatewayToken } : {}),
        },
        ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
      }),
    },
    // 适配层的事件是**任务视角**，渲染层要的是**组件视角**，翻译在 renderer-bridge 里
    onUiEvent: (event) => {
      for (const mapped of translate(event)) options.emitToRenderer(IPC.uiEvent, mapped);
    },
    onNotice: (notice: SessionNotice) => options.emitToRenderer(IPC.notice, notice),
    // 降级一律显式（09 §3.3）：推给 UI，让它在设置里列出"当前不可用的能力"
    onDegrade: (report) => options.emitToRenderer(IPC.degrade, report),
    onPendingApprovalsChanged: (pending: readonly PendingApproval[]) =>
      options.emitToRenderer(
        IPC.pendingApprovals,
        pending.map((a) => toApprovalView(a, adapter.allowsAcceptForSession(a), Date.now())),
      ),
    // 审批最终落在用户身上（F14）。渲染进程不回复时这个 Promise 就一直悬着 ——
    // 那是正确的：交互式任务**不自动拒绝**（10 §3.6），超时策略在适配层里
    askApproval: (approval) =>
      new Promise((resolve) => {
        approvalReplies.set(approval.id, resolve);
        options.emitToRenderer(
          IPC.askApproval,
          toApprovalView(approval, adapter.allowsAcceptForSession(approval), Date.now()),
        );
      }),
    onSideEffect: (effect) => {
      // 副作用的落点：通知中心、并发计数、预算闸门、产物识别、automation_run。
      logger.debug('desktop.side_effect', { reason: effect.kind.toUpperCase().replace(/-/g, '_') });
      routeSideEffect(effect);
    },
  });

  /**
   * 事件流的副作用 → 本机服务。
   *
   * 适配层刻意把副作用做成**数据**（`SideEffect[]`）而不是回调，这样"先落库、再推 UI、
   * 最后做副作用"的顺序是结构性的（09 §3.4）。这里是那些副作用真正被执行的地方。
   */
  function routeSideEffect(effect: {
    readonly kind: string;
    readonly threadId?: string;
    readonly status?: string;
    readonly item?: unknown;
  }): void {
    if (effect.kind === 'automation-run-finished' && effect.threadId) {
      // 定时任务的回合结束了 → 失败分类 → 连败计数 → 可能自动暂停（Q8 / 07 §8-2）
      services.onTurnFinished({
        threadId: effect.threadId,
        ok: effect.status === 'completed',
      });
      return;
    }
    if (effect.kind === 'artifact-scan' && effect.threadId) {
      // 信号 ②：`FileChange` item。真正的识别在 watcher 里，这里只保证那个目录被盯着
      const cwd = store.threads.get(effect.threadId)?.cwd;
      if (cwd) services.watchWorkspace(cwd, effect.threadId);
    }
  }

  const services = createLocalServices({
    store,
    adapter,
    notify: (text) => options.emitToRenderer(IPC.notice, { kind: 'automation', text }),
    // 安装进度单独一个频道：它要在同一个位置连续更新几分钟，
    // 走 notice 的话界面上会堆出几十条"正在下载 3%…4%…"
    onRuntimeProgress: (progress) => options.emitToRenderer(IPC.runtimeProgress, progress),
    logger,
  });

  let reconcileTimer: ReturnType<typeof setInterval> | undefined;
  /** 本机网关子进程（拓扑 A）。网关在服务器上时它一直是 undefined */
  let gateway: GatewayProcess | undefined;

  const resolveApproval = (id: string, reply: ApprovalReply): void => {
    const pending = approvalReplies.get(id);
    if (!pending) {
      // 已经超时自动处理过了。**记一条**：静默丢弃会让"我明明点了允许"变成无从查起
      logger.warn('desktop.approval.stale_decision', { reason: 'ALREADY_RESOLVED' });
      return;
    }
    approvalReplies.delete(id);
    pending(reply);
  };

  /*
   * 模型下拉的数据源（03 §4.5）。
   *
   * 地址取自**内核自己的 `config.toml`** —— 这个文件就是它的写入方（`ensureKernelConfig`）。
   * 另起一个 EvoWork 侧的地址配置会漂：企业改成私有网关时只会改 config.toml，
   * 于是内核打私有网关、下拉打默认网关，而两处配置各自都是对的
   * （表现是"下拉里的模型发过去说不存在"）。
   *
   * 令牌与内核用的是**同一个** `gatewayToken`：网关对两个端点用同一套鉴权，
   * 各读各的只会让"内核能用、下拉 401"这种半可用状态成为可能。
   */
  const gatewayBaseUrl = readGatewayBaseUrl(options.paths.kernelHome, options.env);

  /*
   * 三个目录式页面的数据源。
   *
   * **复用 `services` 已经建好的那两个 repo**，不再建一套：同一张表两个入口
   * 是"两个模块各自对、合起来不对"最常见的起点（CLAUDE.md §9.1，这个项目里发生过四次）。
   * 审计的 repo 是新的 —— 那张表此前没有任何读写方。
   */
  const auditRepo = createAuditRepo(store.db);
  ensureAuditLog(options.paths.auditLog);

  /** 搬一次 hook 写的审计记录。**读之前先搬**，否则页面永远慢一拍 */
  const ingestAudit = (): void => {
    ingestAuditLog({
      path: options.paths.auditLog,
      insert: (records) => auditRepo.insertMany(records),
      logger,
    });
  };

  const actions = createRendererActions({
    adapter,
    store,
    logger,
    resolveApproval,
    /*
     * 选工作空间。**没注入选择器时返回 undefined**，由渲染层显示"选不了"，
     * 而不是抛一个"没有 handler"——后者在界面上就是点了没反应。
     */
    ...(options.pickDirectory ? { pickDirectory: options.pickDirectory } : {}),
    // 办公扩展的探测与安装（08 §4）。本机服务里已经有一份带缓存的探针，
    // 安装成功后由它自己 invalidate —— 这里只是把入口交给渲染层
    officeRuntime: services.officeRuntime,
    pageData: {
      listArtifacts: () => services.artifacts.listAllPresent(),
      listAutomations: () =>
        services.automations.listAll(store.deviceId) as unknown as readonly Record<
          string,
          unknown
        >[],
      listRuns: (automationId) => services.automations.listRuns(automationId),
      listAudit: () => {
        ingestAudit();
        return auditRepo.list() as unknown as readonly Record<string, unknown>[];
      },
      auditOldestAt: () => auditRepo.oldestAt(),
      deviceId: store.deviceId,
      deviceName: hostname(),
    },
    appName: BRAND.appName,
    appVersion: options.appVersion,
    userName: userInfo().username,
    cases: BUILTIN_CASES,
    readModelCatalog: () =>
      fetchModelCatalog({
        baseUrl: gatewayBaseUrl,
        ...(gatewayToken ? { token: gatewayToken } : {}),
      }),
  });

  return {
    store,
    adapter,
    logger,
    services,
    actions,
    resolveApproval,
    reconcileIntervalMs: RECONCILE_INTERVAL_MS,

    async start() {
      /*
       * 网关**在内核之前起**：内核握手之后随时可能发第一个请求，
       * 而网关起来要几百毫秒。反过来的话第一次发消息有概率打在还没监听的端口上，
       * 表现是一次莫名其妙的 ECONNREFUSED，重试一下又好了 —— 最难查的那种。
       *
       * 网关在别处（拓扑 B）时这里什么都不做，见 `startLocalGateway`。
       */
      if (options.gatewayEntryPath) {
        gateway = startLocalGateway({
          baseUrl: gatewayBaseUrl,
          entryPath: options.gatewayEntryPath,
          ...(gatewayToken ? { token: gatewayToken } : {}),
          ...(options.env ? { env: options.env } : {}),
          ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
          logger,
        });
        // `REMOTE` 没有 notice：网关在服务器上是正常部署，不该提示任何东西
        if (!gateway.result.started && gateway.result.reason !== 'REMOTE') {
          options.emitToRenderer(IPC.notice, { kind: 'model', text: gateway.result.notice });
        }
      }

      const catalog = await adapter.start();
      logger.info('desktop.host.started', {
        itemCount: catalog.permissionProfiles.length,
        concurrency: catalog.scenarios.length,
      });

      /*
       * 03 §8：模型不可用要**在发送之前**就说，而不是等用户发了一句话、
       * 任务标成"失败"才知道。这里只判"有没有令牌" —— 网关通不通要发请求才知道，
       * 那条由回合失败的原因负责（`turn-failed`）。
       */
      if (!gatewayToken) {
        logger.warn('desktop.gateway_token.missing', { reason: 'NO_GATEWAY_TOKEN' });
        options.emitToRenderer(IPC.notice, {
          kind: 'model',
          text:
            '还没有配置模型网关的访问令牌，任务发出去会失败。' +
            '把令牌写进 ~/.evowork/gateway-token（一行），或用 EVOWORK_GATEWAY_TOKEN 启动。',
        });
      }

      // 09 §4.1 的一致性校正：启动时一次 + 每 10 分钟一次
      await adapter.reconcile().catch((err: unknown) => {
        // 对账失败不该阻塞启动：投影表可以晚一点补齐（它是投影类，真源在内核）
        logger.warn('desktop.reconcile.failed', {
          errorClass: err instanceof Error ? err.name : 'UnknownError',
        });
      });
      reconcileTimer = setInterval(() => {
        void adapter.reconcile().catch(() => undefined);
        /*
         * 顺带搬一次审计。
         *
         * 只在打开审计页时搬的话，从没打开过那一页的用户会攒一个越来越大的
         * JSONL —— 而它是**未压缩的明文**（虽然不含正文）。跟着对账的节奏走，
         * 不新开一个定时器：两者都是"把本机状态收拢一次"。
         */
        ingestAudit();
      }, RECONCILE_INTERVAL_MS);

      /*
       * 定时调度最后启动，且**不阻塞 start()**。
       *
       * 它启动时会做一次 misfire 扫描并可能立刻补跑几个任务（D5）——
       * 那件事可能很慢（要起 thread、调模型），而用户此刻正等着窗口出来。
       * 补跑失败也不该让应用起不来：那是任务的问题，不是应用的问题。
       */
      void services.startScheduler().catch((err: unknown) => {
        logger.warn('desktop.scheduler.start_failed', {
          errorClass: err instanceof Error ? err.name : 'UnknownError',
        });
      });
    },

    async stop() {
      if (reconcileTimer) clearInterval(reconcileTimer);
      // 网关先停：它没有状态也不写盘，留着只会占住端口，下次启动起不来
      gateway?.stop();
      gateway = undefined;
      services.stop();
      await adapter.stop();
      store.close();
      logger.info('desktop.host.stopped', {});
    },
  };
}
