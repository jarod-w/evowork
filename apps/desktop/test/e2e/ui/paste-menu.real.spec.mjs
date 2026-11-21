/**
 * 右键「粘贴」和中文应用菜单，以及发送过程中再粘的图不会丢。
 * 真模型要认出剪贴板里那张纯蓝图。密钥只经 EVOWORK_UI_MODEL_KEY。
 *
 * 跑法：EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash \
 *   pnpm exec playwright test paste-menu.real.spec.mjs --project=real --retries=0
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { selectRealModel } from '../harness/real-models.mjs';
import { expect } from './fixtures.mjs';
import { test } from './command-approvals.mjs';

test.use({
  registerModels: true,
  hostGateway: true,
  desktopEnv: { EVOWORK_UI_FOLLOW_UP_WIRE: '1' },
});

/** Electron `createFromBitmap` 要 BGRA。蓝是 R=0 G=0 B=255。 */
async function copyBlue(electronApp) {
  await electronApp.evaluate(async ({ clipboard, ClipboardItem, nativeImage }) => {
    const size = 32;
    const pixels = Buffer.alloc(size * size * 4);
    for (let i = 0; i < pixels.length; i += 4) pixels.set([255, 0, 0, 255], i);
    const png = nativeImage.createFromBitmap(pixels, { width: size, height: size }).toPNG();
    await clipboard.write([
      new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) }),
    ]);
  });
}

function wire(root) {
  const filename = join(dirname(root), 'follow-up-wire.jsonl');
  return existsSync(filename)
    ? readFileSync(filename, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

test('右键粘贴纯蓝图，发送过程中再粘一张仍在，MiMo 只答蓝', async ({
  page,
  electronApp,
}, testInfo) => {
  const model = selectRealModel();
  expect(model.upstreamModel).toBe('mimo-v2.6-flash');
  expect(model.baseUrl).toBe('https://api.xiaomimimo.com/v1');

  const bar = await electronApp.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).map((item) => ({
      label: item.label,
      submenu: (item.submenu?.items ?? []).map((child) => child.label),
    })),
  );
  expect(bar.map((item) => item.label)).toContain('编辑');
  expect(bar.find((item) => item.label === '编辑')?.submenu).toEqual(
    expect.arrayContaining(['复制', '粘贴']),
  );

  const input = page.getByLabel('需求输入');
  await input.click({ button: 'right' });
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E.lastContextMenu ?? []))
    .toEqual(expect.arrayContaining(['复制', '粘贴']));
  await page.keyboard.press('Escape');

  await expect(page.getByLabel('选择模型')).toContainText(model.upstreamModel);
  await copyBlue(electronApp);
  await input.click();
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.paste();
  });
  const ready = page.locator('.ew-attachment[data-state="ready"]');
  await expect(ready).toHaveCount(1, { timeout: 30_000 });

  await input.fill(
    '这张图是一种纯色。只回复一个汉字：蓝、红、绿、黑之一。不要解释，不要调用工具。',
  );
  await page.getByRole('button', { name: '发送', exact: true }).click();
  // 点发送的同步段已经占上环境锁；这一下若被丢掉，用户消息出现后输入区不会再有附件
  await copyBlue(electronApp);
  await page.keyboard.press('Meta+v');

  const conversation = page.getByRole('main', { name: '对话区' });
  await expect(conversation.locator('.ew-item-user').first()).toBeVisible({ timeout: 60_000 });
  await expect(ready).toHaveCount(1, { timeout: 30_000 });
  await expect(conversation.locator('.ew-item-agent').first()).toBeVisible({ timeout: 240_000 });
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 240_000,
  });
  const answer = (await conversation.locator('.ew-item-agent').allInnerTexts()).join('\n');
  await testInfo.attach('模型的回答', { body: answer, contentType: 'text/plain' });
  expect(answer, `模型没认出蓝色。完整回答：\n${answer}`).toMatch(/蓝/);
  expect(answer).not.toMatch(/红/);
  await expect(ready).toHaveCount(1);

  const root = realpathSync(await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace));
  await expect
    .poll(() => wire(root).filter((row) => row.type === 'response').length, { timeout: 60_000 })
    .toBeGreaterThan(0);
  const requests = wire(root).filter((row) => row.type === 'request');
  const responses = wire(root).filter((row) => row.type === 'response');
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((row) => row.model === model.upstreamModel)).toBe(true);
  expect(requests.every((row) => row.endpoint === `${model.baseUrl}/chat/completions`)).toBe(true);
  expect(responses.every((row) => row.status === 200)).toBe(true);
  const body = JSON.stringify({
    model: model.upstreamModel,
    baseUrl: model.baseUrl,
    requests: requests.length,
    answer,
  });
  if (process.env.EVOWORK_UI_MODEL_KEY && body.includes(process.env.EVOWORK_UI_MODEL_KEY))
    throw new Error('凭据扫描命中，拒绝保存测试证据');
  writeFileSync(testInfo.outputPath('paste-menu-evidence.json'), body);
});
