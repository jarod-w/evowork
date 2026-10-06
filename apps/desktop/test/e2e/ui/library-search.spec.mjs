import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures.mjs';

test('资料副本的正文命中、位置预览、引用草稿与移除；刷新后范围仍保留', async ({
  page,
  electronApp,
}, testInfo) => {
  const directory = testInfo.outputPath('library-input');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'ordinary-name.txt');
  writeFileSync(
    path,
    '第一段 合同确认。\n第二段 毛利率分析 ZXCV_2026_99 付款条件。\n<script>untrusted source</script>',
  );
  await electronApp.evaluate(
    (_electron, paths) => {
      globalThis.__evoworkE2E.pickedFiles = paths;
    },
    [path],
  );
  await page.getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('button', { name: '开启本机正文检索', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '开启本机正文检索' })).toContainText(
    '不会扫描历史附件',
  );
  await page
    .getByRole('dialog', { name: '开启本机正文检索' })
    .getByRole('button', { name: '开启', exact: true })
    .click();
  await page.getByRole('button', { name: '添加资料', exact: true }).last().click();
  await page
    .getByRole('dialog', { name: '添加资料' })
    .getByRole('button', { name: '选择文件并建立副本' })
    .click();
  await expect(page.getByRole('row').filter({ hasText: 'ordinary-name.txt' })).toContainText(
    '正文可搜',
  );
  await page.reload();
  await page.getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByLabel('搜索资料').fill('毛利率 付款');
  const row = page.getByRole('row').filter({ hasText: 'ordinary-name.txt' });
  await expect(row).toContainText('ZXCV_2026_99');
  await expect(row.locator('mark')).toHaveCount(2);
  await row.getByRole('button', { name: '打开位置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'ordinary-name.txt' })).toContainText(
    'ZXCV_2026_99',
  );
  await page
    .getByRole('dialog', { name: 'ordinary-name.txt' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  await row.getByRole('button', { name: '引用此片段', exact: true }).click();
  await expect(page.locator('.ew-attachment[data-state="ready"]')).toContainText(
    'ordinary-name.txt-引用.md',
  );
  // Reference adds a visible draft attachment without sending a turn or embedding source HTML.
  await expect(page.getByLabel('需求输入')).toHaveValue('');
  await page.getByRole('button', { name: '资料库', exact: true }).click();
  const imported = page.getByRole('row').filter({ hasText: 'ordinary-name.txt' });
  await imported.getByRole('button', { name: '移除', exact: true }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: '删除文件', exact: true })
    .click();
  await expect(imported).toHaveCount(0);
  expect(readFileSync(path, 'utf8')).toContain('ZXCV_2026_99');
});
