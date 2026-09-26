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
export async function startRealGateway({ repoRoot, keyEnvName, apiKey, customModels }) {
  if (!apiKey) throw new Error('真网关需要密钥（不要把它写进任何文件）。');
  const port = await reservePort();
  const token = 'ui-real-token';
  let log = '';
  const child = spawn(process.execPath, [join(repoRoot, 'dist/gateway/main.js')], {
    env: {
      ...process.env,
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
  child.stdout.on('data', (c) => (log += c.toString()));
  child.stderr.on('data', (c) => (log += c.toString()));

  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).ok,
    `真网关没起来：${log.slice(-500)}`,
    20_000,
    250,
  );
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    token,
    stop: () => child.kill(),
    readLog: () => log,
  };
}
