/**
 * **一次附上多个文件，用真模型跑一遍。**
 *
 * 它要证伪的是三条**不会报错**的断言：
 *
 * ① **多选真的整批进了管道**。宿主原来一个一个地调 `ingest`，数量闸门每次只看到 1 个；
 *    单测能证明宿主现在整批交出去，证明不了真 Electron 的多选框 → IPC → 宿主这一路也是整批。
 *    所以这里走的是 `pickAttachments`（系统文件框），不是拖拽那条。
 *
 * ② **文档里嵌的图真的到了模型眼前**。docx / pptx 的图由 `office.py` 抽到 `assets/`，
 *    再作为 `localImage` 挂进 `turn/start`。抽漏、挂错类型、网关丢图，任何一环断了
 *    都不报错 —— 模型只是"没看到"，然后照着文字编。所以要问一个**只在像素里**的数
 *    （饼图里企业客户的 45%），而幻灯片文字里放了一个会误导的 50%。
 *
 * ③ **五个文件在同一轮里都被读到**。每个文件藏一个只有它才有的事实，答案要五条都对。
 *
 * 输入由 `harness/make-office-fixtures.py` 当场生成（要办公扩展的 python：它带着
 * python-docx / python-pptx / matplotlib 与中文字体）。
 *
 * 跑法（密钥只经环境变量进子进程，不写盘、不进日志、不提交）：
 *   EVOWORK_AGENT_LOOP_KEY=sk-... EVOWORK_AGENT_LOOP_MODEL=evowork/deepseek-flash \
 *     EVOWORK_AGENT_LOOP_KEY_ENV=DEEPSEEK_API_KEY \
 *     node scripts/verify-agent-loop.mjs --spec multi-attachment
 */
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { app } from 'electron';

import { bootApp, createE2EHome, writeKernelConfig } from './harness/boot.mjs';
import { createRunner, removeE2EHome, waitFor } from './harness/runner.mjs';

const { stage, report } = createRunner({
  stagePrefix: '__EVOWORK_AGENT_LOOP_STAGE__',
  resultPrefix: '__EVOWORK_AGENT_LOOP__',
});

const repoRoot = process.env.EVOWORK_E2E_REPO_ROOT;
const appServerPath = process.env.EVOWORK_APP_SERVER;
const apiKey = process.env.EVOWORK_AGENT_LOOP_KEY;
const modelId = process.env.EVOWORK_AGENT_LOOP_MODEL ?? 'evowork/deepseek-flash';
const keyEnvName = process.env.EVOWORK_AGENT_LOOP_KEY_ENV ?? 'DEEPSEEK_API_KEY';
if (!repoRoot || !appServerPath) throw new Error('缺少仓库或 app-server 路径。');
if (!apiKey) throw new Error('没有密钥就跑不了真模型（EVOWORK_AGENT_LOOP_KEY）。');

/*
 * 临时 home 下没有办公扩展，探测会判「没装」，docx / pptx 就只剩「以原文件引用」——
 * 那条路径另有单测，这里要验的是装了之后。没装就**失败**并说清，不退化成只测 csv。
 */
const officePython =
  process.env.EVOWORK_OFFICE_PYTHON ?? join(homedir(), '.evowork/runtime/office/bin/python3');
if (!existsSync(officePython)) {
  throw new Error(
    `找不到办公扩展的 python：${officePython}。先在 App 里安装，或设 EVOWORK_OFFICE_PYTHON。`,
  );
}
process.env.EVOWORK_OFFICE_PYTHON = officePython;

const GATEWAY_TOKEN = 'multi-attachment-token';

/** 每个文件一个只有它才有的事实（见 make-office-fixtures.py 的文件头） */
const FACTS = [
  { file: '上半年销售报告.docx', needle: /915/, what: 'docx 正文里的累计销售额' },
  { file: 'Q3市场计划.pptx', needle: /45\s*%/, what: 'pptx 饼图（只在图里）里的企业客户占比' },
  { file: '市场预算.xlsx', needle: /80/, what: 'xlsx 预算合计' },
  {
    file: '渠道名单.csv',
    needle: /星河科技[\s\S]*云帆数据|云帆数据[\s\S]*星河科技/,
    what: 'csv 渠道名',
  },
  { file: '走势图.png', needle: /成本/, what: 'png 图例' },
];

function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function run() {
  const { home, workspace, kernelHome } = createE2EHome('evowork-multi-attachment-');
  let host;
  let gateway;
  try {
    const fixtures = join(home, 'fixtures');
    mkdirSync(fixtures, { recursive: true });
    execFileSync(officePython, [
      join(repoRoot, 'apps/desktop/test/e2e/harness/make-office-fixtures.py'),
      fixtures,
    ]);
    const picked = FACTS.map((fact) => join(fixtures, fact.file));
    for (const path of picked) if (!existsSync(path)) throw new Error(`没生成出 ${path}`);
    stage(`fixtures-ready count=${picked.length}`);

    const gatewayPort = await reservePort();
    gateway = spawn(process.execPath, [join(repoRoot, 'dist/gateway/main.js')], {
      env: {
        ...process.env,
        PORT: String(gatewayPort),
        HOST: '127.0.0.1',
        [keyEnvName]: apiKey,
        EVOWORK_GATEWAY_TOKENS: GATEWAY_TOKEN,
        LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let gatewayLog = '';
    gateway.stdout.on('data', (chunk) => {
      gatewayLog += chunk.toString();
    });
    gateway.stderr.on('data', (chunk) => {
      gatewayLog += chunk.toString();
    });
    const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}/v1`;
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${gatewayPort}/healthz`)).ok,
      `网关没起来：${gatewayLog.slice(-500)}`,
      20_000,
      250,
    );
    stage('gateway-ready');

    // 根键写在第一个表头之前（理由见 agent-loop.e2e.mjs 同一段）
    writeKernelConfig(
      kernelHome,
      `model_provider = "evowork"
default_permissions = "evowork-workspace"
approval_policy = "on-request"

[model_providers.evowork]
name = "Multi Attachment Gateway"
base_url = "${gatewayBaseUrl}"
wire_api = "responses"
env_key = "EVOWORK_GATEWAY_TOKEN"
stream_max_retries = 2

[permissions.evowork-workspace]
extends = ":workspace"

[otel]
environment = "test"
exporter = "none"
`,
    );

    const desktop = await bootApp({
      repoRoot,
      appServerPath,
      home,
      hostEnv: {
        EVOWORK_GATEWAY_TOKEN: GATEWAY_TOKEN,
        EVOWORK_GATEWAY_URL: gatewayBaseUrl,
      },
      preloadTimeoutMs: 60_000,
      // 系统文件框：用户多选了这五个。只有 `openFile + multiSelections` 这一种调用会拿到它们
      showOpenDialog: async (options) => {
        const props = options?.properties ?? [];
        return props.includes('multiSelections')
          ? { canceled: false, filePaths: picked }
          : { canceled: true, filePaths: [] };
      },
    });
    host = desktop.host;
    const evaluate = desktop.evaluate;
    await evaluate(
      `window.__e2eEvents = [];
       window.evowork.onUiEvent((event) => window.__e2eEvents.push(event));
       window.evowork.onPendingApprovals((list) => {
         for (const item of list) void window.evowork.decideApproval({ id: item.id, decision: 'accept' });
       });
       true`,
    );
    stage('preload-ready');

    const project = await evaluate(
      `window.evowork.createProject(${JSON.stringify({ name: 'MultiAttachment', path: workspace })})`,
    );
    const workspaceId = project.projects[0]?.id;
    if (!workspaceId) throw new Error('没能创建测试项目。');

    // ① 走系统多选框那条路
    const attachments = await evaluate(
      `window.evowork.pickAttachments(${JSON.stringify({ workspaceId })})`,
    );
    const notReady = attachments.filter((a) => a.state !== 'ready');
    if (attachments.length !== picked.length || notReady.length > 0) {
      throw new Error(`附件没有全部就绪：${JSON.stringify(attachments, null, 2)}`);
    }
    const uploads = readdirSync(join(workspace, 'uploads'));
    if (uploads.length !== picked.length) {
      throw new Error(`uploads/ 下应有 ${picked.length} 个目录，实际 ${uploads.length}`);
    }
    const references = attachments.flatMap((a) => a.references);
    const embeddedImages = references.filter(
      (r) => r.type === 'localImage' && r.path.includes('/assets/'),
    );
    // docx 两张 + pptx 两张。少了就是抽图那一步断了，后面问模型已经没有意义
    if (embeddedImages.length !== 4) {
      throw new Error(`文档里嵌的图应抽出 4 张，实际 ${embeddedImages.length}`);
    }
    const nonImage = references.filter(
      (r) => r.type === 'localImage' && !/\.(png|jpe?g|gif|webp|bmp)$/i.test(r.path),
    );
    if (nonImage.length > 0) {
      throw new Error(`不是图片的文件被当成 localImage 发出去了：${JSON.stringify(nonImage)}`);
    }
    stage(`attachments-ready files=${attachments.length} embeddedImages=${embeddedImages.length}`);

    // ② ③ 同一轮里五个文件都要用上
    const task = await evaluate(
      `window.evowork.send(${JSON.stringify({
        text:
          '我附上了五个文件。请逐条回答，每条一行，只写答案：\n' +
          '1. 销售报告里上半年销售额累计多少万元？\n' +
          '2. Q3 市场计划 PPT「客户结构」那页的饼图里，企业客户**目前**占比多少？（看图，不是目标值）\n' +
          '3. 市场预算表里 Q3 预算三项合计多少万元？\n' +
          '4. 渠道名单里有哪几个渠道？\n' +
          '5. 走势图.png 里画了哪两条线？',
        scenarioId: 'code',
        modelId,
        modeId: 'request-approval',
        workspaceId,
        references,
      })})`,
    );
    const threadId = task.threadId;
    if (!threadId) throw new Error('没有建出任务。');
    const events = (type) =>
      evaluate(
        `JSON.stringify(window.__e2eEvents.filter((e) => e.type === ${JSON.stringify(type)} && e.taskId === ${JSON.stringify(threadId)}))`,
      );
    await waitFor(
      async () =>
        (await events('turn-completed')) !== '[]' || (await events('turn-failed')) !== '[]',
      '这一轮没跑完',
      300_000,
      500,
    );
    const failed = await events('turn-failed');
    if (failed !== '[]') throw new Error(`这一轮失败了：${failed}`);

    // 流式期间同一条消息会以 item 事件推多次，取最后一次（完整的那条）
    const answer = await evaluate(
      `window.__e2eEvents.filter((e) => e.type === 'item' && e.taskId === ${JSON.stringify(threadId)} && e.item.type === 'agentMessage').map((e) => e.item.text ?? '').at(-1) ?? ''`,
    );
    const missed = FACTS.filter((fact) => !fact.needle.test(answer));
    const toolCalls = await evaluate(
      `window.__e2eEvents.filter((e) => e.type === 'item' && e.taskId === ${JSON.stringify(threadId)} && e.item.type === 'commandExecution').length`,
    );
    stage(`answer toolCalls=${toolCalls}\n${answer}`);
    if (missed.length > 0) {
      throw new Error(
        `模型没答出：${missed.map((fact) => `${fact.what}（${fact.file}）`).join('、')}`,
      );
    }

    report({
      ok: true,
      model: modelId,
      files: attachments.length,
      embeddedImages: embeddedImages.length,
      toolCalls,
      degraded: gatewayLog.includes('"degraded":true'),
    });
    await host.stop();
    gateway.kill();
    // 通过才清理；失败时留着 home，那是排查唯一的依据
    removeE2EHome(home);
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(`E2E home 保留在：${home}`);
    if (host) await host.stop().catch(() => undefined);
    gateway?.kill();
    app.exit(1);
  }
}

void run();
