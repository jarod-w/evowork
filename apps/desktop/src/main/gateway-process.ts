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
 * ## 为什么是"看情况起"而不是"总是起"
 *
 * 网关的位置是部署选择（build-and-deploy §5.1 的拓扑 A / B），不是产品决定：
 *
 *   · **拓扑 A**（个人 / 试点 / 离网）：网关随 App 在本机跑，厂商 key 在用户机器上。
 *   · **拓扑 B**（生产的最小面，Q14 选的这条）：网关在服务器上，用户只有一个 token。
 *
 * 所以这里的判据是 **`base_url` 指向哪儿**：指向环回地址才起本机进程，
 * 指向别人的域名就什么都不做。把它写成"总是起一个"会让企业部署的机器上
 * 多一个占着 8787、拿不到任何厂商 key、每次请求都失败的进程 ——
 * 而那台机器的用户会看到"连不上网关"，然后去查那个**根本不该存在**的本机进程。
 *
 * ## 起不来不是致命错误
 *
 * 网关起不来 = 发不出任务，但界面完全可用（翻历史任务、看产物、改设置）。
 * 所以这里**不抛**，只把失败原因交给宿主推成一条 notice ——
 * 与 `model-catalog.ts` 里"网关连不上不该把首页拖成白屏"是同一条判断。
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';

import { errorFields, type Logger } from '@evowork/logging';

import { envHasProviderKey, PROVIDER_KEY_ENV } from './gateway-env.js';

/** 没配密钥时给用户看的话。listModels 必须原样用这一句，不能再 fetch 一次变成「连不上」。 */
export const GATEWAY_NO_KEYS_NOTICE =
  '本机网关没有启动：一家模型厂商的密钥都没有配置，现在发不出任务。' +
  '在引导里填入 DEEPSEEK / Kimi / GLM 至少一家的 API 密钥，或写进 ~/.evowork/gateway.env 后重启。';

/**
 * `base_url` 是不是指向本机。
 *
 * 只认环回地址，**不认 `0.0.0.0`**：那是"监听所有网卡"的写法，出现在
 * `base_url` 里意味着有人把服务端配置抄进了客户端配置，此时起一个本机进程
 * 只会掩盖那个笔误。
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
  /** 内核 `config.toml` 里的 `base_url`。**它决定起不起** */
  readonly baseUrl: string;
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
  stop(): void;
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
  const env = options.env ?? process.env;
  const noop = { stop: () => undefined };

  if (!isLocalGateway(options.baseUrl)) {
    // 正常部署，不提示用户；但记一条，否则"网关到底在哪"没有任何线索
    options.logger?.info('gateway.child.skipped', { reason: 'REMOTE' });
    return { ...noop, result: { started: false, reason: 'REMOTE' } };
  }

  if (!envHasProviderKey(env)) {
    options.logger?.warn('gateway.child.skipped', { reason: 'NO_KEYS' });
    return {
      ...noop,
      result: {
        started: false,
        reason: 'NO_KEYS',
        notice: GATEWAY_NO_KEYS_NOTICE,
      },
    };
  }
  const keys = PROVIDER_KEY_ENV.filter((name) => (env[name] ?? '').trim() !== '');

  if (!existsSync(options.entryPath)) {
    options.logger?.warn('gateway.child.skipped', { reason: 'NO_ENTRY' });
    return {
      ...noop,
      result: {
        started: false,
        reason: 'NO_ENTRY',
        notice: '本机网关的程序文件不在，现在发不出任务。这是安装包不完整，请重新安装 EvoWork。',
      },
    };
  }

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
    const markDead = (notice: string): void => {
      if (stopping || !result.started) return;
      result = { started: false, reason: 'SPAWN_FAILED', notice };
    };
    child.on('error', (err: Error) => {
      options.logger?.warn('gateway.child.spawn_failed', errorFields(err));
      markDead('本机网关没能启动，现在发不出任务。重启 EvoWork 再试。');
    });
    child.on('exit', (code: number | null) => {
      options.logger?.warn('gateway.child.exited', { exitCode: code ?? -1, reason: 'EXIT' });
      if (code !== 0 && code !== null) {
        markDead('本机网关启动后立刻退出了，现在发不出任务。重启 EvoWork 再试。');
      }
    });

    // `itemCount` 而不是 `count`：字段注册表里没有 `count`，未注册的字段会被
    // **静默丢掉**（Q14 的设计意图）—— 实测这条日志带过一次 droppedFields:1
    options.logger?.info('gateway.child.started', { itemCount: keys.length });
    return {
      get result() {
        return result;
      },
      stop: () => {
        // 网关无状态、不写盘，SIGTERM 直接杀掉没有代价（不需要优雅关闭）
        stopping = true;
        try {
          child.kill();
        } catch {
          /* 已经没了 */
        }
      },
    };
  } catch (err: unknown) {
    options.logger?.warn('gateway.child.spawn_failed', errorFields(err));
    return {
      ...noop,
      result: {
        started: false,
        reason: 'SPAWN_FAILED',
        notice: '本机网关没能启动，现在发不出任务。重启 EvoWork 再试。',
      },
    };
  }
}
