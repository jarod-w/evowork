import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { selectRealModel } from '../harness/real-models.mjs';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';

test.use({
  registerModels: true,
  hostGateway: true,
  desktopEnv: { EVOWORK_UI_FOLLOW_UP_WIRE: '1', EVOWORK_UI_DELIVERY_RPC_FAULT: '1' },
});

async function setup(page, electronApp) {
  const selected = selectRealModel();
  expect(selected.upstreamModel).toBe('mimo-v2.6-flash');
  expect(selected.baseUrl).toBe('https://api.xiaomimimo.com/v1');
  const root = realpathSync(await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace));
  const suffix = randomBytes(6).toString('hex');
  // A real task step waits for test data readiness. Only tool timing is controlled;
  // all model requests, decisions, tool calls, calculations and final replies are real.
  writeFileSync(
    join(root, 'followup_gate.py'),
    [
      'from pathlib import Path',
      'import time',
      "Path('phase-ready').write_text('ready')",
      'deadline = time.monotonic() + 90',
      "while not Path('phase-release').exists():",
      "    if time.monotonic() > deadline: raise RuntimeError('input readiness timed out')",
      '    time.sleep(0.1)',
      "print('准备阶段完成，可以根据最新要求继续。')",
      '',
    ].join('\n'),
  );
  await page.evaluate(() => {
    globalThis.__followUpEvents = [];
    window.evowork.onUiEvent((event) => {
      if (event.type === 'turn-started' || event.type === 'turn-completed')
        globalThis.__followUpEvents.push({ at: Date.now(), ...event });
    });
  });
  const wire = () => {
    const path = join(dirname(root), 'follow-up-wire.jsonl');
    return existsSync(path)
      ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      : [];
  };
  return { root, suffix, wire, selected };
}
async function runningStep(page, m) {
  await expect.poll(() => existsSync(join(m.root, 'phase-ready')), { timeout: 120000 }).toBe(true);
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'running');
  const startup = await page.evaluate(() => window.evowork.getStartup());
  const task = startup.tasks.find((task) => task.cwd && realpathSync(task.cwd) === m.root);
  expect(task?.id).toBeTruthy();
  const history = await page.evaluate((threadId) => window.evowork.openTask({ threadId }), task.id);
  expect(history.turns).toHaveLength(1);
  expect(history.turns[0].status).toBe('inProgress');
  return { id: task.id, firstTurnId: history.turns[0].id };
}
async function history(page, id) {
  return page.evaluate((threadId) => window.evowork.openTask({ threadId }), id);
}
function finalText(h) {
  return h.items
    .filter((item) => item.type === 'agentMessage' && item.phase !== 'commentary')
    .map((item) => item.text ?? '')
    .join('\n');
}
async function save(page, electronApp, info, m, task, extra) {
  const evidence = {
    model: m.selected.upstreamModel,
    baseUrl: m.selected.baseUrl,
    task,
    ...extra,
    observations: m.observations,
    files: Object.fromEntries(
      ['original.txt', 'queued.txt', 'old-plan.txt', 'redirected.txt'].map((name) => [
        name,
        existsSync(join(m.root, name)) ? readFileSync(join(m.root, name), 'utf8') : null,
      ]),
    ),
    wire: m.wire(),
    events: await page.evaluate(() => globalThis.__followUpEvents),
    history: task ? await history(page, task.id) : undefined,
    lifecycle: await electronApp.evaluate(() => globalThis.__evoworkE2E.kernelLifecycle()),
  };
  const body = JSON.stringify(evidence, null, 2);
  const key = process.env.EVOWORK_UI_MODEL_KEY;
  if (key && body.includes(key)) throw new Error('凭据扫描命中，拒绝保存测试证据');
  writeFileSync(info.outputPath('real-follow-up-evidence.json'), body);
  return evidence;
}
function checkWire(m) {
  const requests = m.wire().filter((row) => row.type === 'request');
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((row) => row.model === 'mimo-v2.6-flash')).toBe(true);
  expect(
    requests.every((row) => row.endpoint === 'https://api.xiaomimimo.com/v1/chat/completions'),
  ).toBe(true);
}
function release(m) {
  writeFileSync(join(m.root, 'phase-release'), 'ready');
}

for (const lostReply of [false, true]) {
  test(`MiMo：排队等待原回合结束，丢回执=${lostReply}，反馈准确`, async ({
    page,
    electronApp,
  }, info) => {
    test.setTimeout(360000);
    const m = await setup(page, electronApp);
    const original = `REALFOLLOW_ORIGINAL_${m.suffix}`;
    const queued = `REALFOLLOW_QUEUED_${m.suffix}`;
    let task;
    try {
      await startTaskInWorkspace(
        page,
        electronApp,
        `${original} 这是两阶段本机计算任务。第一步仅运行 python3 followup_gate.py，等脚本返回后才能开始第二步，不并行执行。第二步计算 19*23，将“${original}:437”写入 original.txt，并最终只回复“${original} 原任务完成 437”。不要修改脚本或创建 phase-release；不要联网、创建子任务或其他会话。`,
      );
      task = await runningStep(page, m);
      await expect(page.getByRole('button', { name: '排队发送', exact: true })).toBeVisible();
      await page
        .getByLabel('需求输入')
        .fill(
          `${queued} 这是排队追加任务：在原任务完成后计算 17+25，把“${queued}:42”写入 queued.txt，最终回复“${queued} 排队任务完成 42”。不要改 original.txt，不创建子任务或其他会话。`,
        );
      if (lostReply)
        await electronApp.evaluate(() =>
          globalThis.__evoworkE2E.deliveryFaults.arm('thread/queue/add', 'drop-response'),
        );
      await page.getByRole('button', { name: '排队发送', exact: true }).click();
      await expect(page.getByLabel('发送状态')).toHaveText(
        lostReply ? '等待当前任务完成 回执丢失，已核对排队记录。' : '等待当前任务完成',
      );
      await expect(page.getByLabel('排队中的追问')).toContainText(queued);
      await page.screenshot({ path: info.outputPath('real-queued-waiting.png') });
      // Negative timing assertion while the genuine task command is still running.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(m.wire().some((row) => row.markers?.includes(queued))).toBe(false);
      const before = await history(page, task.id);
      m.observations = {
        waitingFeedback: await page.getByLabel('发送状态').innerText(),
        waitingHistory: before,
        checkedAt: Date.now(),
        queuedReachedUpstream: m.wire().some((row) => row.markers?.includes(queued)),
      };
      expect(before.turns).toHaveLength(1);
      expect(before.turns[0].status).toBe('inProgress');
      expect(existsSync(join(m.root, 'queued.txt'))).toBe(false);
      expect(JSON.stringify(before.items)).not.toContain(queued);
      release(m);
      await expect
        .poll(
          async () => {
            const h = await history(page, task.id);
            return h.turns.length === 2 && h.turns.every((turn) => turn.status === 'completed');
          },
          { timeout: 240000, intervals: [500, 1000, 2000] },
        )
        .toBe(true);
      const h = await history(page, task.id);
      expect(readFileSync(join(m.root, 'original.txt'), 'utf8')).toContain(`${original}:437`);
      expect(readFileSync(join(m.root, 'queued.txt'), 'utf8')).toContain(`${queued}:42`);
      expect(finalText(h)).toContain(`${original} 原任务完成 437`);
      expect(finalText(h)).toContain(`${queued} 排队任务完成 42`);
      const evidence = await save(page, electronApp, info, m, task, {
        original,
        queued,
        waitingHistory: before,
      });
      const events = evidence.events.filter((event) => event.taskId === task.id);
      const complete = events.findIndex(
        (event) => event.type === 'turn-completed' && event.turnId === task.firstTurnId,
      );
      const next = events.findIndex(
        (event) => event.type === 'turn-started' && event.turnId !== task.firstTurnId,
      );
      expect(complete).toBeGreaterThanOrEqual(0);
      expect(next).toBeGreaterThan(complete);
      const completedAt = events[complete].completedAtMs;
      const firstQueuedRequest = m
        .wire()
        .find((row) => row.type === 'request' && row.markers.includes(queued));
      expect(firstQueuedRequest.at).toBeGreaterThanOrEqual(completedAt);
      checkWire(m);
      await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
      await expect(page.getByLabel('发送状态')).toHaveCount(0);
      await expect(page.getByRole('alert', { name: '回合失败' })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath('real-queued-completed.png') });
    } finally {
      await save(page, electronApp, info, m, task, { original, queued }).catch(() => undefined);
    }
  });
}

test('MiMo：立即插话改变同一回合的后续计划，反馈与实际结果一致', async ({
  page,
  electronApp,
}, info) => {
  test.setTimeout(360000);
  const m = await setup(page, electronApp);
  const original = `REALFOLLOW_OLD_${m.suffix}`;
  const redirected = `REALFOLLOW_REDIRECTED_${m.suffix}`;
  let task;
  try {
    await startTaskInWorkspace(
      page,
      electronApp,
      `${original} 这是两阶段本机计算任务。第一步仅运行 python3 followup_gate.py，等脚本返回后才能开始第二步，不并行执行。第二步计算 19*23，将“${original}:437”写入 old-plan.txt，最终回复“${original} 原计划完成 437”。不要修改脚本或创建 phase-release；不要联网、创建子任务或其他会话。`,
    );
    task = await runningStep(page, m);
    await page.getByRole('button', { name: '本次发送方式', exact: true }).click();
    await page.getByRole('menuitem', { name: /立即插话/ }).click();
    await page
      .getByLabel('需求输入')
      .fill(
        `${redirected} 现在调整当前任务：取消准备阶段之后的旧计划，不要创建 old-plan.txt，也不要回复旧的完成标记。准备步骤返回后改为计算 17+25，把“${redirected}:42”写入 redirected.txt，最终只回复“${redirected} 已改为新方向 42”。这是对当前任务的纠正，不是另一个排队任务。不创建子任务或其他会话。`,
      );
    await page.getByRole('button', { name: '立即插话', exact: true }).click();
    await expect(page.getByLabel('发送状态')).toHaveText('已发送，正在调整方向');
    await expect(page.getByRole('button', { name: '排队发送', exact: true })).toBeVisible();
    await expect(page.getByLabel('排队中的追问')).toHaveCount(0);
    m.observations = {
      acceptedFeedback: await page.getByLabel('发送状态').innerText(),
      acceptedAt: Date.now(),
      queuedCount: await page.getByLabel('排队中的追问').count(),
    };
    await page.screenshot({ path: info.outputPath('real-steer-accepted.png') });
    release(m);
    await expect
      .poll(
        async () => {
          const h = await history(page, task.id);
          return h.turns.length === 1 && h.turns[0].status === 'completed';
        },
        { timeout: 240000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
    const h = await history(page, task.id);
    expect(existsSync(join(m.root, 'old-plan.txt'))).toBe(false);
    expect(readFileSync(join(m.root, 'redirected.txt'), 'utf8')).toContain(`${redirected}:42`);
    expect(finalText(h)).toContain(`${redirected} 已改为新方向 42`);
    expect(finalText(h)).not.toContain(`${original} 原计划完成 437`);
    const evidence = await save(page, electronApp, info, m, task, { original, redirected });
    const events = evidence.events.filter((event) => event.taskId === task.id);
    expect(events.filter((event) => event.type === 'turn-started')).toHaveLength(1);
    const firstSteerRequest = m
      .wire()
      .find((row) => row.type === 'request' && row.markers.includes(redirected));
    expect(firstSteerRequest).toBeTruthy();
    expect(firstSteerRequest.at).toBeLessThanOrEqual(
      events.find((event) => event.type === 'turn-completed').at,
    );
    checkWire(m);
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
    await expect(page.getByLabel('发送状态')).toHaveCount(0);
    await expect(page.getByRole('alert', { name: '回合失败' })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('real-steer-completed.png') });
  } finally {
    await save(page, electronApp, info, m, task, { original, redirected }).catch(() => undefined);
  }
});

test('MiMo：停止后保留队列，明确继续才计算追加任务', async ({ page, electronApp }, info) => {
  test.setTimeout(360000);
  const m = await setup(page, electronApp);
  const original = `REALFOLLOW_STOP_${m.suffix}`;
  const queued = `REALFOLLOW_RESUME_${m.suffix}`;
  let task;
  try {
    await startTaskInWorkspace(
      page,
      electronApp,
      `${original} 第一步只运行 python3 followup_gate.py，等待返回后第二步计算19*23写入original.txt。不要创建phase-release，不创建子任务或其他会话。`,
    );
    task = await runningStep(page, m);
    await page
      .getByLabel('需求输入')
      .fill(
        `${queued} 计算17+25，把“${queued}:42”写入queued.txt，最终只回复“${queued} 完成42”。不创建子任务或其他会话。`,
      );
    await page.getByRole('button', { name: '排队发送', exact: true }).click();
    await expect(page.getByLabel('发送状态')).toHaveText('等待当前任务完成');
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');
    release(m);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(m.wire().some((row) => row.markers?.includes(queued))).toBe(false);
    expect(existsSync(join(m.root, 'queued.txt'))).toBe(false);
    const stopped = await history(page, task.id);
    expect(stopped.turns).toHaveLength(1);
    expect(stopped.turns[0].status).toBe('interrupted');
    await expect(page.getByLabel('排队中的追问')).toContainText(queued);
    await page.screenshot({ path: info.outputPath('real-stopped-queue.png') });
    await page.getByRole('button', { name: '继续队列', exact: true }).click();
    await expect
      .poll(
        async () => {
          const h = await history(page, task.id);
          return h.turns.length === 2 && h.turns[1].status === 'completed';
        },
        { timeout: 240000, intervals: [500, 1000, 2000] },
      )
      .toBe(true);
    const h = await history(page, task.id);
    expect(readFileSync(join(m.root, 'queued.txt'), 'utf8')).toContain(`${queued}:42`);
    expect(
      h.items.filter(
        (item) => item.type === 'userMessage' && JSON.stringify(item).includes(queued),
      ),
    ).toHaveLength(1);
    await save(page, electronApp, info, m, task, { original, queued, stopped });
    checkWire(m);
    await page.screenshot({ path: info.outputPath('real-resumed-queue.png') });
  } finally {
    release(m);
    await save(page, electronApp, info, m, task, { original, queued }).catch(() => undefined);
  }
});
