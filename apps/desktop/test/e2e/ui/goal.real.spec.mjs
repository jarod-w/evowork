/** 真模型、宿主网关、发货内核与真窗口；文件内容及权威目标为验收依据。 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import {
  attachGoalEvidence,
  attachGoalFailure,
  goalTask,
  readGoal,
  reopenGoalTask,
  submitGoalCommand,
} from './goal-journey.mjs';

test.use({ registerModels: true, hostGateway: true });
const contents = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '');

test('真模型 goal：首轮未完成自动续跑，验证文件后完成，刷新保留并清除', async ({
  page,
  electronApp,
}, testInfo) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const marker = `GOAL-AUTO-${Date.now()}`;
  await startTaskInWorkspace(
    page,
    electronApp,
    `/goal ${marker} 分两回合完成验收。第一个回合只回复“阶段一就绪”，不调用任何工具，不完成目标，并结束这个回合。系统自动开启下一个回合后，用 exec_command 在当前工作目录创建 goal-result.txt，内容严格为 ${marker} 加一个换行；读取文件核验，再调用 update_goal 标记 complete。不要派生子任务、联网或修改其它文件。`,
  );
  const task = await goalTask(page);
  try {
    await expect(page.getByLabel('持续目标')).toContainText('已完成', { timeout: 180_000 });
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
    expect(contents(join(workspace, 'goal-result.txt'))).toBe(`${marker}\n`);
    const { goal, history } = await attachGoalEvidence(page, testInfo, task);
    expect(goal.status).toBe('complete');
    expect(goal.tokenBudget).toBeNull();
    expect(goal.tokensUsed).toBeGreaterThan(0);
    expect(
      history.turns.filter((turn) => turn.status === 'completed').length,
    ).toBeGreaterThanOrEqual(2);
    expect(history.items.filter((item) => item.type === 'userMessage')).toHaveLength(1);
    await expect(page.getByRole('alert', { name: '回合失败' })).toHaveCount(0);
    await reopenGoalTask(page, task);
    await expect(page.getByLabel('持续目标')).toContainText('已完成');
    await submitGoalCommand(page, '/goal');
    await expect(page.getByLabel('长任务目标')).toBeVisible();
    await submitGoalCommand(page, '/goal clear');
    await expect(page.getByLabel('持续目标')).toHaveCount(0);
    expect(await readGoal(page, task.id)).toBeUndefined();
    expect(contents(join(workspace, 'goal-result.txt'))).toBe(`${marker}\n`);
  } catch (error) {
    await attachGoalFailure(page, testInfo, task);
    throw error;
  }
});

test('真模型 goal：运行时暂停，刷新与内核重启保留，恢复后不重复检查点', async ({
  page,
  electronApp,
}, testInfo) => {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  await startTaskInWorkspace(
    page,
    electronApp,
    '/goal 分两阶段交付。首次回合用 exec_command 执行单条命令：printf "saved-once\\n" >> goal-checkpoint.txt; sleep 20 。命令返回后只回复“检查点已保存”，结束回合，不调用 update_goal、不执行第二阶段。我会在等待期间暂停目标。系统恢复并开启下一回合后先读取 goal-checkpoint.txt，已有检查点不能重复写入；创建 goal-resumed.txt，内容严格为 resumed-done 加换行，读取核验，最后调用 update_goal complete。不要联网、派生子任务或修改其它文件。',
  );
  const task = await goalTask(page);
  try {
    await expect
      .poll(() => contents(join(workspace, 'goal-checkpoint.txt')), { timeout: 120_000 })
      .toBe('saved-once\n');
    await submitGoalCommand(page, '/goal pause');
    await expect(page.getByLabel('持续目标')).toContainText('已暂停');
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
      timeout: 120_000,
    });
    expect(existsSync(join(workspace, 'goal-resumed.txt'))).toBe(false);
    const before = await readGoal(page, task.id);
    await reopenGoalTask(page, task);
    await expect(page.getByLabel('持续目标')).toContainText('已暂停');
    await electronApp.evaluate(() => globalThis.__evoworkE2E.killKernel());
    await expect(page.locator('.ew-banner').filter({ hasText: '执行内核已重启' })).toBeVisible({
      timeout: 60_000,
    });
    await expect.poll(async () => (await readGoal(page, task.id))?.status).toBe('paused');
    expect((await readGoal(page, task.id)).objective).toBe(before.objective);
    expect(existsSync(join(workspace, 'goal-resumed.txt'))).toBe(false);
    await submitGoalCommand(page, '/goal resume');
    await expect(page.getByLabel('持续目标')).toContainText('已完成', { timeout: 150_000 });
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
    expect(contents(join(workspace, 'goal-checkpoint.txt'))).toBe('saved-once\n');
    expect(contents(join(workspace, 'goal-resumed.txt'))).toBe('resumed-done\n');
    await expect(page.getByRole('alert', { name: '回合失败' })).toHaveCount(0);
    await attachGoalEvidence(page, testInfo, task);
  } catch (error) {
    await attachGoalFailure(page, testInfo, task);
    throw error;
  }
});

test('真模型 goal：极小预算耗尽后停止续跑，刷新保留状态并可结束', async ({
  page,
  electronApp,
}, testInfo) => {
  await startTaskInWorkspace(
    page,
    electronApp,
    '/goal 预算停止验收。先用 exec_command 执行 sleep 20；返回后只回复“仍有剩余步骤”，结束回合，目标尚未完成，不调用 update_goal。后续回合也不要标记完成，不要写文件、联网或派生子任务。',
  );
  const task = await goalTask(page);
  try {
    await submitGoalCommand(page, '/goal');
    const panel = page.getByLabel('长任务目标');
    await panel.getByLabel('Token 预算', { exact: true }).fill('1');
    await panel.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByLabel('持续目标')).toContainText('预算已耗尽', { timeout: 120_000 });
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
    const { goal, history } = await attachGoalEvidence(page, testInfo, task);
    expect(goal.status).toBe('budgetLimited');
    expect(goal.tokenBudget).toBe(1);
    expect(goal.tokensUsed).toBeGreaterThan(1);
    expect(history.turns).toHaveLength(1);
    await reopenGoalTask(page, task);
    await expect(page.getByLabel('持续目标')).toContainText('预算已耗尽');
    await expect(page.getByRole('button', { name: '追加预算', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '结束任务', exact: true }).click();
    await expect(page.getByLabel('持续目标')).toContainText('已完成');
    expect((await readGoal(page, task.id)).status).toBe('complete');
    await expect(page.getByRole('alert', { name: '回合失败' })).toHaveCount(0);
    await attachGoalEvidence(page, testInfo, task);
  } catch (error) {
    await attachGoalFailure(page, testInfo, task);
    throw error;
  }
});
