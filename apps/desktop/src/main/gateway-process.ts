/**
 * 本机网关子进程（K4 / D9 的「拓扑 A」）。
 *
 * ## 为什么需要它
 *
 * 内核只认 Responses API（`wire_api = "chat"` 已被上游删掉），而 DeepSeek / Kimi / GLM
 * 都只说 Chat —— **不存在"让内核直连厂商"这条路**，网关是必需组件而不是可选优化。
 * 在此之前它一直是"人手工起的前台进程"，代价 2026-09-06 兑现了一次：
 * 模型目录改了、代码与 dmg 都是新的，而界面上还是旧列表 ——
 * 因为那个进程是几小时前起的，模型表在它的内存里。
 *
 * ## D11 之后它是常驻的
 *
 * 内核的 `base_url` 恒为 loopback。本机网关按 model id 决定上游：
 * BYOK 直连厂商，hosted 转到我们的云，private 转到客户机房那台。
 * `runsLocally` 在产品路径上恒为 true（`model-access.ts`）。
 *
 * 函数仍接受 `runsLocally: false` 作为测试逃生口 —— 产品代码不再走那条。
 * 以前"企业部署不该起本机进程"的判断已经不成立：不起的话内核打 loopback
 * 会 ECONNREFUSED，而真正的上游在别人的机器上。
 *
 * ## 起不来不是致命错误
 *
 * 网关起不来 = 发不出任务，但界面完全可用（翻历史任务、看产物、改设置）。
 * 所以这里**不抛**，只把失败原因交给宿主推成一条 notice ——
 * 与 `model-catalog.ts` 里"网关连不上不该把首页拖成白屏"是同一条判断。
 */
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { errorFields, type Logger } from '@evowork/logging';

import { CUSTOM_MODELS_ENV, TENANT_MODELS_ENV, UPSTREAM_BASE_URL_ENV } from '@evowork/gateway';

import { envHasProviderKey, PROVIDER_KEY_ENV } from './gateway-env.js';

/**
 * 没配密钥时给用户看的话。listModels 必须原样用这一句，不能再 fetch 一次变成「连不上」。
 *
 * **2026-09-08 改了后半句**：原文让用户去写 `~/.evowork/gateway.env`，而那个明文文件
 * 已经被密钥库取代（M10a / Q34）—— 指着一条已经退役的路，比不给路更糟。
 */
export const GATEWAY_NO_KEYS_NOTICE =
  '本机网关没有启动：一家模型厂商的密钥都没有配置，也没有自定义模型，现在发不出任务。' +
  '去「设置 → 模型」添加一个自定义模型。没有可用的模型时任务发不出去，EvoWork 不会自动换一个模型。';

/**
 * 端口上听着的不是我们上次留下的网关。
 * 不能杀掉一个认不出来的进程，所以这里只说明端口被占，让用户自己去关。
 */
export const GATEWAY_PORT_IN_USE_NOTICE =
  '本机网关要用的端口被别的程序占着，现在发不出任务。关掉占用它的程序后再重启 EvoWork。';

/**
 * `base_url` 是不是指向本机。
 *
 * 只认环回地址，**不认 `0.0.0.0`**：那是"监听所有网卡"的写法，出现在
 * `base_url` 里意味着有人把服务端配置抄进了客户端配置，此时起一个本机进程
 * 只会掩盖那个笔误。
 *
 * **它已经不再决定要不要起网关了**（D11 / M10a）：现在只剩一个调用点 ——
 * `app-config.ts` 的一次性兼容读取（老装机没有 `app.toml` 时反推一次并写回）。
 * 不要把它加回到任何判据里；拓扑的真源是 `app.toml` 的 `mode`。
 */
export function isLocalGateway(baseUrl: string): boolean {
  try {
    // URL.hostname 把 IPv6 连方括号一起给（`[::1]`），去掉再比 —— 不去的话
    // `http://[::1]:8787` 会被判成远端，表现是本机网关永远不启动
    const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, '');
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    // 解析不了的地址不猜。宿主那边 `fetchModelCatalog` 会如实报"连不上"
    return false;
  }
}

/** `base_url` 里的端口。网关默认 8787，与 `config.toml.template` 一致。 */
export function portOf(baseUrl: string, fallback = 8787): number {
  try {
    const port = new URL(baseUrl).port;
    return port ? Number(port) : fallback;
  } catch {
    return fallback;
  }
}

export interface GatewayProcessOptions {
  /** 内核 `config.toml` 里的 `base_url`。**只用来取端口** —— 起不起看 `runsLocally` */
  readonly baseUrl: string;
  /**
   * 本机该不该跑网关。产品路径恒为 true（D11）。`false` 只留给测试。
   *
   * **必填**，不给默认值：忘了传必须在编译期就红。
   */
  readonly runsLocally: boolean;
  /** 网关单文件产物的绝对路径（打包时在 `Resources/gateway/main.js`） */
  readonly entryPath: string;
  /** 访问令牌。与内核用的是同一个（宿主已经读出来了） */
  readonly token?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly logger?: Logger | undefined;
  /**
   * 注入以便测试。**默认是真的 `spawn`** ——
   * 只留注入口、不给默认值的话，生产环境永远走不到起进程那一步
   * （2026-09-06 实测踩到：宿主只在测试里传 spawnFn，真跑时网关一次都没起来，
   * 而失败被归成一句"缺少启动器"，看起来像配置问题）。
   */
  readonly spawnFn?: typeof nodeSpawn | undefined;
  /**
   * 父进程退出时补一刀。
   *
   * `before-quit` 里是 `void host.stop()`，Electron **不会等**这个 Promise。
   * 进程真的退了而 `stop()` 还停在第一个 `await` 上时，这里是唯一还能同步
   * 杀掉子进程的地方 —— 漏了的话它会被 launchd 收养，继续占着端口。
   * 测试注入它，避免把监听器挂到测试进程自己的 `exit` 上。
   */
  readonly onParentExit?: ((handler: () => void) => () => void) | undefined;
  /**
   * 用哪个可执行文件跑它。
   *
   * 打包后是 Electron 自己（`process.execPath` + `ELECTRON_RUN_AS_NODE=1`）——
   * **用户机器上没有 node**，假设有 node 的话，产品在干净机器上直接不可用。
   */
  readonly execPath?: string | undefined;
}

export type GatewayStartResult =
  | { readonly started: true }
  /** 没起，且**这是正常的**（网关在别处）—— 不该给用户看任何提示 */
  | { readonly started: false; readonly reason: 'REMOTE' }
  /** 没起，且用户需要知道 —— 宿主把 `notice` 推成一条提示 */
  | {
      readonly started: false;
      readonly reason: 'NO_KEYS' | 'NO_ENTRY' | 'SPAWN_FAILED';
      readonly notice: string;
    };

export interface GatewayProcess {
  readonly result: GatewayStartResult;
  /** 子进程已经结束。重起前要等它，否则新进程会撞上还没放开的端口。 */
  readonly exited: Promise<void>;
  stop(): void;
}

/** 没拉起进程时的占位。`exited` 已经完成，调用方不用区分「没起」和「起了又退了」。 */
function idleGateway(result: GatewayStartResult): GatewayProcess {
  return { result, exited: Promise.resolve(), stop() {} };
}

export type GatewayPlan =
  { readonly kind: 'skip'; readonly process: GatewayProcess } | { readonly kind: 'spawn' };

/**
 * 这次该不该拉起进程。
 *
 * 跟真正的 `spawn` 拆开，是因为「端口上还有上次的孤儿」这件事只能在
 * **决定要 spawn 之后、真正 spawn 之前**处理：没配密钥时不该去动端口，
 * 而 spawn 本身又不能是异步的（测试与 `result` 都假设它立刻返回）。
 */
export function planLocalGateway(options: GatewayProcessOptions): GatewayPlan {
  const env = options.env ?? process.env;

  if (!options.runsLocally) {
    options.logger?.info('gateway.child.skipped', { reason: 'REMOTE' });
    return { kind: 'skip', process: idleGateway({ started: false, reason: 'REMOTE' }) };
  }

  /*
   * "有没有模型可服务"**不只看内置三家的密钥**（M10a）：只加了一条自定义模型、
   * 三家一个都没配，是 Q30=A 下完全正常的一种用法。只看 `envHasProviderKey` 的话，
   * 那位用户会看到"一家密钥都没配"，而他明明刚在设置页加过一个模型。
   */
  const hasCustomModels = (env[CUSTOM_MODELS_ENV] ?? '').trim().length > 2;
  const hasTenantModels = (env[TENANT_MODELS_ENV] ?? '').trim().length > 2;
  const hasPrivateUpstream = (env[UPSTREAM_BASE_URL_ENV] ?? '').trim().length > 0;
  if (!envHasProviderKey(env) && !hasCustomModels && !hasTenantModels && !hasPrivateUpstream) {
    options.logger?.warn('gateway.child.skipped', { reason: 'NO_KEYS' });
    return {
      kind: 'skip',
      process: idleGateway({
        started: false,
        reason: 'NO_KEYS',
        notice: GATEWAY_NO_KEYS_NOTICE,
      }),
    };
  }

  if (!existsSync(options.entryPath)) {
    options.logger?.warn('gateway.child.skipped', { reason: 'NO_ENTRY' });
    return {
      kind: 'skip',
      process: idleGateway({
        started: false,
        reason: 'NO_ENTRY',
        notice: '本机网关的程序文件不在，现在发不出任务。这是安装包不完整，请重新安装 EvoWork。',
      }),
    };
  }

  return { kind: 'spawn' };
}

/**
 * 起一个本机网关（如果该起的话）。
 *
 * 三种"不起"各自有不同的后果，所以**不能合并成一个布尔值**：
 *
 *   · `REMOTE`   —— 网关在别处，一切正常，**不提示**；
 *   · `NO_KEYS`  —— 一家厂商密钥都没配。网关自己会拒绝启动（`gateway.boot.no_models`），
 *                   我们在这里就拦下来：让它启动再退出，用户看到的是"连不上网关"，
 *                   而真正的原因是"没配密钥"，中间隔着一层无谓的归因；
 *   · `NO_ENTRY` —— 产物不在。开发时没跑 `pnpm run build`，或打包漏了 extraResources。
 */
export function startLocalGateway(options: GatewayProcessOptions): GatewayProcess {
  const plan = planLocalGateway(options);
  if (plan.kind === 'skip') return plan.process;
  return spawnLocalGateway(options);
}

function bindParentExit(handler: () => void): () => void {
  process.on('exit', handler);
  return () => process.removeListener('exit', handler);
}

function spawnLocalGateway(options: GatewayProcessOptions): GatewayProcess {
  const env = options.env ?? process.env;
  const keys = PROVIDER_KEY_ENV.filter((name) => (env[name] ?? '').trim() !== '');
  const spawnFn = options.spawnFn ?? nodeSpawn;

  try {
    const child = spawnFn(options.execPath ?? process.execPath, [options.entryPath], {
      env: {
        ...env,
        // 打包后跑的是 Electron 二进制；没有它 Electron 会去开一个窗口而不是执行脚本
        ELECTRON_RUN_AS_NODE: '1',
        PORT: String(portOf(options.baseUrl)),
        HOST: '127.0.0.1',
        ...(options.token ? { EVOWORK_GATEWAY_TOKENS: options.token } : {}),
      },
      // 网关的 stdout 是结构化日志（Q14：不含正文），进父进程日志即可
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      options.logger?.info('gateway.child.stdout', { byteSize: chunk.byteLength });
    });
    /*
     * stderr **要单独记**：网关的两个拒绝启动条件（没密钥 / 没令牌）都从这里出来，
     * 而它们的表现都是"进程起了又没了"。丢掉这一路的话，排查只能从
     * "为什么模型列表是空的"倒推回去。
     */
    child.stderr?.on('data', (chunk: Buffer) => {
      options.logger?.warn('gateway.child.stderr', { byteSize: chunk.byteLength });
    });

    /*
     * `spawn` 返回不等于进程活着：ENOENT / EACCES 走 `error`，密钥没灌进去
     * 则 `main()` 立刻 `exit 1`。两种都曾经被当成 `{ started: true }`，
     * 随后那一次 fetch 得到 ECONNREFUSED，界面写成「连不上模型网关」。
     */
    let result: GatewayStartResult = { started: true };
    let stopping = false;
    let settleExit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      settleExit = resolve;
    });
    const markDead = (notice: string): void => {
      if (stopping || !result.started) return;
      result = { started: false, reason: 'SPAWN_FAILED', notice };
    };
    /*
     * SIGKILL，不是 SIGTERM。网关进程自己接住了 SIGTERM，要等 `server.close()`
     * 把现有连接耗尽才退出 —— 父进程这时往往已经没了，端口就一直被占着。
     * 网关无状态、不写盘，不需要这段优雅关闭。
     */
    let unsubscribe = (): void => undefined;
    const killChild = (): void => {
      if (stopping) return;
      stopping = true;
      unsubscribe();
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经没了 */
      }
    };
    unsubscribe = (options.onParentExit ?? bindParentExit)(killChild);
    const finished = (): void => {
      unsubscribe();
      settleExit();
    };
    child.on('error', (err: Error) => {
      options.logger?.warn('gateway.child.spawn_failed', errorFields(err));
      markDead('本机网关没能启动，现在发不出任务。重启 EvoWork 再试。');
      finished();
    });
    child.on('exit', (code: number | null) => {
      options.logger?.warn('gateway.child.exited', { exitCode: code ?? -1, reason: 'EXIT' });
      if (code !== 0 && code !== null) {
        markDead('本机网关启动后立刻退出了，现在发不出任务。重启 EvoWork 再试。');
      }
      finished();
    });

    // `itemCount` 而不是 `count`：字段注册表里没有 `count`，未注册的字段会被
    // **静默丢掉**（Q14 的设计意图）—— 实测这条日志带过一次 droppedFields:1
    options.logger?.info('gateway.child.started', { itemCount: keys.length });
    return {
      get result() {
        return result;
      },
      exited,
      stop: killChild,
    };
  } catch (err: unknown) {
    options.logger?.warn('gateway.child.spawn_failed', errorFields(err));
    return idleGateway({
      started: false,
      reason: 'SPAWN_FAILED',
      notice: '本机网关没能启动，现在发不出任务。重启 EvoWork 再试。',
    });
  }
}

export interface PortListener {
  readonly pid: number;
  readonly command: string;
}

export type ReclaimResult =
  { readonly status: 'clear' } | { readonly status: 'reclaimed' } | { readonly status: 'blocked' };

/** 命令行里带的是这次要拉起的那个入口，才算「我们上次留下的网关」。 */
function isOurGateway(command: string, entryPath: string): boolean {
  return entryPath.length > 0 && command.includes(entryPath);
}

function listeningPids(port: number): readonly number[] {
  if (process.platform === 'win32') {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true,
    });
    const pids: number[] = [];
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5 || parts[3] !== 'LISTENING') continue;
      if (!(parts[1] ?? '').endsWith(`:${port}`)) continue;
      const pid = Number(parts[4]);
      if (pid > 1) pids.push(pid);
    }
    return pids;
  }
  const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  return out
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => pid > 1);
}

function commandOf(pid: number): string {
  if (process.platform === 'win32') {
    return execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
      ],
      { encoding: 'utf8', timeout: 2_000, windowsHide: true },
    ).trim();
  }
  return execFileSync('ps', ['-ww', '-p', String(pid), '-o', 'command='], {
    encoding: 'utf8',
    timeout: 2_000,
  }).trim();
}

/** 谁在听这个端口。查不到（没装 lsof、或上面根本没人）就当没有，让后面的 spawn 自己失败。 */
export function listGatewayListeners(port: number): readonly PortListener[] {
  try {
    const seen = new Set<number>();
    const listeners: PortListener[] = [];
    for (const pid of listeningPids(port)) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      let command = '';
      try {
        command = commandOf(pid);
      } catch {
        command = '';
      }
      listeners.push({ pid, command });
    }
    return listeners;
  } catch {
    return [];
  }
}

/**
 * 端口上如果还是上次没退出的网关，先杀掉它。
 *
 * 只动手条件是命令行里带本次的入口路径。别的程序占着同一端口时返回 `blocked`，
 * 调用方据此告诉用户，而不是发一个 SIGKILL 给认不出来的进程。
 */
export async function reclaimStaleGateway(options: {
  readonly port: number;
  readonly entryPath: string;
  readonly listListeners?: ((port: number) => readonly PortListener[]) | undefined;
  readonly kill?: ((pid: number) => void) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}): Promise<ReclaimResult> {
  const listListeners = options.listListeners ?? listGatewayListeners;
  const kill = options.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL'));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const others = listListeners(options.port).filter((listener) => listener.pid !== process.pid);
  const stale = others.filter((listener) => isOurGateway(listener.command, options.entryPath));
  /*
   * 命令行没读到（ps 失败）不算「别的程序」：误报成端口被占会让一次本来能起来的
   * 启动直接放弃。这种情况交给后面的 spawn，失败了仍是原来那句「立刻退出」。
   */
  const foreign = others.filter(
    (listener) => listener.command !== '' && !isOurGateway(listener.command, options.entryPath),
  );
  if (foreign.length > 0) return { status: 'blocked' };
  if (stale.length === 0) return { status: 'clear' };

  const stalePids = new Set(stale.map((listener) => listener.pid));
  for (const pid of stalePids) {
    try {
      kill(pid);
    } catch {
      /* 已经没了 */
    }
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const stillThere = listListeners(options.port).some((listener) => stalePids.has(listener.pid));
    if (!stillThere) return { status: 'reclaimed' };
    await sleep(20);
  }
  return { status: 'reclaimed' };
}
