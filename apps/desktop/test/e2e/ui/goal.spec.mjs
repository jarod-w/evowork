import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startCommandApprovals } from './command-approvals.mjs';
import { localPythonCommand } from './shell-commands.mjs';
import { expect, test, startTaskInWorkspace } from './fixtures.mjs';
import {
  attachGoalEvidence,
  goalTask,
  readGoal,
  reopenGoalTask,
  submitGoalCommand,
} from './goal-journey.mjs';

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
  // 暂停必须主动结束在途回合，不能由夹具替产品放行模型。
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
  // 暂停必须主动结束在途回合，不能由夹具替产品放行模型。
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
  const resumePanel = page.getByLabel('长任务目标');
  await resumePanel.getByLabel('Token 预算', { exact: true }).fill('100000');
  await resumePanel.getByRole('button', { name: '保存预算并继续', exact: true }).click();
  await expect(page.getByLabel('持续目标')).toContainText('已完成');
  const extended = await readGoal(page, task.id);
  expect(extended.tokenBudget).toBeGreaterThan(goal.tokensUsed);
  expect(extended.objective).toBe(goal.objective);
  await submitGoalCommand(page, '/goal clear');
  expect(await readGoal(page, task.id)).toBeUndefined();
  await expect(page.getByLabel('持续目标')).toHaveCount(0);
});

test('预算在工具执行中耗尽：中断回合、停止后台命令且刷新不续跑（#24）', async ({
  page,
  electronApp,
}) => {
  const command = localPythonCommand([
    '-c',
    "from pathlib import Path; import time; Path('budget-started.txt').write_text('started'); time.sleep(8); Path('budget-leaked.txt').write_text('leaked')",
  ]);
  await electronApp.evaluate(
    (_, { command }) => {
      const gateway = globalThis.__evoworkE2E.gateway;
      gateway.scriptWhen('budget-wait', (r) => r.text.includes('GOAL-INFLIGHT-BUDGET'), {
        kind: 'hold',
      });
      gateway.scriptWhen(
        'budget-command',
        (r) => r.text.includes('GOAL-INFLIGHT-BUDGET') && r.tools.includes('exec_command'),
        {
          tool: 'exec_command',
          args: { cmd: command, yield_time_ms: 1000, max_output_tokens: 1000 },
          usage: { input_tokens: 1234, output_tokens: 56, total_tokens: 1290 },
        },
      );
      // 模型不服从预算收尾提示时，宿主也必须能停止执行。
      gateway.scriptWhen(
        'budget-ignore',
        (r) => r.text.includes('GOAL-INFLIGHT-BUDGET') && r.calls.includes('exec_command'),
        {
          kind: 'hold',
        },
      );
    },
    { command },
  );
  const stopApprovals = startCommandApprovals(() => page);
  try {
    await startTaskInWorkspace(
      page,
      electronApp,
      '/goal GOAL-INFLIGHT-BUDGET 验证在途工具预算停止',
    );
    await expect
      .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.scriptedTurnHeld()))
      .toBe(true);
    const task = await goalTask(page);
    await submitGoalCommand(page, '/goal');
    const panel = page.getByLabel('长任务目标');
    await panel.getByLabel('Token 预算', { exact: true }).fill('1');
    await panel.getByRole('button', { name: '保存', exact: true }).click();
    await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.releaseScriptedTurn());
    const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
    await expect.poll(() => existsSync(join(workspace, 'budget-started.txt'))).toBe(true);
    await expect(page.getByLabel('持续目标')).toContainText('预算已耗尽');
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
    const history = await page.evaluate((id) => window.evowork.openTask({ threadId: id }), task.id);
    expect(history.turns.some((turn) => turn.status === 'inProgress')).toBe(false);
    expect(history.turns.some((turn) => turn.status === 'interrupted')).toBe(true);
    const turns = history.turns.map((turn) => turn.id);
    await reopenGoalTask(page, task);
    await expect(page.getByLabel('持续目标')).toContainText('预算已耗尽');
    // 超过命令原定的完成时间，确认中断回合后命令没有继续落盘。
    await page.waitForTimeout(9000);
    expect(existsSync(join(workspace, 'budget-leaked.txt'))).toBe(false);
    const restored = await page.evaluate(
      (id) => window.evowork.openTask({ threadId: id }),
      task.id,
    );
    expect(restored.turns.map((turn) => turn.id)).toEqual(turns);
    expect(restored.turns.some((turn) => turn.status === 'inProgress')).toBe(false);
  } finally {
    await stopApprovals();
  }
});

test('目标面板暂停中断在途命令，重启保留暂停，恢复后检查点不重复（#25）', async ({
  page,
  electronApp,
}, testInfo) => {
  const command = localPythonCommand([
    '-c',
    'from pathlib import Path; import time; f=Path("goal-checkpoint.txt").open("ab"); f.write(bytes.fromhex("73617665642d6f6e63650a")); f.close(); time.sleep(8); Path("goal-resumed.txt").write_bytes(bytes.fromhex("726573756d65642d646f6e650a"))',
  ]);
  const resume = localPythonCommand([
    '-c',
    'from pathlib import Path; Path("goal-resumed.txt").write_bytes(bytes.fromhex("726573756d65642d646f6e650a"))',
  ]);
  await electronApp.evaluate(
    (_, { command }) => {
      const gateway = globalThis.__evoworkE2E.gateway;
      gateway.scriptWhen(
        'pause-checkpoint',
        (r) => r.text.includes('GOAL-PAUSE-CONTROL') && r.tools.includes('exec_command'),
        {
          tool: 'exec_command',
          args: { cmd: command, yield_time_ms: 1000 },
        },
      );
      gateway.scriptWhen(
        'pause-ignoring-model',
        (r) =>
          r.text.includes('GOAL-PAUSE-CONTROL') &&
          !globalThis.__evoworkE2E.resumedPause &&
          r.calls.includes('exec_command'),
        { kind: 'hold' },
      );
    },
    { command },
  );
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const checkpoint = () =>
    existsSync(join(workspace, 'goal-checkpoint.txt'))
      ? readFileSync(join(workspace, 'goal-checkpoint.txt'), 'utf8')
      : '';
  const stopApprovals = startCommandApprovals(() => page);
  try {
    await startTaskInWorkspace(
      page,
      electronApp,
      '/goal GOAL-PAUSE-CONTROL 保存检查点，暂停后不得执行后续阶段',
    );
    const task = await goalTask(page);
    await expect.poll(checkpoint).toBe('saved-once\n');
    expect(existsSync(join(workspace, 'goal-resumed.txt'))).toBe(false);
    await submitGoalCommand(page, '/goal');
    await page.getByLabel('长任务目标').getByRole('button', { name: '暂停', exact: true }).click();
    await expect(page.getByLabel('持续目标')).toContainText('已暂停');
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
    const { history } = await attachGoalEvidence(page, testInfo, task);
    expect(history.turns.some((turn) => turn.status === 'inProgress')).toBe(false);
    expect(history.turns.some((turn) => turn.status === 'interrupted')).toBe(true);
    await page.waitForTimeout(9000);
    expect(existsSync(join(workspace, 'goal-resumed.txt'))).toBe(false);
    await reopenGoalTask(page, task);
    await electronApp.evaluate(() => globalThis.__evoworkE2E.killKernel());
    await expect(page.locator('.ew-banner').filter({ hasText: '执行内核已重启' })).toBeVisible({
      timeout: 60000,
    });
    await expect.poll(async () => (await readGoal(page, task.id))?.status).toBe('paused');
    expect(checkpoint()).toBe('saved-once\n');
    expect(existsSync(join(workspace, 'goal-resumed.txt'))).toBe(false);
    const restarted = await page.evaluate(
      (id) => window.evowork.openTask({ threadId: id }),
      task.id,
    );
    expect(restarted.turns.map((turn) => turn.id)).toEqual(history.turns.map((turn) => turn.id));
    await electronApp.evaluate(
      (_, { resume }) => {
        globalThis.__evoworkE2E.resumedPause = true;
        const gateway = globalThis.__evoworkE2E.gateway;
        gateway.scriptWhen(
          'pause-resume-file',
          (r) => r.text.includes('GOAL-PAUSE-CONTROL') && r.tools.includes('exec_command'),
          { tool: 'exec_command', args: { cmd: resume } },
        );
        gateway.scriptWhen(
          'pause-resume-complete',
          (r) => r.text.includes('GOAL-PAUSE-CONTROL') && r.tools.includes('update_goal'),
          { tool: 'update_goal', args: { status: 'complete' } },
        );
      },
      { resume },
    );
    await submitGoalCommand(page, '/goal resume');
    await expect(page.getByLabel('持续目标')).toContainText('已完成');
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
    expect(checkpoint()).toBe('saved-once\n');
    expect(readFileSync(join(workspace, 'goal-resumed.txt'), 'utf8')).toBe('resumed-done\n');
    await attachGoalEvidence(page, testInfo, task);
  } finally {
    await stopApprovals();
  }
});
