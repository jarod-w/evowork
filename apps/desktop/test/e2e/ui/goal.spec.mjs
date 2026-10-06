import { expect, test } from './fixtures.mjs';

test('goal 从真实输入启动、暂停、查看、恢复、完成与清除', async ({ page, electronApp }) => {
  await electronApp.evaluate(() => {
    const gateway = globalThis.__evoworkE2E.gateway;
    gateway.scriptWhen('goal-first', (r) => r.text.includes('GOAL-UI-LIFECYCLE'), { kind: 'hold' });
  });
  const input = page.getByLabel('需求输入');
  const submit = async (text) => {
    await input.fill(text);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(input).toHaveValue('');
  };
  await submit('/goal GOAL-UI-LIFECYCLE 完成并验证报告');
  const status = page.getByLabel('持续目标');
  await expect(status).toContainText('持续推进中');
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.scriptedTurnHeld()))
    .toBe(true);
  await submit('/goal pause');
  await expect(status).toContainText('已暂停');
  await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.releaseScriptedTurn());
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  await submit('/goal');
  await expect(page.getByLabel('长任务目标')).toBeVisible();
  await electronApp.evaluate(() => {
    const gateway = globalThis.__evoworkE2E.gateway;
    gateway.scriptWhen(
      'goal-complete',
      (r) => r.text.includes('GOAL-UI-LIFECYCLE') && r.tools.includes('update_goal'),
      { tool: 'update_goal', args: { status: 'complete' } },
    );
  });
  await submit('/goal resume');
  await expect(status).toContainText('已完成');
  await submit('/goal clear');
  await expect(status).toHaveCount(0);
});
