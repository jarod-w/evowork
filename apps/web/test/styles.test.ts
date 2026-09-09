/**
 * CSS 也不许有颜色与尺寸字面量（与桌面 styles.test.ts 同一条）。
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const css = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../src/app.css'),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

describe('web CSS 只用 token', () => {
  it('没有 hex / rgb / 非 1 的 px', () => {
    expect(css).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
    const px = [...css.matchAll(/(\d+)px/g)].map((m) => m[1]);
    expect(px.every((n) => n === '1' || n === '0')).toBe(true);
  });
});
