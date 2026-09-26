/**
 * **结果区的三类受控 fence**（04 §7）：mermaid → SVG · evowork-chart → 图 · html → 沙箱 iframe。
 *
 * 这是 jsdom 盲区里最大的一块。组件测试给 Visualizer **注入了一个假渲染器**
 * （`visualizer.tsx` 的头注释写明了原因：mermaid 是个大依赖，它的加载属于 M9），
 * 所以"真的画出了一张图没有"从来没人验过 —— jsdom 没有布局、没有 SVG 排版，
 * 而 mermaid 是在第一次真要画图时才 `import()` 进来的。
 *
 * iframe 那条更要紧：**给 `allow-scripts` 但不给 `allow-same-origin`**。
 * 两个一起给等于没有沙箱 —— iframe 里的脚本能访问父页面的同源资源，
 * 而父页面带着 preload 桥。这条只有在真 DOM 上才量得到。
 */
import { expect, test } from './fixtures.mjs';

/** 让模型回一段指定正文，然后等它渲染完 */
async function replyWith(page, electronApp, text) {
  await electronApp.evaluate((_electron, payload) => {
    globalThis.__evoworkE2E.gateway.scriptNext({ kind: 'text', text: payload });
  }, text);
  await page.getByLabel('需求输入').fill('画个图');
  await page.getByRole('button', { name: '发送' }).click();
  await expect(page.getByRole('main', { name: '对话区' })).toBeVisible();
}

test('mermaid fence 真的被渲染成 SVG', async ({ page, electronApp }) => {
  await replyWith(
    page,
    electronApp,
    '这是流程：\n\n```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```\n',
  );

  /*
   * 断言**真的有 `<svg>` 且有内容**，不是"代码块显示出来了"。
   * 渲染失败时 Visualizer 会退回显示源码 —— 那在文本断言下看着一样对。
   */
  // 必须收窄到 Visualizer 自己的容器：对话区里还有一堆 16px 的图标 svg，
  // 第一版用 `svg` 直接 `.first()` 抓到的就是其中一个（断言报的"宽度 16"救了这条）
  const svg = page.locator('.ew-visualizer-svg svg').first();
  await expect(svg).toBeVisible({ timeout: 60_000 });
  const box = await svg.boundingBox();
  expect(box, 'SVG 没有布局出来').not.toBeNull();
  expect(box.width, '画出来的 SVG 宽度为 0 —— 等于没画').toBeGreaterThan(20);
  expect(box.height).toBeGreaterThan(10);

  // 图里要真的有那两个节点的文字，否则只是个空壳
  await expect(page.locator('.ew-visualizer-svg')).toContainText('开始');
});

test('html fence 进沙箱 iframe，而且拿不到 same-origin', async ({ page, electronApp }) => {
  await replyWith(page, electronApp, '预览：\n\n```html\n<p id="probe">来自模型的 HTML</p>\n```\n');

  const frame = page.locator('main[aria-label="对话区"] iframe').first();
  await expect(frame).toBeVisible({ timeout: 30_000 });

  /*
   * **两个属性一起看**。只给 `allow-scripts` 是有意的；一旦同时出现
   * `allow-same-origin`，沙箱就名存实亡 —— iframe 里的脚本能读父页面，
   * 而父页面挂着 preload 桥。`visualizer.tsx:14-16` 专门写了这一条。
   */
  const sandbox = (await frame.getAttribute('sandbox')) ?? '';
  expect(sandbox, 'iframe 根本没有 sandbox 属性').not.toBe('');
  expect(
    sandbox.split(/\s+/),
    '沙箱同时给了 allow-scripts 和 allow-same-origin —— 等于没有沙箱',
  ).not.toContain('allow-same-origin');
});

test('evowork-chart 的非法 spec 被拒绝渲染，并把原始 JSON 显示出来', async ({
  page,
  electronApp,
}) => {
  /*
   * 04 §7 要求 spec 先过 Schema 校验，**非法字段拒绝渲染并显示原始 JSON**。
   * 这条比"合法 spec 能画出来"更值得钉：静默画出一张错的图，用户不会知道；
   * 而这正是"拒绝"这个行为存在的理由。
   */
  await replyWith(
    page,
    electronApp,
    '图：\n\n```evowork-chart\n{"type":"不存在的图型","数据":123}\n```\n',
  );

  const conversation = page.getByRole('main', { name: '对话区' });
  // 原始 JSON 要看得见 —— 看不见的话用户只知道"图没出来"，不知道为什么
  await expect(conversation).toContainText('不存在的图型', { timeout: 30_000 });
});
