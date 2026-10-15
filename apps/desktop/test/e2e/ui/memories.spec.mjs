import { expect, test } from './fixtures.mjs';

test('/memories 从补全和手输打开，取消不保存，禁读在真实任务中生效', async ({
  page,
  electronApp,
}, testInfo) => {
  const input = page.getByLabel('需求输入');
  await expect(page.getByRole('button', { name: '新任务读取记忆', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '任务记忆', exact: true })).toHaveCount(0);
  await input.fill('/mem');
  await page.getByRole('option', { name: /memories/ }).click();
  const dialog = page.getByRole('dialog', { name: '记忆设置' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: '不读取已有记忆' }).check();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(0);
  await input.fill('/memories');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: /跟随全局设置/ })).toBeChecked();
  await expect(page.getByRole('option', { name: /memories/ })).toHaveCount(0);
  await dialog.getByRole('radio', { name: '不读取已有记忆' }).check();
  await page.screenshot({ path: testInfo.outputPath('memories-dialog.png') });
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await input.fill('MEMORIES_COMMAND_UI_TASK');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect
    .poll(async () => (await page.evaluate(() => window.evowork.getStartup())).tasks.length)
    .toBe(1);
  const task = (await page.evaluate(() => window.evowork.getStartup())).tasks[0];
  expect(
    await electronApp.evaluate(
      (_, id) => globalThis.__evoworkE2E.host.adapter.taskMemoryUse(id),
      task.id,
    ),
  ).toBe(false);
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  await input.fill('/memories');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(dialog.getByText(/更改读取方式请新建任务/)).toBeVisible();
  await dialog.getByRole('checkbox', { name: '允许当前任务贡献新记忆' }).uncheck();
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await input.fill('/memories');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: '允许当前任务贡献新记忆' })).not.toBeChecked();
  await dialog.getByRole('button', { name: '打开全局记忆设置' }).click();
  await expect(page.getByRole('checkbox', { name: '启用本地记忆' })).toBeVisible();
  expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(1);
  const requests = await electronApp.evaluate(() =>
    globalThis.__evoworkE2E.gateway.requestBodies.map((body) => JSON.parse(body)),
  );
  const userText = requests
    .flatMap((request) => request.input ?? [])
    .filter((item) => item.role === 'user')
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part) => part.type === 'input_text')
    .map((part) => part.text.trim());
  expect(userText).toContain('MEMORIES_COMMAND_UI_TASK');
  expect(userText).not.toContain('/memories');
});
