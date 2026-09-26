/**
 * **资料库 · 自动化 · 设置**：三个此前只有组件测试、从没被真窗口走过的视图。
 *
 * 每条旅程都做两件事：
 *   ① 从侧边栏真的**走得进去**（入口接没接通，是最常见的"看起来做完了"）；
 *   ② 进去之后**几何是成立的** —— 不横向溢出、没有被无声硬裁的文字。
 *
 * 第 ② 件在每个视图上重复，正是因为它在每个视图上都可能单独坏掉：
 * 一个视图的列宽写死了，别的视图一点事都没有。
 */
import { horizontalOverflow, resizeWindow, silentlyClippedText } from './assertions.mjs';
import { expect, test } from './fixtures.mjs';

/** 每个视图都要过的几何体检。窄窗口下做 —— 宽的时候什么都挤得下。 */
async function expectLayoutIsSound(page, electronApp, view) {
  await resizeWindow(electronApp, 900, 760);
  await expect
    .poll(() => horizontalOverflow(page), { message: `${view} 把页面撑破了` })
    .toBeLessThanOrEqual(1);

  const { examined, bad } = await silentlyClippedText(page);
  expect(examined, `${view} 里一个候选元素都没扫到 —— 这条判据此刻什么都没在守`).toBeGreaterThan(0);
  expect(bad, `${view} 里有文字被无声硬裁：既没有省略号也没有 title`).toEqual([]);
}

test('资料库：从侧边栏进得去，两栏都在，布局站得住', async ({ page, electronApp }) => {
  await page.getByRole('button', { name: '资料库' }).click();

  // 两栏都要在：只有主区没有导航的话，用户进得去但找不到东西
  await expect(page.getByRole('main', { name: '资料库' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '资料库导航' })).toBeVisible();

  await expectLayoutIsSound(page, electronApp, '资料库');
});

test('自动化：从侧边栏进得去，能看到新建入口', async ({ page, electronApp }) => {
  await page.getByRole('button', { name: '自动化' }).click();

  /*
   * 「新建自动化」是这个页面唯一的**写入口**。它不在的话页面只是个只读列表，
   * 而 Q8 的整套调度能力就没有任何地方能被用到。
   */
  await expect(page.getByRole('button', { name: '新建自动化' })).toBeVisible();

  await expectLayoutIsSound(page, electronApp, '自动化');
});

test('设置：菜单里进得去，每个分区都点得开', async ({ page, electronApp }) => {
  /*
   * **声明的分区与渲染出来的分区必须逐项相等。**
   *
   * 这正是 CLAUDE.md 夸过的那种钉法。少一个的后果是"某个设置从此打不开"，
   * 而那在组件测试里看不出来 —— 组件自己渲染得好好的，没被挂上去而已。
   */
  const EXPECTED = ['账号', '模型', '个性化', '用量与预算', '数据管理', '安全与权限', '关于与更新'];

  await page.getByRole('button', { name: /菜单$/ }).click();
  await page
    .getByRole('menu', { name: '用户菜单' })
    .getByRole('menuitem', { name: '设置' })
    .click();

  const nav = page.getByRole('navigation', { name: '设置分类' });
  await expect(nav).toBeVisible();
  const labels = await nav.getByRole('button').allInnerTexts();
  expect(
    labels.map((t) => t.trim()),
    '设置页渲染出来的分区与 SETTINGS_SECTIONS 对不上',
  ).toEqual(EXPECTED);

  // 每个分区都要真的切得过去（挂错 onClick 的表现是"点了没反应"）
  for (const label of EXPECTED) {
    await nav.getByRole('button', { name: label, exact: true }).click();
    await expect(
      nav.getByRole('button', { name: label, exact: true }),
      `点了「${label}」却没有变成当前分区`,
    ).toHaveAttribute('aria-current', 'page');
  }

  await expectLayoutIsSound(page, electronApp, '设置');
});
