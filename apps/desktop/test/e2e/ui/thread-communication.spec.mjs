/** Real Electron + shipped kernel + bundled MCP, with deterministic model responses. */
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
test.use({ registerModels: true });
const idle = (page) =>
  expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', { timeout: 60000 });
async function idFor(page, marker) {
  await expect
    .poll(
      async () => {
        const { tasks } = await page.evaluate(() => window.evowork.getStartup());
        return tasks.find((t) => t.title?.includes(marker))?.id;
      },
      { timeout: 60000 },
    )
    .toBeTruthy();
  const { tasks } = await page.evaluate(() => window.evowork.getStartup());
  return tasks.find((t) => t.title?.includes(marker)).id;
}
async function setup(page, electronApp) {
  const run = Date.now().toString(36),
    b = 'COMM-B-' + run,
    a = 'COMM-A-' + run;
  await startTaskInWorkspace(page, electronApp, b);
  await idle(page);
  const target = await idFor(page, b);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await startTaskInWorkspace(
    page,
    electronApp,
    a + ' ' + '上下文说明'.repeat(24) + ' COMM-PRIVATE-' + run,
  );
  await idle(page);
  return {
    source: await idFor(page, a),
    target,
    a,
    b,
    request: 'COMM-REQUEST-' + run,
    result: 'COMM-RESULT-' + run,
  };
}
async function scriptReplies(electronApp, m) {
  await electronApp.evaluate((_electron, m) => {
    const gateway = globalThis.__evoworkE2E.gateway;
    gateway.scriptWhen(
      'communication-target',
      (r) => r.text.includes('[EvoWork 会话请求') && r.text.includes(m.request),
      { kind: 'text', text: m.result },
    );
    gateway.scriptWhen(
      'communication-summary',
      (r) => r.text.includes('[EvoWork 会话回复') && r.text.includes(m.result),
      { kind: 'text', text: '已汇总 ' + m.result },
    );
  }, m);
}
test('用户明确选择同项目目标，完整请求执行、回传、汇总与刷新恢复，无回复循环', async ({
  page,
  electronApp,
}, testInfo) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const m = await setup(page, electronApp);
  await scriptReplies(electronApp, m);
  await page.getByText('会话通信', { exact: true }).click();
  await expect(page.getByLabel('通信目标会话').locator('option')).toContainText([
    '请选择会话',
    m.b,
  ]);
  await page.getByLabel('通信目标会话').selectOption(m.target);
  await page.getByLabel('会话请求内容').fill(m.request);
  await page.getByRole('button', { name: '发送会话请求', exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(
            (threadId) => window.evowork.getCommunicationRecords({ threadId }),
            m.source,
          )
        )[0]?.status,
      { timeout: 90000 },
    )
    .toBe('completed');
  await expect(page.getByLabel('会话通信记录')).toContainText(m.result);
  await expect(page.getByLabel('会话通信记录')).toContainText('已完成');
  const conversation = await page.locator('.ew-conversation-scroll').boundingBox();
  const windowHeight = await page.evaluate(() => window.innerHeight);
  expect(conversation.height).toBeGreaterThan(windowHeight / 8);
  const records = await page.evaluate(
    (threadId) => window.evowork.getCommunicationRecords({ threadId }),
    m.source,
  );
  expect(records).toHaveLength(1);
  const targetHistory = await page.evaluate(
    (threadId) => window.evowork.openTask({ threadId }),
    m.target,
  );
  expect(JSON.stringify(targetHistory.items)).toContain(m.request);
  expect(JSON.stringify(targetHistory.items)).not.toContain(
    'COMM-PRIVATE-' + m.a.replace('COMM-A-', ''),
  );
  await page.screenshot({
    path: testInfo.outputPath('communication-completed.png'),
    fullPage: true,
  });
  const sourceTitle = (await page.evaluate(() => window.evowork.getStartup())).tasks.find(
    (t) => t.id === m.source,
  ).title;
  await page.reload();
  await page.getByRole('button', { name: sourceTitle, exact: true }).click();
  await page.getByText('会话通信', { exact: true }).click();
  await expect(page.getByLabel('会话通信记录')).toContainText(m.result);
  const after = await page.evaluate(
    (threadId) => window.evowork.getCommunicationRecords({ threadId }),
    m.source,
  );
  expect(after).toHaveLength(1);
  expect(after[0].id).toBe(records[0].id);
  expect(after[0].status).toBe('completed');
  expect(pageErrors).toEqual([]);
});
for (const accept of [false, true]) {
  test(`代理发起独立会话请求：${accept ? '批准后执行并回传' : '拒绝后零投递'}`, async ({
    page,
    electronApp,
  }) => {
    const m = await setup(page, electronApp);
    await scriptReplies(electronApp, m);
    await electronApp.evaluate((_electron, m) => {
      const gateway = globalThis.__evoworkE2E.gateway;
      gateway.scriptWhen(
        'communication-send',
        (r) => r.text.includes('COMM-ASK-' + m.a) && !r.calls.includes('send_request'),
        {
          tool: 'send_request',
          args: { targetThreadId: m.target, text: m.request },
        },
      );
      gateway.scriptWhen('communication-sent', (r) => r.calls.includes('send_request'), {
        kind: 'text',
        text: '本次通信工具调用已结束。',
      });
    }, m);
    await page.getByLabel('需求输入').fill('COMM-ASK-' + m.a);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const approval = page
      .getByRole('alertdialog')
      .filter({ has: page.getByRole('button', { name: '批准本次发送', exact: true }) });
    // Native MCP policy may separately request permission to invoke the connector.
    const native = page
      .getByRole('alertdialog')
      .filter({ has: page.getByRole('button', { name: '允许这一次', exact: true }) });
    await expect
      .poll(async () => (await approval.count()) + (await native.count()), { timeout: 60000 })
      .toBeGreaterThan(0);
    if (await native.count())
      await native.getByRole('button', { name: '允许这一次', exact: true }).click();
    await expect(approval).toBeVisible();
    await expect(approval).toContainText(m.b);
    await expect(approval).toContainText(m.request);
    expect(
      await page.evaluate(
        (threadId) => window.evowork.getCommunicationRecords({ threadId }),
        m.source,
      ),
    ).toHaveLength(0);
    await approval
      .getByRole('button', { name: accept ? '批准本次发送' : '拒绝', exact: true })
      .click();
    await idle(page);
    if (accept)
      await expect
        .poll(
          async () =>
            (
              await page.evaluate(
                (threadId) => window.evowork.getCommunicationRecords({ threadId }),
                m.source,
              )
            )[0]?.status,
          { timeout: 90000 },
        )
        .toBe('completed');
    else
      expect(
        await page.evaluate(
          (threadId) => window.evowork.getCommunicationRecords({ threadId }),
          m.source,
        ),
      ).toHaveLength(0);
  });
}
