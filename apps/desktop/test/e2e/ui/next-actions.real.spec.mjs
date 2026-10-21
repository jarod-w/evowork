/** Real providers, host gateway, shipped kernel, bundled MCP and actual Electron input. */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import { selectRealModel } from '../harness/real-models.mjs';

test.use({
  registerModels: true,
  hostGateway: true,
  desktopEnv: { EVOWORK_UI_FOLLOW_UP_WIRE: '1' },
});
const history = (page, id) =>
  page.evaluate((threadId) => window.evowork.openTask({ threadId }), id);
async function setup(electronApp) {
  const model = selectRealModel();
  expect(['mimo-v2.6-flash', 'deepseek-flash']).toContain(model.upstreamModel);
  const root = realpathSync(await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace));
  return { model, root, marker: 'REALNEXT_' + randomBytes(5).toString('hex') };
}
async function currentTask(page, m) {
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.evowork.getStartup())).tasks.find(
          (t) => t.cwd && realpathSync(t.cwd) === m.root,
        )?.id,
    )
    .toBeTruthy();
  return (await page.evaluate(() => window.evowork.getStartup())).tasks.find(
    (t) => t.cwd && realpathSync(t.cwd) === m.root,
  );
}
async function completed(page, id, turns) {
  await expect
    .poll(
      async () => {
        const h = await history(page, id);
        return h.turns.length === turns && h.turns.every((turn) => turn.status === 'completed');
      },
      { timeout: 180000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
}
const proposals = (h) =>
  h.items.filter(
    (item) =>
      item.type === 'mcpToolCall' &&
      item.server === 'next_actions' &&
      item.tool === 'propose_next_actions',
  );
const argumentsOf = (item) =>
  typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
function wire(m) {
  const filename = join(dirname(m.root), 'follow-up-wire.jsonl');
  return existsSync(filename)
    ? readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
}
async function evidence(page, electronApp, m, info, task, extra = {}, strict = true) {
  await expect
    .poll(
      () => {
        const rows = wire(m);
        return rows.filter(
          (row) =>
            row.type === 'request' &&
            !rows.some(
              (outcome) =>
                outcome.type !== 'request' && outcome.pid === row.pid && outcome.id === row.id,
            ),
        ).length;
      },
      { timeout: 60000, intervals: [500, 1000, 2000] },
    )
    .toBe(0);
  const observations = wire(m);
  const requests = observations.filter((row) => row.type === 'request');
  if (strict) {
    expect(requests.length).toBeGreaterThan(0);
    const taskRequests = requests.filter((row) => row.hasNextActionTask);
    expect(taskRequests.length).toBeGreaterThan(0);
    expect(
      taskRequests.every(
        (row) => row.hasNextActionRules && row.hasNextActionRulesInSystem && row.hasNextActionTool,
      ),
    ).toBe(true);
    expect(requests.every((row) => row.model === m.model.upstreamModel)).toBe(true);
    expect(
      requests.every(
        (row) =>
          row.endpoint ===
          (m.model.provider === 'deepseek'
            ? 'https://api.deepseek.com/v1/chat/completions'
            : m.model.baseUrl.replace(/\/$/, '') + '/chat/completions'),
      ),
    ).toBe(true);
    expect(observations.filter((row) => row.type === 'response')).toHaveLength(requests.length);
    expect(
      observations.filter((row) => row.type === 'response').every((row) => row.status === 200),
    ).toBe(true);
    expect(observations.filter((row) => row.type === 'transport-error')).toEqual([]);
  }
  const result = {
    model: m.model.upstreamModel,
    baseUrl: m.model.baseUrl,
    marker: m.marker,
    ...extra,
    history: task ? await history(page, task.id) : null,
    wire: observations,
    lifecycle: await electronApp.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle()),
  };
  const body = JSON.stringify(result, null, 2);
  if (process.env.EVOWORK_UI_MODEL_KEY && body.includes(process.env.EVOWORK_UI_MODEL_KEY))
    throw new Error('凭据扫描命中，拒绝保存证据');
  writeFileSync(info.outputPath('next-actions-real-evidence.json'), body);
  await page.screenshot({ path: info.outputPath('next-actions-real-final.png') });
}

test('真实模型自主提出后续建议：实际文件交付、草稿保护、刷新、Tab 采纳及编辑后执行', async ({
  page,
  electronApp,
}, info) => {
  const m = await setup(electronApp);
  const values = Array.from({ length: 7 }, () => randomInt(100, 1000));
  writeFileSync(join(m.root, 'sales-input.json'), JSON.stringify(values));
  let task;
  try {
    await startTaskInWorkspace(
      page,
      electronApp,
      m.marker +
        ' 请读取当前目录 sales-input.json，用本机 Python 计算全部整数的总和与最大值，写入 analysis.json，格式严格为 {"total":整数,"max":整数}，并读取核验。' +
        '本轮先完成这个分析文件即可；下一阶段我准备把分析结果整理成一页管理层 Markdown 汇报，还没有开始做。不要提前制作汇报，不联网、不读环境变量或工作目录外文件、不创建子任务。',
    );
    task = await currentTask(page, m);
    const input = page.getByLabel('需求输入');
    await input.fill('用户正在编辑的草稿 ' + m.marker);
    await completed(page, task.id, 1);
    expect(JSON.parse(readFileSync(join(m.root, 'analysis.json'), 'utf8'))).toEqual({
      total: values.reduce((sum, value) => sum + value, 0),
      max: Math.max(...values),
    });
    await expect(input).toHaveValue('用户正在编辑的草稿 ' + m.marker);
    await expect(page.getByLabel('下一步建议')).toHaveCount(0);
    const first = await history(page, task.id);
    expect(first.items.some((item) => item.type === 'commandExecution')).toBe(true);
    expect(proposals(first).length).toBeGreaterThan(0);
    const proposal = proposals(first).at(-1);
    expect(proposal.status).toBe('completed');
    expect(proposal.error ?? null).toBeNull();
    expect(argumentsOf(proposal).outcome).toBe('delivered');
    expect(argumentsOf(proposal).actions.length).toBeGreaterThan(0);
    expect(existsSync(join(m.root, 'accepted-report.md'))).toBe(false);
    await input.fill('');
    const suggestion = page.getByLabel('下一步建议');
    await expect(suggestion).toBeVisible();
    const actions = await page.evaluate(
      (threadId) => window.evowork.getNextActions({ threadId }),
      task.id,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].prompt.length).toBeGreaterThan(4);
    await page.screenshot({ path: info.outputPath('next-actions-real-suggestion.png') });
    await page.reload();
    await page.getByRole('button', { name: task.title, exact: true }).click();
    await expect(suggestion).toBeVisible();
    await input.focus();
    await input.press('Tab');
    await expect(input).toHaveValue(actions[0].prompt);
    expect(
      (await history(page, task.id)).items.filter((item) => item.type === 'userMessage'),
    ).toHaveLength(1);
    await expect(suggestion).toHaveCount(0);
    const followup =
      actions[0].prompt +
      '\n具体要求：仅基于 analysis.json 生成 accepted-report.md，内容包含分析结果和验收标识 ' +
      m.marker +
      '。不要联网、读取环境变量、修改其他文件或执行上线。完成后简短回复。';
    await input.fill(followup);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await completed(page, task.id, 2);
    expect(readFileSync(join(m.root, 'accepted-report.md'), 'utf8')).toContain(m.marker);
    const after = await history(page, task.id);
    expect(after.items.filter((item) => item.type === 'userMessage')).toHaveLength(2);
    const lastInput = after.items.filter((item) => item.type === 'userMessage').at(-1);
    expect(
      lastInput.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n'),
    ).toContain(followup);
    await evidence(page, electronApp, m, info, task, {
      values,
      first,
      actions,
      followup,
      report: readFileSync(join(m.root, 'accepted-report.md'), 'utf8'),
    });
  } catch (error) {
    await evidence(page, electronApp, m, info, task, { values }, false).catch(() => undefined);
    throw error;
  }
});

test('真实模型等待补充时无建议，回答后交付计划；点击忽略在刷新重开后保持', async ({
  page,
  electronApp,
}, info) => {
  const m = await setup(electronApp);
  let task;
  try {
    await startTaskInWorkspace(
      page,
      electronApp,
      m.marker +
        ' 我需要一个三步上线计划，但还没有决定用 Markdown 还是 JSON。请先只问我交付格式，等我回答后再拟计划。这一轮不要创建文件，也不要开始计划。不要联网、读取环境变量或创建子任务。',
    );
    task = await currentTask(page, m);
    await completed(page, task.id, 1);
    const awaiting = await history(page, task.id);
    await expect(page.getByLabel('下一步建议')).toHaveCount(0);
    expect(
      await page.evaluate((threadId) => window.evowork.getNextActions({ threadId }), task.id),
    ).toEqual([]);
    for (const item of proposals(awaiting)) {
      expect(argumentsOf(item).outcome).toBe('needs_input');
      expect(argumentsOf(item).actions).toEqual([]);
    }
    await page.screenshot({ path: info.outputPath('next-actions-real-awaiting.png') });
    await page
      .getByLabel('需求输入')
      .fill(
        '选择 Markdown。现在仅在回复中给出三步上线计划，不写文件。下一阶段我准备将计划扩展成回滚演练检查清单，本轮先不制作清单。实际执行上线将来再由我安排，目前只完成计划；不要联网、读取环境变量或使用子任务。',
      );
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await completed(page, task.id, 2);
    const suggestion = page.getByLabel('下一步建议');
    await expect(suggestion).toBeVisible();
    const actions = await page.evaluate(
      (threadId) => window.evowork.getNextActions({ threadId }),
      task.id,
    );
    expect(actions).toHaveLength(1);
    const delivered = await history(page, task.id);
    const proposal = proposals(delivered).at(-1);
    expect(proposal?.status).toBe('completed');
    expect(argumentsOf(proposal).outcome).toBe('delivered');
    expect(actions[0].prompt).toContain('回滚');
    expect(actions[0].prompt).toMatch(/演练|检查/);
    await suggestion.getByRole('button', { name: '忽略', exact: true }).click();
    await expect(suggestion).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: task.title, exact: true }).click();
    await expect(suggestion).toHaveCount(0);
    expect(
      await page.evaluate((threadId) => window.evowork.getNextActions({ threadId }), task.id),
    ).toEqual([]);
    expect(
      (await history(page, task.id)).items.filter((item) => item.type === 'userMessage'),
    ).toHaveLength(2);
    await evidence(page, electronApp, m, info, task, { awaiting, delivered, actions });
  } catch (error) {
    await evidence(page, electronApp, m, info, task, {}, false).catch(() => undefined);
    throw error;
  }
});
