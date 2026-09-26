/**
 * **剩下五个视图**：插件 · 项目 · 项目详情 · 独立搜索 · 审计。
 *
 * 它们各自都有组件测试，而组件测试证明不了**入口接没接通** —— 一个没挂上 onClick 的
 * 侧栏按钮，组件那边渲染得好好的。「看起来做完了」在这个项目里最常见的形状就是这个。
 *
 * 每条同样跑一遍几何体检（`assertions.mjs`）：一个视图的列宽写死了，别的视图一点事都没有。
 */
import { horizontalOverflow, resizeWindow, silentlyClippedText } from './assertions.mjs';
import { expect, test } from './fixtures.mjs';

async function expectLayoutIsSound(page, electronApp, view) {
  await resizeWindow(electronApp, 900, 760);
  await expect
    .poll(() => horizontalOverflow(page), { message: `${view} 把页面撑破了` })
    .toBeLessThanOrEqual(1);
  const { examined, bad } = await silentlyClippedText(page);
  expect(examined, `${view} 里一个候选都没扫到 —— 这条判据此刻什么都没在守`).toBeGreaterThan(0);
  expect(bad, `${view} 里有文字被无声硬裁：既没有省略号也没有 title`).toEqual([]);
}

test('插件：三个分类 Tab 都切得动，搜索框在', async ({ page, electronApp }) => {
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await expect(page.getByRole('heading', { name: '精选技能' })).toBeVisible();

  /*
   * 三个 Tab 是 05 的「技能 · 连接器 · 专家」三分。少一个的后果不是报错，
   * 是那一类插件从此没有入口 —— 而它们各自的组件测试照样全绿。
   */
  for (const tab of ['专家', '技能', '连接器']) {
    await expect(page.getByRole('tab', { name: tab, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('searchbox', { name: '搜索技能' })).toBeVisible();
  await expectLayoutIsSound(page, electronApp, '插件');
});

test('项目：列表在，搜索在，每个项目都有更多操作', async ({ page, electronApp }) => {
  await page.getByRole('button', { name: '项目', exact: true }).first().click();
  await expect(page.getByRole('searchbox', { name: '搜索项目' })).toBeVisible();
  /*
   * 引导里建的那个项目要真的列出来 —— 列表只读 props 的话，组件测试看不出接线断了。
   * `locator('button')` 收窄是必要的：卡片本身也顶着同一个 aria-label（`role="button"` 的 div），
   * 不收窄会撞上 Playwright 的严格模式。
   */
  await expect(page.locator('button[aria-label="UI 的更多操作"]')).toBeVisible();
  await expect(page.getByRole('button', { name: '新建项目' })).toBeVisible();
  await expectLayoutIsSound(page, electronApp, '项目');
});

test('项目详情：四个 Tab 逐个切得过去', async ({ page, electronApp }) => {
  // 从侧栏直接进 —— 那是用户最常走的那条，也比在列表里挑卡片稳
  await page
    .locator('nav[aria-label="侧边栏"]')
    .getByRole('button', { name: 'UI', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'UI', level: 1 })).toBeVisible();

  /*
   * 04 的项目页四分。断言「点了之后当前 Tab 真的变了」而不是「按钮在」——
   * 挂错 onChange 的表现就是点了没反应，而按钮一直都在。
   */
  const tabs = page.getByRole('tablist', { name: '项目内容' });
  await expect(tabs).toBeVisible();
  for (const label of ['任务', '文件', '项目说明', '自动化']) {
    const tab = tabs.getByRole('tab', { name: label, exact: true });
    await tab.click();
    await expect(tab, `点了「${label}」却没有变成当前 Tab`).toHaveAttribute(
      'aria-selected',
      'true',
    );
  }
  await expectLayoutIsSound(page, electronApp, '项目详情');
});

test('独立搜索：打得开，快捷操作在', async ({ page, electronApp }) => {
  await page.getByRole('button', { name: '打开搜索框' }).click();
  // section 与它里面的输入框顶着同一个 aria-label；section 用 CSS 定位最直接
  await expect(page.locator('section[aria-label="搜索聊天"]')).toBeVisible();
  await expect(page.getByRole('searchbox', { name: '搜索聊天' })).toBeVisible();
  // 快捷操作是空结果时唯一的出路，没有它这个面板就是个死胡同
  await expect(page.getByRole('list', { name: '快捷操作' })).toBeVisible();
  await expectLayoutIsSound(page, electronApp, '搜索');
});

test('审计：进得去，筛选与导出都在', async ({ page, electronApp }) => {
  await page.getByRole('button', { name: /菜单$/ }).click();
  await page.getByRole('menuitem', { name: '用量与审计' }).click();
  await expect(page.getByRole('heading', { name: '用量与审计' })).toBeVisible();

  /*
   * 两个导出入口是审计页存在的理由之一（10 §3 的审计链要能被带走）。
   * 它们不在的话，页面只是一个看不了几行的列表。
   */
  await expect(page.getByRole('button', { name: '导出 CSV' })).toBeVisible();
  await expect(page.getByRole('button', { name: '导出 JSONL' })).toBeVisible();
  await expect(page.getByLabel('时间范围')).toBeVisible();
  await expect(page.getByLabel('动作类型')).toBeVisible();
  await expectLayoutIsSound(page, electronApp, '审计');
});
