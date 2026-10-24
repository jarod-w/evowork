/** 全新用户首次启动直接进入主界面，不经过引导。 */
import { realpathSync } from 'node:fs';
import { expect, test } from './fixtures.mjs';

test.use({ freshStart: true });

test('首次启动直接进入主界面，刷新后仍可使用，不创建默认项目', async ({ page }, testInfo) => {
  await expect(page.getByLabel('需求输入')).toBeVisible();
  await expect(page.getByRole('heading', { name: '欢迎使用 EvoWork' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '文档解析组件' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '开始使用', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '现在安装', exact: true })).toHaveCount(0);
  const initial = await page.evaluate(() => window.evowork.getWorkingDirectory());
  expect(initial.isDefault).toBe(true);
  expect((await page.evaluate(() => window.evowork.getStartup())).workspaces).toEqual([]);
  await expect(page.getByRole('button', { name: '选择项目', exact: true })).toContainText(
    '不使用项目',
  );
  await page.screenshot({ path: testInfo.outputPath('first-launch-main.png') });
  await page.reload();
  await expect(page.getByLabel('需求输入')).toBeVisible();
  expect(await page.evaluate(() => window.evowork.getWorkingDirectory())).toEqual(initial);
  await page.getByLabel('需求输入').fill('FIRST_LAUNCH_TASK');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.evowork.getStartup())).tasks.length)
    .toBe(1);
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  const startup = await page.evaluate(() => window.evowork.getStartup());
  expect(realpathSync(startup.tasks[0].cwd).startsWith(`${realpathSync(initial.path)}/`)).toBe(
    true,
  );
  expect(startup.tasks[0].projectId).toBeNull();
  expect(startup.workspaces).toEqual([]);
});
