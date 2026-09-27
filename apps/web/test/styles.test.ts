/**
 * CSS 也不许有颜色与尺寸字面量（与桌面 styles.test.ts 同一条）。
 *
 * 两份都要扫：账号应用的 `app.css` 与分享页的 `share.css`。
 * 分享页是独立 bundle，但它不因此获得一套自己的颜色 —— token 只有一份。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

function stylesheet(path: string): string {
  return readFileSync(resolve(HERE, path), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

describe.each([
  ['账号应用 app.css', '../src/app.css'],
  ['分享页 share.css', '../src/share/share.css'],
])('%s 只用 token', (_name, path) => {
  it('没有 hex / rgb / 非 1 的 px', () => {
    const css = stylesheet(path);
    expect(css).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
    const px = [...css.matchAll(/(\d+)px/g)].map((m) => m[1]);
    expect(px.every((n) => n === '1' || n === '0')).toBe(true);
  });
});
