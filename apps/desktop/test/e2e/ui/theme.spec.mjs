/**
 * **L2 续：主题层的运行时断言。**
 *
 * `packages/tokens` 的单测证明的是「token 的值对不对」，`test/styles.test.ts` 证明的是
 * 「源码里没写死字面量」。两者都在**源码层**。真窗口能验的是第三件事：
 * **那些覆盖规则在浏览器里真的生效了吗，而且只动了它该动的东西。**
 */
import { expect, test } from './fixtures.mjs';

/** 读一批 CSS 变量当前解析成什么 */
function readTokens(page, names) {
  return page.evaluate((list) => {
    const cs = getComputedStyle(document.documentElement);
    return Object.fromEntries(list.map((n) => [n, cs.getPropertyValue(n).trim()]));
  }, names);
}

test('高对比度模式只改那三个边框 token，别的一个都不动', async ({ page }) => {
  /*
   * `css.ts` 的头注释把三层覆盖写得很死：
   *   `:root`（浅色）→ `prefers-contrast: more` / `[data-contrast=high]`（**只覆盖三个边框 token**）
   *
   * 「只覆盖三个」这句话此前没有任何东西验证。写错一个选择器的后果不是报错，
   * 是**高对比度下整套配色跟着变** —— 而开了这个模式的用户往往正是最看不清的那批人。
   */
  const BORDERS = ['--border-subtle', '--border-default', '--border-strong'];
  const OTHERS = ['--bg-app', '--bg-surface', '--text-primary', '--text-secondary', '--accent'];

  const normalBorders = await readTokens(page, BORDERS);
  const normalOthers = await readTokens(page, OTHERS);
  for (const [name, value] of Object.entries(normalBorders)) {
    expect(value, `${name} 没有解析出值 —— token 根本没注入`).not.toBe('');
  }

  await page.emulateMedia({ contrast: 'more' });

  const highBorders = await readTokens(page, BORDERS);
  const highOthers = await readTokens(page, OTHERS);

  // ① 三个边框真的变了（规则没生效的话它们会原封不动）
  for (const name of BORDERS) {
    expect(
      highBorders[name],
      `${name} 在高对比度下没有变 —— 覆盖规则没生效，用户开了这个模式却什么都没得到`,
    ).not.toBe(normalBorders[name]);
  }

  // ② 别的一个都没动 —— 这才是「只覆盖三个」那句话的含义
  expect(highOthers, '高对比度把边框以外的 token 也改了 —— 选择器圈大了').toEqual(normalOthers);

  // 收尾：把媒体特性放回去，免得影响同一 worker 里后面的用例
  await page.emulateMedia({ contrast: 'no-preference' });
});

test('键盘走到哪里，哪里就要看得见', async ({ page }) => {
  /*
   * 焦点环是**只有真窗口能验**的东西：jsdom 没有 `:focus-visible`，也没有 outline。
   * 而"焦点不可见"这种缺陷对鼠标用户完全无感，对键盘用户则是整个界面不可用。
   *
   * 判据取「有 outline 或有 box-shadow」，不指定具体样式：01 允许两种做法，
   * 钉死其中一种会让改设计的人被迫来改测试。
   */
  await page.getByLabel('需求输入').focus();
  await page.keyboard.press('Tab');

  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    return {
      tag: el.tagName,
      label: el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 20) ?? '',
      outlineWidth: parseFloat(cs.outlineWidth) || 0,
      outlineStyle: cs.outlineStyle,
      boxShadow: cs.boxShadow,
    };
  });

  expect(focus, 'Tab 之后没有任何元素拿到焦点 —— 键盘用户走不进这个界面').not.toBeNull();
  const visible =
    (focus.outlineWidth > 0 && focus.outlineStyle !== 'none') ||
    (focus.boxShadow !== 'none' && focus.boxShadow !== '');
  expect(
    visible,
    `焦点落在「${focus.label || focus.tag}」上却看不出来（outline ${focus.outlineStyle} ${focus.outlineWidth}px，shadow ${focus.boxShadow}）`,
  ).toBe(true);
});
