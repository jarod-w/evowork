/** Real Electron, shipped kernel and bundled MCP with a local deterministic upstream. */
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import { horizontalOverflow, resizeWindow } from './assertions.mjs';
test.use({ registerModels: true });
const DEFAULT_PLACEHOLDER = '输入需求，或描述你想完成的工作';
const candidate = { title: '验收交付结果', prompt: '检查刚生成的交付结果，汇总验收结论。' };
async function propose(electronApp, marker, outcome = 'delivered', held = false) {
  await electronApp.evaluate(
    (_electron, { marker, candidate, outcome, held }) => {
      const gateway = globalThis.__evoworkE2E.gateway;
      gateway.scriptWhen(
        'next-actions-propose-' + marker,
        (view) => view.text.includes(marker) && !view.calls.includes('propose_next_actions'),
        {
          tool: 'propose_next_actions',
          args: { outcome, actions: outcome === 'delivered' ? [candidate] : [] },
        },
      );
      gateway.scriptWhen(
        'next-actions-finish-' + marker,
        (view) => view.text.includes(marker) && view.calls.includes('propose_next_actions'),
        held
          ? { kind: 'hold' }
          : {
              kind: 'text',
              text: outcome === 'delivered' ? '已完成交付 ' + marker : '请补充目标格式 ' + marker,
            },
      );
    },
    { marker, candidate, outcome, held },
  );
}
async function task(page, marker) {
  const { tasks } = await page.evaluate(() => window.evowork.getStartup());
  return tasks.find((item) => item.title?.includes(marker));
}
async function idle(page) {
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 60000,
  });
}
async function history(page, id) {
  return page.evaluate((threadId) => window.evowork.openTask({ threadId }), id);
}
test('缺少标题返回字段级错误，保留最终交付且不保存建议或自动重试', async ({
  page,
  electronApp,
}) => {
  const marker = 'INVALIDNEXT-' + Date.now().toString(36);
  await electronApp.evaluate((_electron, marker) => {
    const gateway = globalThis.__evoworkE2E.gateway;
    gateway.scriptWhen(
      'invalid-next-actions',
      (view) => view.text.includes(marker) && !view.calls.includes('propose_next_actions'),
      {
        tool: 'propose_next_actions',
        args: { outcome: 'delivered', actions: [{ prompt: '核对行情' }, { prompt: '核对新闻' }] },
      },
    );
    gateway.scriptWhen(
      'finish-invalid-next-actions',
      (view) => view.text.includes(marker) && view.calls.includes('propose_next_actions'),
      { kind: 'text', text: '当前分析已交付 ' + marker },
    );
  }, marker);
  await startTaskInWorkspace(page, electronApp, marker + ' 分析并交付结论。');
  await idle(page);
  await expect(page.getByText('当前分析已交付 ' + marker, { exact: true })).toBeVisible();
  const current = await task(page, marker);
  const result = await history(page, current.id);
  const calls = result.items.filter(
    (item) => item.type === 'mcpToolCall' && item.tool === 'propose_next_actions',
  );
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls[0])).toContain('actions[0].title');
  expect(JSON.stringify(calls[0])).toContain('actions[1].title');
  expect(JSON.stringify(calls[0])).toContain('不重试');
  expect(result.turns).toHaveLength(1);
  expect(result.turns[0].status).toBe('completed');
  await expect(page.getByLabel('需求输入')).toHaveAttribute('placeholder', DEFAULT_PLACEHOLDER);
});
test('纯文本漏登记由 Stop 在原回合提醒一次，补报建议且不自动执行', async ({
  page,
  electronApp,
}) => {
  const marker = 'TEXTSTOP-' + Date.now().toString(36);
  await electronApp.evaluate(
    (_electron, { marker, candidate }) => {
      const gateway = globalThis.__evoworkE2E.gateway;
      gateway.scriptWhen(
        'text-before-stop',
        (view) => view.text.includes(marker) && !view.text.includes('本回合尚未登记下一步状态。'),
        { kind: 'text', text: '三步计划已交付 ' + marker },
      );
      gateway.scriptWhen(
        'proposal-after-stop',
        (view) =>
          view.text.includes(marker) &&
          view.text.includes('本回合尚未登记下一步状态。') &&
          !view.calls.includes('propose_next_actions'),
        { tool: 'propose_next_actions', args: { outcome: 'delivered', actions: [candidate] } },
      );
      gateway.scriptWhen(
        'finish-after-stop',
        (view) => view.text.includes(marker) && view.calls.includes('propose_next_actions'),
        { kind: 'text', text: '计划已交付，可选择下一步。' },
      );
    },
    { marker, candidate },
  );
  await startTaskInWorkspace(
    page,
    electronApp,
    marker + ' 只在回复中给三步计划，下一阶段准备验收清单。',
  );
  await idle(page);
  await expect(page.getByLabel('需求输入')).toHaveAttribute('placeholder', candidate.prompt);
  const current = await task(page, marker);
  const result = await history(page, current.id);
  expect(result.turns).toHaveLength(1);
  expect(result.turns[0].status).toBe('completed');
  expect(result.items.filter((item) => item.type === 'userMessage')).toHaveLength(1);
  expect(
    result.items.filter(
      (item) => item.type === 'mcpToolCall' && item.tool === 'propose_next_actions',
    ),
  ).toHaveLength(1);
  expect(result.items.filter((item) => item.type === 'commandExecution')).toHaveLength(0);
});
test('模型忽略结束提醒也能完成原回合，不无限重试或伪造建议', async ({ page, electronApp }) => {
  const marker = 'IGNORESTOP-' + Date.now().toString(36);
  await electronApp.evaluate((_electron, marker) => {
    const gateway = globalThis.__evoworkE2E.gateway;
    gateway.scriptWhen(
      'ignore-stop-first',
      (view) => view.text.includes(marker) && !view.text.includes('本回合尚未登记下一步状态。'),
      { kind: 'text', text: '正文交付 ' + marker },
    );
    gateway.scriptWhen(
      'ignore-stop-again',
      (view) => view.text.includes(marker) && view.text.includes('本回合尚未登记下一步状态。'),
      { kind: 'text', text: '结束 ' + marker },
    );
  }, marker);
  await startTaskInWorkspace(page, electronApp, marker + ' 回复一个计划。');
  await idle(page);
  await expect(page.getByText('结束 ' + marker, { exact: true })).toBeVisible();
  await expect(page.getByLabel('需求输入')).toHaveAttribute('placeholder', DEFAULT_PLACEHOLDER);
  const current = await task(page, marker);
  const result = await history(page, current.id);
  expect(result.turns).toHaveLength(1);
  expect(result.turns[0].status).toBe('completed');
  expect(result.items.filter((item) => item.type === 'userMessage')).toHaveLength(1);
});
test('MCP 候选完成后显示，刷新保留，Tab 只填入，编辑后发送走原回合链路', async ({
  page,
  electronApp,
}, testInfo) => {
  const marker = 'NEXT-' + Date.now().toString(36);
  await propose(electronApp, marker);
  await startTaskInWorkspace(page, electronApp, marker + ' 生成交付结果');
  await idle(page);
  const input = page.getByLabel('需求输入');
  await expect(input).toHaveAttribute('placeholder', candidate.prompt);
  await expect(page.getByRole('button', { name: '填入', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '忽略', exact: true })).toHaveCount(0);
  const current = await task(page, marker);
  expect(
    (await history(page, current.id)).items.filter((item) => item.type === 'userMessage'),
  ).toHaveLength(1);
  await page.reload();
  await page.getByRole('button', { name: current.title, exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(input).toHaveAttribute('placeholder', candidate.prompt);
  await page.screenshot({ path: testInfo.outputPath('next-action.png') });
  await resizeWindow(electronApp, 480, 820);
  await page.getByRole('button', { name: '折叠侧边栏', exact: true }).click();
  await expect(input).toHaveAttribute('placeholder', candidate.prompt);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('next-action-480.png') });
  await resizeWindow(electronApp, 1280, 820);
  await input.focus();
  await input.press('Tab');
  await expect(input).toHaveValue(candidate.prompt);
  await expect(input).toHaveAttribute('placeholder', DEFAULT_PLACEHOLDER);
  expect(
    (await history(page, current.id)).items.filter((item) => item.type === 'userMessage'),
  ).toHaveLength(1);
  await input.fill(candidate.prompt + ' 仅检查第一页。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await idle(page);
  await expect
    .poll(
      async () =>
        (await history(page, current.id)).items.filter((item) => item.type === 'userMessage')
          .length,
    )
    .toBe(2);
  await expect(input).toHaveAttribute('placeholder', DEFAULT_PLACEHOLDER);
});
test('运行中的候选不展示、不覆盖草稿，方向右键只填入不发送；Escape 忽略刷新后仍隐藏', async ({
  page,
  electronApp,
}) => {
  const marker = 'DRAFT-' + Date.now().toString(36);
  await propose(electronApp, marker, 'delivered', true);
  await startTaskInWorkspace(page, electronApp, marker + ' 生成结果');
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.scriptedTurnHeld()))
    .toBe(true);
  const input = page.getByLabel('需求输入');
  await input.fill('用户自己的草稿');
  await expect(input).toHaveAttribute('placeholder', DEFAULT_PLACEHOLDER);
  await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.releaseScriptedTurn());
  await idle(page);
  await expect(input).toHaveValue('用户自己的草稿');
  await expect(input).toHaveAttribute('placeholder', DEFAULT_PLACEHOLDER);
  await input.fill('');
  await expect(input).toHaveAttribute('placeholder', candidate.prompt);
  const current = await task(page, marker);
  await input.focus();
  await input.press('ArrowRight');
  await expect(input).toHaveValue(candidate.prompt);
  await expect(input).toBeFocused();
  expect(
    (await history(page, current.id)).items.filter((item) => item.type === 'userMessage'),
  ).toHaveLength(1);
  // A fresh task gets a separate suggestion, which can be persistently dismissed.
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const second = 'IGNORE-' + Date.now().toString(36);
  await propose(electronApp, second);
  await startTaskInWorkspace(page, electronApp, second + ' 生成结果');
  await idle(page);
  await expect(input).toHaveAttribute('placeholder', candidate.prompt);
  const ignored = await task(page, second);
  await input.focus();
  await input.press('Escape');
  await expect(input).toHaveAttribute('placeholder', DEFAULT_PLACEHOLDER);
  await page.reload();
  await page.getByRole('button', { name: ignored.title, exact: true }).click();
  await expect(page.getByLabel('需求输入')).toBeVisible();
  await expect(input).toHaveAttribute('placeholder', DEFAULT_PLACEHOLDER);
});
test('等待用户补充不展示下一步建议', async ({ page, electronApp }) => {
  const marker = 'ASK-' + Date.now().toString(36);
  await propose(electronApp, marker, 'needs_input');
  await startTaskInWorkspace(page, electronApp, marker + ' 需要补充需求');
  await idle(page);
  await expect(page.getByText('请补充目标格式 ' + marker, { exact: true })).toBeVisible();
  await expect(page.getByLabel('需求输入')).toHaveAttribute('placeholder', DEFAULT_PLACEHOLDER);
});

test('提出候选后停止回合，不发布或恢复未完成建议', async ({ page, electronApp }) => {
  const marker = 'STOP-' + Date.now().toString(36);
  await propose(electronApp, marker, 'delivered', true);
  await startTaskInWorkspace(page, electronApp, marker + ' 生成结果');
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.scriptedTurnHeld()))
    .toBe(true);
  const current = await task(page, marker);
  await expect(page.getByLabel('需求输入')).toHaveAttribute('placeholder', DEFAULT_PLACEHOLDER);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.releaseScriptedTurn());
  await idle(page);
  expect(
    await page.evaluate((threadId) => window.evowork.getNextActions({ threadId }), current.id),
  ).toEqual([]);
  await page.reload();
  await page.getByRole('button', { name: current.title, exact: true }).click();
  await expect(page.getByLabel('需求输入')).toHaveAttribute('placeholder', DEFAULT_PLACEHOLDER);
});
