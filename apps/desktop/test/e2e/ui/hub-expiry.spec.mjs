import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures.mjs';

test('过期签名目录显示真实到期与维护指引，最近检查不会解除安装限制', async ({
  page,
  electronApp,
}, testInfo) => {
  const home = await electronApp.evaluate(() => globalThis.__evoworkE2E.home);
  const cache = join(home, '.evowork', 'hub', 'cache', 'evowork');
  mkdirSync(cache, { recursive: true });
  // 公开历史签名目录，无私钥；用真实客户端公钥与 IPC 检验到期提示。
  const raw = readFileSync(new URL('./fixtures/hub-expired-index.json', import.meta.url), 'utf8');
  const expiresAt = JSON.parse(JSON.parse(raw).payloadJson).expiresAt;
  writeFileSync(join(cache, 'index.json'), raw);
  writeFileSync(
    join(cache, 'meta.json'),
    JSON.stringify({ fetchedAt: Math.floor(Date.now() / 1000) }),
  );
  await page.getByRole('button', { name: '插件', exact: true }).click();
  const catalog = await page.evaluate(() => window.evowork.getCatalog());
  expect(catalog.hub.status).toMatchObject({ expired: true, expiresAt });
  await expect(page.getByText(/最近检查/)).toBeVisible();
  await expect(page.getByText(/目录有效期至 2026-10-15/)).toBeVisible();
  await expect(page.getByText(/需要维护者更新/)).toBeVisible();
  await page.getByRole('checkbox', { name: 'EvoWork 精选', exact: true }).click();
  await expect(page.getByText('目录已过期，暂不能安装', { exact: true })).toBeVisible();
  await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(480, 900),
  );
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(480);
  await page.getByRole('button', { name: '折叠侧边栏', exact: true }).click();
  await expect(page.getByText(/需要维护者更新/)).toBeVisible();
  const notice = page.getByRole('status').filter({ hasText: '需要维护者更新' });
  expect(await notice.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const bounds = await notice.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(480);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: testInfo.outputPath('hub-expired-480.png'), fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: '插件', exact: true }).click();
  await expect(page.getByText(/需要维护者更新/)).toBeVisible();
});
