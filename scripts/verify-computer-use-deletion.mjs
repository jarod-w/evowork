#!/usr/bin/env node
/** CU-M0：只操作 mkdtemp 内的测试历史；通过 JSON-RPC 写入/归档/删除，磁盘只读验收。 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const binary = process.env.EVOWORK_APP_SERVER;
if (!binary) throw new Error('请设置 EVOWORK_APP_SERVER，必须是待验收版本的 app-server');
const root = mkdtempSync(join(tmpdir(), 'evowork-cu-delete-'));
const marker = 'CU_DELETE_PROBE_' + Date.now();
const image =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=';
const child = spawn(resolve(binary), [], {
  env: { ...process.env, CODEX_HOME: root },
  stdio: ['pipe', 'pipe', 'ignore'],
});
const pending = new Map();
let sequence = 0;
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return;
  }
  if (value.method && value.id !== undefined) {
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: value.id,
        result: { action: 'decline', content: null, _meta: null },
      }) + '\n',
    );
    return;
  }
  const request = pending.get(value.id);
  if (!request) return;
  clearTimeout(request.timer);
  pending.delete(value.id);
  if (value.error) request.reject(new Error(JSON.stringify(value.error)));
  else request.resolve(value.result);
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`TIMEOUT ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}
function retained() {
  return files(root)
    .filter((path) => /\.jsonl$|\.json$/.test(path))
    .filter((path) => {
      const data = readFileSync(path, 'utf8');
      return data.includes(marker) || data.includes(image);
    });
}
try {
  await request('initialize', {
    clientInfo: { name: 'evowork-cu-deletion-probe', version: '1' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n');
  const result = await request('thread/start', {
    cwd: root,
    model: 'gpt-5',
    approvalPolicy: 'never',
    persistExtendedHistory: true,
  });
  const id = result.thread.id;
  await request('thread/inject_items', {
    threadId: id,
    items: [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: marker },
          { type: 'input_image', image_url: `data:image/png;base64,${image}` },
        ],
      },
    ],
  });
  await request('thread/archive', { threadId: id });
  assert.ok(retained().length > 0, '归档必须保留注入的正文和图片');
  const before = await request('thread/read', { threadId: id, includeTurns: true });
  assert.equal(before.thread.id, id);
  await request('thread/delete', { threadId: id });
  assert.equal(retained().length, 0, '删除之后测试正文/图片不能留在 JSON 历史');
  await assert.rejects(request('thread/read', { threadId: id, includeTurns: true }));
  console.log(
    JSON.stringify({
      ok: true,
      root,
      archivedRetained: true,
      deletedHistory: true,
      limitation:
        '验证了注入图文的历史删除；MCP 工具结果/blob/备份导出仍须独立验收，不生成 releaseVerified 标记。',
    }),
  );
} finally {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  child.kill();
  lines.close();
  // 保留测试目录作为验收证据；不删除用户或内核目录。
}
