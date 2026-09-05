/**
 * 真实的运行时探测（08 §4）。
 *
 * `RuntimeProbe` 在别处是注入的接口（为了可测），这里是它跑在真机上的实现：
 * 找到办公扩展的解释器，用它去 import 那些模块。
 *
 * ## 为什么要缓存
 *
 * 每次拖入文件都 spawn 一次 python 去问"装了吗"，在一次多文件上传里就是 20 次进程启动。
 * 扩展的安装状态在一次会话里几乎不变，所以缓存到显式失效为止 ——
 * 安装流程结束时调用 `invalidate()`。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

import { officeInterpreterPaths, type RuntimeProbe } from './runtime.js';

export interface ProbeOptions {
  readonly home?: string | undefined;
  /** 覆盖解释器路径（企业离线部署 / 测试） */
  readonly interpreter?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

export function resolveOfficeInterpreter(options: ProbeOptions = {}): string | undefined {
  const override = options.interpreter ?? process.env.EVOWORK_OFFICE_PYTHON;
  if (override) return existsSync(override) ? override : undefined;
  return officeInterpreterPaths(options.home ?? homedir()).find((path) => existsSync(path));
}

export function createRuntimeProbe(options: ProbeOptions = {}): RuntimeProbe & {
  invalidate(): void;
  interpreter(): string | undefined;
} {
  const cache = new Map<string, boolean>();
  let interpreter: string | undefined | null = null; // null = 还没查过

  const resolve = (): string | undefined => {
    if (interpreter === null) interpreter = resolveOfficeInterpreter(options);
    return interpreter;
  };

  return {
    hasModule(name: string): boolean {
      const cached = cache.get(name);
      if (cached !== undefined) return cached;

      const python = resolve();
      let ok = false;
      if (python) {
        try {
          execFileSync(python, ['-c', `import ${name}`], {
            stdio: 'ignore',
            timeout: options.timeoutMs ?? 10_000,
          });
          ok = true;
        } catch {
          ok = false;
        }
      }
      cache.set(name, ok);
      return ok;
    },
    invalidate(): void {
      cache.clear();
      interpreter = null;
    },
    interpreter: resolve,
  };
}
