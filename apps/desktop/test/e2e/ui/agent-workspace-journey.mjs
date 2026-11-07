import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { expect } from './fixtures.mjs';

/** 所有夹具都经公开 IPC 保存；不直接写数据库或注入渲染状态。 */
export function role(name, instructions = '按事实完成当前节点，不调用工具。') {
  return {
    id: randomUUID(),
    name,
    description: `${name}的工作职责`,
    instructions,
    skills: [],
    connectors: ['files'],
  };
}
export function single(name, instructions) {
  return { ...role(name, instructions), kind: 'single', icon: 'agent', example: false };
}
export function teamConfig({
  name = '边界协作团队',
  architecture = 'custom',
  middle = 1,
  condition = 'success',
  instructions,
} = {}) {
  const lead = { ...role('主控', instructions), lead: true };
  const workers = Array.from({ length: middle }, (_, index) => ({
    ...role(`专业成员${index + 1}`, instructions),
    lead: false,
  }));
  const node = (name, memberId, condition = 'success') => ({
    id: randomUUID(),
    name,
    memberId,
    condition,
    input: '',
    output: '给出可核验的节点结果',
  });
  return {
    ...single(name),
    kind: 'team',
    architecture,
    description: '完成一个可核验的协作任务',
    instructions: '',
    members: [lead, ...workers],
    nodes: [
      node('入口节点', lead.id, condition),
      ...workers.map((w) => node(w.name, w.id)),
      node('最终交付', lead.id),
    ],
  };
}
export async function saveAgent(page, agent) {
  return page.evaluate((agent) => window.evowork.saveAgentWorkspace({ agent }), agent);
}
export async function isolatedExecution(page) {
  const result = await page.evaluate(() =>
    window.evowork.setMemorySettings({
      enabled: false,
      useMemories: false,
      generateMemories: false,
    }),
  );
  expect(result.ok).toBe(true);
  await page.evaluate(() => window.evowork.setPreferences({ taskTokenBudget: 0 }));
}
export async function openAgents(page) {
  await page
    .getByRole('navigation', { name: '侧边栏', exact: true })
    .getByRole('button', { name: '智能体', exact: true })
    .click();
}
export async function editAgent(page, agent) {
  await openAgents(page);
  await page
    .getByRole('article', { name: agent.name, exact: true })
    .getByRole('button', { name: '编辑', exact: true })
    .click();
}
export async function monitor(page, agent) {
  await editAgent(page, agent);
  await page.getByRole('tab', { name: '③ 运行监控', exact: true }).click();
}
export async function startRun(page, prompt) {
  await page.getByLabel('团队任务需求', { exact: true }).fill(prompt);
  await page.getByRole('button', { name: '开始运行', exact: true }).click();
}
export function readRun(page, agent) {
  return page.evaluate((agentId) => window.evowork.getAgentWorkspaceRun({ agentId }), agent.id);
}
export async function runStatus(page, agent, status, timeout = 90000) {
  await expect
    .poll(async () => (await readRun(page, agent))?.status, { timeout, intervals: [200, 500] })
    .toBe(status);
  return readRun(page, agent);
}
export async function history(page, threadId) {
  return page.evaluate((threadId) => window.evowork.openTask({ threadId }), threadId);
}
export async function evidence(info, value) {
  const body = JSON.stringify(value, null, 2);
  if (process.env.EVOWORK_UI_MODEL_KEY && body.includes(process.env.EVOWORK_UI_MODEL_KEY))
    throw new Error('证据中出现凭据，拒绝保存。');
  const path = info.outputPath('workspace-evidence.json');
  writeFileSync(path, body);
  await info.attach('workspace-evidence', { path, contentType: 'application/json' });
}
export async function scriptNodes(
  electronApp,
  agent,
  { holdFirst = false, failFirst = false } = {},
) {
  await electronApp.evaluate(
    (_electron, { agent, holdFirst, failFirst }) => {
      const gateway = globalThis.__evoworkE2E.gateway;
      for (const [index, node] of agent.nodes.entries()) {
        const token = `${agent.id}-${index}`;
        gateway.scriptWhen(
          `node-${node.id}`,
          (r) => r.tools.includes('exec_command') && r.text.includes(token),
          index === 0 && failFirst
            ? { kind: 'fail', code: 'invalid_prompt', text: '节点输入被上游拒绝' }
            : index === 0 && holdFirst
              ? { kind: 'hold', text: `在途输出-${index}` }
              : { kind: 'text', text: `已处理-${index}` },
        );
      }
    },
    { agent, holdFirst, failFirst },
  );
}
export function taggedTeam(options) {
  const agent = teamConfig(options);
  agent.nodes.forEach((node, index) => {
    node.input = `${agent.id}-${index}`;
  });
  return agent;
}
