/**
 * **真模型下的多代理协作**：什么样的需求会让模型派子代理，派了之后协作是不是真的发生。
 *
 * 内核写给模型的规则（`core/src/tools/handlers/multi_agents_spec.rs` 的 spawn_agent 描述）：
 * 「除非用户、AGENTS.md 或技能**明确要求**子代理、委派或并行代理，否则不要派生；
 * 要求深入、仔细、调研**不算**授权。」所以这里三条：
 *   1. 明确要求两个并行子代理 → 真的派出两个，各自读了自己那份文件，结论汇总回来
 *   2. 只说「仔细、深入」→ 模型自己做，**不派**（反向对照：证明第 1 条靠的是那句明确要求）
 *   3. 明确要求兄弟代理互发 → agent_a 的 send_message 真的发到了 agent_b
 *
 * 剧本化的那一面（时序、路由、只读视图）在 `multi-agent.spec.mjs`。这里只判真模型才答得出来的：
 * 它读没读懂那句要求、选没选对工具。**概率性**的：一轮绿不代表稳定，用 `--repeat-each` 看比例。
 *
 * 跑法：`EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash EVOWORK_UI_MODEL_KEY=sk-... pnpm run test:ui-real -- multi-agent`
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { selectRealModel } from '../harness/real-models.mjs';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';

/*
 * 走宿主自己的本机网关，模型登记成自定义模型 —— 与用户在设置页加了 MiMo 之后一模一样。
 * harness 自己的网关只登记了模型、宿主的模型目录里却没有它，于是子代理拿不到协作工具，
 * 2026-10-05 第二轮里两个子代理因此空转到 6 分钟预算用完（见 docs/status.md）。
 */
test.use({ hostGateway: true });

const TURN_BUDGET_MS = 6 * 60_000;

test.beforeAll(async () => {
  const key = process.env.EVOWORK_UI_MODEL_KEY;
  if (!key) return; // fixtures.mjs 的 requireKey 会给出正经的报错
  const reply = await fetch(selectRealModel().probeUrl, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  }).catch((err) => err);
  if (reply instanceof Error || !reply.ok) {
    const why =
      reply instanceof Error ? (reply.cause?.code ?? reply.message) : `HTTP ${reply.status}`;
    throw new Error(`模型上游不可用（${why}），不跑：先确认网络 / 代理 / 密钥。`);
  }
});

/** 两份文件，各藏一个只有它才有的编号。编号每轮现给，模型背不出来 */
async function placeInputs(electronApp) {
  const workspace = await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace);
  const north = `NORTH-${randomBytes(4).toString('hex').toUpperCase()}`;
  const south = `SOUTH-${randomBytes(4).toString('hex').toUpperCase()}`;
  mkdirSync(join(workspace, 'inputs'), { recursive: true });
  writeFileSync(join(workspace, 'inputs/north.txt'), `华北区本季度编号：${north}\n`);
  writeFileSync(join(workspace, 'inputs/south.txt'), `华南区本季度编号：${south}\n`);
  return { north, south };
}

/**
 * 跑到根任务回合结束。审批卡一律「允许这一次」—— 子代理的审批也弹在这里（审批是全局的）。
 * 回合失败的用例**不判分**：什么都没做也会让「没派子代理」空心通过。
 */
async function runUntilIdle(page) {
  const composer = page.getByLabel('输入区');
  await expect(composer).toHaveAttribute('data-run-state', /running|pending/, { timeout: 60_000 });
  const deadline = Date.now() + TURN_BUDGET_MS;
  while (Date.now() < deadline) {
    const card = page.getByLabel('需要你确认');
    if (await card.count()) {
      const allow = card.first().getByRole('button', { name: '允许这一次' });
      if (!(await allow.count())) {
        throw new Error(`弹出了一张没有「允许这一次」的卡：${await card.first().innerText()}`);
      }
      await allow.click();
      continue;
    }
    if ((await composer.getAttribute('data-run-state')) === 'idle') return;
    await page.waitForTimeout(300);
  }
  throw new Error(`回合 ${TURN_BUDGET_MS / 60_000} 分钟内没有结束`);
}

async function rootTask(page) {
  const { tasks } = await page.evaluate(() => window.evowork.getStartup());
  return [...tasks]
    .filter((task) => !task.parentThreadId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

/** 根任务、子任务与它们的完整历史 —— 判分与失败附件都从这里取 */
async function snapshot(page) {
  const root = await rootTask(page);
  const read = (threadId) =>
    page.evaluate((id) => window.evowork.openTask({ threadId: id }), threadId);
  const rootItems = (await read(root.id)).items;
  const children = await page.evaluate(
    (threadId) => window.evowork.listSubtasks({ threadId }),
    root.id,
  );
  const childItems = {};
  for (const child of children) childItems[child.id] = (await read(child.id)).items;
  return { root, rootItems, children, childItems };
}

/**
 * 派出了几个子代理。V2 的派生**不是**一张 collabAgentToolCall，而是父任务流里一条
 * `subAgentActivity(kind=started)`（spawn.rs 的 `emit_sub_agent_activity`）——
 * 按协作卡数，派了两个也数出 0（2026-10-05 第一轮就这么红的）。
 */
const spawned = (items) =>
  items.filter((item) => item.type === 'subAgentActivity' && item.kind === 'started');

/** 根任务最后一条助手消息 —— 「告诉我」的那句 */
function finalAnswer(items) {
  return items.filter((item) => item.type === 'agentMessage').at(-1)?.text ?? '';
}

/** 回合失败、或模型一个字没回，就不是「模型选择了怎么做」—— 报原因，不判分 */
function requireRealRun(snap) {
  if (!finalAnswer(snap.rootItems).trim()) {
    throw new Error('根任务没有给出任何回复：这一轮没有真正跑起来，不判分。看附件里的历史。');
  }
}

/** 历史落进用例的输出目录：list reporter 下 attach 的正文跑完就没了，而失败时只能靠它 */
async function attach(testInfo, snap) {
  const path = testInfo.outputPath('history.json');
  writeFileSync(path, JSON.stringify(snap, null, 2));
  await testInfo.attach('history.json', { path, contentType: 'application/json' });
}

test('明确要求两个并行子代理：真的派出两个，各读各的文件，结论汇总回根任务', async ({
  page,
  electronApp,
}, testInfo) => {
  test.setTimeout(TURN_BUDGET_MS + 3 * 60_000);
  const { north, south } = await placeInputs(electronApp);
  await startTaskInWorkspace(
    page,
    electronApp,
    '请创建两个子代理并行完成这件事：子代理 1 读取 inputs/north.txt，子代理 2 读取 inputs/south.txt，' +
      '各自把文件里的编号报回来。等两个子代理都完成后，你把两个编号一起告诉我。',
  );
  await runUntilIdle(page);
  const snap = await snapshot(page);
  await attach(testInfo, snap);
  requireRealRun(snap);

  expect(spawned(snap.rootItems).length, '应当派出两个子代理').toBeGreaterThanOrEqual(2);
  expect(snap.children.length, '子代理要进本机投影，子任务抽屉才看得到').toBeGreaterThanOrEqual(2);

  // 活是子代理干的：两个编号分别出现在子代理自己的历史里，而不是根代理自己读完了事
  const childText = (needle) =>
    Object.values(snap.childItems).filter((items) => JSON.stringify(items).includes(needle)).length;
  expect(childText(north), `没有哪个子代理的历史里出现过 ${north}`).toBeGreaterThanOrEqual(1);
  expect(childText(south), `没有哪个子代理的历史里出现过 ${south}`).toBeGreaterThanOrEqual(1);

  const answer = finalAnswer(snap.rootItems);
  expect(answer, '根任务的结论里要有两个编号').toContain(north);
  expect(answer).toContain(south);
});

test('只要求「仔细、深入」：模型自己做，不派子代理', async ({ page, electronApp }, testInfo) => {
  /*
   * 反向对照。内核规则写明「要求深入、仔细不算授权」。这条红了说明模型在没被要求时也会派子代理 ——
   * 那会多花 token、占并发名额（Q11 的 3 个上限），而用户什么都没要求。
   */
  test.setTimeout(TURN_BUDGET_MS + 3 * 60_000);
  const { north, south } = await placeInputs(electronApp);
  await startTaskInWorkspace(
    page,
    electronApp,
    '请仔细、深入地检查 inputs/north.txt 和 inputs/south.txt，把两个文件里的编号都告诉我。',
  );
  await runUntilIdle(page);
  const snap = await snapshot(page);
  await attach(testInfo, snap);
  requireRealRun(snap);

  expect(spawned(snap.rootItems), '没被要求委派，不该派子代理').toHaveLength(0);
  expect(snap.children).toHaveLength(0);
  const answer = finalAnswer(snap.rootItems);
  expect(answer, '它得自己把活干完').toContain(north);
  expect(answer).toContain(south);
});

test('明确要求兄弟代理互发：agent_a 的 send_message 真的发到了 agent_b', async ({
  page,
  electronApp,
}, testInfo) => {
  test.setTimeout(TURN_BUDGET_MS + 3 * 60_000);
  const { north, south } = await placeInputs(electronApp);
  await startTaskInWorkspace(
    page,
    electronApp,
    [
      '请创建两个子代理协作完成，严格按下面的分工：',
      '1. 先创建 agent_b（task_name 用 agent_b）：它先用 wait_agent 等待 agent_a 发来的编号；收到后读取 inputs/south.txt，' +
        '把两个编号按「北编号+南编号」的格式作为它的最终答复。',
      '2. 再创建 agent_a（task_name 用 agent_a）：读取 inputs/north.txt，然后用 send_message 把编号发给 /root/agent_b。',
      '3. 你等 agent_b 完成后，把它的最终答复原样告诉我。',
    ].join('\n'),
  );
  await runUntilIdle(page);
  const snap = await snapshot(page);
  await attach(testInfo, snap);
  requireRealRun(snap);

  expect(snap.children.length, '应当派出两个子代理').toBeGreaterThanOrEqual(2);

  /*
   * 判的是**子代理到子代理**：发送者是某个子代理、接收者是另一个子代理。
   * 根代理自己 send_message 给 agent_b 不算 —— 那是父子沟通，第 1 条已经覆盖了。
   * V2 的 send_message 在发送方时间线里留一条指向接收方的 `subAgentActivity(kind=interacted)`
   * （不是协作卡），所以发送者 = 这条活动出现在谁的时间线里。
   */
  const childIds = new Set(snap.children.map((child) => child.id));
  const siblingSends = Object.entries(snap.childItems).flatMap(([sender, items]) =>
    items
      .filter((item) => item.type === 'subAgentActivity' && item.kind === 'interacted')
      .filter((item) => childIds.has(item.agentThreadId) && item.agentThreadId !== sender)
      .map((item) => ({ sender, receiver: item.agentThreadId })),
  );
  expect(siblingSends.length, '没有一条从子代理发给另一个子代理的消息').toBeGreaterThanOrEqual(1);
  // 活动条目里没有正文：看接收方的历史里有没有北区编号（提示词要它只读南区那份）
  const receivers = siblingSends.map(({ receiver }) => JSON.stringify(snap.childItems[receiver]));
  expect(
    receivers.some((history) => history.includes(north)),
    '接收消息的那个子代理的历史里应当出现北区编号',
  ).toBe(true);

  const answer = finalAnswer(snap.rootItems);
  expect(answer, '最终答复里要有两个编号').toContain(north);
  expect(answer).toContain(south);
});
