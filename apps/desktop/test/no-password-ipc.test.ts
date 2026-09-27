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

/**
 * 2026-09-27 登记：分享链接的口令**刻意不叫 `password`**。
 *
 * 接分享链路时撞上了上面那条守卫 —— 而它拦对了：账号密码与分享访问码是两件事，
 * 共用一个名字会让这条口令有一天被顺手接进账号那条路，也会让上面那条断言
 * 从"绝对没有"退化成"有几个例外"。所以改的是名字，不是守卫。
 */
describe('分享的访问码不叫 password', () => {
  it('IPC 契约里是 accessCode，且它带着为什么', () => {
    const ipc = readFileSync(join(ROOT, 'src/shared/ipc.ts'), 'utf8');
    expect(ipc).toContain('readonly accessCode?: string | undefined;');
    expect(ipc).toContain('字段名不叫 `password`，这是刻意的');
  });

  it('分享模态里也没有 password 标识符 —— 它是渲染层，同样在客户端进程里', () => {
    const dialog = readFileSync(join(ROOT, 'src/renderer/components/share-dialog.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      // `type="password"` 是 HTML 属性值，必须留着（否则输入框会明文显示口令）——
      // 这条断言管的是**标识符**，不是那个属性
      .replace(/type="password"/g, '');
    expect(dialog).not.toMatch(/\bpassword\b/);
    // 但界面上那个词仍然是「访问密码」——改的是标识符，不是给用户看的文案
    expect(readFileSync(join(ROOT, 'src/renderer/components/share-dialog.tsx'), 'utf8')).toContain(
      '访问密码',
    );
  });
});
