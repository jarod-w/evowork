#!/usr/bin/env node
/**
 * 用**真模型**跑一遍整条智能体回路（内核 → 我们的网关 → 厂商 → 工具 → 结果回传）。
 *
 * 与 `verify-provider.mjs` 的分工：那个直接打厂商的 Chat 接口，验的是**厂商怎么说话**；
 * 这个把请求穿过我们自己的网关与真内核，验的是**我们翻译得对不对**。
 * 两件事都对不代表合起来对 —— 而今天修掉的缺陷里有三个正是"合起来不对"。
 *
 * 需要密钥，所以**不进 `pnpm run check`**：它要花钱、要联网，两条都不该出现在 CI 的必经路上。
 * 没给密钥时直接失败并说清怎么给，不静默跳过（CLAUDE.md §9.1：跳过的测试等于没有测试）。
 *
 * 用法：
 *   EVOWORK_AGENT_LOOP_KEY=sk-... node scripts/verify-agent-loop.mjs
 *   EVOWORK_AGENT_LOOP_KEY=sk-... EVOWORK_AGENT_LOOP_MODEL=evowork/glm-flash \
 *     EVOWORK_AGENT_LOOP_KEY_ENV=ZHIPU_API_KEY node scripts/verify-agent-loop.mjs
 *
 * **密钥只经环境变量传给子进程**，不写配置文件、不进日志（K6 / Q14）。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);

if (!process.env.EVOWORK_AGENT_LOOP_KEY) {
  console.error(
    '没有密钥。这条验证必须打真实厂商，请给 EVOWORK_AGENT_LOOP_KEY（默认按 Kimi 的 key 用）。',
  );
  process.exit(2);
}

const platformKey =
  platform() === 'darwin'
    ? `mac-${arch()}`
    : platform() === 'win32'
      ? `win-${arch()}`
      : `linux-${arch()}`;
const kernel =
  process.env.EVOWORK_APP_SERVER ??
  resolve(
    root,
    'build/kernel',
    platformKey,
    platform() === 'win32' ? 'codex-app-server.exe' : 'codex-app-server',
  );
if (!existsSync(kernel)) {
  throw new Error(`找不到真实 app-server：${kernel}。先构建或设置 EVOWORK_APP_SERVER。`);
}
if (!existsSync(resolve(root, 'dist/gateway/main.js'))) {
  throw new Error('找不到网关产物：先跑 pnpm run build。');
}

// 与 desktop-skills-e2e 同一条理由：直接启动包里的二进制，超时才杀得干净
const electron = require('electron');
/*
 * VS Code 的集成终端与扩展宿主会设 `ELECTRON_RUN_AS_NODE=1`（它自己就是 Electron 应用）。
 * 原样继承给子进程后，Electron 会以**普通 Node** 启动，`electron` 这个 specifier 于是
 * 解析到 npm 那个只导出二进制路径的壳 —— 入口第一行 `import { app } from 'electron'`
 * 直接报 "does not provide an export named 'app'"。
 *
 * 那个报错看起来像代码坏了，其实是环境：同一份代码在普通终端里是好的。
 * 2026-09-26 实测踩到一次，排查成本远大于这三行。
 */
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...parentEnv } = process.env;

const child = spawn(electron, [resolve(root, 'apps/desktop/test/e2e/agent-loop.e2e.mjs')], {
  cwd: root,
  env: { ...parentEnv, EVOWORK_E2E_REPO_ROOT: root, EVOWORK_APP_SERVER: kernel },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  stdout += text;
  process.stdout.write(text);
});
child.stderr.on('data', (chunk) => {
  const text = chunk.toString();
  stderr += text;
  process.stderr.write(text);
});

// 真模型 + 两轮工具调用：给足时间，但不能没有上限
const timer = setTimeout(
  () => {
    child.kill('SIGKILL');
  },
  Number(process.env.EVOWORK_AGENT_LOOP_TIMEOUT_MS ?? 600_000),
);
timer.unref?.();

child.on('exit', (code) => {
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(`真模型回路验证失败（退出码 ${String(code)}）\n${stderr.slice(-2000)}`);
  }
  if (!stdout.includes('__EVOWORK_AGENT_LOOP__')) {
    throw new Error('没有拿到结果行 —— 进程退出了但没跑到终点。');
  }
  console.log('✅ 真模型回路验证通过');
});
