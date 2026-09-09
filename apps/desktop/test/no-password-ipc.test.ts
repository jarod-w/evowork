/**
 * Q33=A / 11 §12 第 12 条：密码只出现在 WEB 表单与 identity 服务端。
 *
 * 客户端进程、IPC 契约、桌面 app.toml 里都没有 `password` 这个标识符
 * （注释里写「没有 password」是合法的）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const CLIENT_FILES = [
  'src/shared/ipc.ts',
  'src/preload/index.ts',
  'src/main/account.ts',
  'src/main/app-config.ts',
  'src/main/renderer-bridge.ts',
  'src/main/service-host.ts',
  'src/main/bootstrap.ts',
];

describe('客户端没有 password 字段', () => {
  it('IPC / 宿主 / app-config 里没有 password 标识符', () => {
    const hits: string[] = [];
    for (const rel of CLIENT_FILES) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      if (/\breadonly password\b|\bpassword\?:|\bpassword:/.test(text)) {
        hits.push(rel);
      }
      if (/['"]password['"]/.test(text) && !text.includes('没有 password')) {
        hits.push(`${rel}:string-literal`);
      }
    }
    expect(hits, `客户端出现了 password 字段：${hits.join(', ')}`).toEqual([]);
  });
});
