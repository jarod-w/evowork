#!/usr/bin/env node
/** 不请求 TCC：验证本机 Helper 进程的 stdio 帧与 health 握手。 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') throw new Error('原生 Helper 健康检查仅支持 macOS');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const app = join(root, 'build/computer-use/EvoWork Computer Use.app/Contents');
const release = JSON.parse(readFileSync(join(app, 'Resources/release.json'), 'utf8'));
const body = Buffer.from(JSON.stringify({ method: 'health', params: {} }));
const header = Buffer.alloc(4);
header.writeUInt32BE(body.length);

const child = spawn(join(app, 'MacOS/EvoWorkComputerUse'), [], {
  stdio: ['pipe', 'pipe', 'ignore'],
  env: { EVOWORK_CUA_BUILD_VERSION: release.buildVersion },
});
const output = await new Promise((resolveOutput, reject) => {
  let chunks = [];
  let size = 0;
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error('Helper health 握手超时'));
  }, 10000);
  child.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.stdout.on('data', (chunk) => {
    size += chunk.length;
    if (size > 16 * 1024 * 1024 + 4) {
      child.kill();
      clearTimeout(timer);
      reject(new Error('Helper health 响应超过帧上限'));
      return;
    }
    chunks.push(chunk);
  });
  child.on('close', (code, signal) => {
    clearTimeout(timer);
    if (code !== 0) reject(new Error(`Helper health 进程异常退出：${signal ?? code}`));
    else resolveOutput(Buffer.concat(chunks));
    chunks = [];
  });
  child.stdin.end(Buffer.concat([header, body]));
});
if (output.length < 4 || output.readUInt32BE(0) !== output.length - 4)
  throw new Error('Helper health 响应帧长度无效');
const response = JSON.parse(output.subarray(4).toString('utf8'));
if (
  response.ok !== true ||
  response.value?.protocolVersion !== 1 ||
  response.value?.buildVersion !== release.buildVersion ||
  typeof response.value?.accessibility !== 'boolean' ||
  typeof response.value?.screenRecording !== 'boolean'
)
  throw new Error('Helper health 响应字段无效');
console.log('Helper health 握手通过；未请求 AX 或截图内容。');
