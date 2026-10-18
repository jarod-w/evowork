/** Real provider + host gateway + shipped kernel + bundled MCP + Electron UI. */
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import { selectRealModel } from '../harness/real-models.mjs';
import { writeFileSync } from 'node:fs';

test.use({ registerModels: true, hostGateway: true });
const idle = (page) =>
  expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 120000,
  });
async function create(page, electronApp, marker, extra = '') {
  await startTaskInWorkspace(
    page,
    electronApp,
    `${marker} 本次只回复“初始化完成”，不要使用工具、联网、读写文件或创建子任务。${extra}`,
  );
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.evowork.getStartup())).tasks.find((t) =>
          t.title?.includes(marker),
        )?.id,
      { timeout: 60000 },
    )
    .toBeTruthy();
  await idle(page);
  return (await page.evaluate(() => window.evowork.getStartup())).tasks.find((t) =>
    t.title?.includes(marker),
  );
}
async function setup(page, electronApp) {
  const run = Date.now().toString(36),
    privateText = `PRIVATE-${run}`;
  const target = await create(page, electronApp, `REAL-B-${run}`);
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const source = await create(
    page,
    electronApp,
    `REAL-A-${run}`,
    '这是来源独有的背景资料。'.repeat(20) + privateText,
  );
  const answer = `ANSWER-${run}`;
  return {
    source,
    target,
    privateText,
    answer,
    request: `REQUEST-${run} 请计算 17 + 25。只回复“${answer}：42”，不要使用工具、联网、读写文件或继续发送消息。`,
  };
}
const records = (page, id) =>
  page.evaluate((threadId) => window.evowork.getCommunicationRecords({ threadId }), id);
async function evidence(page, testInfo, m) {
  const history = await page.evaluate(async (m) => {
    const source = await window.evowork.openTask({ threadId: m.source.id });
    const target = await window.evowork.openTask({ threadId: m.target.id });
    const records = await window.evowork.getCommunicationRecords({ threadId: m.source.id });
    return { source, target, records };
  }, m);
  const body = JSON.stringify({ model: selectRealModel().upstreamModel, ...history }, null, 2);
  writeFileSync(testInfo.outputPath('communication-history.json'), body);
  await testInfo.attach('communication-history', {
    body,
    contentType: 'application/json',
  });
  await page.screenshot({ path: testInfo.outputPath('communication.png'), fullPage: true });
  return history;
}
async function completed(page, testInfo, m, sourceTurns = 3) {
  await expect
    .poll(async () => (await records(page, m.source.id))[0]?.status, { timeout: 180000 })
    .toBe('completed');
  await idle(page);
  const history = await evidence(page, testInfo, m);
  expect(history.records).toHaveLength(1);
  expect(history.source.turns).toHaveLength(sourceTurns);
  expect(history.target.turns).toHaveLength(2);
  expect(history.records[0].reply).toContain(m.answer);
  expect(history.records[0].reply).toContain('42');
  expect(JSON.stringify(history.target.items)).not.toContain(m.privateText);
  const requests = history.target.items.filter(
    (i) => i.type === 'userMessage' && JSON.stringify(i.content).includes('[EvoWork 会话请求'),
  );
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests[0])).toContain(m.request);
  const replies = history.source.items.filter(
    (i) => i.type === 'userMessage' && JSON.stringify(i.content).includes('[EvoWork 会话回复'),
  );
  expect(replies).toHaveLength(1);
  const final = history.source.items.filter(
    (i) => i.type === 'agentMessage' && i.phase !== 'commentary',
  );
  expect(final.at(-1)?.text).toContain('42');
  await expect(page.getByRole('alert', { name: '回合失败' })).toHaveCount(0);
  return history.records[0];
}

for (const accept of [false, true]) {
  test(`真模型独立会话：代理工具请求${accept ? '批准后执行并回传' : '拒绝后零投递'}`, async ({
    page,
    electronApp,
  }, testInfo) => {
    const m = await setup(page, electronApp);
    try {
      await page
        .getByLabel('需求输入')
        .fill(
          `请给“${m.target.title}”任务（会话 ID：${m.target.id}）发送以下完整请求，并把结果返回这里：\n${m.request}\n发送后简短确认并结束当前回合，不轮询、不重试、不使用其他工具。收到回复后简短汇总并保留 ${m.answer}。`,
        );
      await page.getByRole('button', { name: '发送', exact: true }).click();
      const approval = page
        .getByRole('alertdialog')
        .filter({ has: page.getByRole('button', { name: '批准本次发送', exact: true }) });
      const native = page
        .getByRole('alertdialog')
        .filter({ has: page.getByRole('button', { name: '允许这一次', exact: true }) });
      await expect
        .poll(async () => (await approval.count()) + (await native.count()), {
          timeout: 120000,
        })
        .toBeGreaterThan(0);
      if (await native.count())
        await native.getByRole('button', { name: '允许这一次', exact: true }).click();
      await expect(approval).toBeVisible();
      await expect(approval).toContainText(m.target.id);
      await expect(approval).toContainText(m.request);
      expect(await records(page, m.source.id)).toHaveLength(0);
      await approval
        .getByRole('button', { name: accept ? '批准本次发送' : '拒绝', exact: true })
        .click();
      await idle(page);
      if (accept) {
        const record = await completed(page, testInfo, m);
        await expect(page.locator('.ew-conversation-scroll')).toContainText(m.answer);
        await page.reload();
        await page.getByRole('button', { name: m.source.title, exact: true }).click();
        await expect(page.getByText('会话通信', { exact: true })).toHaveCount(0);
        await expect(page.locator('.ew-conversation-scroll')).toContainText(m.answer);
        expect(await records(page, m.source.id)).toEqual([record]);
      } else {
        const history = await evidence(page, testInfo, m);
        expect(history.records).toHaveLength(0);
        expect(JSON.stringify(history.target.items)).not.toContain(m.request);
        expect(history.target.turns).toHaveLength(1);
      }
    } catch (error) {
      await evidence(page, testInfo, m).catch(() => undefined);
      throw error;
    }
  });
}
