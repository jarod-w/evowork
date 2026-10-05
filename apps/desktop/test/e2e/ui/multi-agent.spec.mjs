/**
 * **同一任务内的多代理协作（04 §5.6）**：派生 · 等待 · 结论回根 · 只读子视图 ·
 * 子视图里的追加要求经根任务路由 · 兄弟代理互发消息。
 *
 * 假网关按**内容**认领每个代理的请求（`scriptWhen`）：根代理和子代理的请求打到同一个网关，
 * 到达顺序由内核调度决定，按「下一次」写剧本会把给子代理的话发给根代理。
 *
 * 这里**不判模型会不会选对工具** —— 那是 `multi-agent.real.spec.mjs` 的事。这里判的是
 * 模型选对之后，真内核、适配层与界面有没有把它变成用户看得到、语义也对的东西。
 * 剧本里的工具名与参数形状取自内核 `core/src/tools/handlers/multi_agents_v2/`
 * （`SpawnAgentArgs` · `SendMessageArgs` · `FollowupTaskArgs` · `WaitArgs`）。
 */
import { expect, test } from './fixtures.mjs';

/*
 * 把假网关的模型登记成自定义模型，让它进宿主写给内核的模型目录：子代理拿不拿得到
 * 协作工具（兄弟互发、嵌套派生）看的就是那份目录里的 `multi_agent_version`。
 * 不登记的话，兄弟互发那条只会测出「unsupported call」—— 那是 harness 的缺口，不是产品的行为。
 */
test.use({ registerModels: true });

/** 04 §5.6 要求六个 V2 协作动作在 Craft / Plan / Ask 里都在（`non_code_mode_only = false`） */
const V2_TOOLS = [
  'spawn_agent',
  'send_message',
  'followup_task',
  'wait_agent',
  'interrupt_agent',
  'list_agents',
];

/**
 * `wait_agent` 的超时。子代理比根代理先答完时，根代理这次等待会一直等到超时
 * （2026-10-05 实测：子代理的结论已经进了根代理的下一次请求，等待本身却超时了）。
 * 取内核允许的下限（`config/mod.rs` 的 `DEFAULT_MULTI_AGENT_V2_MIN_WAIT_TIMEOUT_MS` = 10 秒），
 * 免得每条用例白等一分钟。兄弟互发里 agent_b 那次等待是被测对象，另取 60 秒。
 * 剧本跑在主进程里够不着这个常量，所以随标记一起传过去（`m.waitMs`）。
 */
const WAIT_MS = 10_000;

/** 每条用例一组新标记：认领规则靠它们，断言「谁的请求里带着什么」也靠它们 */
function markers() {
  const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const tag = (name) => `MA-${name}-${run}`;
  return {
    root: tag('ROOT'),
    task: tag('TASK'),
    result: tag('RESULT'),
    done: tag('DONE'),
    followup: tag('FOLLOWUP'),
    relay: tag('RELAY'),
    again: tag('AGAIN'),
    taskA: tag('TASK-A'),
    taskB: tag('TASK-B'),
    aToB: tag('A-TO-B'),
    waitMs: WAIT_MS,
  };
}

function matchedBody(electronApp, name) {
  return electronApp.evaluate(
    (_electron, rule) => globalThis.__evoworkE2E.gateway.matchedBody(rule),
    name,
  );
}

/** 等到那条规则认领到请求，交回请求正文 */
async function waitForMatch(electronApp, name, message) {
  await expect
    .poll(() => matchedBody(electronApp, name), { timeout: 90_000, message })
    .toBeTruthy();
  return matchedBody(electronApp, name);
}

/** 请求里声明给模型的工具名（命名空间里的也摊平） */
function toolNames(body) {
  const names = (list) =>
    (list ?? []).flatMap((entry) =>
      Array.isArray(entry?.tools) ? names(entry.tools) : [entry?.name],
    );
  return names(JSON.parse(body).tools);
}

async function send(page, text) {
  await page.getByLabel('需求输入').fill(text);
  await page.getByRole('button', { name: '发送' }).click();
}

async function waitIdle(page) {
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle', {
    timeout: 90_000,
  });
}

/**
 * 协作条目在「处理过程」组里，回合结束后组是折叠的。展开一组后列表会变，所以每次点第一个。
 * 返回两类条目的摘要：V2 的派生是一条 `subAgentActivity`（spawn.rs 的 `emit_sub_agent_activity`），
 * 等待 / 发消息 / 转交才是 `collabAgentToolCall`。
 */
async function collabSummaries(page) {
  const collapsed = page.locator('.ew-process-summary[aria-expanded="false"]');
  for (let guard = 0; guard < 20 && (await collapsed.count()) > 0; guard += 1) {
    await collapsed.first().click();
  }
  const texts = (kind) =>
    page.locator(`.ew-item[data-kind="${kind}"] > .ew-item-summary`).allInnerTexts();
  const flat = (list) => list.map((text) => text.replace(/\s+/g, ' ').trim());
  return {
    activities: flat(await texts('subAgentActivity')),
    calls: flat(await texts('collabAgentToolCall')),
  };
}

/** 根任务的 thread id：首条消息里带着这次的根标记 */
async function rootThreadId(page, marker) {
  await expect
    .poll(async () => {
      const { tasks } = await page.evaluate(() => window.evowork.getStartup());
      return tasks.find((task) => task.title?.includes(marker))?.id;
    })
    .toBeTruthy();
  const { tasks } = await page.evaluate(() => window.evowork.getStartup());
  return tasks.find((task) => task.title?.includes(marker)).id;
}

/**
 * 「派一个子代理，等它，再汇总」的剧本：
 * 根① spawn_agent → 根② wait_agent → 子代理回结论 → 根③ 回汇总。
 * 子代理用 `fork_turns: "none"`：它只该拿到委派的那句话（04 §5.6.1「上下文按代理隔离」）。
 */
function scriptSpawnAndWait(electronApp, m) {
  return electronApp.evaluate((_electron, m) => {
    const gateway = globalThis.__evoworkE2E.gateway;
    gateway.scriptWhen(
      'root-spawn',
      (r) => r.tools.includes('spawn_agent') && r.text.includes(m.root) && r.calls.length === 0,
      {
        tool: 'spawn_agent',
        args: {
          task_name: 'researcher',
          message: `${m.task} 统计三个渠道的数量`,
          fork_turns: 'none',
        },
      },
    );
    gateway.scriptWhen(
      'root-wait',
      (r) => r.text.includes(m.root) && r.calls.length === 1 && r.calls[0] === 'spawn_agent',
      { tool: 'wait_agent', args: { timeout_ms: m.waitMs } },
    );
    // 根代理的请求里也有这段委派文字（在 spawn_agent 的参数里），所以要排除带着那次调用的
    gateway.scriptWhen(
      'child',
      (r) => r.text.includes(m.task) && !r.calls.includes('spawn_agent'),
      { kind: 'text', text: `${m.result}：三个渠道共 42 家` },
    );
    gateway.scriptWhen(
      'root-summary',
      (r) => r.text.includes(m.root) && r.calls.includes('wait_agent'),
      { kind: 'text', text: `汇总完成 ${m.done}` },
    );
  }, m);
}

test('明确要求派子代理：子代理真的跑了、只拿到委派的话，结论回到根任务', async ({
  page,
  electronApp,
}) => {
  const m = markers();
  await scriptSpawnAndWait(electronApp, m);
  await send(page, `${m.root} 派一个子代理去统计渠道数量，等它做完再汇总给我。`);

  /*
   * ① 六个协作动作真的交给了模型。E2E 的 config.toml 是 harness 自己写的、不带
   * `[features.multi_agent_v2]` —— 能在这里看到它们，说明宿主启动时的迁移给老配置补上了。
   */
  const rootSpawn = await waitForMatch(electronApp, 'root-spawn', '根代理的第一次请求没有到网关');
  expect(toolNames(rootSpawn)).toEqual(expect.arrayContaining(V2_TOOLS));

  // ② 子代理真的发了请求，而且只带着委派的那句话 —— 根任务的原话不在里面
  const child = await waitForMatch(electronApp, 'child', 'spawn_agent 之后子代理一直没开始跑');
  expect(child).toContain(m.task);
  expect(child, 'fork_turns=none 的子代理不该看到根任务的上下文').not.toContain(m.root);

  // ③ 子代理的结论进了根代理 wait_agent 之后的那次请求
  const summary = await waitForMatch(electronApp, 'root-summary', '根代理等完之后没有再请求模型');
  expect(summary, '子代理的结论没有回到根代理').toContain(m.result);

  /*
   * ④ 界面：回合收尾，汇总画出来；子代理画成「路径 已启动 / 已完成」，等待画成「等待代理 · 已完成」。
   * 两处都要是中文：内核线上的等待叫 `wait`、活动类型是 `started`，标签表漏了就原样露出英文。
   */
  await waitIdle(page);
  await expect(page.getByRole('main', { name: '对话区' })).toContainText(m.done);
  const { activities, calls } = await collabSummaries(page);
  // 子代理的一生在父任务里是两条：启动、完成（内核在子代理答完时补一条 completed）
  expect(activities).toEqual(['/root/researcher 已启动', '/root/researcher 已完成']);
  expect(calls).toContain('等待代理 · 已完成');
});

test('运行中派出的子代理：不切换任务，标题栏就能打开它的只读时间线', async ({
  page,
  electronApp,
}) => {
  /*
   * 用户的路径：发了需求，看着它跑完，然后想看看子代理干了什么。
   * 这中间**没有切换过任务** —— 子任务入口要靠这一回合里发生的事出现，不能等用户切走再切回来。
   */
  const m = markers();
  await scriptSpawnAndWait(electronApp, m);
  await send(page, `${m.root} 派一个子代理去统计渠道数量，等它做完再汇总给我。`);
  await waitForMatch(electronApp, 'root-summary', '根代理等完之后没有再请求模型');
  await waitIdle(page);

  const entry = page.getByRole('button', { name: /^子任务 \d+$/ });
  await expect(entry, '这一回合派出了 1 个子代理，标题栏应该有入口').toHaveText('子任务 1');
  await entry.click();
  await page
    .getByRole('complementary', { name: '子任务详情' })
    .locator('li button')
    .first()
    .click();

  await expect(page.getByText('这是子代理的只读时间线')).toBeVisible();
  await expect(page.getByRole('main', { name: '对话区' })).toContainText(m.result);
});

test('子任务视图里追加要求：先送回根任务，再由根代理用 followup_task 转给子代理', async ({
  page,
  electronApp,
}) => {
  const m = markers();
  await scriptSpawnAndWait(electronApp, m);
  await electronApp.evaluate((_electron, m) => {
    const gateway = globalThis.__evoworkE2E.gateway;
    // 根代理收到的是桌面宿主包过的一段话（renderer-bridge 的子代理路由），不是用户原话直达子代理
    gateway.scriptWhen(
      'root-relay',
      (r) =>
        r.text.includes(m.followup) &&
        r.text.includes('用户正在只读查看子代理') &&
        !r.calls.includes('followup_task'),
      {
        tool: 'followup_task',
        args: { target: '/root/researcher', message: `${m.relay} 再按地区拆一下` },
      },
    );
    gateway.scriptWhen(
      'child-again',
      (r) => r.text.includes(m.relay) && !r.calls.includes('followup_task'),
      { kind: 'text', text: `${m.again} 华东 20 · 华南 22` },
    );
  }, m);

  await send(page, `${m.root} 派一个子代理去统计渠道数量，等它做完再汇总给我。`);
  await waitForMatch(electronApp, 'root-summary', '根代理等完之后没有再请求模型');
  await waitIdle(page);

  // 进子代理视图：和用户一样，从标题栏的子任务入口点进去
  await page.getByRole('button', { name: /^子任务 \d+$/ }).click();
  await page
    .getByRole('complementary', { name: '子任务详情' })
    .locator('li button')
    .first()
    .click();
  await expect(page.getByText('这是子代理的只读时间线')).toBeVisible();

  await send(page, `${m.followup} 再按地区拆一下`);

  // ① 话先到了根代理：它的请求里带着根任务的上下文、用户的追加要求和路由说明
  const relay = await waitForMatch(electronApp, 'root-relay', '追加要求没有送到根代理');
  expect(relay).toContain(m.root);

  // ② 根代理用 followup_task 转交后，子代理收到的是转交的话，**不是用户原话**
  const again = await waitForMatch(electronApp, 'child-again', 'followup_task 没有唤醒子代理');
  expect(again).toContain(m.relay);
  expect(again, '用户的原话不该绕过根代理直达子代理').not.toContain(m.followup);
});

test('兄弟代理互发：agent_a 用 send_message 把结果交给正在等待的 agent_b', async ({
  page,
  electronApp,
}) => {
  /*
   * 这是「代理之间沟通」最直接的一条：消息不经根代理，从一个子代理到另一个子代理。
   * 时序由网关定死：agent_b 先进入 wait_agent，agent_a 才发 —— 否则 send_message
   * 会撞上「live agent path not found」，判出来的是调度的偶然，不是协作语义。
   */
  const m = markers();
  await electronApp.evaluate((_electron, m) => {
    const gateway = globalThis.__evoworkE2E.gateway;
    const spawn = (name, message) => ({
      tool: 'spawn_agent',
      args: { task_name: name, message, fork_turns: 'none' },
    });
    gateway.scriptWhen(
      'root-spawn-a',
      (r) => r.tools.includes('spawn_agent') && r.text.includes(m.root) && r.calls.length === 0,
      spawn('agent_a', `${m.taskA} 算出数量后用 send_message 发给 /root/agent_b`),
    );
    gateway.scriptWhen(
      'root-spawn-b',
      (r) => r.text.includes(m.root) && r.calls.length === 1 && r.calls[0] === 'spawn_agent',
      spawn('agent_b', `${m.taskB} 等 agent_a 发来的数量`),
    );
    gateway.scriptWhen('root-wait', (r) => r.text.includes(m.root) && r.calls.length === 2, {
      tool: 'wait_agent',
      args: { timeout_ms: m.waitMs },
    });
    gateway.scriptWhen('b-wait', (r) => r.text.includes(m.taskB) && r.calls.length === 0, {
      tool: 'wait_agent',
      args: { timeout_ms: 60_000 },
    });
    gateway.scriptWhen(
      'a-send',
      (r) => r.text.includes(m.taskA) && r.calls.length === 0,
      { tool: 'send_message', args: { target: '/root/agent_b', message: `${m.aToB} 数量是 42` } },
      { ready: ({ matched }) => matched('b-wait') },
    );
    gateway.scriptWhen(
      'a-done',
      (r) =>
        r.text.includes(m.taskA) &&
        r.calls.includes('send_message') &&
        !r.calls.includes('spawn_agent'),
      { kind: 'text', text: 'agent_a 已发出' },
    );
    gateway.scriptWhen(
      'b-received',
      (r) =>
        r.text.includes(m.taskB) &&
        r.calls.includes('wait_agent') &&
        !r.calls.includes('spawn_agent'),
      { kind: 'text', text: 'agent_b 收到了' },
    );
  }, m);

  await send(page, `${m.root} 派 agent_a 和 agent_b 两个子代理，让 a 把结果直接发给 b。`);

  // ① agent_b 等完之后的那次请求里，带着 agent_a 发来的话 —— 消息真的从 a 到了 b
  const received = await waitForMatch(electronApp, 'b-received', 'agent_b 一直没等到消息');
  expect(received, 'agent_a 的消息没有到 agent_b').toContain(m.aToB);
  expect(received, 'agent_b 是 fork_turns=none 派出的，不该看到根任务的上下文').not.toContain(
    m.root,
  );

  /*
   * ② 落盘的历史里，这条消息的发送者是 agent_a、接收者是 agent_b，而不是根代理。
   * 04 §5.6.1 要求保留 sender 与 recipients —— 只看到「根代理发了消息」的话，界面就在撒谎。
   * V2 的 send_message 不留协作卡，而是在**发送方**的时间线里留一条指向接收方的
   * `subAgentActivity(kind=interacted)`（message_tool.rs 的 `emit_sub_agent_activity`）——
   * 所以发送者就是「这条活动出现在谁的时间线里」。
   */
  const root = await rootThreadId(page, m.root);
  await expect
    .poll(
      async () =>
        (await page.evaluate((threadId) => window.evowork.listSubtasks({ threadId }), root)).length,
      { message: '两个子代理没有都进本机投影' },
    )
    .toBe(2);
  const children = await page.evaluate(
    (threadId) => window.evowork.listSubtasks({ threadId }),
    root,
  );
  const sends = [];
  for (const child of children) {
    const { items } = await page.evaluate(
      (threadId) => window.evowork.openTask({ threadId }),
      child.id,
    );
    for (const item of items) {
      if (item.type === 'subAgentActivity' && item.kind === 'interacted') {
        sends.push({ sender: child.id, receiver: item.agentThreadId, path: item.agentPath });
      }
    }
  }
  expect(sends, '两个子代理的历史里应当恰好有一条子代理之间的消息').toHaveLength(1);
  const [sent] = sends;
  const other = children.find((child) => child.id !== sent.sender).id;
  expect(sent.sender, '发送者是子代理，不是根代理').not.toBe(root);
  expect(sent.receiver, '接收者应是另一个子代理').toBe(other);
  expect(sent.path).toBe('/root/agent_b');
});
