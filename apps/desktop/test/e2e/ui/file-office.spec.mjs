import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { expect, makeOfficeFixtures, startTaskInWorkspace, test } from './fixtures.mjs';
import { scriptFileTools, settle } from './file-results-support.mjs';

async function openOffice(page, electronApp, file, marker) {
  await scriptFileTools(
    electronApp,
    marker,
    [{ tool: 'open_file', args: { path: file } }],
    marker + ' DONE',
  );
  await startTaskInWorkspace(page, electronApp, marker);
  await settle(page, marker + ' DONE');
  const preview = page.getByRole('region', { name: '文件预览：' + file });
  await expect(preview).toBeVisible();
  return preview;
}
const decoded = async (image) =>
  expect
    .poll(() => image.evaluate((i) => i.complete && i.naturalWidth > 100 && i.naturalHeight > 100))
    .toBe(true);

test('四类 Office 在真实界面显示页面，逐一翻页并正确显示总页数', async ({
  page,
  electronApp,
}, info) => {
  const root = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const fixtures = makeOfficeFixtures(info.outputPath('source')).filter((f) =>
    /\.(docx|pptx|xlsx)$/.test(f.file),
  );
  for (const f of fixtures) copyFileSync(f.path, join(root, f.file));
  writeFileSync(
    join(root, 'layout.rtf'),
    '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0\\fs36 Office layout preview\\par Second paragraph.}',
  );
  await openOffice(page, electronApp, fixtures[0].file, 'OFFICE-ALL-FORMATS');
  const expected = { docx: 2, pptx: 3, xlsx: 1, rtf: 1 };
  for (const file of [...fixtures.map((f) => f.file), 'layout.rtf']) {
    await page
      .getByRole('region', { name: '结果区项目文件' })
      .getByRole('button', { name: file, exact: true })
      .click();
    const preview = page.getByRole('region', { name: '文件预览：' + file });
    await expect(preview).toContainText('本机离线转换');
    const image = preview.getByRole('img');
    await decoded(image);
    const count = expected[file.split('.').at(-1)];
    await expect(preview.getByLabel('预览页码')).toHaveAttribute('max', String(count));
    await expect(preview).toContainText(`共 ${count} 页`);
    for (let pageNumber = 2; pageNumber <= count; pageNumber++) {
      await preview.getByRole('button', { name: '下一页', exact: true }).click();
      await expect(image).toHaveAttribute('alt', new RegExp(`第 ${pageNumber} 页$`));
      await decoded(image);
    }
    await expect(preview.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
    await page.screenshot({ path: info.outputPath('office-' + file.split('.').at(-1) + '.png') });
  }
});

test('超过20页如实标明截断，页码和翻页不会进入未渲染的空白页', async ({
  page,
  electronApp,
}, info) => {
  const root = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const python =
    process.env.EVOWORK_OFFICE_PYTHON ?? join(homedir(), '.evowork/runtime/office/bin/python3');
  execFileSync(python, [
    '-c',
    `from docx import Document
import sys
d=Document()
for i in range(21):
    if i: d.add_page_break()
    d.add_heading('Page '+str(i+1),0)
d.save(sys.argv[1])`,
    join(root, '21-pages.docx'),
  ]);
  const preview = await openOffice(page, electronApp, '21-pages.docx', 'OFFICE-LIMIT');
  await expect(preview).toContainText('仅显示前 20 页，共 21 页');
  const pageNumber = preview.getByLabel('预览页码');
  await expect(pageNumber).toHaveAttribute('max', '20');
  await pageNumber.fill('20');
  await expect(preview.getByRole('img')).toHaveAttribute('alt', /第 20 页$/);
  await decoded(preview.getByRole('img'));
  await expect(preview.getByRole('button', { name: '下一页', exact: true })).toBeDisabled();
  await pageNumber.fill('21');
  await expect(pageNumber).toHaveValue('20');
  await page.screenshot({ path: info.outputPath('office-limit-visible.png') });
});

for (const failure of ['missing-converter', 'failed-converter', 'missing-extension']) {
  test.describe(failure, () => {
    test.use({
      desktopEnv: {
        ...(failure === 'missing-converter'
          ? { EVOWORK_OFFICE_CONVERTER: '/nonexistent/evowork-office-converter' }
          : {}),
        ...(failure === 'failed-converter' ? { EVOWORK_OFFICE_CONVERTER: '/usr/bin/false' } : {}),
        ...(failure === 'missing-extension'
          ? { EVOWORK_OFFICE_PYTHON: '/nonexistent/evowork-office-python' }
          : {}),
      },
    });
    test('组件不可用时明确回退，正文或失败原因可见且无空白PDF框', async ({
      page,
      electronApp,
    }, info) => {
      const root = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
      const fixture = makeOfficeFixtures(info.outputPath('source')).find((f) =>
        f.file.endsWith('.docx'),
      );
      copyFileSync(fixture.path, join(root, fixture.file));
      const preview = await openOffice(
        page,
        electronApp,
        fixture.file,
        'OFFICE-FALLBACK-' + failure,
      );
      await expect(preview).toContainText('不代表原文件排版');
      await expect(preview.locator('iframe')).toHaveCount(0);
      await expect(preview.getByRole('img')).toHaveCount(0);
      if (failure === 'missing-extension') await expect(preview).toContainText('正文预览也不可用');
      else await expect(preview).toContainText('915');
      await page.screenshot({ path: info.outputPath(failure + '.png') });
    });
  });
}
