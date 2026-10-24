import { writeFileSync } from 'node:fs';
import { expect, test } from './fixtures.mjs';

test.use({ desktopEnv: { EVOWORK_UI_DELIVERY_RPC_FAULT: '1' } });
const composer = (page) => page.getByLabel('输入区');
const input = (page) => page.getByLabel('需求输入');
const queue = (page) => page.getByLabel('排队中的追问');
async function selectSteer(page) {
  await page.getByRole('button', { name: '本次发送方式', exact: true }).click();
  await page.getByRole('menuitem', { name: /立即插话/ }).click();
}
async function arm(app, method, kind, persistent = false) {
  await app.evaluate(
    (_, args) => globalThis.__evoworkE2E.deliveryFaults.arm(...args),
    [method, kind, persistent],
  );
}
const fault = (app) => app.evaluate(() => globalThis.__evoworkE2E.deliveryFaults.snapshot());
const releaseFault = (app) => app.evaluate(() => globalThis.__evoworkE2E.deliveryFaults.release());
const releaseModel = (app) =>
  app.evaluate(() => globalThis.__evoworkE2E.gateway.releaseScriptedTurn());
async function hold(app, marker) {
  await app.evaluate(
    (_, text) =>
      globalThis.__evoworkE2E.gateway.scriptWhen(
        `fault-${text}`,
        (view) => view.text.includes(text),
        { kind: 'hold' },
      ),
    marker,
  );
}
async function begin(page, app, marker = '故障验证原任务') {
  await hold(app, marker);
  await input(page).fill(marker);
  await input(page).press('Enter');
  await expect
    .poll(() => app.evaluate(() => globalThis.__evoworkE2E.gateway.scriptedTurnHeld()))
    .toBe(true);
  await expect(composer(page)).toHaveAttribute('data-run-state', 'running');
}
const saw = (app, marker) =>
  app.evaluate(
    (_, text) => globalThis.__evoworkE2E.gateway.requestBodies.some((body) => body.includes(text)),
    marker,
  );
async function attach(page, app, info) {
  const path = info.outputPath('keep.txt');
  writeFileSync(path, '发送失败时保留的真实附件');
  await app.evaluate((_, file) => {
    globalThis.__evoworkE2E.pickedFiles = [file];
  }, path);
  await page.getByRole('button', { name: '添加内容' }).click();
  await page.getByRole('menuitem', { name: /添加本地文件/ }).click();
  await expect(page.locator('.ew-attachment[data-state="ready"]')).toHaveCount(1);
}
async function evidence(page, app, info, label) {
  const startup = await page.evaluate(() => window.evowork.getStartup());
  const histories = await Promise.all(
    startup.tasks.map((task) =>
      page.evaluate((threadId) => window.evowork.openTask({ threadId }), task.id),
    ),
  );
  const lifecycle = await app.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle());
  expect(lifecycle.filter((row) => row.kind === 'started')).toHaveLength(1);
  expect(lifecycle.filter((row) => row.kind === 'exited')).toHaveLength(0);
  writeFileSync(
    info.outputPath(`${label}.json`),
    JSON.stringify({ faults: await fault(app), histories, lifecycle }, null, 2),
  );
  await page.screenshot({ path: info.outputPath(`${label}.png`) });
  return histories;
}

test('拒绝：草稿、附件和插话选择保留，重试只接受一次', async ({ page, electronApp: app }, info) => {
  await begin(page, app);
  await attach(page, app, info);
  await selectSteer(page);
  await arm(app, 'turn/steer', 'reject');
  await input(page).fill('REJECT-RETRY');
  await input(page).press('Enter');
  await expect(page.getByText(/没能发出去：/)).toBeVisible();
  await expect(input(page)).toHaveValue('REJECT-RETRY');
  await expect(page.locator('.ew-attachment')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '立即插话', exact: true })).toBeVisible();
  await input(page).press('Enter');
  await expect(page.getByLabel('发送状态')).toHaveText('已发送，正在调整方向');
  await expect(input(page)).toHaveValue('');
  await expect(page.locator('.ew-attachment')).toHaveCount(0);
  expect((await fault(app)).counts['turn/steer']).toBe(2);
  await releaseModel(app);
  await expect.poll(() => saw(app, 'REJECT-RETRY')).toBe(true);
  await expect(composer(page)).toHaveAttribute('data-run-state', 'idle');
  const histories = await evidence(page, app, info, 'rejected-retry');
  expect(
    histories[0].items.filter(
      (item) => item.type === 'userMessage' && JSON.stringify(item).includes('REJECT-RETRY'),
    ),
  ).toHaveLength(1);
});

for (const kind of ['drop-response', 'hold-response']) {
  test(`排队${kind}：超时核对原生队列，迟到回执不重复发送`, async ({
    page,
    electronApp: app,
  }, info) => {
    await begin(page, app);
    await arm(app, 'thread/queue/add', kind);
    await input(page).fill(`ACK-${kind}`);
    await input(page).press('Enter');
    await expect(page.getByLabel('发送状态')).toHaveText(
      '等待当前任务完成 回执丢失，已核对排队记录。',
    );
    await expect(input(page)).toHaveValue('');
    await expect(queue(page)).toContainText('排队中 (1)');
    expect(await saw(app, `ACK-${kind}`)).toBe(false);
    if (kind === 'hold-response') await releaseFault(app);
    expect((await fault(app)).counts['thread/queue/add']).toBe(1);
    await evidence(page, app, info, kind);
    await releaseModel(app);
    await expect.poll(() => saw(app, `ACK-${kind}`)).toBe(true);
    await expect(composer(page)).toHaveAttribute('data-run-state', 'idle');
    const tasks = (await page.evaluate(() => window.evowork.getStartup())).tasks;
    const h = await page.evaluate((threadId) => window.evowork.openTask({ threadId }), tasks[0].id);
    expect(h.turns).toHaveLength(2);
  });
}

test('无法确认：保留草稿附件，重复发送只核对、不盲目重投', async ({
  page,
  electronApp: app,
}, info) => {
  await begin(page, app);
  await attach(page, app, info);
  await arm(app, 'turn/steer', 'drop-request');
  await selectSteer(page);
  await input(page).fill('UNKNOWN-REQUEST');
  await input(page).press('Enter');
  await expect(page.getByText(/发送结果尚未确认/)).toBeVisible();
  await expect(input(page)).toHaveValue('UNKNOWN-REQUEST');
  await expect(page.locator('.ew-attachment')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '立即插话', exact: true })).toBeVisible();
  await input(page).press('Enter');
  await expect(page.getByText(/发送结果尚未确认/)).toHaveCount(1);
  await expect(page.getByRole('button', { name: '立即插话', exact: true })).toBeEnabled();
  expect((await fault(app)).counts['turn/steer']).toBe(1);
  expect(await saw(app, 'UNKNOWN-REQUEST')).toBe(false);
  await evidence(page, app, info, 'unknown-no-replay');
  await page.getByRole('button', { name: '停止', exact: true }).click();
});

test('发送处理中：连续回车和点击只投递一次，切任务后迟到回执不污染新草稿', async ({
  page,
  electronApp: app,
}, info) => {
  await begin(page, app);
  await arm(app, 'thread/queue/add', 'hold-response');
  await input(page).fill('SINGLE-IN-FLIGHT');
  await input(page).press('Enter');
  await expect.poll(async () => (await fault(app)).held).toBe(1);
  await input(page).press('Enter');
  await input(page).press('Enter');
  await expect(page.getByRole('button', { name: '排队发送', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '停止', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await input(page).fill('新任务不能被旧回执清空');
  await releaseFault(app);
  await expect(input(page)).toHaveValue('新任务不能被旧回执清空');
  await expect(composer(page)).toHaveAttribute('data-run-state', 'idle');
  await expect(page.getByLabel('发送状态')).toHaveCount(0);
  expect((await fault(app)).counts['thread/queue/add']).toBe(1);
  await evidence(page, app, info, 'late-ack-other-task');
});

for (const mode of ['steer', 'queue']) {
  test(`结束竞态：${mode}请求在原回合结束后才到达，接受一次且反馈真实`, async ({
    page,
    electronApp: app,
  }, info) => {
    await begin(page, app);
    const marker = `COMPLETED-RACE-${mode}`;
    await hold(app, marker);
    await arm(app, mode === 'steer' ? 'turn/steer' : 'thread/queue/add', 'hold-request');
    await input(page).fill(marker);
    if (mode === 'steer') await selectSteer(page);
    await input(page).press('Enter');
    await expect.poll(async () => (await fault(app)).held).toBe(1);
    await releaseModel(app);
    await expect(composer(page)).toHaveAttribute('data-run-state', 'idle');
    await releaseFault(app);
    await expect.poll(() => saw(app, marker)).toBe(true);
    await expect(composer(page)).toHaveAttribute('data-run-state', 'running');
    if (mode === 'steer')
      await expect(page.getByLabel('发送状态')).toHaveText(
        '原回合已结束或已切换，这条输入已改为排队。',
      );
    await expect(input(page)).toHaveValue('');
    const histories = await evidence(page, app, info, `completion-race-${mode}`);
    expect(histories[0].turns).toHaveLength(2);
    expect(
      histories[0].items.filter(
        (item) => item.type === 'userMessage' && JSON.stringify(item).includes(marker),
      ),
    ).toHaveLength(1);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await releaseModel(app);
  });
}

for (const mode of ['native', 'local']) {
  test(`停止与继续：${mode}队列保留两条，停止后不启动，明确继续才顺序执行`, async ({
    page,
    electronApp: app,
  }, info) => {
    await begin(page, app);
    if (mode === 'local') await arm(app, 'thread/queue/add', 'unavailable', true);
    for (const marker of ['STOP-QUEUE-A', 'STOP-QUEUE-B']) {
      await input(page).fill(marker);
      await input(page).press('Enter');
      await expect(queue(page)).toContainText(marker);
    }
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(composer(page)).toHaveAttribute('data-run-state', 'idle');
    await releaseModel(app);
    // 等待明确超过正常自动出队的窗口，验证中断通知不会消费本机队列。
    await expect
      .poll(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2200));
        return (await saw(app, 'STOP-QUEUE-A')) || (await saw(app, 'STOP-QUEUE-B'));
      })
      .toBe(false);
    await expect(queue(page)).toContainText('排队中 (2)');
    await expect(page.getByRole('button', { name: '继续队列', exact: true })).toBeVisible();
    await evidence(page, app, info, `stopped-${mode}`);
    await page.getByRole('button', { name: '继续队列', exact: true }).click();
    await expect.poll(() => saw(app, 'STOP-QUEUE-B')).toBe(true);
    await expect(composer(page)).toHaveAttribute('data-run-state', 'idle');
    const histories = await evidence(page, app, info, `resumed-${mode}`);
    expect(histories[0].turns).toHaveLength(3);
    expect(histories[0].turns.map((turn) => turn.status)).toEqual([
      'interrupted',
      'completed',
      'completed',
    ]);
  });
}

test('已接受后的队列刷新失败不会谎报没发出去', async ({ page, electronApp: app }, info) => {
  await begin(page, app);
  await app.evaluate(() => {
    const actions = globalThis.__evoworkE2E.host.actions;
    // 队列变化事件也会触发读取；同时拒绝事件读取和发送后的刷新，避免故障被提前消耗。
    actions.listQueuedInputs = async () => {
      throw new Error('Controlled queue refresh failure');
    };
  });
  await input(page).fill('ACCEPTED-REFRESH-FAILED');
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('');
  await expect(
    page.getByText('消息已发送，但队列未能刷新，请稍后重新打开任务查看。'),
  ).toBeVisible();
  await expect(page.getByText(/没能发出去：/)).toHaveCount(0);
  expect((await fault(app)).counts['thread/queue/add']).toBe(1);
  await evidence(page, app, info, 'refresh-failure');
});

test('插话已接受但核对故障：完成后沿用原身份核对，不会再建回合', async ({
  page,
  electronApp: app,
}, info) => {
  await begin(page, app);
  await arm(app, 'turn/steer', 'drop-response');
  await arm(app, 'thread/items/list', 'reject', true);
  await input(page).fill('STEER-ACCEPTED-UNKNOWN');
  await selectSteer(page);
  await input(page).press('Enter');
  await expect(page.getByText(/发送结果尚未确认/)).toBeVisible();
  await releaseModel(app);
  await expect(composer(page)).toHaveAttribute('data-run-state', 'idle');
  await app.evaluate(() => globalThis.__evoworkE2E.deliveryFaults.clear());
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('');
  expect((await fault(app)).counts['turn/steer']).toBe(1);
  const histories = await evidence(page, app, info, 'steer-reconcile-after-complete');
  expect(histories[0].turns).toHaveLength(1);
  expect(
    histories[0].items.filter(
      (item) =>
        item.type === 'userMessage' && JSON.stringify(item).includes('STEER-ACCEPTED-UNKNOWN'),
    ),
  ).toHaveLength(1);
});

test('回执等待中仍可停止，已接受的排队项不会越过停止自动执行', async ({
  page,
  electronApp: app,
}, info) => {
  await begin(page, app);
  await arm(app, 'thread/queue/add', 'hold-response');
  await input(page).fill('STOP-WHILE-SENDING');
  await input(page).press('Enter');
  await expect.poll(async () => (await fault(app)).held).toBe(1);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(composer(page)).toHaveAttribute('data-run-state', 'idle');
  await releaseFault(app);
  await expect(input(page)).toHaveValue('');
  await releaseModel(app);
  await expect(page.getByRole('button', { name: '继续队列', exact: true })).toBeVisible();
  expect(await saw(app, 'STOP-WHILE-SENDING')).toBe(false);
  const histories = await evidence(page, app, info, 'stop-while-sending');
  expect(histories[0].turns.map((turn) => turn.status)).toEqual(['interrupted']);
});

test('结束竞态叠加队列不可用：本机降级消息直接进入新回合', async ({
  page,
  electronApp: app,
}, info) => {
  await begin(page, app);
  const marker = 'LOCAL-COMPLETED-RACE';
  await hold(app, marker);
  await arm(app, 'turn/steer', 'hold-request');
  await input(page).fill(marker);
  await selectSteer(page);
  await input(page).press('Enter');
  await expect.poll(async () => (await fault(app)).held).toBe(1);
  await releaseModel(app);
  await expect(composer(page)).toHaveAttribute('data-run-state', 'idle');
  await arm(app, 'thread/queue/add', 'unavailable');
  await releaseFault(app);
  await expect.poll(() => saw(app, marker)).toBe(true);
  await expect(page.getByLabel('发送状态')).toHaveText('原回合已结束，这条输入已开始执行。');
  await expect(queue(page)).toHaveCount(0);
  const histories = await evidence(page, app, info, 'local-completion-race');
  expect(histories[0].turns).toHaveLength(2);
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await releaseModel(app);
});
