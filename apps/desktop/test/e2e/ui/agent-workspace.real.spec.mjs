import { horizontalOverflow, resizeWindow } from './assertions.mjs';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { expect, test } from './fixtures.mjs';
import { selectRealModel } from '../harness/real-models.mjs';

test.use({ hostGateway: true });
const marker = () => randomBytes(5).toString('hex').toUpperCase();
async function agents(page) {
  await page
    .getByRole('navigation', { name: '侧边栏', exact: true })
    .getByRole('button', { name: '智能体', exact: true })
    .click();
}
async function createSingle(page, name, instructions) {
  await page.getByRole('button', { name: '新建智能体', exact: true }).click();
  await page.getByLabel('智能体名称', { exact: false }).fill(name);
  await page.getByLabel('角色说明', { exact: false }).fill('只用文字处理本次需求，不调用工具。');
  await page.getByLabel('工作指令', { exact: false }).fill(instructions);
  await page.getByRole('button', { name: '保存智能体', exact: true }).click();
  await expect(page.getByRole('article', { name, exact: true })).toBeVisible();
}
async function complete(page, threadId, count = 1) {
  await expect
    .poll(
      async () => {
        const history = await page.evaluate(
          (id) => window.evowork.openTask({ threadId: id }),
          threadId,
        );
        if (history.turns.some((t) => ['failed', 'interrupted'].includes(t.status)))
          throw new Error('真实任务未完成');
        return (
          history.turns.length >= count && history.turns.every((t) => t.status === 'completed')
        );
      },
      { timeout: 150000, intervals: [500, 1000] },
    )
    .toBe(true);
  return page.evaluate((id) => window.evowork.openTask({ threadId: id }), threadId);
}
async function attach(info, value) {
  const path = info.outputPath('evidence.json');
  writeFileSync(path, JSON.stringify(value, null, 2));
  await info.attach('evidence', { path, contentType: 'application/json' });
}

test('MiMo 单体：角色指令生效，刷新保留配置，编辑和删除不改变已有任务快照', async ({
  page,
}, info) => {
  const old = `ROLE-${marker()}`;
  const next = `NEW-${marker()}`;
  await agents(page);
  await createSingle(page, '真实角色助手', `每次最终回答只输出固定校验码 ${old}，不要调用工具。`);
  await page.reload();
  await page.getByLabel('需求输入').waitFor();
  await agents(page);
  await page
    .getByRole('article', { name: '真实角色助手', exact: true })
    .getByRole('button', { name: '开始对话', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: '与真实角色助手对话', exact: true });
  await dialog.getByLabel('任务需求').fill('请按工作角色的要求回答。');
  await dialog.getByRole('button', { name: '开始任务', exact: true }).click();
  await expect(page.getByLabel('需求输入')).toBeVisible();
  await expect
    .poll(async () => {
      const { tasks } = await page.evaluate(() => window.evowork.getStartup());
      return tasks.length;
    })
    .toBeGreaterThan(0);
  const { tasks } = await page.evaluate(() => window.evowork.getStartup());
  const root = [...tasks]
    .filter((t) => !t.parentThreadId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  expect(root.modelId).toBe(selectRealModel().id);
  const initial = await complete(page, root.id);
  expect(initial.items.filter((i) => i.type === 'agentMessage').at(-1).text).toContain(old);
  const [saved] = await page.evaluate(() => window.evowork.listAgentWorkspace());
  const changed = await page.evaluate(
    ({ agent, instructions }) =>
      window.evowork.saveAgentWorkspace({ agent: { ...agent, instructions } }),
    { agent: saved, instructions: `每次最终回答只输出 ${next}` },
  );
  await page.evaluate(
    (agent) => window.evowork.deleteAgentWorkspace({ id: agent.id, revision: agent.revision }),
    changed,
  );
  await page.getByLabel('需求输入').fill('请再按当前工作角色回答一次。');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const follow = await complete(page, root.id, 2);
  const answer = follow.items.filter((i) => i.type === 'agentMessage').at(-1).text;
  expect(answer).toContain(old);
  expect(answer).not.toContain(next);
  await attach(info, { model: root.modelId, initial, follow });
  await page.screenshot({ path: info.outputPath('single-real-result.png') });
});

test('MiMo 团队：真实输出经人工确认后交接并汇总，刷新恢复等待状态', async ({
  page,
  electronApp,
}, info) => {
  const workerMarker = `WORKER-${marker()}`;
  const leadMarker = `LEAD-${marker()}`;
  await agents(page);
  await createSingle(
    page,
    '专业成员',
    `只用文字回答，不调用工具。你的每次最终输出只包含 ${workerMarker}。`,
  );
  await page.getByRole('button', { name: /创建多智能体协作/ }).click();
  await page.getByLabel('团队名称', { exact: false }).fill('真实协作团队');
  await page.getByRole('button', { name: /自主交接/ }).click();
  await page
    .getByLabel('工作指令', { exact: false })
    .fill(
      `不要调用工具。若当前节点是理解目标，只输出 ${leadMarker}；若当前节点是汇总报告，原样列出前序所有节点输出中的校验码，包括 LEAD 和 WORKER。`,
    );
  await page.getByRole('tab', { name: '② 流程编排', exact: true }).click();
  await page.getByRole('combobox', { name: '完成条件', exact: true }).selectOption('human');
  await page.getByRole('button', { name: '保存团队', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('已保存到本机');
  await page.getByRole('tab', { name: '③ 运行监控', exact: true }).click();
  await page.getByLabel('团队任务需求').fill('按团队角色完成一个文字校验任务。不要调用工具。');
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
  await expect(page.getByText('流程等待人工确认', { exact: true })).toBeVisible({
    timeout: 150000,
  });
  const saved = await page.evaluate(() => window.evowork.listAgentWorkspace());
  const team = saved.find((a) => a.kind === 'team');
  let run = await page.evaluate(
    (agentId) => window.evowork.getAgentWorkspaceRun({ agentId }),
    team.id,
  );
  expect(run.nodes[0].output).toContain(leadMarker);
  await expect(
    page.evaluate(
      (agent) => window.evowork.deleteAgentWorkspace({ id: agent.id, revision: agent.revision }),
      team,
    ),
  ).rejects.toThrow('先停止运行');
  expect(run.nodes.slice(1).every((n) => !n.threadId)).toBe(true);
  await page.reload();
  await page.getByLabel('需求输入').waitFor();
  await agents(page);
  await page
    .getByRole('article', { name: '真实协作团队', exact: true })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await page.getByRole('tab', { name: '③ 运行监控', exact: true }).click();
  await expect(page.getByText('流程等待人工确认', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('团队运行已完成', { timeout: 150000 });
  run = await page.evaluate((agentId) => window.evowork.getAgentWorkspaceRun({ agentId }), team.id);
  expect(run.status).toBe('completed');
  expect(run.nodes).toHaveLength(3);
  expect(run.nodes[1].output).toContain(workerMarker);
  expect(run.nodes[2].output).toContain(leadMarker);
  expect(run.nodes[2].output).toContain(workerMarker);
  const histories = [];
  for (const node of run.nodes) {
    expect(node.status).toBe('completed');
    expect(node.threadId).toBeTruthy();
    histories.push(await complete(page, node.threadId));
  }
  await attach(info, { run, histories });
  await page.getByRole('button', { name: '查看节点任务', exact: true }).last().click();
  await expect(page.getByLabel('需求输入')).toBeVisible();
  await agents(page);
  await page
    .getByRole('article', { name: '真实协作团队', exact: true })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
  await page.getByRole('tab', { name: '③ 运行监控', exact: true }).click();
  await expect(page.getByRole('log')).toContainText('团队运行已完成');
  await page.locator('details').last().getByText('节点输出', { exact: true }).click();
  await page.screenshot({ path: info.outputPath('team-real-result.png') });
  await resizeWindow(electronApp, 480, 900);
  const collapse = page.getByRole('button', { name: '折叠侧边栏', exact: true });
  if (await collapse.isVisible()) await collapse.click();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('team-real-result-480.png') });
});
