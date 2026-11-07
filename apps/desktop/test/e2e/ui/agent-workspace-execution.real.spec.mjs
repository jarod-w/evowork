import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures.mjs';
import { startCommandApprovals } from './command-approvals.mjs';
import { localPythonCommand } from './shell-commands.mjs';
import { selectRealModel } from '../harness/real-models.mjs';
import {
  evidence,
  history,
  isolatedExecution,
  monitor,
  readRun,
  runStatus,
  saveAgent,
  startRun,
  teamConfig,
} from './agent-workspace-journey.mjs';

const token = () => randomBytes(5).toString('hex').toUpperCase();
test.use({ hostGateway: true });
async function workspace(electronApp) {
  return realpathSync(await electronApp.evaluate(() => globalThis.__evoworkE2E.workspace));
}
async function selectWorkspace(page) {
  await page.getByRole('button', { name: '选择项目', exact: true }).click();
  await page.getByRole('menuitem', { name: /^UI/ }).click();
}
async function reopenMonitor(page, agent) {
  await monitor(page, agent);
  await expect(page.getByRole('log')).not.toContainText('等待启动');
}

test('MiMo 并行团队：两位成员真实同时执行，结果按角色汇合，运行快照不受后续配置修改影响', async ({
  page,
}, info) => {
  await isolatedExecution(page);
  const preferences = await page.evaluate(() => window.evowork.getPreferences());
  expect(preferences.concurrencyComputed).toBeGreaterThanOrEqual(2);
  await page.evaluate(() => window.evowork.setPreferences({ concurrencyLimit: 2 }));
  const a = `A-${token()}`,
    b = `B-${token()}`,
    lead = `ROOT-${token()}`;
  const config = teamConfig({ name: '真实并行校验团队', architecture: 'parallel', middle: 2 });
  config.members[0].instructions = `不要调用工具。入口节点只回复 ${lead}。最终交付节点逐一原样列出前序结果中的 ROOT、A 和 B 校验码。`;
  config.members[1].instructions = `不要调用工具。只回复你自己的校验码 ${a}，不替其他成员回答。`;
  config.members[2].instructions = `不要调用工具。只回复你自己的校验码 ${b}，不替其他成员回答。`;
  const agent = await saveAgent(page, config);
  await monitor(page, agent);
  await startRun(page, '按各自角色完成文字校验，等待两位专业成员后再交付。');
  let overlap;
  await expect
    .poll(
      async () => {
        const run = await readRun(page, agent);
        if (run?.nodes.slice(1, 3).every((n) => n.status === 'running' && n.threadId)) {
          overlap = run;
          return true;
        }
        return false;
      },
      { timeout: 150000, intervals: [100, 250] },
    )
    .toBe(true);
  expect(overlap.concurrencyLimit).toBe(2);
  const changed = await saveAgent(page, {
    ...agent,
    name: '更新后的团队配置',
    members: agent.members.map((m) => ({ ...m, instructions: '这是下一次运行才生效的配置' })),
  });
  const run = await runStatus(page, agent, 'completed', 180000);
  expect(run.agent).toEqual(agent);
  expect(changed.revision).toBe(agent.revision + 1);
  expect(run.nodes[1].output).toContain(a);
  expect(run.nodes[1].output).not.toContain(b);
  expect(run.nodes[2].output).toContain(b);
  expect(run.nodes[2].output).not.toContain(a);
  expect(run.nodes.at(-1).output).toContain(a);
  expect(run.nodes.at(-1).output).toContain(b);
  expect(run.nodes.at(-1).output).toContain(lead);
  const histories = [];
  for (const node of run.nodes) {
    const value = await history(page, node.threadId);
    expect(value.turns.every((t) => t.status === 'completed')).toBe(true);
    histories.push(value);
  }
  const { tasks } = await page.evaluate(() => window.evowork.getStartup());
  expect(
    tasks
      .filter((t) => run.nodes.some((n) => n.threadId === t.id))
      .every((t) => t.modelId === selectRealModel().id),
  ).toBe(true);
  await evidence(info, { overlap, run, changed, histories });
  await page.screenshot({ path: info.outputPath('parallel-team-completed.png') });
});

test('MiMo 文件交付：节点读取只在本机的随机输入，真实计算并写文件，复核后按真实结果交接', async ({
  page,
  electronApp,
}, info) => {
  await isolatedExecution(page);
  await selectWorkspace(page);
  const root = await workspace(electronApp);
  const values = Array.from({ length: 9 }, () => randomInt(1000, 9000));
  mkdirSync(join(root, 'inputs'), { recursive: true });
  writeFileSync(join(root, 'inputs/workspace-numbers.json'), JSON.stringify(values));
  const config = teamConfig({ name: '真实文件交付团队' });
  config.nodes = [
    {
      ...config.nodes[0],
      name: '本机计算',
      memberId: config.members[1].id,
      condition: 'human',
      input: '读取 inputs/workspace-numbers.json',
      output: 'workspace-result.json，内容为 {"sum":整数,"max":整数}，最终回复同一 JSON',
    },
    {
      ...config.nodes.at(-1),
      name: '最终交付',
      input: '使用前序实际结果',
      output: '原样列出 sum 和 max，不重新计算',
    },
  ];
  config.members[1].instructions =
    '必须用本机 Python 读取当前任务目录的 inputs/workspace-numbers.json，计算全部数字的总和与最大值，写 workspace-result.json。不要联网或创建子代理。最终只回复生成文件中的 JSON。';
  config.members[0].instructions =
    '不要调用工具，只根据前序节点真实输出列出 sum 与 max，两个数字不得改写。';
  const agent = await saveAgent(page, config);
  await monitor(page, agent);
  await startRun(page, '完成本机文件计算，等待我复核后交付。');
  await page.getByRole('button', { name: '查看节点任务', exact: true }).first().click();
  const stopApprovals = startCommandApprovals(() => page);
  let waiting, approved;
  try {
    waiting = await runStatus(page, agent, 'waiting', 180000);
  } finally {
    approved = await stopApprovals();
  }
  const expected = { sum: values.reduce((a, b) => a + b, 0), max: Math.max(...values) };
  expect(JSON.parse(readFileSync(join(root, 'workspace-result.json'), 'utf8'))).toEqual(expected);
  expect(waiting.nodes[1].threadId).toBeUndefined();
  const before = await history(page, waiting.nodes[0].threadId);
  expect(before.items.some((i) => i.type === 'commandExecution')).toBe(true);
  const task = (await page.evaluate(() => window.evowork.getStartup())).tasks.find(
    (t) => t.id === waiting.nodes[0].threadId,
  );
  expect(realpathSync(task.cwd)).toBe(root);
  await reopenMonitor(page, agent);
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  const run = await runStatus(page, agent, 'completed', 150000);
  expect(run.nodes[1].output).toContain(String(expected.sum));
  expect(run.nodes[1].output).toContain(String(expected.max));
  expect(JSON.parse(readFileSync(join(root, 'workspace-result.json'), 'utf8'))).toEqual(expected);
  await evidence(info, { values, expected, approved, before, run });
  await page.screenshot({ path: info.outputPath('file-workflow-completed.png') });
});

test('MiMo 运行中停止：中断真实本机命令，释放外部门闩后也不能写出完成文件或启动后续节点', async ({
  page,
  electronApp,
}, info) => {
  await isolatedExecution(page);
  await selectWorkspace(page);
  const root = await workspace(electronApp),
    marker = token();
  const script = join(root, 'controlled-node.py');
  const released = join(root, 'workspace-release');
  writeFileSync(
    script,
    [
      'import time, pathlib, sys',
      `root = pathlib.Path(${JSON.stringify(root)})`,
      `root.joinpath('workspace-started').write_text('${marker}')`,
      'deadline = time.monotonic() + 90',
      "while not root.joinpath('workspace-release').exists():",
      '    if time.monotonic() > deadline: sys.exit(2)',
      '    time.sleep(0.1)',
      `root.joinpath('workspace-finished').write_text('${marker}')`,
    ].join('\n'),
  );
  const command = localPythonCommand([script]);
  const config = teamConfig({ name: '真实停止保护团队' });
  config.members[0].instructions = `当前入口节点必须用 exec_command 运行以下命令：${command}。不要创建或修改 workspace-release；若工具返回 session_id，必须用 write_stdin 等待进程结束，不得在它运行期间声称完成。不联网、不创建子代理。`;
  config.nodes[0].output = '仅在命令真正退出之后返回完成';
  const agent = await saveAgent(page, config);
  let stopApprovals = () => Promise.resolve(0),
    approved = 0;
  try {
    await monitor(page, agent);
    await startRun(page, '启动已提供的受控本机程序，必须等程序结束。');
    await page.getByRole('button', { name: '查看节点任务', exact: true }).first().click();
    stopApprovals = startCommandApprovals(() => page);
    await expect
      .poll(() => existsSync(join(root, 'workspace-started')), {
        timeout: 150000,
        intervals: [100, 250],
      })
      .toBe(true);
    approved = await stopApprovals();
    stopApprovals = () => Promise.resolve(0);
    expect(readFileSync(join(root, 'workspace-started'), 'utf8')).toBe(marker);
    const inProgress = await readRun(page, agent);
    expect(inProgress.status).toBe('running');
    expect(inProgress.nodes[0].status).toBe('running');
    expect(inProgress.nodes.slice(1).every((n) => !n.threadId)).toBe(true);
    await reopenMonitor(page, agent);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    const run = await runStatus(page, agent, 'stopped');
    await expect
      .poll(async () => (await history(page, run.nodes[0].threadId)).turns.at(-1)?.status)
      .toBe('interrupted');
    writeFileSync(released, 'release after interruption');
    await page.waitForTimeout(1200);
    expect(existsSync(join(root, 'workspace-finished'))).toBe(false);
    expect((await readRun(page, agent)).nodes.slice(1).every((n) => !n.threadId)).toBe(true);
    const finalHistory = await history(page, run.nodes[0].threadId);
    expect(finalHistory.items.some((i) => i.type === 'commandExecution')).toBe(true);
    await evidence(info, {
      inProgress,
      run: await readRun(page, agent),
      approved,
      history: finalHistory,
    });
    await page.screenshot({ path: info.outputPath('real-command-stopped.png') });
  } finally {
    await stopApprovals();
    writeFileSync(released, 'cleanup');
  }
});
