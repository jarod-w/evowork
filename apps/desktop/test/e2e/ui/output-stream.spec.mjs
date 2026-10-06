import { expect, test } from './fixtures.mjs';

test('输出流保持进度与操作顺序，当前动作可见，停止和刷新后计时与详情一致', async ({
  page,
  electronApp,
}, testInfo) => {
  await electronApp.evaluate(() => {
    const gateway = globalThis.__evoworkE2E.gateway;
    gateway.scriptWhen(
      'stream-command',
      (r) => r.text.includes('OUTPUT-STREAM-UI') && !r.calls.includes('exec_command'),
      {
        preamble: '先核对本机执行环境，再整理结果。',
        tool: 'exec_command',
        args: { cmd: "sleep 1; printf 'STREAM_TOOL_OK\n'; sleep 2", yield_time_ms: 10_000 },
      },
    );
    gateway.scriptWhen(
      'stream-progress',
      (r) => r.text.includes('OUTPUT-STREAM-UI') && r.calls.includes('exec_command'),
      {
        kind: 'hold',
        text: '执行环境已核对，正在整理结果。',
        phase: 'commentary',
        completeMessage: true,
      },
    );
  });
  await page.getByLabel('需求输入').fill('OUTPUT-STREAM-UI 核对执行环境并整理结果');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const first = page.getByText('先核对本机执行环境，再整理结果。', { exact: true });
  await expect(first).toBeVisible();
  const group = page.getByRole('button', { name: /操作记录/ });
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('当前动作')).toContainText('正在');
  await page.screenshot({ path: testInfo.outputPath('running.png') });
  await expect(page.getByText('执行环境已核对，正在整理结果。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('当前动作')).toHaveCount(0);
  await group.click();
  const command = page.locator('.ew-process-body [data-kind="commandExecution"]');
  await command.locator('.ew-item-summary').click();
  await expect(command.locator('.ew-command-output').nth(1)).toHaveText('STREAM_TOOL_OK\n');
  expect(
    (await page.locator('.ew-item-agent').allTextContents()).map((text) => text.trim()),
  ).toEqual(['先核对本机执行环境，再整理结果。', '执行环境已核对，正在整理结果。']);
  await page.screenshot({ path: testInfo.outputPath('expanded.png') });
  await page.getByRole('button', { name: '中断', exact: true }).click();
  const clock = page.getByLabel('回合处理时间');
  await expect(clock).toContainText('已停止');
  const stopped = await clock.innerText();
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  await page.reload();
  await page
    .getByRole('navigation', { name: '侧边栏' })
    .getByRole('button', { name: /^OUTPUT-STREAM-UI/ })
    .first()
    .click();
  await expect(first).toBeVisible();
  await expect(page.getByText('执行环境已核对，正在整理结果。', { exact: true })).toBeVisible();
  await expect(clock).toHaveText(stopped);
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('当前动作')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('restored.png') });
  await group.click();
  await command.locator('.ew-item-summary').click();
  await expect(command.locator('.ew-command-output').nth(1)).toHaveText('STREAM_TOOL_OK\n');
  await group.click();
  await electronApp.evaluate(() =>
    globalThis.__evoworkE2E.gateway.scriptNext({
      kind: 'text',
      text: '执行环境核对完成，结果已经整理。',
    }),
  );
  await page.getByLabel('需求输入').fill('继续整理结果');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByText('执行环境核对完成，结果已经整理。', { exact: true })).toBeVisible();
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
  await expect(clock).toHaveCount(2);
  const durations = await clock.allTextContents();
  await page.reload();
  await page
    .getByRole('navigation', { name: '侧边栏' })
    .getByRole('button', { name: /^OUTPUT-STREAM-UI/ })
    .first()
    .click();
  await expect(page.getByText('执行环境核对完成，结果已经整理。', { exact: true })).toBeVisible();
  await expect(clock).toHaveCount(2);
  expect(await clock.allTextContents()).toEqual(durations);
  await expect(page.getByLabel('当前动作')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('completed.png') });
});
