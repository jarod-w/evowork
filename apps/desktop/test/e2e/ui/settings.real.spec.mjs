import { randomInt } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { selectRealModel } from '../harness/real-models.mjs';
import { horizontalOverflow, resizeWindow } from './assertions.mjs';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';

test.use({
  registerModels: true,
  hostGateway: true,
  desktopEnv: { EVOWORK_UI_FOLLOW_UP_WIRE: '1' },
});

const categories = ['常规', '账号', '模型', '记忆与导入', '用量与预算', '安全与权限', '关于与更新'];
async function selectCategory(page, label) {
  const nav = page.getByRole('navigation', { name: '设置分类' });
  if (await nav.isVisible()) await nav.getByRole('button', { name: label, exact: true }).click();
  else {
    await page.getByRole('button', { name: '设置分类', exact: true }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: label, exact: true, level: 1 })).toBeVisible();
}
async function openSettings(page, label) {
  await page.getByRole('button', { name: /菜单$/ }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await selectCategory(page, label);
}
async function setup(electronApp) {
  const model = selectRealModel();
  expect(model.upstreamModel).toBe('mimo-v2.6-flash');
  expect(model.baseUrl).toBe('https://api.xiaomimimo.com/v1');
  const root = realpathSync(await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace));
  const values = Array.from({ length: 8 }, () => randomInt(100, 1000));
  writeFileSync(join(root, 'settings-input.json'), JSON.stringify(values));
  return { model, root, values };
}
function wire(m) {
  const path = join(dirname(m.root), 'follow-up-wire.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
}
async function completeFileTask(page, electronApp, m, info) {
  // Input is random and exists only on disk: the model must run a real local tool.
  await startTaskInWorkspace(
    page,
    electronApp,
    '请读取当前目录 settings-input.json，用本机 Python 计算其中全部整数的总和与最大值，' +
      '把结果写入 settings-result.json，格式为 {"sum":整数,"max":整数}。' +
      '不要联网、创建子任务或其他会话。最终只回复“设置验收完成”，无需额外分析。',
  );
  const startup = await page.evaluate(() => window.evowork.getStartup());
  const task = startup.tasks.find((task) => task.cwd && realpathSync(task.cwd) === m.root);
  expect(task?.id).toBeTruthy();
  await expect
    .poll(
      async () => {
        const h = await page.evaluate((id) => window.evowork.openTask({ threadId: id }), task.id);
        return h.turns.length > 0 && h.turns.every((turn) => turn.status === 'completed');
      },
      { timeout: 180000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  const result = JSON.parse(readFileSync(join(m.root, 'settings-result.json'), 'utf8'));
  expect(result).toEqual({ sum: m.values.reduce((a, b) => a + b, 0), max: Math.max(...m.values) });
  const history = await page.evaluate((id) => window.evowork.openTask({ threadId: id }), task.id);
  expect(history.items.some((item) => item.type === 'commandExecution')).toBe(true);
  const reply = history.items
    .filter((item) => item.type === 'agentMessage' && item.phase !== 'commentary')
    .map((item) => item.text ?? '')
    .join('\n');
  expect(reply).toContain('设置验收完成');
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  await page.screenshot({ path: info.outputPath('real-settings-task.png') });
  return { task, history, result };
}
async function saveEvidence(page, electronApp, m, info, extra) {
  // Task completion may start a genuine background model request.
  // Wait for its response too, rather than snapshotting an in-flight fetch.
  await expect
    .poll(
      () => {
        const rows = wire(m);
        return rows.filter(
          (request) =>
            request.type === 'request' &&
            !rows.some(
              (outcome) =>
                outcome.type !== 'request' &&
                outcome.pid === request.pid &&
                outcome.id === request.id,
            ),
        ).length;
      },
      { timeout: 60000, intervals: [500, 1000, 2000] },
    )
    .toBe(0);
  const observations = wire(m);
  const requests = observations.filter((row) => row.type === 'request');
  const responses = observations.filter((row) => row.type === 'response');
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((row) => row.model === m.model.upstreamModel)).toBe(true);
  expect(requests.every((row) => row.endpoint === `${m.model.baseUrl}/chat/completions`)).toBe(
    true,
  );
  expect(responses).toHaveLength(requests.length);
  expect(responses.every((row) => row.status === 200)).toBe(true);
  expect(observations.filter((row) => row.type === 'transport-error')).toEqual([]);
  const evidence = {
    model: m.model.upstreamModel,
    baseUrl: m.model.baseUrl,
    input: m.values,
    preferences: await page.evaluate(() => window.evowork.getPreferences()),
    memory: await page.evaluate(() => window.evowork.getMemorySettings()),
    ...extra,
    wire: observations,
    lifecycle: await electronApp.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle()),
  };
  const body = JSON.stringify(evidence, null, 2);
  if (process.env.EVOWORK_UI_MODEL_KEY && body.includes(process.env.EVOWORK_UI_MODEL_KEY))
    throw new Error('凭据扫描命中，拒绝保存测试证据');
  writeFileSync(info.outputPath('real-settings-evidence.json'), body);
}

test('MiMo：设置七分类和窄窗、已保存模型连通性、记忆开关刷新保持及真实文件任务', async ({
  page,
  electronApp,
}, info) => {
  const m = await setup(electronApp);
  await resizeWindow(electronApp, 1280, 820);
  await openSettings(page, '模型');
  await expect(page.getByRole('tab', { name: '对话模型', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.locator('.ew-settings-model-name')).toContainText([m.model.displayName]);
  await page.getByRole('button', { name: `修改 ${m.model.id}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('endpoint 地址')).toHaveValue(m.model.baseUrl);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: `检查 ${m.model.id} 连接`, exact: true }).click();
  await expect(page.getByText('通了：这个模型现在可以用。', { exact: true })).toBeVisible({
    timeout: 60000,
  });
  await page.screenshot({ path: info.outputPath('real-settings-model-connected.png') });
  await selectCategory(page, '记忆与导入');
  const memory = await page.evaluate(() => window.evowork.getMemorySettings());
  const enabled = page.getByRole('checkbox', { name: '启用本地记忆', exact: true });
  await enabled.setChecked(!memory.enabled);
  await expect
    .poll(async () => (await page.evaluate(() => window.evowork.getMemorySettings())).enabled)
    .toBe(!memory.enabled);
  await page.reload();
  await openSettings(page, '记忆与导入');
  await expect(enabled).toBeChecked({ checked: !memory.enabled });
  await enabled.setChecked(memory.enabled);
  await expect
    .poll(async () => (await page.evaluate(() => window.evowork.getMemorySettings())).enabled)
    .toBe(memory.enabled);
  await page.getByRole('button', { name: '折叠侧边栏', exact: true }).click();
  for (const width of [960, 480]) {
    await resizeWindow(electronApp, width, 720);
    for (const label of categories) {
      await selectCategory(page, label);
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
    }
    await selectCategory(page, '模型');
    await page.screenshot({ path: info.outputPath(`real-settings-model-${width}.png`) });
  }
  await resizeWindow(electronApp, 1280, 820);
  await page.getByRole('button', { name: '展开侧边栏', exact: true }).click();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const completed = await completeFileTask(page, electronApp, m, info);
  await saveEvidence(page, electronApp, m, info, { memoryRestored: memory.enabled, ...completed });
});

test('MiMo：预算不在失焦时保存、离开保护草稿、明确保存刷新保持并可正常执行任务', async ({
  page,
  electronApp,
}, info) => {
  const m = await setup(electronApp);
  await openSettings(page, '用量与预算');
  const initial = await page.evaluate(() => window.evowork.getPreferences());
  await page.getByRole('button', { name: '单任务用量上限', exact: true }).click();
  await page.getByRole('menuitem', { name: '自定义', exact: true }).click();
  const input = page.getByLabel('用量上限（tokens）');
  await input.fill('200000');
  await input.press('Tab');
  expect(await page.evaluate(() => window.evowork.getPreferences())).toEqual(initial);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: '设置尚未保存' });
  await expect(confirm).toBeVisible();
  await page.screenshot({ path: info.outputPath('real-settings-budget-guard.png') });
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(input).toHaveValue('200000');
  await page.getByRole('button', { name: '保存预算', exact: true }).click();
  await expect(page.getByText('已保存。', { exact: true })).toBeVisible();
  await page.reload();
  await openSettings(page, '用量与预算');
  await expect(input).toHaveValue('200000');
  expect((await page.evaluate(() => window.evowork.getPreferences())).taskTokenBudget).toBe(200000);
  await page.screenshot({ path: info.outputPath('real-settings-budget-saved.png') });
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const completed = await completeFileTask(page, electronApp, m, info);
  await saveEvidence(page, electronApp, m, info, completed);
});
