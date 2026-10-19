import { expect, test } from './fixtures.mjs';
import { horizontalOverflow, resizeWindow } from './assertions.mjs';

test.use({ registerModels: true, imageGeneration: 'fixture' });
const categories = ['常规', '账号', '模型', '记忆与导入', '用量与预算', '安全与权限', '关于与更新'];
async function selectCategory(page, label) {
  const nav = page.getByRole('navigation', { name: '设置分类' });
  if (await nav.isVisible()) await nav.getByRole('button', { name: label, exact: true }).click();
  else {
    await page.getByRole('button', { name: '设置分类', exact: true }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  }
}
async function openSettings(page, label = '模型') {
  await page.getByRole('button', { name: /菜单$/ }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await selectCategory(page, label);
  await expect(page.getByRole('heading', { name: label, exact: true, level: 1 })).toBeVisible();
}
async function assertSettingsFit(page) {
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  const overflow = await page.locator('.ew-settings').evaluate((root) => {
    const box = root.getBoundingClientRect();
    return Array.from(
      root.querySelectorAll('button,input,.ew-settings-row-label,.ew-settings-directory'),
    )
      .filter((el) => el.getClientRects().length && el.getBoundingClientRect().width > 0)
      .filter((el) => {
        const b = el.getBoundingClientRect();
        return b.left < box.left - 1 || b.right > box.right + 1;
      })
      .map((el) => el.getAttribute('aria-label') || el.textContent || el.tagName);
  });
  expect(overflow).toEqual([]);
}

test('七个分类、模型标签与记忆渐进披露在三档窗口可用', async ({ page, electronApp }, info) => {
  await resizeWindow(electronApp, 1280, 820);
  await openSettings(page);
  const nav = page.getByRole('navigation', { name: '设置分类' });
  expect((await nav.getByRole('button').allTextContents()).map((text) => text.trim())).toEqual(
    categories,
  );
  await expect(page.getByRole('tab', { name: '对话模型', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Ark API Key')).toHaveCount(0);
  for (const label of categories) {
    await selectCategory(page, label);
    await expect(page.getByRole('heading', { name: label, exact: true, level: 1 })).toBeVisible();
    await assertSettingsFit(page);
  }
  await selectCategory(page, '模型');
  await page.screenshot({ path: info.outputPath('settings-models-1280.png') });
  await selectCategory(page, '记忆与导入');
  await expect(page.getByRole('checkbox', { name: '启用本地记忆', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '记忆提取模型', exact: true })).not.toBeVisible();
  await page
    .locator('summary')
    .filter({ hasText: /^高级设置$/ })
    .click();
  await expect(page.getByRole('button', { name: '记忆提取模型', exact: true })).toBeVisible();
  await page
    .locator('summary')
    .filter({ hasText: /^高级设置$/ })
    .click();
  await page.screenshot({ path: info.outputPath('settings-memory-1280.png') });
  await page.getByRole('button', { name: '折叠侧边栏', exact: true }).click();
  for (const [width, height] of [
    [960, 720],
    [480, 600],
  ]) {
    await resizeWindow(electronApp, width, height);
    await expect(nav).not.toBeVisible();
    for (const label of categories) {
      await selectCategory(page, label);
      await expect(page.getByRole('heading', { name: label, exact: true, level: 1 })).toBeVisible();
      await assertSettingsFit(page);
    }
    await selectCategory(page, '模型');
    await page.getByRole('tab', { name: '图片模型', exact: true }).click();
    await expect(page.getByRole('button', { name: '配置图片模型' })).toBeVisible();
    await page.getByRole('button', { name: '配置图片模型' }).click();
    await assertSettingsFit(page);
    await page.screenshot({ path: info.outputPath(`settings-image-${width}.png`) });
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('tab', { name: '对话模型', exact: true }).click();
  }
});

test('预算失焦不写入，取消离开保留草稿，明确保存后刷新仍保留', async ({ page }, info) => {
  await openSettings(page, '用量与预算');
  const initial = await page.evaluate(() => window.evowork.getPreferences());
  await page.getByRole('button', { name: '单任务用量上限', exact: true }).click();
  await page.getByRole('menuitem', { name: '自定义', exact: true }).click();
  const input = page.getByLabel('用量上限（tokens）');
  await input.fill('234567');
  await input.press('Tab');
  expect(await page.evaluate(() => window.evowork.getPreferences())).toEqual(initial);
  await selectCategory(page, '账号');
  const confirm = page.getByRole('dialog', { name: '设置尚未保存' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(input).toHaveValue('234567');
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('heading', { name: '用量与预算', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '保存预算' }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await page.evaluate(() => window.evowork.getPreferences())).taskTokenBudget)
    .toBe(234567);
  await page.screenshot({ path: info.outputPath('settings-budget-saved.png') });
  await page.reload();
  await openSettings(page, '用量与预算');
  await expect(input).toHaveValue('234567');
  await page.getByRole('button', { name: '单任务用量上限', exact: true }).click();
  await page.getByRole('menuitem', { name: '不限', exact: true }).click();
  expect((await page.evaluate(() => window.evowork.getPreferences())).taskTokenBudget).toBe(234567);
  await page.getByRole('button', { name: '保存预算' }).click();
  await expect
    .poll(
      async () => (await page.evaluate(() => window.evowork.getPreferences())).taskTokenBudget ?? 0,
    )
    .toBe(0);
});

test('图片表单保留失败草稿，标签和业务导航均保护未保存内容', async ({ page }, info) => {
  await openSettings(page);
  await page.getByRole('tab', { name: '图片模型', exact: true }).click();
  await page.getByRole('button', { name: '配置图片模型' }).click();
  const input = page.getByLabel('图片接口地址');
  const initial = await page.evaluate(() => window.evowork.getImageSettings());
  await input.fill('not-an-endpoint');
  await expect(page.getByRole('button', { name: '测试已保存配置' })).toBeDisabled();
  await page.getByRole('button', { name: '保存图片设置' }).click();
  await expect(page.locator('.ew-image-settings').getByRole('alert')).toBeVisible();
  await expect(input).toHaveValue('not-an-endpoint');
  expect(await page.evaluate(() => window.evowork.getImageSettings())).toEqual(initial);
  await page.getByRole('tab', { name: '对话模型', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '设置尚未保存' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(input).toHaveValue('not-an-endpoint');
  await page.getByRole('button', { name: '资料库', exact: true }).click();
  await expect(confirm).toBeVisible();
  await page.screenshot({ path: info.outputPath('settings-unsaved-confirmation.png') });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('tab', { name: '对话模型', exact: true }).click();
  await confirm.getByRole('button', { name: '丢弃并离开' }).click();
  await expect(page.getByRole('tab', { name: '对话模型', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.getByRole('tab', { name: '图片模型', exact: true }).click();
  await page.getByRole('button', { name: '配置图片模型' }).click();
  await expect(input).toHaveValue(initial.baseUrl);
});
