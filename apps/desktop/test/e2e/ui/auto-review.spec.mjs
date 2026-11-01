/** Shipping kernel, deterministic reviewer outcomes; no automatic approval is faked in the host. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures.mjs';

test.use({ registerModels: true });

for (const outcome of ['allow', 'deny', 'invalid']) {
  test(`自动审批 ${outcome}：按真实审查结果执行或关闭，刷新后证据保留`, async ({
    page,
    electronApp,
  }, testInfo) => {
    const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
    const output = join(workspace, `review-${outcome}.txt`);
    const marker = `AUTO_REVIEW_${outcome}_${Date.now()}`;
    await electronApp.evaluate(
      (_electron, { output, marker, outcome }) => {
        const gateway = globalThis.__evoworkE2E.gateway;
        const isReview = (view) => {
          const schema = JSON.parse(view.text).text?.format?.schema;
          return schema?.required?.includes('outcome') === true;
        };
        gateway.scriptWhen(`${marker}-review`, isReview, {
          kind: 'text',
          text:
            outcome === 'invalid'
              ? 'INVALID_REVIEW_PAYLOAD'
              : JSON.stringify({
                  outcome,
                  risk_level: outcome === 'allow' ? 'low' : 'high',
                  user_authorization: 'high',
                  rationale: 'DETERMINISTIC_REVIEW_REASON',
                }),
        });
        gateway.scriptWhen(
          `${marker}-command`,
          (view) => view.text.includes(marker) && !isReview(view) && view.calls.length === 0,
          {
            tool: 'exec_command',
            args: {
              cmd: `printf APPROVED > '${output}'`,
              sandbox_permissions: 'require_escalated',
              justification: '测试自动审批执行边界',
            },
          },
        );
        gateway.scriptWhen(
          `${marker}-finished`,
          (view) => view.text.includes(marker) && !isReview(view) && view.calls.length > 0,
          { kind: 'text', text: `DONE_${marker}` },
        );
      },
      { output, marker, outcome },
    );
    await page.getByRole('button', { name: '审批档' }).click();
    await page.getByRole('menuitem', { name: /^帮我批准/ }).click();
    await page.getByLabel('需求输入').fill(`只创建本次测试文件 ${marker}`);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('main', { name: '对话区' })).toContainText(`DONE_${marker}`, {
      timeout: 90_000,
    });
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
      timeout: 90_000,
    });
    if (outcome !== 'allow')
      await expect(page.getByRole('button', { name: /^策略注入 · stop:/ })).toHaveCount(0);
    const status = outcome === 'allow' ? '已通过' : '已阻止';
    const review = page.getByRole('button', { name: `自动审批 · ${status}` });
    await expect(review).toHaveCount(1);
    expect(existsSync(output)).toBe(outcome === 'allow');
    if (outcome === 'allow') expect(readFileSync(output, 'utf8')).toBe('APPROVED');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
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
    await expect(review).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath('auto-review.png') });
  });
}
