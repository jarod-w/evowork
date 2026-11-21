/** 真模型必须读到 @ 引用文件里的口令。密钥只经 EVOWORK_UI_MODEL_KEY。 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, runUntilIdle, test } from './fixtures.mjs';

test('真模型只从 @ 引用的文件里读出口令', async ({ page, electronApp }) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const secret = `PASS-${Date.now().toString(36)}`;
  writeFileSync(join(workspace, 'secret-pass.txt'), `${secret}\n`);

  const input = page.getByLabel('需求输入');
  await input.fill('/go');
  await expect(page.getByRole('option', { name: /持续推进目标/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /暂停目标/ })).toHaveCount(0);
  await input.fill('/goal');
  await expect(page.getByRole('option', { name: /暂停目标/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /恢复目标/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /清除目标/ })).toBeVisible();

  await page.getByRole('button', { name: '选择项目' }).click();
  await page.getByRole('menuitem', { name: /^UI/ }).click();
  await input.fill('@secret');
  await page.getByRole('option', { name: /secret-pass\.txt/ }).click();
  await expect(input).toHaveValue(/@.*secret-pass\.txt/);
  await input.evaluate((element) => {
    const box = element;
    const end = box.value.search(/\s/u);
    const caret = end === -1 ? box.value.length : end;
    box.focus();
    box.setSelectionRange(caret, caret);
  });
  await input.press('Backspace');
  await expect(input).not.toHaveValue(/secret-pass\.txt/);

  await input.fill('@secret');
  await page.getByRole('option', { name: /secret-pass\.txt/ }).click();
  await input.click();
  await input.press('End');
  await input.pressSequentially(
    '文件里有一行口令。只回复那一行口令本身，不要加引号、标点或解释，也不要修改文件。',
  );
  await page.getByRole('button', { name: '发送', exact: true }).click();

  const composer = page.getByLabel('输入区');
  await expect(composer).toHaveAttribute('data-run-state', /running|pending/, { timeout: 60_000 });
  await input.fill('先别停');
  if ((await composer.getAttribute('data-run-state')) === 'running') {
    await input.press('Escape');
    await expect(composer).toHaveAttribute('data-run-state', 'running');
  }
  await input.fill('');

  await runUntilIdle(page);
  await expect(page.getByRole('main', { name: '对话区' })).toContainText(secret);
  await expect(page.getByRole('main', { name: '对话区' })).not.toContainText('先别停');
});
