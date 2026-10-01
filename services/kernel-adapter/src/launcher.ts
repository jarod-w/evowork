/**
 * 真实内核进程的启动器。
 *
 * ## 为什么它在适配层而不是在桌面壳里
 *
 * 最初这段代码写在 `apps/desktop/src/main/service-host.ts` 里 —— 看起来合理：
 * 桌面壳是宿主，它 spawn 子进程。但 `@evowork/no-kernel-internals` 这条 lint 规则
 * 立刻报了：**只有 `services/kernel-adapter` 可以引用 `CODEX_HOME`**。
 *
 * 规则是对的，而当时的代码是错的：`CODEX_HOME`、stdio 帧、内核可执行文件名
 * 这些都是"内核长什么样"的知识，它们应该只在 K2 边界的这一侧存在。
 * 散到桌面壳里的后果不是立刻出错，而是**下一个需要起内核的地方**（EvoWork CLI，Q13）
 * 会把这段逻辑再抄一遍，然后两份慢慢分叉。
 *
 * 所以桌面壳现在只传路径，不知道环境变量叫什么。
 */
import { spawn, type SpawnOptions } from 'node:child_process';
import { join } from 'node:path';

import type { KernelLauncher, KernelProcess } from './session.js';

export interface SpawnLauncherOptions {
  /** app-server 可执行文件路径（M9 打包时随内核二进制分发） */
  readonly appServerPath: string;
  /**
   * 内核的家目录。
   *
   * 我们把它指向 `~/.evowork/kernel/`，但**内部环境变量名保持内核原样**
   * （K5：只改对外可见字符串，内部路径名不动 —— 改它会凭空增加补丁面）。
   */
  readonly kernelHome: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** 注入 spawn 供测试替换 */
  readonly spawnFn?: typeof spawn;
  /** 内核 stderr 的处理。默认丢弃 —— 见下面的注释 */
  readonly onStderr?: (chunk: string) => void;
}

/** 本机回环：内核发往本机网关、hook 与 MCP 子进程的流量都在这里 */
const LOOPBACK = ['127.0.0.1', 'localhost', '::1'] as const;

/**
 * 把回环地址并进 `NO_PROXY`，保留用户已有的例外。
 *
 * ## 为什么必须有它（2026-09-28 实测）
 *
 * 内核的 HTTP 客户端（reqwest）在 macOS 上会读**系统代理**。开着 Clash 一类代理时，
 * 内核发往本机网关 `127.0.0.1:<port>` 的每一个请求 —— 整段 prompt 与文件内容 ——
 * 都绕进了 `127.0.0.1:7890` 那个代理进程（`lsof` 采样：内核的连接**全部**指向 7890，
 * 一条都没有直连网关）。代理自带的例外清单救不了：常见写法是把整串
 * `localhost,127.*,…` 塞进**一个**数组元素，按清单逐项匹配的客户端认不出它。
 *
 * 两个后果：① 本机明文流量经过第三方进程，K6「不出本机」的口径被一个我们看不见的进程穿过；
 * ② 代理一抖，内核收到的是**没有正文的 502**（我们的网关从不这样回）—— 回合失败，
 * 界面只能给出「unexpected status 502 Bad Gateway: Unknown error」。
 *
 * 只动回环：发往外网的流量（云端网关、MCP 连接器）照旧遵从用户的代理设置。
 */
export function withLoopbackNoProxy(env: NodeJS.ProcessEnv): Record<string, string> {
  const existing = [env.NO_PROXY, env.no_proxy]
    .filter((value): value is string => typeof value === 'string')
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter((value) => value !== '');
  const merged = [...new Set([...existing, ...LOOPBACK])].join(',');
  return { NO_PROXY: merged, no_proxy: merged };
}

export function createSpawnLauncher(options: SpawnLauncherOptions): KernelLauncher {
  return {
    launch(): KernelProcess {
      const cwd = join(options.kernelHome, 'startup');
      const spawnOptions: SpawnOptions = {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CODEX_HOME: options.kernelHome,
          ...options.extraEnv,
          // 放在最后：extraEnv 也不许把回环重新送回代理
          ...withLoopbackNoProxy({ ...process.env, ...options.extraEnv }),
        },
      };
      const child = (options.spawnFn ?? spawn)(options.appServerPath, [], spawnOptions);
      const stdout = child.stdout;
      const stderr = child.stderr;
      const stdin = child.stdin;
      if (!stdout || !stdin) {
        throw new Error('内核进程没有 stdio 管道 —— spawn 参数被改坏了');
      }

      stdout.setEncoding('utf8');

      /**
       * 内核的 stderr 是**它自己的**日志。
       *
       * 默认丢弃（`resume()` 只为了不让管道背压卡住子进程），原因有两条：
       *   ① 它可能含正文，而我们对自己的日志有 Q14 的约束，混进来就破了口径；
       *   ② 它的格式由上游决定，我们无法约束，转成结构化字段只会得到一堆自由文本。
       * 需要排查内核问题时看内核自己的日志文件。
       */
      if (stderr) {
        if (options.onStderr) {
          stderr.setEncoding('utf8');
          stderr.on('data', (chunk: string) => options.onStderr?.(chunk));
        } else {
          stderr.resume();
        }
      }

      return {
        writeLine: (line) => {
          stdin.write(`${line}\n`);
        },
        onStdout: (handler) => {
          stdout.on('data', (chunk: string) => handler(chunk));
        },
        onExit: (handler) => {
          child.on('exit', (code, signal) => handler({ code, signal }));
        },
        kill: () => {
          child.kill();
        },
      };
    },
  };
}
