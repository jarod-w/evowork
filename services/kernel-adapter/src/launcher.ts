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

export function createSpawnLauncher(options: SpawnLauncherOptions): KernelLauncher {
  return {
    launch(): KernelProcess {
      const spawnOptions: SpawnOptions = {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CODEX_HOME: options.kernelHome,
          ...options.extraEnv,
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
