/** 无项目任务本地技能：真 Electron / preload / 宿主 / 内核，本机夹具网关。 */
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { app } from 'electron';

import { bootApp, createE2EHome, writeKernelConfig } from './harness/boot.mjs';
import { createFakeGateway } from './harness/fake-gateway.mjs';
import { createRunner, removeE2EHome, waitFor } from './harness/runner.mjs';

const { stage, report } = createRunner({
  stagePrefix: '__EVOWORK_DESKTOP_E2E_STAGE__',
  resultPrefix: '__EVOWORK_DESKTOP_E2E__',
});
// 放在真实应用数据目录下的独立测试子树，覆盖项目选址规则对 ~/.evowork 的拒绝。
// 仅清理本次随机目录，不读取或改写用户既有配置与任务。
const parentDir = join(homedir(), '.evowork');
mkdirSync(parentDir, { recursive: true });
const { home, kernelHome } = createE2EHome('evowork-task-skills-e2e-', parentDir);
const workspace = mkdtempSync(join(tmpdir(), 'evowork-skill-project-'));
const gateway = createFakeGateway({ turnMarker: 'unused-held-turn' });
let host;

async function run() {
  try {
    const baseUrl = await gateway.listen();
    writeKernelConfig(
      kernelHome,
      `model_provider = "evowork"
default_permissions = "evowork-workspace"
approval_policy = "never"

[model_providers.evowork]
name = "E2E Gateway"
base_url = "${baseUrl}"
wire_api = "responses"
env_key = "EVOWORK_GATEWAY_TOKEN"

[permissions.evowork-workspace]
extends = ":workspace"
`,
    );
    const desktop = await bootApp({
      repoRoot: process.env.EVOWORK_E2E_REPO_ROOT,
      appServerPath: process.env.EVOWORK_APP_SERVER,
      home,
      hostEnv: { EVOWORK_GATEWAY_TOKEN: 'e2e-token', EVOWORK_GATEWAY_URL: baseUrl },
      captureKernelProcess: true,
    });
    host = desktop.host;
    const evaluate = desktop.evaluate;
    const call = (method, input) => evaluate(`window.evowork.${method}(${JSON.stringify(input)})`);
    const standalone = await call('send', {
      text: '验证独立任务的技能目录',
      modelId: 'e2e-model',
      modeId: 'request-approval',
    });
    const task = (await call('getStartup')).tasks.find((item) => item.id === standalone.threadId);
    if (!task?.cwd || task.projectId) throw new Error('没有创建无项目任务。');
    const target = { threadId: task.id };
    await call('getComposerContext', target);
    const coachDir = join(realpathSync(task.cwd), '.agents', 'skills', 'evowork-task-coach');
    const coachPath = join(coachDir, 'SKILL.md');
    mkdirSync(coachDir, { recursive: true });
    writeFileSync(
      coachPath,
      '---\nname: evowork-task-coach\ndescription: 独立任务的工作教练\n---\n\n帮助整理工作。\n',
    );
    await waitFor(
      async () => {
        const context = await call('getComposerContext', target);
        return context.mentions.some(
          (candidate) => candidate.name === 'evowork-task-coach' && candidate.path === coachPath,
        );
      },
      '无项目任务的新技能没有进入候选列表',
      20_000,
    );
    stage('standalone-skill-discovered');

    const project = await call('createProject', { name: '其他项目', path: workspace });
    if (!project.ok || !project.projects[0]?.id) throw new Error('没有创建对照项目。');
    const context = await call('getComposerContext', { workspaceId: project.projects[0].id });
    if (context.mentions.some((candidate) => candidate.path === coachPath))
      throw new Error('任务本地技能泄漏到了其他项目。');
    report({ ok: true, standaloneSkillDiscoveryVerified: true, projectIsolationVerified: true });
    await host.stop();
    await gateway.close();
    removeE2EHome(home);
    removeE2EHome(workspace);
    app.exit(0);
  } catch (error) {
    console.error(error);
    await host?.stop().catch(() => {});
    await gateway.close().catch(() => {});
    app.exit(1);
  }
}
void run();
