#!/usr/bin/env node
/**
 * 用**发货内核 + 随包配置模板**真起一次，看内核想往哪儿发请求（K6 / K7）。
 *
 * 2026-10-22 的教训：模板里没写 `chatgpt_base_url`，内核没登录也在启动 / `plugin/list` 时
 * 请求 `chatgpt.com/backend-api/plugins/featured`（401，已到达对方），还起了一个指向
 * chatgpt.com 的远程控制循环。单测证明得了「配置里写了什么」，证明不了「内核拿它做了什么」——
 * 上游换个配置键或改成硬编码地址，配置照样是对的，请求照样发出去。所以升级内核后跑这个。
 *
 * **判据是内核自己的日志**，不是抓 TCP 连接：内核走系统代理，连接只看得到 `127.0.0.1:<代理端口>`，
 * 看不到真实目的地；而失败与否都会以完整 URL 写进日志。
 *
 * 不需要密钥、不进 `pnpm run check`（要先编出内核）。
 *
 * 用法：
 *   node scripts/verify-kernel-egress.mjs                       # 随包模板（新装的样子）
 *   node scripts/verify-kernel-egress.mjs --config <config.toml> # 任意一份配置（比如迁移后的老配置）
 *   EVOWORK_APP_SERVER=<路径> node scripts/verify-kernel-egress.mjs
 */
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { kernelProvenanceProblem } from './kernel-provenance.mjs';

const root = resolve(import.meta.dirname, '..');
const configFlag = process.argv.indexOf('--config');
const configPath =
  configFlag >= 0
    ? resolve(process.argv[configFlag + 1] ?? '')
    : join(root, 'config/config.toml.template');
const WAIT_MS = 8000;

/** 登记过的目的地（总纲 K6 登记表）。其余非本机地址一律算未登记。 */
const REGISTERED = [/^github\.com$/];
/** K7：OpenAI 侧的服务一个都不许出现，登记了也不行 */
const FORBIDDEN = /(^|\.)(chatgpt\.com|openai\.com)$/;

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
  throw new Error(
    `找不到真实 app-server：${kernel}。先 node scripts/build-kernel.mjs 或设 EVOWORK_APP_SERVER。`,
  );
}
const kernelProblem = kernelProvenanceProblem(kernel, root);
if (kernelProblem) throw new Error(kernelProblem);
if (!existsSync(configPath)) throw new Error(`找不到配置：${configPath}`);

const temp = mkdtempSync(join(tmpdir(), 'evowork-egress-'));
const kernelHome = join(temp, 'kernel');
const work = join(temp, 'work');
mkdirSync(kernelHome, { recursive: true });
mkdirSync(work, { recursive: true });
copyFileSync(configPath, join(kernelHome, 'config.toml'));

const child = spawn(kernel, [], {
  env: { ...process.env, CODEX_HOME: kernelHome, HOME: temp, RUST_LOG: 'info' },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let log = '';
child.stderr.on('data', (chunk) => {
  log += chunk;
});
const pending = new Map();
let nextId = 1;
createInterface({ input: child.stdout }).on('line', (line) => {
  try {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  } catch {
    /* 非 JSON 行忽略 */
  }
});
function request(method, params) {
  return new Promise((done) => {
    const id = nextId++;
    const timer = setTimeout(() => done({ error: { message: `${method} 超时` } }), 15_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      done(message);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

const steps = [];
try {
  const init = await request('initialize', {
    clientInfo: { name: 'evowork-egress-check', version: '0' },
    capabilities: { experimentalApi: true },
  });
  steps.push(['initialize', init.error]);
  child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`);
  // 插件页会调它；精选插件预热就是它触发的
  steps.push(['plugin/list', (await request('plugin/list', {})).error]);
  steps.push([
    'thread/start',
    (await request('thread/start', { cwd: work, ephemeral: true })).error,
  ]);
  await new Promise((done) => setTimeout(done, WAIT_MS));
} finally {
  child.kill();
  await new Promise((done) => setTimeout(done, 300));
  rmSync(temp, { recursive: true, force: true });
}

// eslint-disable-next-line no-control-regex -- 去掉日志里的 ANSI 颜色
const plain = log.replace(/\x1b\[[0-9;]*m/g, '');
const hosts = new Map();
for (const match of plain.matchAll(/\bhttps?:\/\/([^/\s"'`:]+)/g)) {
  const host = match[1].toLowerCase();
  if (/^(127\.|localhost$|\[?::1\]?$)/.test(host)) continue;
  hosts.set(host, (hosts.get(host) ?? 0) + 1);
}

console.log(`内核：${kernel}`);
console.log(`配置：${configPath}`);
for (const [method, error] of steps) {
  console.log(`  ${method}：${error ? `失败 ${JSON.stringify(error).slice(0, 200)}` : 'ok'}`);
}
console.log(
  `内核日志里出现的非本机地址：${[...hosts].map(([h, n]) => `${h} ×${n}`).join('、') || '（无）'}`,
);

const problems = [];
for (const [method, error] of steps)
  if (error) problems.push(`${method} 失败：配置可能把内核弄坏了`);
for (const host of hosts.keys()) {
  if (FORBIDDEN.test(host)) problems.push(`内核在请求 ${host}（K7：OpenAI 侧的服务不许出现）`);
  else if (!REGISTERED.some((pattern) => pattern.test(host)))
    problems.push(`内核在请求 ${host}：总纲 K6 登记表里没有它`);
}
if (problems.length > 0) {
  console.error(`\n✗ ${problems.join('\n✗ ')}`);
  process.exit(1);
}
console.log('\n✓ 没有发往 OpenAI 侧或未登记目的地的请求');
