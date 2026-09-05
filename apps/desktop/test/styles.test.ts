/**
 * 01 §9 验收项 1 的另一半：**CSS 里也不许有颜色与尺寸字面量**。
 *
 * eslint 的 `@evowork/no-style-literals` 只能看 `.ts` / `.tsx`，管不到 `.css`。
 * 而"把颜色写死"这件事在 CSS 里最容易发生 —— 所以这条断言在这里补上。
 *
 * 放行的例外与 lint 规则一致，且每条都有理由：
 *   · `1px` 边框宽度 —— 01 §4.5 明确要它（暗色下用 1px 描边替代阴影）；token 化一个永远等于 1 的值没有意义
 *   · `0` —— 无单位歧义
 *   · `100%` / `100vh` 等比例值 —— 不含 px
 *   · `@keyframes` 里的百分比与 `opacity` 数值 —— 它们不是尺寸也不是颜色
 *   · 动画时长（`1600ms` / `1400ms`）—— 呼吸与骨架的节奏，01 §6.1 / §4.4 直接给了数值且没有对应 token
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CSS_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src/renderer/styles/app.css',
);
const css = readFileSync(CSS_PATH, 'utf8');

/** 去掉注释：注释里会提到 `1px`、`3px` 这类文档原话 */
const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

describe('CSS 只用 token（01 §9 验收项 1）', () => {
  it('没有 hex 颜色', () => {
    const hits = code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hits, `发现 hex 颜色：${hits.join(', ')}`).toEqual([]);
  });

  it('没有 rgb() / hsl() 颜色函数', () => {
    const hits = code.match(/\b(?:rgba?|hsla?)\s*\(/g) ?? [];
    expect(hits, `发现颜色函数：${hits.join(', ')}`).toEqual([]);
  });

  it('没有除 0 / 1px 之外的 px 字面量', () => {
    // 媒体查询单独处理：见下一条
    const withoutMedia = code.replace(/@media[^{]+/g, '');
    const hits = (withoutMedia.match(/(?<![\w-])(\d+(?:\.\d+)?)px\b/g) ?? []).filter(
      (hit) => !['0px', '1px'].includes(hit),
    );
    expect(hits, `发现 px 字面量：${hits.join(', ')}`).toEqual([]);
  });

  /**
   * 媒体查询是 token 规则唯一的**技术性**例外：CSS 规范不允许在 `@media` 的条件里
   * 引用自定义属性（`@media (max-height: var(--x))` 不生效，且不报错）。
   *
   * 所以断点值只能是字面量。作为补偿，这里钉住"断点只能来自文档里写过的那几个" ——
   * 冒出一个 733px 立刻会红，而那通常意味着有人在对着自己的显示器调数字。
   */
  it('媒体查询的断点只能来自文档给过的值', () => {
    const documented = new Set([
      '720px', // 03 §3.1：窗口高 < 720 时 Hero 降级，保证 Composer 不被挤出首屏
      '860px', // 01 §3.1：< 860 不支持（= LAYOUT.unsupportedWidth）
      '1024px', // 01 §3.1：最小窗口宽（= LAYOUT.minWindowWidth）
    ]);
    const used = [...code.matchAll(/@media[^{]+/g)].flatMap(
      (m) => (m[0].match(/(?<![\w-])(\d+(?:\.\d+)?)px\b/g) ?? []) as string[],
    );
    const undocumented = used.filter((value) => !documented.has(value));
    expect(undocumented, `未登记的断点：${undocumented.join(', ')}`).toEqual([]);
  });

  it('算术必须包在 calc() 里 —— 裸的 `var(--x) * 2` 会让整条声明静默失效', () => {
    // 这条抓的是一个真实写错过的地方：`max-width: var(--space-64) * 10;`。
    // CSS 不报错，只是那条声明整体无效，表现为"这个块怎么撑满了整行"
    const offenders: string[] = [];
    for (const line of code.split('\n')) {
      if (!line.includes('var(--')) continue;
      const withoutCalc = line.replace(/calc\([^)]*\)/g, '');
      if (/var\(--[a-z0-9-]+\)\s*[*/+]/.test(withoutCalc)) offenders.push(line.trim());
    }
    expect(offenders, `这些行的算术没有 calc()：${offenders.join(' | ')}`).toEqual([]);
  });

  it('引用的都是真实存在的 token（拼错的 var 名会静默失效）', () => {
    // 这条是为了抓 `var(--bg-surfce)` 这类拼写错误：CSS 里拼错 var 名不报错，
    // 只会让那条声明整体失效 —— 表现是"某个地方没有背景色"，很难归因
    const referenced = new Set(
      [...code.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1] as string),
    );
    const generated = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/tokens/src/css.ts'),
      'utf8',
    );
    // 组件自己定义的局部变量（带 --ew- 前缀）不在 token 表里，跳过
    const missing = [...referenced].filter(
      (name) => !name.startsWith('--ew-') && !tokenExists(name, generated),
    );
    expect(missing, `引用了不存在的 token：${missing.join(', ')}`).toEqual([]);
  });
});

/**
 * token 是否存在。
 *
 * `css.ts` 是生成器（token 名来自 `palette.ts` 的键 + 前缀），所以这里做的是
 * "名字的词根在生成器或调色板里出现过"这种宽松检查 —— 严格做法要跑一遍生成，
 * 但那会让这条测试依赖生成器的实现细节。宽松版本足够抓拼写错误。
 */
function tokenExists(name: string, generatorSource: string): boolean {
  const bare = name.slice(2);
  const palette = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/tokens/src/palette.ts'),
    'utf8',
  );
  const haystack = `${generatorSource}\n${palette}`;
  // 生成器里 layout / z / space / r / shadow / font 是加前缀拼出来的，逐类核对
  for (const prefix of ['layout-', 'z-', 'space-', 'r-', 'shadow-', 'font-']) {
    if (bare.startsWith(prefix)) {
      const key = bare.slice(prefix.length);
      // kebab → camel（生成器用 kebab() 转过）
      const camel = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      return (
        haystack.includes(`'${key}'`) ||
        haystack.includes(`${camel}:`) ||
        haystack.includes(`'${camel}'`) ||
        /^\d+$/.test(key) ||
        // font-<name>-size/line/weight
        /^[a-z0-9-]+-(size|line|weight)$/.test(key)
      );
    }
  }
  return haystack.includes(`'${bare}'`) || haystack.includes(`${bare}:`);
}
