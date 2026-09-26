/**
 * **L2：真实布局的几何回归。**
 *
 * jsdom 不做布局 —— 它报的每个元素都是 0×0，位于 (0,0)。所以"两个东西压在一起"
 * 这类缺陷在组件测试里**永远是绿的**，只能靠人打开应用用眼睛发现。
 * [status.md](../../../../../docs/status.md) 里那条「macOS 交通灯与 EvoWork 品牌名重叠」
 * 就是这么被发现的，而它当时已经有完整的组件测试。
 *
 * 这里的断言都绑在 **token 与窗口尺寸**上，不绑魔数：规则失效会红，调间距不会误报。
 */
import { expect, test } from './fixtures.mjs';

/** 两个矩形有没有相交 */
function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** 改窗口大小要改**原生窗口**：Electron 里 setViewportSize 不管用 */
async function resizeWindow(electronApp, width, height) {
  await electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height);
    },
    { width, height },
  );
}

test('macOS：交通灯的位置是留出来的，品牌名不会被压住', async ({ page }) => {
  test.skip(
    process.platform !== 'darwin',
    '只有 macOS 用 hiddenInset —— 别的平台是系统标题栏，没有交通灯浮在内容上',
  );

  // ① 平台标记要在。它没了，下面那条留位的 CSS 规则就整条失效而界面不会报错
  await expect(page.locator('html')).toHaveAttribute('data-platform', 'macos');

  /*
   * ② **交通灯底下不许有内容。**
   *
   * 这条就是 status.md 那次回归（「EvoWork 品牌名与窗口控件重叠」）的判据。
   *
   * 矩形是 **macOS 的事实**，不是我们的 token：hiddenInset 下系统把三颗按钮画在
   * 窗口左上角，直径 12px、竖直居中在标题栏上沿附近。取 80×40 是保守估计
   * （三颗加间距约 64px 宽），宁可多圈一点也不要漏判。
   *
   * 曾经想把它绑到 `--space-40`（CSS 拿它做 `::before` 的宽度），实测放弃了：
   * 把那个宽度改成 0 之后**几何一个像素都不变** —— 真正在推挤的是同一条规则里的
   * `margin-right: auto`，而侧栏从没窄到让那 40px 生效。绑在那个 token 上的断言
   * 会永远是绿的，无论规则还在不在。
   */
  const TRAFFIC_LIGHTS = { x: 0, y: 0, width: 80, height: 40 };
  const intruders = await page.evaluate((rect) => {
    const hits = [];
    for (const el of document.querySelectorAll('button, a, input, textarea, [class*="brand"]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const hit =
        r.left < rect.x + rect.width &&
        rect.x < r.right &&
        r.top < rect.y + rect.height &&
        rect.y < r.bottom;
      if (hit)
        hits.push(`${el.className || el.tagName} @(${Math.round(r.left)},${Math.round(r.top)})`);
    }
    return hits;
  }, TRAFFIC_LIGHTS);
  expect(
    intruders,
    '有内容落在 macOS 交通灯底下 —— 用户会点不到它，或者点出一个意外的窗口动作',
  ).toEqual([]);

  // ②b 品牌区另起一行，不和标题栏那条带子叠在一起（交通灯就浮在那条带子上）
  const bar = await page.locator('.ew-sidebar-titlebar').boundingBox();
  const brandBox = await page.locator('.ew-sidebar-brand').boundingBox();
  expect(brandBox, '侧边栏品牌区没有布局出来').not.toBeNull();
  expect(overlaps(brandBox, bar), '品牌名压在了标题栏带子上 —— 交通灯就在那儿').toBe(false);

  // ③ 品牌区和折叠按钮不许互相压住
  const collapse = await page.getByRole('button', { name: '折叠侧边栏' }).boundingBox();
  expect(collapse).not.toBeNull();
  expect(overlaps(brandBox, collapse), '品牌区和折叠按钮重叠了 —— 窄侧栏下最容易出的那种').toBe(
    false,
  );
});

test('三个断点下都不出现横向滚动条', async ({ page, electronApp }) => {
  /*
   * app.css 的断点是 1100 / 760 / 480。**每个都要比它窄一点去试** ——
   * 正好等于断点值时走的是另一条分支，而出问题的一向是刚过线那一侧。
   *
   * 横向滚动条是"有东西撑破了容器"最可靠的信号：它不挑具体元素，
   * 所以不会因为界面改版而失效。
   */
  for (const width of [1080, 740, 460]) {
    await resizeWindow(electronApp, width, 800);
    /*
     * 轮询到「不溢出」为止，而不是先 sleep 再看一眼：resize 之后布局要几帧才稳，
     * 固定等待要么太短（偶发红）要么太长（三个断点每个都白等）。
     * 容 1px 是亚像素取整，不是给溢出留口子。
     */
    await expect
      .poll(
        () =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        { message: `窗口 ${width}px 时页面横向被撑破` },
      )
      .toBeLessThanOrEqual(1);
  }
});
