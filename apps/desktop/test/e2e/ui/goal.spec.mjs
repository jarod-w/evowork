import { expect, test } from './fixtures.mjs';
import { goalTask, readGoal, reopenGoalTask, submitGoalCommand } from './goal-journey.mjs';

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

test('未创建目标时，查看与控制给出提示且不创建任务', async ({ page }) => {
  await submitGoalCommand(page, '/goal');
  await expect(page.getByRole('status').filter({ hasText: '还没有目标' })).toBeVisible();
  for (const command of ['/goal pause', '/goal resume', '/goal clear']) {
    await submitGoalCommand(page, command);
  }
  expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(0);
  await expect(page.getByLabel('持续目标')).toHaveCount(0);
});

test('未完成目标替换先确认：取消保留旧目标，确认重置预算并执行新目标', async ({
  page,
  electronApp,
}) => {
  await electronApp.evaluate(() => {
    globalThis.__evoworkE2E.gateway.scriptWhen(
      'original',
      (view) => view.text.includes('GOAL-ORIGINAL'),
      { kind: 'hold' },
    );
  });
  await submitGoalCommand(page, '/goal GOAL-ORIGINAL 原目标');
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.scriptedTurnHeld()))
    .toBe(true);
  await submitGoalCommand(page, '/goal pause');
  await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.releaseScriptedTurn());
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  const task = await goalTask(page);
  await submitGoalCommand(page, '/goal');
  const panel = page.getByLabel('长任务目标');
  await panel.getByLabel('Token 预算', { exact: true }).fill('100000');
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await readGoal(page, task.id))?.tokenBudget).toBe(100000);
  const original = await readGoal(page, task.id);
  const input = page.getByLabel('需求输入');
  await input.fill('/goal GOAL-REPLACEMENT 新目标');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '替换当前目标？' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(await readGoal(page, task.id)).toEqual(original);
  await expect(input).toHaveValue('/goal GOAL-REPLACEMENT 新目标');
  await electronApp.evaluate(() => {
    globalThis.__evoworkE2E.gateway.scriptWhen(
      'replacement',
      (view) => view.text.includes('GOAL-REPLACEMENT') && view.tools.includes('update_goal'),
      { tool: 'update_goal', args: { status: 'complete' } },
    );
  });
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await dialog.getByRole('button', { name: '替换并开始', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.getByLabel('持续目标')).toContainText('已完成');
  const replaced = await readGoal(page, task.id);
  expect(replaced.objective).toBe('GOAL-REPLACEMENT 新目标');
  expect(replaced.tokenBudget).toBeNull();
  const history = await page.evaluate((id) => window.evowork.openTask({ threadId: id }), task.id);
  expect(history.items.filter((item) => item.type === 'userMessage')).toHaveLength(2);
});

test('预算编辑拒绝非正数，耗尽后不续跑，刷新后追加预算恢复并清除', async ({
  page,
  electronApp,
}) => {
  await electronApp.evaluate(() =>
    globalThis.__evoworkE2E.gateway.scriptWhen(
      'budget',
      (view) => view.text.includes('GOAL-UI-BUDGET'),
      { kind: 'hold' },
    ),
  );
  await submitGoalCommand(page, '/goal GOAL-UI-BUDGET 等待预算停止');
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.scriptedTurnHeld()))
    .toBe(true);
  const task = await goalTask(page);
  await submitGoalCommand(page, '/goal');
  const panel = page.getByLabel('长任务目标');
  const budget = panel.getByLabel('Token 预算', { exact: true });
  const save = panel.getByRole('button', { name: '保存', exact: true });
  for (const value of ['0', '-1', '1.5']) {
    await budget.fill(value);
    await expect(save).toBeDisabled();
  }
  await budget.fill('1');
  await save.click();
  await expect.poll(async () => (await readGoal(page, task.id))?.tokenBudget).toBe(1);
  await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.releaseScriptedTurn());
  await expect(page.getByLabel('持续目标')).toContainText('预算已耗尽');
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  const goal = await readGoal(page, task.id);
  expect(goal.status).toBe('budgetLimited');
  expect(goal.tokensUsed).toBeGreaterThan(1);
  const history = await page.evaluate((id) => window.evowork.openTask({ threadId: id }), task.id);
  // 创建时目标暂为 paused；无工具的首轮可能不计入目标，下一轮才耗尽预算。
  // 守的是 budgetLimited 后不再续跑，不把“从创建起总共一轮”冒充内核契约。
  const stoppedTurns = history.turns.map((turn) => turn.id);
  await reopenGoalTask(page, task);
  await expect(page.getByLabel('持续目标')).toContainText('预算已耗尽');
  await page.waitForTimeout(2_000);
  const restored = await page.evaluate((id) => window.evowork.openTask({ threadId: id }), task.id);
  expect(restored.turns.map((turn) => turn.id)).toEqual(stoppedTurns);
  await electronApp.evaluate(() => {
    globalThis.__evoworkE2E.gateway.scriptWhen(
      'budget-complete',
      (view) => view.text.includes('GOAL-UI-BUDGET') && view.tools.includes('update_goal'),
      { tool: 'update_goal', args: { status: 'complete' } },
    );
  });
  await page.getByRole('button', { name: '追加预算', exact: true }).click();
  await expect(page.getByLabel('持续目标')).toContainText('已完成');
  const extended = await readGoal(page, task.id);
  expect(extended.tokenBudget).toBeGreaterThan(goal.tokensUsed);
  expect(extended.objective).toBe(goal.objective);
  await submitGoalCommand(page, '/goal clear');
  expect(await readGoal(page, task.id)).toBeUndefined();
  await expect(page.getByLabel('持续目标')).toHaveCount(0);
});
