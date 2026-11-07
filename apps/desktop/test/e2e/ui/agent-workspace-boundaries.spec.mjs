import { expect, test } from './fixtures.mjs';
import {
  editAgent,
  evidence,
  history,
  isolatedExecution,
  monitor,
  openAgents,
  readRun,
  role,
  runStatus,
  saveAgent,
  scriptNodes,
  single,
  startRun,
  taggedTeam,
  teamConfig,
} from './agent-workspace-journey.mjs';

test('智能体筛选与离开保护：组合搜索不改变后台配置，未保存修改可保留或放弃', async ({ page }) => {
  const alpha = await saveAgent(page, single('Alpha 文档助手'));
  await saveAgent(page, single('Beta 数据助手'));
  await saveAgent(page, teamConfig({ name: 'Alpha 协作团队' }));
  await openAgents(page);
  await expect(page.getByRole('article')).toHaveCount(3);
  await page.getByRole('tab', { name: '单个智能体 2', exact: true }).click();
  await page.getByRole('searchbox', { name: '搜索智能体' }).fill('ALPHA');
  await expect(page.getByRole('article')).toHaveCount(1);
  await expect(page.getByRole('article', { name: alpha.name, exact: true })).toBeVisible();
  await page.getByRole('searchbox').fill('不存在的角色');
  await expect(page.getByText('没有找到匹配的智能体', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '清除搜索', exact: true }).first().click();
  await page.getByRole('tab', { name: '全部 3', exact: true }).click();
  await page
    .getByRole('article', { name: alpha.name, exact: true })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await page.getByLabel('智能体名称', { exact: false }).fill('未保存的改名');
  await page
    .getByRole('navigation', { name: '侧边栏', exact: true })
    .getByRole('button', { name: '插件', exact: true })
    .click();
  let dialog = page.getByRole('dialog', { name: '离开当前配置？', exact: true });
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click();
  await expect(page.getByLabel('智能体名称', { exact: false })).toHaveValue('未保存的改名');
  await page.getByRole('button', { name: '返回智能体', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '离开当前配置？', exact: true });
  await dialog.getByRole('button', { name: '放弃并离开', exact: true }).click();
  await expect(page.getByRole('article', { name: alpha.name, exact: true })).toBeVisible();
  expect(
    (await page.evaluate(() => window.evowork.listAgentWorkspace())).find((a) => a.id === alpha.id),
  ).toEqual(alpha);
});

test('过期编辑与删除：后台拒绝覆盖，新数据保留，错误在原表单或弹窗内可见', async ({ page }) => {
  const saved = await saveAgent(page, single('并发编辑助手'));
  await editAgent(page, saved);
  await page.getByLabel('工作指令', { exact: false }).fill('来自旧编辑器的修改');
  const current = await saveAgent(page, { ...saved, instructions: '另一编辑器已保存的指令' });
  await page.getByRole('button', { name: '保存智能体', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('配置已改变');
  await expect(page.getByLabel('工作指令', { exact: false })).toHaveValue('来自旧编辑器的修改');
  expect((await page.evaluate(() => window.evowork.listAgentWorkspace()))[0]).toEqual(current);
  await page.getByRole('button', { name: '返回智能体', exact: true }).click();
  await page
    .getByRole('dialog', { name: '离开当前配置？' })
    .getByRole('button', { name: '放弃并离开' })
    .click();
  // 列表仍持旧修订号；后台另一个写入者已更新它。
  await page.getByRole('button', { name: `管理${saved.name}`, exact: true }).click();
  await page.getByRole('button', { name: '删除配置', exact: true }).click();
  const deletion = page.getByRole('alertdialog', { name: `删除${saved.name}？`, exact: true });
  await deletion.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(deletion.getByRole('alert')).toContainText('配置已改变');
  await deletion.getByRole('button', { name: '取消', exact: true }).click();
  await page.reload();
  await page.getByLabel('需求输入').waitFor();
  await editAgent(page, current);
  await expect(page.getByLabel('工作指令', { exact: false })).toHaveValue(current.instructions);
});

test('IPC 配置校验：拒绝未接入能力、重复主控、悬空节点和未知完成条件，不产生任务', async ({
  page,
}) => {
  const agent = await saveAgent(page, single('合法角色'));
  const invalidTeam = teamConfig();
  const mutations = [
    { ...agent, connectors: ['feishu'] },
    { ...invalidTeam, members: invalidTeam.members.map((m) => ({ ...m, lead: true })) },
    { ...invalidTeam, nodes: [{ ...invalidTeam.nodes[0], memberId: 'missing' }] },
    { ...invalidTeam, nodes: [{ ...invalidTeam.nodes[0], condition: 'auto-approve' }] },
    { ...invalidTeam, members: [invalidTeam.members[0], { ...role(''), lead: false }] },
  ];
  for (const invalid of mutations) await expect(saveAgent(page, invalid)).rejects.toThrow();
  expect(await page.evaluate(() => window.evowork.listAgentWorkspace())).toEqual([agent]);
  expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toEqual([]);
});

for (const condition of ['human', 'review']) {
  test(`${condition} 节点拒绝后停止，重新运行不继承确认；运行中禁删且停后可删除`, async ({
    page,
    electronApp,
  }, info) => {
    await isolatedExecution(page);
    const agent = await saveAgent(page, taggedTeam({ condition }));
    await scriptNodes(electronApp, agent);
    await monitor(page, agent);
    await startRun(page, `检查 ${condition} 的确认边界`);
    let run = await runStatus(page, agent, 'waiting');
    expect(run.nodes[0].output).toContain('已处理-0');
    expect(run.nodes.slice(1).every((n) => n.status === 'pending' && !n.threadId)).toBe(true);
    await page.getByRole('tab', { name: '② 流程编排', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('请先停止运行');
    await page.getByRole('button', { name: '返回智能体', exact: true }).click();
    await page.getByRole('button', { name: `管理${agent.name}`, exact: true }).click();
    await page.getByRole('button', { name: '删除配置', exact: true }).click();
    const deletion = page.getByRole('alertdialog', { name: `删除${agent.name}？`, exact: true });
    await deletion.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(deletion.getByRole('alert')).toContainText('先停止运行');
    await deletion.getByRole('button', { name: '取消', exact: true }).click();
    await monitor(page, agent);
    await page.getByRole('button', { name: '拒绝并停止', exact: true }).click();
    run = await runStatus(page, agent, 'stopped');
    expect(run.nodes.slice(1).every((n) => !n.threadId)).toBe(true);
    await expect(
      page.evaluate(
        (runId) => window.evowork.decideAgentWorkspaceRun({ runId, action: 'confirm' }),
        run.id,
      ),
    ).rejects.toThrow('运行已结束');
    await startRun(page, '重新运行必须重新确认');
    const next = await runStatus(page, agent, 'waiting');
    expect(next.id).not.toBe(run.id);
    expect(next.nodes.every((n) => !n.confirmed)).toBe(true);
    await page.getByRole('button', { name: '停止', exact: true }).click();
    await runStatus(page, agent, 'stopped');
    await page.evaluate(
      (agent) => window.evowork.deleteAgentWorkspace({ id: agent.id, revision: agent.revision }),
      agent,
    );
    await evidence(info, { first: run, next });
  });
}

test('停止在途输出：真实回合被中断，迟到响应及刷新不能推进后续节点', async ({
  page,
  electronApp,
}, info) => {
  await isolatedExecution(page);
  const agent = await saveAgent(page, taggedTeam());
  await scriptNodes(electronApp, agent, { holdFirst: true });
  await monitor(page, agent);
  await startRun(page, '在流式响应中停止');
  await expect
    .poll(() =>
      electronApp.evaluate(
        (_electron, id) => globalThis.__evoworkE2E.gateway.matchedBody(`node-${id}`),
        agent.nodes[0].id,
      ),
    )
    .toBeTruthy();
  await page.getByRole('button', { name: '停止', exact: true }).click();
  const run = await runStatus(page, agent, 'stopped');
  await expect
    .poll(async () => (await history(page, run.nodes[0].threadId)).turns.at(-1)?.status)
    .toBe('interrupted');
  await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.releaseScriptedTurn());
  await page.reload();
  await page.getByLabel('需求输入').waitFor();
  await monitor(page, agent);
  await expect(page.getByRole('log')).toContainText('用户停止运行');
  const restored = await readRun(page, agent);
  expect(restored.status).toBe('stopped');
  expect(restored.nodes.slice(1).every((n) => !n.threadId)).toBe(true);
  expect((await page.evaluate(() => window.evowork.getStartup())).tasks).toHaveLength(1);
  await evidence(info, { run: restored, history: await history(page, run.nodes[0].threadId) });
});

test('上游明确失败：展示失败且不交接，刷新保持失败，仍可修改配置', async ({
  page,
  electronApp,
}, info) => {
  await isolatedExecution(page);
  const agent = await saveAgent(page, taggedTeam());
  await scriptNodes(electronApp, agent, { failFirst: true });
  await monitor(page, agent);
  await startRun(page, '验证失败不交接');
  const run = await runStatus(page, agent, 'failed');
  expect(run.nodes[0].status).toBe('failed');
  expect(run.nodes.slice(1).every((n) => !n.threadId)).toBe(true);
  const first = await history(page, run.nodes[0].threadId);
  expect(first.turns.some((t) => t.status === 'failed')).toBe(true);
  await page.reload();
  await page.getByLabel('需求输入').waitFor();
  await monitor(page, agent);
  await expect(page.getByRole('log')).toContainText('节点执行失败');
  await page.getByRole('tab', { name: '② 流程编排', exact: true }).click();
  await page.getByLabel('节点名称', { exact: false }).fill('修正后的入口');
  await page.getByRole('button', { name: '保存团队', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存到本机');
  expect((await page.evaluate(() => window.evowork.listAgentWorkspace()))[0].nodes[0].name).toBe(
    '修正后的入口',
  );
  await evidence(info, { run, history: first });
});

test('并行架构遵守用户的一路并发：前序输出到达后才启动下一节点', async ({
  page,
  electronApp,
}, info) => {
  await isolatedExecution(page);
  await page.evaluate(() => window.evowork.setPreferences({ concurrencyLimit: 1 }));
  const agent = await saveAgent(page, taggedTeam({ architecture: 'parallel', middle: 2 }));
  await electronApp.evaluate((_electron, agent) => {
    const g = globalThis.__evoworkE2E.gateway;
    for (const [index, node] of agent.nodes.entries()) {
      g.scriptWhen(
        `serial-${index}`,
        (r) => r.tools.includes('exec_command') && r.text.includes(node.input),
        index === 1
          ? { kind: 'hold', text: '处理中' }
          : { kind: 'text', text: `批次结果-${index}` },
      );
    }
  }, agent);
  await monitor(page, agent);
  await startRun(page, '并行架构按设置降到一路');
  await expect
    .poll(() =>
      electronApp.evaluate(() => Boolean(globalThis.__evoworkE2E.gateway.matchedBody('serial-1'))),
    )
    .toBe(true);
  const pending = await readRun(page, agent);
  expect(pending.concurrencyLimit).toBe(1);
  expect(pending.nodes[0].status).toBe('completed');
  expect(pending.nodes[2].threadId).toBeUndefined();
  await electronApp.evaluate(() => globalThis.__evoworkE2E.gateway.releaseScriptedTurn());
  const completed = await runStatus(page, agent, 'completed');
  const finalBody = await electronApp.evaluate(() =>
    globalThis.__evoworkE2E.gateway.matchedBody('serial-3'),
  );
  expect(finalBody).toContain('批次结果-0');
  expect(finalBody).toContain('批次结果-2');
  expect(completed.nodes.every((n) => n.status === 'completed')).toBe(true);
  await evidence(info, { pending, completed });
});
