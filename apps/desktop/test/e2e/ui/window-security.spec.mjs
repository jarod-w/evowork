/**
 * **窗口这一层的三条安全行为**：最小尺寸 · 外链不在应用窗口打开 · 任何导航都被阻止。
 *
 * `bootstrap.test.ts` 验的是「我们把对的参数传下去了」。参数对不等于行为对 ——
 * Electron 收下一个选项却不生效（或者被后面某处覆盖掉）时，单测一片绿。
 * 这三条只有在**真窗口**上才问得出答案。
 *
 * 后两条是 K6 在前端的落点：渲染进程带着 preload 桥，把它导航到外部页面等于
 * 把那座桥交出去。`index.html` 的 CSP 写着 `connect-src 'none'`，而 CSP 管不了导航。
 */
import { expect, test } from './fixtures.mjs';

/** `.invalid` 是保留顶级域，永远解析不到 —— 万一拦截失效，也不会有请求真的出网。 */
const OUTSIDE = 'https://evowork.invalid/';

test('窗口缩不到 480×600 以下（01 §1 / §4.2）', async ({ page, electronApp }) => {
  /*
   * 比最小值更小的界面不是"挤一点"，是**功能拿不到** —— 三栏塌掉之后
   * Composer 和结果区会互相盖住。所以这条是硬下限，不是建议值。
   */
  const size = await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setSize(200, 200);
    return w.getSize();
  });
  expect(size, `窗口被缩到了 ${size.join('×')} —— 最小尺寸没有生效`).toEqual([480, 600]);
  // 顺带确认界面还在（真缩到 200 的话这一条也会红）
  await expect(page.getByLabel('需求输入')).toBeVisible();
});

test('外链不在应用窗口里打开 —— 那等于把 preload 桥交出去', async ({ page, electronApp }) => {
  const before = electronApp.windows().length;
  await page.evaluate((url) => {
    window.open(url, '_blank');
  }, OUTSIDE);
  await page.waitForTimeout(1500);

  /*
   * 断言**没有新窗口**，而不是"handler 被调用了"。新开的那扇窗会带着同一份
   * `webPreferences`（含 preload），于是一个外部页面就拿到了 `window.evowork` 的全部动作。
   */
  expect(electronApp.windows().length, '外链开出了一扇新窗口 —— 它会带着 preload 桥').toBe(before);
  await expect(page.getByLabel('需求输入')).toBeVisible();
});

test('任何导航都被阻止 —— 页面只能是我们打包的那一个', async ({ page, electronApp }) => {
  const read = () =>
    electronApp.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      return { url: wc.getURL(), crashed: wc.isCrashed() };
    });

  const before = await read();
  expect(before.url.startsWith('file://'), '起手就不是本地页面').toBe(true);
  await expect(page.getByLabel('需求输入')).toBeVisible();

  await page.evaluate((url) => {
    window.location.href = url;
  }, OUTSIDE);
  await page.waitForTimeout(1500);

  /*
   * **判据必须从主进程取。**
   *
   * `will-navigate` 被 preventDefault 之后，Chromium 里那次导航停在"进行中"不再收尾，
   * 于是渲染侧的任何查询都会卡在 Playwright 的 "waiting for navigation to finish"
   * —— 界面其实完好无损（失败快照里侧栏渲染得好好的），只是问不出话来。
   * 第一版就栽在这儿：拦截明明成功，测试却红在一句"输入框不可见"上。
   *
   * CSP 的 `connect-src 'none'` 管 fetch，**管不了导航**。拦不住的话渲染进程会带着
   * preload 桥去到别人的页面上 —— 那是 K6「没有出网路径」在前端唯一可能被绕开的地方。
   */
  const after = await read();
  expect(after.url, '页面被导航走了 —— preload 桥跟着一起出去了').toBe(before.url);
  expect(after.crashed, '渲染进程崩了').toBe(false);
});
