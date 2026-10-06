/** Real OCR engine/decoder and offline install; only the model gateway is a fixture. */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, test } from './fixtures.mjs';
const runtime = process.env.EVOWORK_OCR_TEST_RUNTIME;
const python = process.env.EVOWORK_OFFICE_PYTHON;
test.use({ ocrBundle: runtime });
test('离线安装后识别扫描 PDF 和图片：普通附件不进入资料库，发送只含选择的识别文字', async ({
  page,
  electronApp,
}, testInfo) => {
  if (!runtime || !python)
    throw new Error(
      '该真实 OCR 旅程需要 EVOWORK_OCR_TEST_RUNTIME 与 EVOWORK_OFFICE_PYTHON；缺组件不代表验过。',
    );
  const dir = testInfo.outputPath('ocr-input');
  mkdirSync(dir, { recursive: true });
  execFileSync(python, [
    resolve('scripts/ocr-samples.py'),
    '--output',
    dir,
    '--font',
    join(dirname(dirname(python)), 'fonts/NotoSansSC-Regular.ttf'),
  ]);
  execFileSync(python, [
    '-c',
    'import pypdfium2 as p,sys; src=p.PdfDocument(sys.argv[1]); doc=p.PdfDocument.new(); doc.import_pages(src,[0]); doc.save(sys.argv[2])',
    join(dir, 'clear-print.pdf'),
    join(dir, 'single-scan.pdf'),
  ]);
  await page.getByRole('button', { name: '资料库', exact: true }).click();
  await page.getByRole('button', { name: '安装 OCR 组件', exact: true }).click();
  await page
    .getByRole('dialog', { name: '安装本地 OCR 组件' })
    .getByRole('button', { name: '安装', exact: true })
    .click();
  await expect(page.getByRole('main', { name: '资料库' })).toContainText('本地 OCR 引擎可用', {
    timeout: 60000,
  });
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const paths = [join(dir, 'single-scan.pdf'), join(dir, 'clear-print.png')];
  await electronApp.evaluate((_electron, files) => {
    globalThis.__evoworkE2E.pickedFiles = files;
  }, paths);
  await page.getByRole('button', { name: '添加内容' }).click();
  await page.getByRole('menuitem', { name: /添加本地文件/ }).click();
  const chips = page.locator('.ew-attachment');
  await expect(chips).toHaveCount(2);
  const registered = await page.evaluate(() => window.evowork.getLibrary());
  expect(registered.rows.some((r) => paths.some((p) => p.endsWith(r.name)))).toBe(false);
  for (const name of ['single-scan.pdf', 'clear-print.png']) {
    const chip = chips.filter({ hasText: name });
    await chip.getByRole('button', { name: '识别文字', exact: true }).click();
    await page
      .getByRole('dialog', { name: '本机识别文字' })
      .getByRole('button', { name: '开始识别', exact: true })
      .click();
    await expect(chip).toHaveAttribute('data-state', 'ready', { timeout: 60000 });
    await expect(chip).toContainText('已处理 1/1 页');
  }
  // Stop a real multi-page job after its first committed page; reload keeps the choice and partial text needs an explicit action.
  await electronApp.evaluate(
    (_electron, files) => {
      globalThis.__evoworkE2E.pickedFiles = files;
    },
    [join(dir, 'clear-print.pdf')],
  );
  await page.getByRole('button', { name: '添加内容' }).click();
  await page.getByRole('menuitem', { name: /添加本地文件/ }).click();
  let partial = chips.filter({ hasText: 'clear-print.pdf' });
  await partial.getByRole('button', { name: '识别文字', exact: true }).click();
  await page
    .getByRole('dialog', { name: '本机识别文字' })
    .getByRole('button', { name: '开始识别', exact: true })
    .click();
  await expect(partial).toContainText(/已处理 [1-9]\/30 页/, { timeout: 60000 });
  await partial.getByRole('button', { name: '停止识别', exact: true }).click();
  await expect(partial).toHaveAttribute('data-state', 'failed');
  await expect(partial.getByRole('button', { name: '继续识别', exact: true })).toBeVisible();
  await page.reload();
  partial = page.locator('.ew-attachment').filter({ hasText: 'clear-print.pdf' });
  await expect(partial).toHaveAttribute('data-state', 'failed');
  await partial.getByRole('button', { name: '使用已完成部分', exact: true }).click();
  await expect(partial).toHaveAttribute('data-state', 'ready');
  // Only an explicit join makes a cross-task registration.
  await chips
    .filter({ hasText: 'clear-print.png' })
    .getByRole('button', { name: '加入资料库', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: '加入资料库' })
    .getByRole('button', { name: '加入资料库', exact: true })
    .click();
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.evowork.getLibrary())).rows.some(
        (r) => r.name === 'original.png',
      ),
    )
    .toBe(true);
  const marker = `OCR-TEXT-${Date.now()}`;
  await page.getByLabel('需求输入').fill(`核对这些识别文字 ${marker}`);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const request = () =>
    electronApp.evaluate(
      (_electron, needle) =>
        globalThis.__evoworkE2E.gateway.requestBodies.find((body) => body.includes(needle)) ?? null,
      marker,
    );
  await expect.poll(request).not.toBeNull();
  const content = JSON.parse(await request())
    .input.filter((i) => i.role === 'user')
    .flatMap((i) => i.content ?? []);
  expect(content.filter((p) => p.type === 'input_image')).toHaveLength(0);
  const text = content
    .filter((p) => p.type === 'input_text')
    .map((p) => p.text)
    .join('\n');
  expect(text).toContain('仅使用已完成');
  expect(text).toContain('ocr-content.md');
  expect(text).toContain('12301.67');
  expect(text).toContain('识别文字可能有误');
});
