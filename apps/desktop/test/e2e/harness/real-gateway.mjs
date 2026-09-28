/**
 * **真网关子进程**：请求真的穿过 `translate/to-chat.ts` 与 `translate/from-chat.ts`，
 * 再打到真厂商。
 *
 * 与 `fake-gateway.mjs` 是互补关系：假的能把模型摆布成任何样子（挂住、断线、调某个工具），
 * 真的能回答**只有真模型答得出来的问题** —— 比如「介绍一下自己」会不会说漏内核品牌（K5）。
 *
 * 密钥只经环境变量进这个子进程：不写盘、不进日志、不提交
 * （与 `scripts/verify-agent-loop.mjs` 同一条纪律）。
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { waitFor } from './runner.mjs';

/** 先占一个端口再让出来：网关从 PORT 读端口，而它不会把自己选的端口说出来。 */
function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 起一个真网关。返回 `{ baseUrl, token, stop, log }`。
 *
 * `log` 收着它的 stdout/stderr —— 起不来时要把原因带出来，
 * 否则调用方只会看到一句「网关没起来」。
 */
export async function startRealGateway({ repoRoot, keyEnvName, apiKey, customModels, logFile }) {
  if (!apiKey) throw new Error('真网关需要密钥（不要把它写进任何文件）。');
  const port = await reservePort();
  const token = 'ui-real-token';
  let log = '';
  const child = spawn(process.execPath, [join(repoRoot, 'dist/gateway/main.js')], {
    env: {
      ...process.env,
      /*
       * 这里的 `process.execPath` 是 **Electron 本体**（本文件跑在 Electron 主进程里）。
       * 不设这一项，网关会被当成一个 Electron *应用*启动：Dock 上多一个图标，
       * 而且它不是我们的窗口，关 App 时没人会去关它。网关只是一段 Node 脚本。
       */
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      HOST: '127.0.0.1',
      [keyEnvName]: apiKey,
      EVOWORK_GATEWAY_TOKENS: token,
      /*
       * 自定义模型 —— **真实用户走的就是这条路**（设置页「添加模型」，11 §4.1）。
       * 内置目录按厂商密钥过滤，而目录里当前没有 DeepSeek 的条目
       * （`known-models.ts` 里那两条都没有 `builtinId`），只配 `DEEPSEEK_API_KEY`
       * 网关会以 `no_models` 拒绝启动。
       */
      ...(customModels ? { EVOWORK_CUSTOM_MODELS: JSON.stringify(customModels) } : {}),
      LOG_LEVEL: 'info',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  /*
   * `logFile` 给了就同时落盘（放在 E2E home 里：测试失败时 home 会被留下）。
   * 2026-09-28 真模型轮次里网关回了 502「网关处理失败」，而原因只在它自己的日志里 ——
   * 当时日志只在内存，进程一退就没了。网关日志不带正文（Q14），落盘是安全的。
   */
  const collect = (c) => {
    log += c.toString();
    if (logFile) {
      try {
        appendFileSync(logFile, c);
      } catch {
        /* 诊断用的副本写不进去不影响测试 */
      }
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).ok,
    `真网关没起来：${log.slice(-500)}`,
    20_000,
    250,
  );
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    token,
    /** 给进程外的夹具核对「关 App 之后它真的退了」用 —— 见 fixtures.mjs */
    pid: child.pid,
    stop: () => child.kill(),
    readLog: () => log,
  };
}
