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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { cpus, homedir, hostname, totalmem, userInfo } from 'node:os';
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
/*
 * 并发上限的公式与"只能往下调"的规则**从 `@evowork/policy` 来**（10 §5.1），
 * 不在这里另写一份：设置页显示的数与闸门实际用的数必须是同一个，
 * 否则用户会看到"上限 3"而第 2 个任务就开始排队。
 */
import { applyUserPreference, computeConcurrencyLimit } from '@evowork/policy';
import { BRAND } from '@evowork/tokens';
import { createAuditRepo, openStore, readMeta, writeMeta, type Store } from '@evowork/store';

import type {
  CustomModelInput,
  ModelAccessMutationResult,
  ModelAccessView,
  ModelCatalogResult,
  ModelProbeResult,
  PolicyPackStatusView,
  PreferencesInput,
  PreferencesView,
  SaveProviderKeyInput,
} from '../shared/ipc.js';
import { createAccountSession, originsFromEnv } from './account.js';
import { ensureAuditLog, ingestAuditLog } from './audit-ingest.js';
import { isLocalGateway, startLocalGateway, type GatewayProcess } from './gateway-process.js';
import { createModelAccess, probeModel, type ModelAccess } from './model-access.js';
import { EMPTY_POLICY_VIEW, syncEnterprisePolicy, type PolicyPackView } from './policy-pack.js';
import { NO_KEYRING_NOTICE, type SafeStorageLike } from './secret-store.js';
import { createLocalServices, type LocalServices } from './local-services.js';
import {
  DEFAULT_GATEWAY_BASE_URL,
  fetchModelCatalog,
  parseGatewayBaseUrl,
  readGatewayBaseUrl,
  rewriteEvoworkBaseUrl,
  waitUntilGatewayReady,
} from './model-catalog.js';
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
   * 网关访问令牌的**旧**明文文件。
   *
   * M10a 之后令牌也进密钥库（`model-access.ts` 的 `token()`）；这个路径只用于
   * 一次性迁移与"钥匙串不可用"那条回退路径。单独一个文件而不是写进 `config.toml`
   * 的理由仍然成立：那个文件是**内核的**配置，混进去等于让它承载我们的凭据。
   */
  readonly gatewayToken: string;
  /**
   * 厂商密钥的**旧**明文文件（`gateway-env.ts`）。
   *
   * M10a 之后它只被读一次：启动时导入密钥库，然后改名成 `gateway.env.migrated`
   * （见 `migratePlaintextSecrets`）。新装机器上它根本不存在。
   */
  readonly gatewayEnv: string;
  /** 密钥库（密文，`safeStorage`）。Q34=A 的落点 */
  readonly secrets: string;
  /** 明文兜底文件。**只在用户显式选择时才会被创建**（11 §4.3） */
  readonly secretsPlain: string;
  /** EvoWork 自己的配置（`mode` = 默认模型的上游在哪，D11）。**不是内核的 config.toml** */
  readonly appConfig: string;
  /** 自定义模型的元数据（第③层）。**里面没有密钥** */
  readonly modelsFile: string;
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
    gatewayEnv: join(root, 'gateway.env'),
    secrets: join(root, 'secrets.bin'),
    secretsPlain: join(root, 'secrets.plain.json'),
    appConfig: join(root, 'app.toml'),
    modelsFile: join(root, 'models.toml'),
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
 * 首次运行时把随包的**模式指令**装进 `~/.evowork/modes/`。
 *
 * ## 少了它会发生什么（K5 的实际破口）
 *
 * `config/modes/*.md` 描述的是 **Craft / Plan / Ask 怎么干活**，不是产品名。
 * 它们没被安装时 `developer_instructions` 为空 —— Craft 约束（先产物再解释、
 * 办公技能不要自己拼）不会进上下文。产品身份是另一层：`thread/start.baseInstructions`
 * （F25，见 `readBaseInstructions`）。2026-09-06 把两层当成一层修过，
 * 2026-09-07 证实只叠加 developer 指令盖不住系统底稿里的 Codex CLI。
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

/**
 * 读随包的产品身份底稿（`config/prompts/base-instructions.md`）。
 *
 * 这是内核 `default.md` 的 fork，只改了身份段。每次 `thread/start` 经
 * `baseInstructions` 整段替换系统底稿（F25）。相对路径的 `model_instructions_file`
 * 是按 **cwd** 解析的，不能写进 `config.toml` 模板 —— 用户换工作空间就会找不到文件。
 *
 * 从随包目录读而不是装进 `~/.evowork/`：这份文件是产品身份，升级必须立刻生效；
 * 已存在不覆盖会让旧安装永远停在 Codex CLI（F21/F23 那套对企业配置是对的，对品牌不对）。
 */
export function readBaseInstructions(configDir: string | undefined): string | undefined {
  if (configDir === undefined) return undefined;
  const path = join(configDir, 'prompts', 'base-instructions.md');
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8').trim();
  return text.length > 0 ? text : undefined;
}

export interface ServiceHostOptions {
  readonly paths: EvoworkPaths;
  /** app-server 可执行文件路径。M9 打包时随内核二进制一起分发 */
  readonly appServerPath: string;
  /**
   * 网关单文件产物（`dist/gateway/main.js`）。
   *
   * **只在 `app.toml` 的 `mode = "local"` 时才会被用到**（拓扑 A）。企业把网关部署在
   * 服务器上时这个路径存在但永远不执行 —— 判据是那个 mode（D11），由宿主算出来
   * 传给 `startLocalGateway`，不在这个文件里从 URL 反推。
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
   * Electron 的 `safeStorage`（Q34=A）。由 `bootstrap` 注入 —— 这个文件不 import electron。
   *
   * **没给时密钥库不可用**：`set()` 拒绝写入，设置页显示 11 §4.3 的那两个选项。
   * 这正是"钥匙串不可用"那条路径能被测到的方式（否则要一台没有 keyring 的 Linux）。
   */
  readonly safeStorage?: SafeStorageLike | undefined;
  /**
   * 打开系统的目录选择框（首运行第②步）。
   *
   * 由 `bootstrap` 从 electron 注入 —— 这个文件不 import electron，
   * 否则"选工作空间会发生什么"就只能靠真跑一次来验。
   * **没有它时首运行走不完**：`blockingReason` 要求至少一个工作空间，
   * 而干净机器上内核一个 project 都没有。
   */
  readonly pickDirectory?: () => Promise<string | undefined>;
  /** 在访达 / 资源管理器里打开一个目录。由 M9 入口注入 `shell.openPath` */
  readonly openPath?: ((path: string) => Promise<void>) | undefined;
  /** 系统浏览器（Q33=A 的 PKCE 登录）。没给时登录动作会如实失败 */
  readonly openExternal?: ((url: string) => Promise<void>) | undefined;
  /**
   * 本机网关 listen 最多等多久。测试里假 spawn 不会真的听端口，传 0 跳过。
   * 不传 = 8 秒（见 `waitUntilGatewayReady`）。
   */
  readonly gatewayReadyTimeoutMs?: number | undefined;
  /** 注入以便测试网关就绪探测，不必真起一个 HTTP 服务 */
  readonly fetchFn?: typeof fetch | undefined;
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

  /*
   * 本机网关的密钥、令牌、拓扑与自定义模型 —— 全部收在 `model-access.ts` 里（M10a）。
   *
   * 必须在起内核之前备齐：内核从自己的进程环境读令牌，而从访达启动时 shell 环境是空的。
   * 这一段此前是"读明文文件 + 按 URL 反推拓扑 + 没令牌就签一个"三件事挤在一起；
   * 现在顺序是显式的：拓扑（`app.toml`）→ 密钥库（含两个明文文件的一次性迁移）
   * → 子进程环境（密钥解密后只进环境，不落盘）。
   */
  const baseEnv = options.env ?? process.env;
  const kernelBaseUrl = readGatewayBaseUrl(options.paths.kernelHome, baseEnv);
  const modelAccess: ModelAccess = createModelAccess({
    paths: {
      home: options.paths.home,
      kernelHome: options.paths.kernelHome,
      secrets: options.paths.secrets,
      secretsPlain: options.paths.secretsPlain,
      appConfig: options.paths.appConfig,
      modelsFile: options.paths.modelsFile,
      gatewayEnv: options.paths.gatewayEnv,
      gatewayToken: options.paths.gatewayToken,
      requirements: options.paths.requirements,
    },
    ...(options.safeStorage ? { safeStorage: options.safeStorage } : {}),
    logger,
    baseEnv,
    kernelBaseUrl,
    readFlag: (key) => readMeta(store.db, key),
    writeFlag: (key, value) => writeMeta(store.db, key, value),
  });
  if (modelAccess.inferredMode) {
    /*
     * 老装机：`app.toml` 不存在而内核的 base_url 指向别处，于是反推了一次（D11）。
     * **必须记一条** —— 一次静默的拓扑推断在排查 401 时是完全看不见的。
     */
    logger.info('desktop.app_config.inferred', {
      authMode: modelAccess.mode,
      reason: 'LEGACY_URL',
    });
  }
  /*
   * 反推完成后再把内核 base_url 改回 loopback。顺序不能反：远端 URL 是
   * `upstream_base_url` 的输入，先改掉就丢了。
   */
  const kernelConfigPath = join(options.paths.kernelHome, 'config.toml');
  if (existsSync(kernelConfigPath) && !(baseEnv.EVOWORK_GATEWAY_URL ?? '').trim()) {
    const text = readFileSync(kernelConfigPath, 'utf8');
    const current = parseGatewayBaseUrl(text);
    if (current && !isLocalGateway(current)) {
      const rewritten = rewriteEvoworkBaseUrl(text, DEFAULT_GATEWAY_BASE_URL);
      if (rewritten.changed) {
        try {
          writeFileSync(kernelConfigPath, rewritten.text, 'utf8');
          logger.info('desktop.kernel_config.loopback', { reason: 'D11' });
        } catch {
          /* 写不进不阻塞启动 */
        }
      }
    }
  }
  logger.info('desktop.model_access.ready', {
    authMode: modelAccess.mode,
    secretStore: modelAccess.secretBackend,
  });
  const fromKernel = readGatewayBaseUrl(options.paths.kernelHome, baseEnv);
  const gatewayBaseUrl = isLocalGateway(fromKernel) ? fromKernel : DEFAULT_GATEWAY_BASE_URL;
  const account = createAccountSession({
    ...originsFromEnv(baseEnv),
    vault: modelAccess.accountVault,
    readFlag: (key) => readMeta(store.db, key),
    writeFlag: (key, value) => writeMeta(store.db, key, value),
    openExternal: options.openExternal ?? (async () => undefined),
    logger,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  });
  const composeGatewayEnv = (): NodeJS.ProcessEnv => ({
    ...modelAccess.env(),
    ...account.gatewayInject(),
  });
  let gatewayRuntimeEnv = composeGatewayEnv();
  let gatewayToken = modelAccess.token();
  let policyView: PolicyPackView = EMPTY_POLICY_VIEW;

  function policyStatus(): PolicyPackStatusView {
    return {
      status: policyView.status,
      ...(policyView.expiresAt !== undefined ? { expiresAt: policyView.expiresAt } : {}),
      ...(policyView.message !== undefined ? { message: policyView.message } : {}),
      disableShare: policyView.disableShare,
      disableSlots: policyView.disableSlots,
      disabledProfiles: [...policyView.disabledProfiles],
    };
  }

  async function refreshPolicy(): Promise<void> {
    policyView = await syncEnterprisePolicy({
      home: options.paths.home,
      requirementsPath: options.paths.requirements,
      ...(account.origins.identityOrigin ? { identityOrigin: account.origins.identityOrigin } : {}),
      ...(account.accessToken() ? { accessJwt: account.accessToken() } : {}),
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      ...(options.logger ? { logger } : {}),
    });
  }

  const accessView = (catalog: ModelCatalogResult): ModelAccessView => ({
    ...modelAccess.view(catalog),
    ...account.decorate(),
    policyPack: policyStatus(),
  });

  const readInstructions = (file: string): string | undefined => {
    // `config/modes/*.md` 随产品分发（取代原 P3 补丁，F1）
    const path = join(options.paths.home, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };

  const baseInstructions = readBaseInstructions(options.configDir);

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
    ...(baseInstructions ? { baseInstructions } : {}),
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

  const catalogFetchOptions = () => ({
    baseUrl: gatewayBaseUrl,
    ...(gatewayToken ? { token: gatewayToken } : {}),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  });

  /**
   * 网关没起时**不要再 fetch 一次**。
   *
   * NO_KEYS 时 8787 上没人听，fetch 的 catch 会把原因改写成「连不上模型网关」。
   * 用户下一步该填密钥，不是去查网关进程 —— 两个模块各自都对，合起来把归因弄反了。
   */
  const readModelCatalog = async (): Promise<ModelCatalogResult> => {
    if (gateway && !gateway.result.started && gateway.result.reason !== 'REMOTE') {
      const reason =
        gateway.result.reason === 'NO_KEYS'
          ? ('no-keys' as const)
          : gateway.result.reason === 'NO_ENTRY'
            ? ('broken-install' as const)
            : ('unreachable' as const);
      return { models: [], unavailable: gateway.result.notice, reason };
    }
    return fetchModelCatalog(catalogFetchOptions());
  };

  const launchLocalGateway = (): void => {
    if (!options.gatewayEntryPath) return;
    gateway = startLocalGateway({
      baseUrl: gatewayBaseUrl,
      // D11：本机网关常驻。`runsLocalGateway` 恒为 true。
      runsLocally: modelAccess.runsLocalGateway,
      entryPath: options.gatewayEntryPath,
      ...(gatewayToken ? { token: gatewayToken } : {}),
      env: gatewayRuntimeEnv,
      ...(options.spawnFn ? { spawnFn: options.spawnFn } : {}),
      logger,
    });
  };

  const awaitGatewayReady = async (): Promise<boolean> => {
    const budget = options.gatewayReadyTimeoutMs ?? 8_000;
    if (!gateway?.result.started || budget <= 0) return true;
    return waitUntilGatewayReady({
      ...catalogFetchOptions(),
      readyTimeoutMs: budget,
    });
  };

  /**
   * 改完密钥 / 自定义模型之后重起网关，并把新的目录拉回来。
   *
   * **必须重起，不能只重拉目录**：模型表在网关进程的内存里（`main.ts` 启动时
   * 从进程环境算一次）。2026-09-06 为此付过一次代价：模型目录改了、代码与 dmg 都是新的，
   * 而界面上还是旧列表 —— 因为那个进程是几小时前起的。
   *
   * 重起之前**重新算一遍环境**：密钥刚从库里解密出来，自定义模型刚写进文件。
   */
  const restartGateway = async (): Promise<ModelCatalogResult> => {
    gatewayRuntimeEnv = composeGatewayEnv();
    gatewayToken = modelAccess.token();
    gateway?.stop();
    gateway = undefined;
    launchLocalGateway();
    const ready = await awaitGatewayReady();
    if (!ready) {
      return {
        models: [],
        reason: 'unreachable' as const,
        unavailable: '本机网关启动了但还没开始接受请求。等几秒再点「检查模型接入」。',
      };
    }
    return readModelCatalog();
  };

  /*
   * 设置页「用量与预算」的两个数（阶段 1；托管额度随 M10b）。
   *
   * 落在 `meta` 表而不是一个新文件：它们是**本机偏好**，与 `onboarded` 同一档。
   * 并发上限存的是**用户的意愿值**，生效值每次按当前机器重算 ——
   * 换了机器（或插了外接显示器把内存吃掉）之后，一个存下来的 3 不该继续生效
   * （10 §5.1：机器就是资源上限）。
   */
  const BUDGET_KEY = 'evowork.prefs.task_token_budget';
  const CONCURRENCY_KEY = 'evowork.prefs.concurrency';

  const readPreferences = (): PreferencesView => {
    const computed = computeConcurrencyLimit({
      totalMemoryBytes: totalmem(),
      cpuCount: cpus().length,
    });
    const rawBudget = Number(readMeta(store.db, BUDGET_KEY) ?? '');
    const rawConcurrency = Number(readMeta(store.db, CONCURRENCY_KEY) ?? '');
    return {
      ...(Number.isFinite(rawBudget) && rawBudget > 0 ? { taskTokenBudget: rawBudget } : {}),
      concurrencyComputed: computed,
      concurrencyLimit: applyUserPreference(
        computed,
        Number.isFinite(rawConcurrency) && rawConcurrency > 0 ? rawConcurrency : undefined,
      ),
    };
  };

  const writePreferences = (input: PreferencesInput): PreferencesView => {
    if (input.taskTokenBudget !== undefined) {
      // 0 / 负数 = 不限（用户清空了输入框）。**不报错** —— 那是一个合法的选择
      const value = Math.floor(input.taskTokenBudget);
      writeMeta(store.db, BUDGET_KEY, value > 0 ? String(value) : '');
    }
    if (input.concurrencyLimit !== undefined) {
      writeMeta(store.db, CONCURRENCY_KEY, String(Math.max(1, Math.floor(input.concurrencyLimit))));
    }
    return readPreferences();
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
    /*
     * 「项目」页的 I/O。真正读盘的只有这几行 —— 判定全在 `@evowork/projects` 里，
     * 所以"越界了怎么办"是可单测的，而不是埋在这段 fs 调用中间。
     */
    projectPorts: {
      home: homedir(),
      rootExists: (path) => existsSync(path),
      realpath: async (path) => {
        try {
          return await realpath(path);
        } catch {
          // 解析不了（不存在、断链、没权限）就是不给读 —— 失败一律收紧，不放行
          return undefined;
        }
      },
      isSymlink: async (path) => {
        try {
          return (await lstat(path)).isSymbolicLink();
        } catch (err: unknown) {
          // 不存在就不是软链——`writeAgentsMemo` 首次建文件走的正是这条路，不能拦
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
          // 其它失败（没权限等）与 realpath 同一条纪律：失败一律收紧，当作"是"处理
          return true;
        }
      },
      pickDirectory: async () => options.pickDirectory?.() ?? undefined,
      readDir: async (path) => {
        try {
          const entries = await readdir(path, { withFileTypes: true });
          return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
        } catch {
          // 读不了（没权限、刚被删）就是空的。抛错在树上的表现是节点卡在转圈
          return [];
        }
      },
      openFolder: async (path) => {
        await options.openPath?.(path);
      },
      readTextFile: async (path) => {
        try {
          return await readFile(path, 'utf8');
        } catch {
          return undefined;
        }
      },
      writeTextFile: async (path, content) => {
        await writeFile(path, content, 'utf8');
      },
    },
    pageData: {
      /*
       * C2：不能喂 `listAllPresent()`——那个 feed 只挑 `PRESENT`、按 200 条封顶，
       * 折算产物数（`buildProjectCard`）与「最近的文件动作」都要看到完整版本链，
       * 理由见 `listAllForProjects` 的头注释。
       */
      listArtifacts: () => services.artifacts.listAllForProjects(),
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
    readModelCatalog,
    /*
     * 引导第④步与首页「检查模型接入」共用（三家一起填）。
     *
     * **M10a 之后它写的是密钥库，不再写 `gateway.env`** —— 明文文件那条路已经退役
     * （Q34=A）。密钥库不可用时**不静默写明文**：如实返回那段说明，让用户去设置页
     * 做选择（11 §4.3）。
     */
    applyModelAccess: async (input) => {
      const pairs: readonly { readonly id: string; readonly key: string | undefined }[] = [
        { id: 'deepseek', key: input.deepseekApiKey },
        { id: 'moonshot', key: input.moonshotApiKey },
        { id: 'zhipu', key: input.zhipuApiKey },
      ];
      let saved = 0;
      let rejected = false;
      for (const pair of pairs) {
        if (!pair.key?.trim()) continue;
        if (modelAccess.saveProviderKey({ providerId: pair.id, apiKey: pair.key })) saved += 1;
        else rejected = true;
      }
      if (saved > 0) logger.info('desktop.provider_keys.saved', { itemCount: saved });
      if (rejected && saved === 0) {
        return {
          models: [],
          reason: 'no-keys' as const,
          unavailable: NO_KEYRING_NOTICE,
        };
      }
      return restartGateway();
    },

    /** 设置页「模型接入」的六个动作（11 §4.4）。都在这里落地，渲染层只拿视图 */
    modelAccessPorts: {
      read: async (): Promise<ModelAccessMutationResult> => {
        if (account.signedIn()) await account.listDevices();
        return { ok: true, view: accessView(await readModelCatalog()) };
      },
      saveProviderKey: async (input: SaveProviderKeyInput): Promise<ModelAccessMutationResult> => {
        const ok = modelAccess.saveProviderKey(input);
        if (!ok) {
          return {
            ok: false,
            // 保存不了只有两个原因：密钥库不可用，或这个厂商 id 不认识
            refused:
              modelAccess.secretBackend === 'unavailable'
                ? NO_KEYRING_NOTICE
                : '这个厂商不在内置名单里。',
            view: accessView(await readModelCatalog()),
          };
        }
        logger.info('desktop.provider_keys.saved', { itemCount: 1 });
        return { ok: true, view: accessView(await restartGateway()) };
      },
      clearProviderKey: async (providerId: string): Promise<ModelAccessMutationResult> => {
        const ok = modelAccess.clearProviderKey(providerId);
        return {
          ok,
          ...(ok ? {} : { refused: '这把密钥本来就没有保存。' }),
          view: accessView(await restartGateway()),
        };
      },
      addCustomModel: async (input: CustomModelInput): Promise<ModelAccessMutationResult> => {
        const refused = modelAccess.addCustomModel(input);
        if (refused !== undefined) {
          // `refused` 是一句要显示给用户的话，不是错误码（同 ProjectMutationResult）
          return { ok: false, refused, view: accessView(await readModelCatalog()) };
        }
        return { ok: true, view: accessView(await restartGateway()) };
      },
      removeCustomModel: async (id: string): Promise<ModelAccessMutationResult> => {
        const ok = modelAccess.removeCustomModel(id);
        return {
          ok,
          ...(ok ? {} : { refused: '没有这个自定义模型。' }),
          view: accessView(await restartGateway()),
        };
      },
      setPlaintextFallback: async (accept: boolean): Promise<ModelAccessMutationResult> => {
        const hadToken = gatewayToken !== undefined;
        modelAccess.setPlaintextFallback(accept);
        const catalog = await restartGateway();
        /*
         * **内核拿不到刚签出来的令牌** —— 它的进程环境是启动时定下的（`extraEnv`），
         * 而这一刻内核已经在跑了。网关重起就够，内核不行。
         *
         * 如实说要重启，而不是让用户发一句话、拿到
         * `Missing environment variable: EVOWORK_GATEWAY_TOKEN`，然后去猜自己哪儿做错了。
         * （M10b 之后令牌会变成短期 JWT，那时这条路径要改成"通知内核换令牌"。）
         */
        if (!hadToken && gatewayToken !== undefined) {
          options.emitToRenderer(IPC.notice, {
            kind: 'model',
            text: '密钥保存方式已改。**重启 EvoWork 之后**才能发出新任务 —— 当前的内核进程还没有拿到网关令牌。',
          });
        }
        return { ok: true, view: accessView(catalog) };
      },
      probe: async (modelId: string): Promise<ModelProbeResult> =>
        probeModel({
          baseUrl: gatewayBaseUrl,
          token: gatewayToken,
          modelId,
          ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        }),
    },

    /** 设置页「用量与预算」的阶段 1（Q11：单任务预算 + 并发上限，只能往下调） */
    preferencePorts: {
      read: (): PreferencesView => readPreferences(),
      write: (input: PreferencesInput): PreferencesView => writePreferences(input),
    },
    accountPorts: {
      startLogin: async () => {
        const result = await account.startLogin();
        if (result.ok) {
          await refreshPolicy();
          await restartGateway();
        }
        return result;
      },
      logout: async () => {
        await account.logout();
        await restartGateway();
        return { ok: true };
      },
      listDevices: () => account.listDevices(),
      revokeDevice: (deviceId: string) => account.revokeDevice(deviceId),
      openWeb: (path: string) => account.openWeb(path),
    },
    policyPorts: {
      status: () => policyStatus(),
      readOnlyReason: () =>
        policyView.status === 'expired' ? (policyView.message ?? undefined) : undefined,
    },
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
       * 已登录才 restore（会打 identity）。未登录时 vault 里没有 refresh，
       * restore 立刻返回，**零出网**（11 §12 第 14 条）。
       */
      await account.restore();
      await refreshPolicy();
      gatewayRuntimeEnv = composeGatewayEnv();
      /*
       * 网关**在内核之前起**：内核握手之后随时可能发第一个请求，
       * 而网关起来要几百毫秒。反过来的话第一次发消息有概率打在还没监听的端口上，
       * 表现是一次莫名其妙的 ECONNREFUSED，重试一下又好了 —— 最难查的那种。
       *
       * 网关在别处（拓扑 B）时这里什么都不做，见 `startLocalGateway`。
       */
      if (options.gatewayEntryPath) {
        launchLocalGateway();
        // `REMOTE` 没有 notice：网关在服务器上是正常部署，不该提示任何东西
        if (gateway && !gateway.result.started && gateway.result.reason !== 'REMOTE') {
          options.emitToRenderer(IPC.notice, { kind: 'model', text: gateway.result.notice });
        }
        const ready = await awaitGatewayReady();
        if (!ready) {
          logger.warn('gateway.child.not_ready', { reason: 'TIMEOUT' });
          options.emitToRenderer(IPC.notice, {
            kind: 'model',
            text: '本机网关启动了但还没开始接受请求。等几秒再点「检查模型接入」。',
          });
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

      if (!baseInstructions) {
        logger.warn('desktop.base_instructions.missing', { reason: 'NOT_INSTALLED' });
        options.emitToRenderer(IPC.notice, {
          kind: 'identity',
          text:
            '产品身份底稿没有随包装上，智能体可能自称错误的产品名。' +
            '这是安装问题，不是模型问题。',
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
