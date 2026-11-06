import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { selectRealModel } from '../harness/real-models.mjs';
import { expect, startTaskInWorkspace, test } from './fixtures.mjs';
import { approveTaskTreeCommandOnce } from './task-tree-approvals.mjs';

const readHistory = (page, threadId) =>
  page.evaluate((id) => window.evowork.openTask({ threadId: id }), threadId);
const finalReply = (history) =>
  history.items.filter((item) => item.type === 'agentMessage' && item.phase !== 'commentary').at(-1)
    ?.text ?? '';

test('同一任务按 3+2 派出五个子代理，各自读取并使用自己的 Skill', async ({
  page,
  electronApp,
}, info) => {
  test.setTimeout(450_000);
  const model = selectRealModel();
  const { home, workspace } = await electronApp.evaluate(() => {
    const { home, workspace } = globalThis.__evoworkE2E;
    return { home, workspace };
  });
  const assignments = ['audit', 'budget', 'copy', 'data', 'review'].map((role) => {
    const agent = `skill_${role}`;
    const skill = `five-agent-${role}`;
    const marker = `SKILL-${randomBytes(8).toString('hex')}`;
    const directory = join(workspace, '.agents', 'skills', skill);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: Read-only test procedure for the ${role} child.\n---\n\n` +
        `执行规则：最终答复只输出以下校验码一行。\n\n${marker}\n`,
    );
    const delegation = `REALFOLLOW_${role.toUpperCase()}_${randomBytes(6).toString('hex')}`;
    return { agent, skill, marker, delegation };
  });
  const roster = assignments.map(
    ({ agent, skill, delegation }, index) =>
      `${index + 1}. task_name=${agent}，派发正文中写入任务编号 ${delegation}，` +
      `要求用只读命令 cat .agents/skills/${skill}/SKILL.md 读取 Skill 全文，然后按该文件规则回复。`,
  );

  await startTaskInWorkspace(
    page,
    electronApp,
    [
      '请在同一个任务里创建恰好五个不同的子代理验证 Skill。你只编排和汇总。',
      '第一批先派 1–3，并等这三位均完成。之后再派第二批 4–5，等这两位均完成。',
      '每次 spawn_agent 用指定 task_name 和 fork_turns="none"，把对应分工完整交给子代理。',
      '每个子代理只读它自己的文件。主代理不读文件，也不直接输出任务编号。',
      '可用 list_agents 核对状态，wait_agent 只等待尚未完成的代理，移除已经完成的目标。',
      '五位完成后，把各自的最终答复按名称汇总给我。',
      ...roster,
    ].join('\n'),
  );

  const { tasks } = await page.evaluate(() => window.evowork.getStartup());
  const roots = tasks.filter((task) => !task.parentThreadId);
  expect(roots).toHaveLength(1);
  const rootId = roots[0].id;
  const composer = page.getByLabel('输入区');
  const deadline = Date.now() + 345_000;
  while (Date.now() < deadline && (await composer.getAttribute('data-run-state')) !== 'idle') {
    if (!(await approveTaskTreeCommandOnce(page))) await page.waitForTimeout(350);
  }

  const root = await readHistory(page, rootId);
  const activities = root.items.filter((item) => item.type === 'subAgentActivity');
  const started = activities.filter((item) => item.kind === 'started');
  const children = await page.evaluate(
    (threadId) => window.evowork.listSubtasks({ threadId }),
    rootId,
  );
  const histories = {};
  for (const child of children) histories[child.id] = await readHistory(page, child.id);
  const wire = join(home, 'follow-up-wire.jsonl');
  const requests = existsSync(wire)
    ? readFileSync(wire, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  writeFileSync(
    info.outputPath('skill-evidence.json'),
    JSON.stringify({ assignments, root, children, histories, requests }, null, 2),
  );
  await page.screenshot({ path: info.outputPath('five-agent-skills.png') });

  expect(root.turns.at(-1)?.status).toBe('completed');
  expect(started).toHaveLength(5);
  expect(children).toHaveLength(5);
  expect(new Set(started.map((item) => item.agentThreadId))).toEqual(
    new Set(children.map((child) => child.id)),
  );
  const firstBatch = assignments.slice(0, 3).map(({ agent }) => `/root/${agent}`);
  expect(new Set(started.slice(0, 3).map((item) => item.agentPath))).toEqual(new Set(firstBatch));
  const firstSecondBatchStart = activities.indexOf(started[3]);
  expect(
    new Set(
      activities
        .slice(0, firstSecondBatchStart)
        .filter((item) => item.kind === 'completed')
        .map((item) => item.agentPath),
    ),
  ).toEqual(new Set(firstBatch));

  expect(root.items.filter((item) => item.type === 'commandExecution')).toHaveLength(0);
  for (const { agent, skill, marker } of assignments) {
    const activity = started.find((item) => item.agentPath === `/root/${agent}`);
    expect(activity, `派发 ${agent}`).toBeDefined();
    const history = histories[activity.agentThreadId];
    expect(history.turns.at(-1)?.status, agent).toBe('completed');
    const commands = history.items.filter((item) => item.type === 'commandExecution');
    expect(
      commands.some(
        (item) =>
          item.status === 'completed' &&
          item.command.includes(`${skill}/SKILL.md`) &&
          item.output.includes(marker),
      ),
      agent,
    ).toBe(true);
    expect(finalReply(history).trim(), agent).toBe(marker);
    expect(finalReply(root), agent).toContain(marker);
    for (const other of assignments.filter((assignment) => assignment.agent !== agent)) {
      expect(JSON.stringify(commands), agent).not.toContain(`${other.skill}/SKILL.md`);
    }
  }
  const upstream = requests.filter((row) => row.type === 'request');
  expect(upstream.length).toBeGreaterThanOrEqual(6);
  for (const request of upstream) {
    expect(request.model).toBe(model.upstreamModel);
    expect(request.endpoint).toBe(`${model.baseUrl}/chat/completions`);
  }
});
