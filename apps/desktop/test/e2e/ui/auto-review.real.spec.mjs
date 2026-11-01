/** Real provider + shipping kernel: an actual sandbox approval must be reviewed. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from './fixtures.mjs';
import { selectRealModel } from '../harness/real-models.mjs';

test.use({ hostGateway: true });

test('帮我批准：真实审查通过后执行，保留审批证据', async ({ page, electronApp }, testInfo) => {
  test.setTimeout(480_000);
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const output = join(workspace, 'auto-reviewed.txt');
  await page.getByRole('button', { name: '审批档' }).click();
  await page.getByRole('menuitem', { name: /^帮我批准/ }).click();
  await page
    .getByLabel('需求输入')
    .fill(
      '这是自动审批验收。请只执行一次 exec_command：' +
        `cmd 为 printf EVOWORK-AUTO-REVIEWED > '${output}'，` +
        'sandbox_permissions 为 require_escalated，justification 为“自动审批验收：创建测试文件”。' +
        '必须明确申请提权以验证审查；只创建这个测试文件，不换工具，不修改其他文件。完成后回复结果。',
    );
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const composer = page.getByLabel('输入区');
  await expect(composer).toHaveAttribute('data-run-state', /running|pending/, { timeout: 60_000 });
  const deadline = Date.now() + 360_000;
  try {
    while (Date.now() < deadline) {
      const card = page.getByRole('alertdialog');
      if (await card.count())
        throw new Error(`普通测试写操作未由自动审查处理：${await card.first().innerText()}`);
      if ((await composer.getAttribute('data-run-state')) === 'idle') break;
      await page.waitForTimeout(300);
    }
    await expect(composer).toHaveAttribute('data-run-state', 'idle');
    expect(existsSync(output), '审查没有执行用户明确要求的新建文件').toBe(true);
    expect(readFileSync(output, 'utf8')).toBe('EVOWORK-AUTO-REVIEWED');
    const reviews = await electronApp.evaluate(() => globalThis.__evoworkE2E.approvalReviews());
    expect(
      reviews.some((event) => event.method.endsWith('/completed')),
      '没有真实审查完成事件',
    ).toBe(true);
    await expect(page.getByRole('button', { name: '自动审批 · 已通过' })).toHaveCount(1);
    const taskName = await page
      .getByRole('region', { name: '最近' })
      .getByRole('listitem')
      .first()
      .getByRole('button')
      .first()
      .innerText();
    await page.reload();
    await page
      .getByRole('region', { name: '最近' })
      .getByRole('button', { name: taskName, exact: true })
      .click();
    await expect(page.getByRole('button', { name: '自动审批 · 已通过' })).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('auto-review.png') });
  } finally {
    const reviews = await electronApp.evaluate(() => globalThis.__evoworkE2E.approvalReviews());
    const reply = await page.getByRole('main', { name: '对话区' }).allInnerTexts();
    writeFileSync(
      testInfo.outputPath('review-evidence.json'),
      JSON.stringify({ model: selectRealModel().name, reviews, reply }, null, 2),
    );
  }
});
