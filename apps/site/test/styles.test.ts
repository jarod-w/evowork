import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('官网 site.css 遵守 token-only 色值约束', () => {
  it('不包含硬编码 hex 或 rgb/rgba 颜色字面量', () => {
    const css = readFileSync(resolve(HERE, '../src/site.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    expect(css).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(css).not.toMatch(/\brgba?\(/);
  });
});
