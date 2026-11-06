import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { selectRealModel } from '../harness/real-models.mjs';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import { approveTaskTreeCommandOnce } from './task-tree-approvals.mjs';

const marker = (label) => `REALFOLLOW_${label}_${randomBytes(8).toString('hex')}`;
const read = (page, threadId) =>
  page.evaluate((id) => window.evowork.openTask({ threadId: id }), threadId);
const reply = (history) =>
  history.items.filter((item) => item.type === 'agentMessage' && item.phase !== 'commentary').at(-1)
    ?.text ?? '';

test('主任务并行运行三个子代理，子代理请求各自持有独立上下文', async ({
  page,
  electronApp,
}, info) => {
  test.setTimeout(540_000);
  const model = selectRealModel();
  const { home, workspace } = await electronApp.evaluate(() => {
    const { home, workspace } = globalThis.__evoworkE2E;
    return { home, workspace };
  });
  mkdirSync(join(workspace, 'inputs'), { recursive: true });
  const rootHistoryMarker = marker('HISTORY');
  const rootOnly = marker('ROOT');
  const assignments = ['audit', 'budget', 'review'].map((role) => ({
    agent: `ctx_${role}`,
    file: `inputs/${role}.txt`,
    taskMarker: marker(role.toUpperCase()),
    result: marker(`RESULT${role.toUpperCase()}`),
  }));
  const wire = join(home, 'follow-up-wire.jsonl');
  const observations = () =>
    existsSync(wire)
      ? readFileSync(wire, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const childRequests = (rows, taskMarker) =>
    rows.filter((row) => row.type === 'request' && row.delegationMarkers?.includes(taskMarker));

  await startTaskInWorkspace(
    page,
    electronApp,
    `这是留在当前主任务历史里的测试标记 ${rootHistoryMarker}。暂不委派或读取文件，只回复已记录。`,
  );
  const { tasks } = await page.evaluate(() => window.evowork.getStartup());
  const root = tasks.find((task) => !task.parentThreadId);
  expect(root).toBeDefined();
  await expect
    .poll(async () => (await read(page, root.id)).turns.at(-1)?.status, {
      timeout: 150_000,
    })
    .toBe('completed');
  await expect(page.getByLabel('输入区')).toHaveAttribute('data-run-state', 'idle');

  const roster = assignments.map(
    ({ agent, file, taskMarker }) =>
      `- task_name=${agent}。委派正文包含任务编号 ${taskMarker}。让该代理独自执行只读命令 ` +
      `for i in $(seq 1 180); do if test -f ${file}; then cat ${file}; exit 0; fi; sleep 1; done; exit 1。` +
      '如果命令返回运行中的会话 ID，使用 write_stdin 等待输出。最终只回复文件内容一行。',
  );
  await page
    .getByLabel('需求输入')
    .fill(
      [
        '请在当前任务并行创建恰好三个子代理。先全部派出，再等待它们完成，主代理只汇总三个文件编号。',
        '每次 spawn_agent 使用指定 task_name 及 fork_turns="none"，只传该代理那一行分工，勿传其他代理分工和主任务历史。',
        `主任务内部标记 ${rootOnly} 不转发。子代理之间不要互发消息。`,
        '三个文件会在三个子代理都运行后由外部测试程序放入，不要提前结束或自行创建文件。',
        '可用 list_agents 核对状态，wait_agent 只等待尚未完成的代理。',
        ...roster,
      ].join('\n'),
    );
  await page.getByRole('button', { name: '发送', exact: true }).click();

  const composer = page.getByLabel('输入区');
  const children = () =>
    page.evaluate((threadId) => window.evowork.listSubtasks({ threadId }), root.id);
  const deadline = Date.now() + 345_000;
  let overlap;
  while (Date.now() < deadline) {
    const state = await read(page, root.id);
    if (state.turns.length === 2 && state.turns.at(-1)?.status !== 'inProgress') break;
    if (
      !overlap &&
      assignments.every(({ taskMarker }) => childRequests(observations(), taskMarker).length > 0)
    ) {
      const list = await children();
      const running = list.filter((task) => task.status === 'running');
      if (running.length === 3) {
        overlap = { at: Date.now(), children: running };
        const drawer = page.getByRole('complementary', { name: '子任务详情' });
        if (!(await drawer.isVisible()))
          await page.getByRole('button', { name: '子任务 3', exact: true }).click();
        await expect(drawer.getByRole('listitem')).toHaveCount(3);
        await expect(drawer.getByText(/^进行中 ·/)).toHaveCount(3);
        await page.screenshot({ path: info.outputPath('parallel-window.png') });
        await drawer.getByRole('button', { name: '关闭子任务详情' }).click();
        for (const { file, result } of assignments)
          writeFileSync(join(workspace, file), result + '\n');
      }
    }
    if (!(await approveTaskTreeCommandOnce(page))) await page.waitForTimeout(350);
  }

  const history = await read(page, root.id);
  const childrenById = {};
  for (const child of await children()) childrenById[child.id] = await read(page, child.id);
  const activities = history.items.filter((item) => item.type === 'subAgentActivity');
  const upstream = observations();
  writeFileSync(
    info.outputPath('parallel-context-evidence.json'),
    JSON.stringify(
      {
        model: model.upstreamModel,
        rootHistoryMarker,
        rootOnly,
        assignments,
        overlap,
        history,
        childrenById,
        upstream,
      },
      null,
      2,
    ),
  );

  expect(overlap, '三个真实子代理同时活跃后才释放输入').toBeDefined();
  expect(history.turns.map((turn) => turn.status)).toEqual(['completed', 'completed']);
  await expect(composer).toHaveAttribute('data-run-state', 'idle');
  expect(activities.map((item) => item.kind)).toEqual([
    'started',
    'started',
    'started',
    'completed',
    'completed',
    'completed',
  ]);
  expect(Object.keys(childrenById)).toHaveLength(3);
  expect(
    upstream.some(
      (row) =>
        row.type === 'request' &&
        row.markers.includes(rootHistoryMarker) &&
        row.markers.includes(rootOnly) &&
        assignments.every(({ taskMarker }) => row.markers.includes(taskMarker)),
    ),
    '负控：主控自己的请求包含全部任务标记及两条主任务标记',
  ).toBe(true);

  for (const { agent, file, taskMarker, result } of assignments) {
    const started = activities.find(
      (item) => item.kind === 'started' && item.agentPath === `/root/${agent}`,
    );
    expect(started, agent).toBeDefined();
    const child = childrenById[started.agentThreadId];
    expect(child.turns.at(-1)?.status, agent).toBe('completed');
    expect(reply(child).trim(), agent).toBe(result);
    expect(reply(history), agent).toContain(result);
    expect(
      child.items.some((item) => item.type === 'commandExecution' && item.command.includes(file)),
      agent,
    ).toBe(true);
    const requests = childRequests(upstream, taskMarker);
    expect(requests.length, agent).toBeGreaterThanOrEqual(2);
    expect(
      requests.some((row) => row.markers.includes(result)),
      agent,
    ).toBe(true);
    for (const row of requests) {
      expect(row.model).toBe(model.upstreamModel);
      expect(row.endpoint).toBe(`${model.baseUrl}/chat/completions`);
      expect(row.delegationMarkers, agent).toEqual([taskMarker]);
      expect(
        row.markers.filter((value) => value !== result),
        agent,
      ).toEqual([taskMarker]);
    }
  }
});
