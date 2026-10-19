import { randomInt } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { selectRealModel } from '../harness/real-models.mjs';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import { goalTask, readGoal, reopenGoalTask } from './goal-journey.mjs';

test.use({
  registerModels: true,
  hostGateway: true,
  desktopEnv: { EVOWORK_UI_FOLLOW_UP_WIRE: '1' },
});

async function openSettings(page, category) {
  await page.getByRole('button', { name: /菜单$/ }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page
    .getByRole('navigation', { name: '设置分类' })
    .getByRole('button', { name: category, exact: true })
    .click();
}
function wire(root) {
  const path = join(dirname(root), 'follow-up-wire.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
}
async function history(page, id) {
  return page.evaluate((threadId) => window.evowork.openTask({ threadId }), id);
}
async function snapshot(page, root, task) {
  return {
    goal: await readGoal(page, task.id),
    history: await history(page, task.id),
    wire: wire(root),
    result: existsSync(join(root, 'budget-result.json'))
      ? JSON.parse(readFileSync(join(root, 'budget-result.json'), 'utf8'))
      : null,
  };
}
function persist(info, evidence) {
  const body = JSON.stringify(evidence, null, 2);
  const key = process.env.EVOWORK_UI_MODEL_KEY;
  if (key && body.includes(key)) throw new Error('凭据扫描命中，拒绝保存证据');
  writeFileSync(info.outputPath('budget-evidence.json'), body);
}

for (const action of ['追加预算', '结束任务']) {
  test(`MiMo：设置默认预算真正耗尽、刷新不续跑，明确${action}`, async ({
    page,
    electronApp,
  }, info) => {
    const model = selectRealModel();
    expect(model.upstreamModel).toBe('mimo-v2.6-flash');
    expect(model.baseUrl).toBe('https://api.xiaomimimo.com/v1');
    const root = realpathSync(await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace));
    const values = [randomInt(100, 1000), randomInt(100, 1000)];
    writeFileSync(join(root, 'budget-input.json'), JSON.stringify(values));
    // A real first tool creates a checkpoint and waits for local input readiness.
    // Only tool timing is controlled; all model requests and budget accounting are real.
    writeFileSync(
      join(root, 'budget_checkpoint.py'),
      [
        'from pathlib import Path',
        'import time',
        "if not Path('budget-checkpoint.txt').exists(): Path('budget-checkpoint.txt').write_text('ready-once\\n')",
        'deadline = time.monotonic() + 90',
        "while not Path('budget-release').exists():",
        "    if time.monotonic() > deadline: raise RuntimeError('input not ready')",
        '    time.sleep(0.1)',
        "print('检查点就绪；剩余任务是计算输入文件并交付结果。')",
        '',
      ].join('\n'),
    );
    await openSettings(page, '记忆与导入');
    await page.getByRole('checkbox', { name: '启用本地记忆', exact: true }).setChecked(false);
    await expect
      .poll(async () => (await page.evaluate(() => window.evowork.getMemorySettings())).enabled)
      .toBe(false);
    await openSettings(page, '用量与预算');
    await page.getByRole('button', { name: '单任务用量上限', exact: true }).click();
    await page.getByRole('menuitem', { name: '自定义', exact: true }).click();
    await page.getByLabel('用量上限（tokens）').fill('1');
    await page.getByRole('button', { name: '保存预算', exact: true }).click();
    await expect
      .poll(
        async () => (await page.evaluate(() => window.evowork.getPreferences())).taskTokenBudget,
      )
      .toBe(1);
    await page.getByRole('button', { name: '新建任务', exact: true }).click();
    let task;
    const evidence = { model: model.upstreamModel, baseUrl: model.baseUrl, action, input: values };
    try {
      await startTaskInWorkspace(
        page,
        electronApp,
        '这是预算暂停验收。首先仅执行 python3 budget_checkpoint.py，等待脚本返回。' +
          '预算耗尽时遵守系统限制，立即收尾，不执行剩余步骤，不标记目标完成。' +
          '用户明确追加预算后才继续：读取 budget-input.json，用本机 Python 计算两个整数之和，' +
          '把 {"sum":整数} 写入 budget-result.json，读取核验后调用 update_goal 标记 complete，最终回复“预算恢复验收完成”。' +
          '不要修改检查点脚本或 budget-release，不要联网、派生子任务或创建其他会话。',
      );
      task = await goalTask(page);
      await expect
        .poll(async () => (await readGoal(page, task.id))?.tokenBudget, {
          timeout: 10000,
          message: '设置默认预算没有在首轮生效',
        })
        .toBe(1);
      writeFileSync(join(root, 'budget-release'), 'ready');
      await expect(page.getByLabel('持续目标')).toContainText('预算已耗尽', { timeout: 150000 });
      await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
        timeout: 120000,
      });
      evidence.limited = await snapshot(page, root, task);
      expect(evidence.limited.goal.tokensUsed).toBeGreaterThan(1);
      expect(evidence.limited.goal.status).toBe('budgetLimited');
      expect(evidence.limited.result).toBeNull();
      const stoppedTurns = evidence.limited.history.turns.map((turn) => turn.id);
      await page.screenshot({ path: info.outputPath('budget-limited.png') });
      await reopenGoalTask(page, task);
      await expect(page.getByLabel('持续目标')).toContainText('预算已耗尽');
      await page.waitForTimeout(5000);
      evidence.restored = await snapshot(page, root, task);
      expect(evidence.restored.goal.status).toBe('budgetLimited');
      expect(evidence.restored.history.turns.map((turn) => turn.id)).toEqual(stoppedTurns);
      expect(evidence.restored.wire.filter((r) => r.type === 'request')).toHaveLength(
        evidence.limited.wire.filter((r) => r.type === 'request').length,
      );
      expect(evidence.restored.result).toBeNull();
      await page.screenshot({ path: info.outputPath('budget-restored.png') });
      await page.getByRole('button', { name: action, exact: true }).click();
      if (action === '追加预算') {
        const panel = page.getByLabel('长任务目标');
        await expect(panel).toBeVisible();
        await expect(panel.getByRole('button', { name: '保存预算并继续' })).toBeDisabled();
        await panel.getByLabel('Token 预算', { exact: true }).fill('100000');
        await panel.getByRole('button', { name: '取消', exact: true }).click();
        await expect(panel).not.toBeVisible();
        expect((await readGoal(page, task.id)).status).toBe('budgetLimited');
        await page.getByRole('button', { name: '追加预算', exact: true }).click();
        await expect(panel.getByLabel('Token 预算', { exact: true })).toHaveValue('1');
        // Opening the editor must not resume or spend tokens before explicit approval.
        await page.waitForTimeout(3000);
        expect((await readGoal(page, task.id)).status).toBe('budgetLimited');
        expect(wire(root).filter((r) => r.type === 'request')).toHaveLength(
          evidence.restored.wire.filter((r) => r.type === 'request').length,
        );
        await panel.getByLabel('Token 预算', { exact: true }).fill('100000');
        await page.screenshot({ path: info.outputPath('budget-add-confirm.png') });
        await panel.getByRole('button', { name: '保存预算并继续', exact: true }).click();
      }
      await expect(page.getByLabel('持续目标')).toContainText('已完成', { timeout: 150000 });
      await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
      evidence.final = await snapshot(page, root, task);
      expect(evidence.final.goal.status).toBe('complete');
      expect(evidence.final.goal.objective).toBe(evidence.limited.goal.objective);
      if (action === '追加预算') {
        expect(evidence.final.goal.tokenBudget).toBeGreaterThan(evidence.limited.goal.tokensUsed);
        expect(evidence.final.result).toEqual({ sum: values[0] + values[1] });
        expect(
          evidence.final.history.items.some(
            (i) =>
              i.type === 'agentMessage' &&
              i.phase !== 'commentary' &&
              i.text?.includes('预算恢复验收完成'),
          ),
        ).toBe(true);
      } else {
        await page.waitForTimeout(5000);
        const after = await snapshot(page, root, task);
        expect(after.history.turns.map((t) => t.id)).toEqual(stoppedTurns);
        expect(after.wire.filter((r) => r.type === 'request')).toHaveLength(
          evidence.restored.wire.filter((r) => r.type === 'request').length,
        );
        expect(after.result).toBeNull();
      }
      await expect(page.getByRole('alert', { name: '回合失败' })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath('budget-final.png') });
      const requests = wire(root).filter((r) => r.type === 'request');
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests.every(
          (r) =>
            r.model === model.upstreamModel && r.endpoint === `${model.baseUrl}/chat/completions`,
        ),
      ).toBe(true);
      expect(
        requests.every((q) =>
          wire(root).some(
            (r) => r.type === 'response' && r.id === q.id && r.pid === q.pid && r.status === 200,
          ),
        ),
      ).toBe(true);
    } finally {
      writeFileSync(join(root, 'budget-release'), 'ready');
      if (task) evidence.last = await snapshot(page, root, task).catch(() => null);
      evidence.lifecycle = await electronApp
        .evaluate(() => globalThis.__evoworkE2E.kernelLifecycle())
        .catch(() => null);
      persist(info, evidence);
    }
  });
}
