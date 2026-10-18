import { resizeWindow } from './assertions.mjs';
import { expect, test } from './fixtures.mjs';

test('项目悬浮卡展示目录与真实聊天数，置顶和编辑可用，窄窗口不裁切', async ({
  page,
  electronApp,
}, testInfo) => {
  const sidebar = page.getByRole('navigation', { name: '侧边栏', exact: true });
  const row = sidebar.getByRole('button', { name: 'UI', exact: true });
  const card = page.getByRole('region', { name: 'UI 项目信息', exact: true });
  const startup = await page.evaluate(() => window.evowork.getStartup());
  const project = startup.workspaces.find((item) => item.name === 'UI');
  await row.hover();
  await expect(card).toBeVisible();
  await expect(card).toContainText(project.path);
  await expect(card).toContainText('0 次聊天');
  const anchor = await row.boundingBox();
  const box = await card.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(anchor.x + anchor.width);
  await card.hover();
  await card.getByRole('button', { name: '置顶项目', exact: true }).click();
  await expect(card.getByRole('button', { name: '取消置顶项目', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await row.click();
  await page.getByRole('button', { name: '在项目中新建任务', exact: true }).click();
  await page.getByLabel('需求输入').fill('PROJECT_HOVER_COUNT');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .poll(async () => {
      const current = await page.evaluate(() => window.evowork.getStartup());
      return current.tasks.find((task) => task.projectId === project.id)?.status;
    })
    .toBe('completed');
  await row.click();
  await expect(page.getByRole('heading', { name: 'UI', exact: true })).toBeVisible();
  await page.getByRole('heading', { name: 'UI', exact: true }).hover();
  await row.hover();
  await expect(card).toContainText('1 次聊天');
  await page.screenshot({ path: testInfo.outputPath('project-hover.png') });
  await card.getByRole('button', { name: '编辑项目', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '编辑项目', exact: true });
  await dialog.getByLabel('项目名称', { exact: true }).fill('悬浮项目');
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(sidebar.getByRole('button', { name: '悬浮项目', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '悬浮项目', exact: true })).toBeVisible();
  await page.reload();
  const renamedRow = sidebar.getByRole('button', { name: '悬浮项目', exact: true });
  await renamedRow.hover();
  const renamedCard = page.getByRole('region', { name: '悬浮项目 项目信息', exact: true });
  await expect(
    renamedCard.getByRole('button', { name: '取消置顶项目', exact: true }),
  ).toBeVisible();
  await expect(renamedCard).toContainText('1 次聊天');
  for (const width of [900, 600]) {
    await resizeWindow(electronApp, width, 600);
    await renamedRow.hover();
    await expect(renamedCard).toBeVisible();
    const bounds = await renamedCard.boundingBox();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
    await expect(renamedCard.getByRole('button', { name: '编辑项目', exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`project-hover-${width}.png`) });
  }
});
