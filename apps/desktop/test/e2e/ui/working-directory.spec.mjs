import { realpathSync } from 'node:fs';
import { expect, test } from './fixtures.mjs';

test('常规修改无项目工作目录，新任务实际使用新目录，刷新与恢复默认不迁移旧任务', async ({
  page,
  electronApp,
}, testInfo) => {
  const selected = realpathSync(
    await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace),
  );
  const openGeneral = async () => {
    await page.getByRole('button', { name: / 菜单$/ }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await page.getByRole('button', { name: '常规', exact: true }).click();
    await expect(page.getByRole('heading', { name: '工作目录', exact: true })).toBeVisible();
  };
  await openGeneral();
  const initial = await page.evaluate(() => window.evowork.getWorkingDirectory());
  expect(initial.isDefault).toBe(true);
  await page.getByRole('button', { name: '更改…', exact: true }).click();
  await expect(page.locator('.ew-settings-directory')).toHaveText(selected);
  await page.reload();
  await openGeneral();
  await expect(page.locator('.ew-settings-directory')).toHaveText(selected);
  await page.screenshot({ path: testInfo.outputPath('working-directory.png') });
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await expect(page.getByRole('button', { name: '选择项目', exact: true })).toContainText(
    '不使用项目',
  );
  await page.getByLabel('需求输入').fill('WORKING_DIRECTORY_CUSTOM_TASK');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.evowork.getStartup())).tasks.length)
    .toBe(1);
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  const first = (await page.evaluate(() => window.evowork.getStartup())).tasks[0];
  expect(first.cwd.startsWith(`${selected}/`)).toBe(true);
  expect(first.projectId).toBeNull();
  await openGeneral();
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(page.locator('.ew-settings-directory')).toHaveText(initial.path);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByLabel('需求输入').fill('WORKING_DIRECTORY_DEFAULT_TASK');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.evowork.getStartup())).tasks.length)
    .toBe(2);
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  const tasks = (await page.evaluate(() => window.evowork.getStartup())).tasks;
  expect(tasks.find((task) => task.id === first.id).cwd).toBe(first.cwd);
  expect(
    tasks.find((task) => task.id !== first.id).cwd.startsWith(`${realpathSync(initial.path)}/`),
  ).toBe(true);
});
