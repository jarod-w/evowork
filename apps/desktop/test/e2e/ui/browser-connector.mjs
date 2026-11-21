import { expect } from './fixtures.mjs';

/** Use the connector's explicit action; the display card itself is not a button. */
export async function trustBrowserConnector(page) {
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('tab', { name: '连接器', exact: true }).click();
  await page.getByRole('button', { name: '查看权限 · 浏览器', exact: true }).click();
  await expect(page.getByRole('heading', { name: '浏览器', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '信任并启用', exact: true }).click();
  const dialog = page.getByRole('alertdialog', { name: '信任「浏览器」', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '信任并启用', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: '信任并启用', exact: true })).toHaveCount(0);
}
