import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
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

// `node_modules/.bin/electron` 会再派生一层真正的 Electron；超时时只杀到 shim，
// macOS 上 GUI 进程会变成孤儿并继续占着 stdout。直接启动包导出的二进制，
// 才能让测试超时与 CI 清理都可靠。
const electron = require('electron');
const entry = resolve(root, 'apps/desktop/test/e2e/skill-reference.e2e.mjs');
const child = spawn(electron, [entry], {
  cwd: root,
  env: {
    ...process.env,
    EVOWORK_E2E_REPO_ROOT: root,
    EVOWORK_APP_SERVER: kernel,
  },
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

const timeout = setTimeout(() => child.kill('SIGKILL'), 90_000);
const code = await new Promise((resolveExit) => child.on('close', resolveExit));
clearTimeout(timeout);
if (code !== 0) throw new Error(`桌面 E2E 失败（退出码 ${String(code)}）\n${stderr}`);
const marker = stdout.split(/\r?\n/).findLast((line) => line.startsWith('__EVOWORK_DESKTOP_E2E__'));
if (!marker) throw new Error('桌面 E2E 没有返回验收结果。');
const result = JSON.parse(marker.slice('__EVOWORK_DESKTOP_E2E__'.length));
if (result.ok !== true) throw new Error(`桌面 E2E 未通过：${JSON.stringify(result)}`);
console.log('✅ 真实 app-server + Electron 技能引用 E2E 通过');
