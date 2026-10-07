import { writeFileSync } from 'node:fs';
import { selectRealModel } from '../harness/real-models.mjs';
import { expect } from './fixtures.mjs';

export async function submitGoalCommand(page, text) {
  const input = page.getByLabel('需求输入');
  await input.fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(input).toHaveValue('');
}

export async function goalTask(page) {
  const { tasks } = await page.evaluate(() => window.evowork.getStartup());
  const task = [...tasks]
    .filter((entry) => !entry.parentThreadId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  expect(task?.id, '目标应创建持久根任务').toBeTruthy();
  return task;
}

export function readGoal(page, threadId) {
  return page.evaluate((id) => window.evowork.getTaskGoal({ threadId: id }), threadId);
}

export async function reopenGoalTask(page, task) {
  await page.reload();
  await page.getByRole('button', { name: task.title, exact: true }).click();
  await expect(page.getByLabel('需求输入')).toBeVisible();
}

/** 只经公开桥读取权威目标与历史，不读内核文件。 */
export async function attachGoalEvidence(page, testInfo, task) {
  const goal = await readGoal(page, task.id);
  const history = await page.evaluate((id) => window.evowork.openTask({ threadId: id }), task.id);
  const model = testInfo.project.name === 'real' ? selectRealModel() : undefined;
  const state = goal?.status ?? 'cleared';
  const historyPath = testInfo.outputPath(`goal-${state}-history.json`);
  const imagePath = testInfo.outputPath(`goal-${state}-window.png`);
  writeFileSync(historyPath, JSON.stringify({ model, task, goal, history }, null, 2));
  await page.screenshot({ path: imagePath });
  await testInfo.attach(`goal-${state}-history`, {
    path: historyPath,
    contentType: 'application/json',
  });
  await testInfo.attach(`goal-${state}-window`, { path: imagePath, contentType: 'image/png' });
  return { goal, history };
}

/** 失败现场的桥可能已断开；诊断不能覆盖原始断言或挂到整条用例超时。 */
export async function attachGoalFailure(page, testInfo, task) {
  try {
    await Promise.race([
      attachGoalEvidence(page, testInfo, task),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('目标诊断读取超过 10 秒')), 10_000),
      ),
    ]);
  } catch (error) {
    await testInfo.attach('goal-diagnostic-error', {
      body: String(error),
      contentType: 'text/plain',
    });
  }
}
