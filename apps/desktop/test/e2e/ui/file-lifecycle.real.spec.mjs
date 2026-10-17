import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import { changes, results, revertSelected, settle, taskId } from './file-results-support.mjs';
import { selectRealModel } from '../harness/real-models.mjs';

test.use({ registerModels: true, hostGateway: true });
async function evidence(page, info, id) {
  const history = await page.evaluate((threadId) => window.evowork.openTask({ threadId }), id);
  const data = {
    model: selectRealModel().upstreamModel,
    files: await results(page, id),
    items: history.items,
  };
  const body = JSON.stringify(data, null, 2),
    key = process.env.EVOWORK_UI_MODEL_KEY;
  if (key && body.includes(key)) throw new Error('测试证据中发现凭据，拒绝写盘');
  await info.attach('file-evidence', { body, contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('real-file-results.png') });
  return history;
}

test('真模型自主计算和交付：建立归属、明确打开，并通过界面恢复真实磁盘', async ({
  page,
  electronApp,
}, info) => {
  const root = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  mkdirSync(join(root, 'inputs'));
  writeFileSync(
    join(root, 'inputs', 'sales.csv'),
    '区域,金额\n华东,137\n华南,211\n华东,269\n华南,113\n',
  );
  writeFileSync(join(root, 'config.txt'), 'mode=original\n');
  writeFileSync(join(root, 'obsolete.txt'), 'restore obsolete bytes\n');
  const marker = 'REAL-FILE-' + Date.now().toString(36);
  await startTaskInWorkspace(
    page,
    electronApp,
    `${marker} 请读取 inputs/sales.csv，用本机代码按区域计算金额总和及总计，写入 outputs/summary.md；把 config.txt 改为 mode=updated 并删除 obsolete.txt。交付后在结果区打开 summary.md。只操作这些输出和指定文件，不联网，不创建子任务，不使用其他会话；不要修改输入文件。最终回复 ${marker} DONE。`,
  );
  const id = await taskId(page, marker);
  try {
    await settle(page, marker + ' DONE', 240000);
    const path = join(root, 'outputs/summary.md');
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, 'utf8');
    expect(text).toMatch(/华东[^\n]*406/);
    expect(text).toMatch(/华南[^\n]*324/);
    expect(text).toContain('730');
    expect(readFileSync(join(root, 'config.txt'), 'utf8')).toContain('mode=updated');
    expect(existsSync(join(root, 'obsolete.txt'))).toBe(false);
    await expect(page.getByRole('tab', { name: '文件', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('region', { name: '文件预览：summary.md' })).toContainText('730');
    const files = await results(page, id);
    expect(files.artifacts.some((a) => a.path.endsWith('summary.md'))).toBe(true);
    expect(files.workspace.files.find((f) => f.path.endsWith('summary.md')).source).toBe('task');
    const history = await evidence(page, info, id);
    expect(
      history.items.some(
        (i) =>
          i.type === 'mcpToolCall' && i.server === 'workspace_files' && i.tool === 'register_file',
      ),
    ).toBe(true);
    expect(
      history.items.some(
        (i) => i.type === 'mcpToolCall' && i.server === 'workspace_files' && i.tool === 'open_file',
      ),
    ).toBe(true);
    await changes(page);
    for (const name of ['config.txt', 'obsolete.txt', 'summary.md']) {
      await page
        .locator('.ew-changed-files')
        .getByRole('button', { name: new RegExp(name.replace('.', '\\.')) })
        .click();
      await revertSelected(page);
      await expect(
        page
          .locator('.ew-changed-files')
          .getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }),
      ).toHaveCount(0);
    }
    expect(readFileSync(join(root, 'config.txt'), 'utf8')).toBe('mode=original\n');
    expect(readFileSync(join(root, 'obsolete.txt'), 'utf8')).toBe('restore obsolete bytes\n');
    expect(existsSync(path)).toBe(false);
  } catch (error) {
    await evidence(page, info, id).catch(() => undefined);
    throw error;
  }
});

test('真模型生成中文Word交付，实际Office页面显示且归属与明确打开可追溯', async ({
  page,
  electronApp,
}, info) => {
  const root = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  mkdirSync(join(root, 'inputs'));
  writeFileSync(
    join(root, 'inputs', 'report.md'),
    '# 季度经营简报\n\n华东收入406万元，华南收入324万元，总收入730万元。\n\n请包含：摘要、分区域收入表、下一步行动。下一步行动为复核渠道成本。\n',
  );
  const marker = 'REAL-OFFICE-' + Date.now().toString(36);
  await startTaskInWorkspace(
    page,
    electronApp,
    `${marker} 根据 inputs/report.md 用已安装的本机办公技能生成 outputs/季度经营简报.docx。要求中文标题、分节、收入表，保持来源数字，不联网、不创建子任务、不改输入、不操作其他文件。生成后登记本任务交付文件并在结果区打开供我检查。最终回复 ${marker} DONE。`,
  );
  const id = await taskId(page, marker);
  try {
    await settle(page, marker + ' DONE', 240000);
    const path = join(root, 'outputs/季度经营简报.docx');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).subarray(0, 2).toString()).toBe('PK');
    const preview = page.getByRole('region', { name: '文件预览：季度经营简报.docx' });
    await expect(preview).toContainText('本机离线转换', { timeout: 90000 });
    const image = preview.getByRole('img');
    await expect
      .poll(() => image.evaluate((i) => i.complete && i.naturalWidth > 100), { timeout: 90000 })
      .toBe(true);
    expect(
      (await results(page, id)).artifacts.some((a) => a.path.endsWith('季度经营简报.docx')),
    ).toBe(true);
    const history = await evidence(page, info, id);
    expect(
      history.items.some(
        (i) => i.type === 'mcpToolCall' && i.server === 'workspace_files' && i.tool === 'open_file',
      ),
    ).toBe(true);
  } catch (error) {
    await evidence(page, info, id).catch(() => undefined);
    throw error;
  }
});
