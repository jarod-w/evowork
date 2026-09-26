/**
 * **整条智能体回路，用真模型跑一遍。**
 *
 * 在这之前，这条回路的每一段都有测试、**合起来没人跑过**：
 *   内核 → 我们的网关 → 真厂商 → 工具调用 → 内核执行 → 结果回传 → 下一轮。
 * 而今天修掉的缺陷里有三个都是"两个模块各自都对、合起来不对"（CLAUDE.md §9.1）。
 *
 * 它要证伪的是两条**不会报错**的断言：
 *
 * ① **工具结果回得去吗**（`to-chat.ts` 坑 1）。`function_call_output` 要变成
 *    `role: "tool"` 且 `tool_call_id` 对得上。对不上时模型看不见工具结果，
 *    于是**反复调用同一个工具** —— 界面上像"模型有点笨"，不报错、不失败、token 一直烧。
 *    所以断言不是"发出去了"，是**文件真的落盘了，而且模型把读回来的内容说了出来**。
 *
 * ② **思维链回得去吗**（坑 4）。DeepSeek / Kimi / GLM 的 thinking 模式要求把上一轮的
 *    `reasoning_content` 原样挂回 assistant 消息，丢了就是 400
 *    `The reasoning_content in the thinking mode must be passed back to the API.`
 *    —— 而且是**第二轮**才失败。所以这里一定要跑两轮，且第二轮必须在同一个任务里。
 *
 * 跑法（密钥只经环境变量进子进程，不写盘、不进日志、不提交）：
 *   EVOWORK_AGENT_LOOP_KEY=sk-... node scripts/verify-agent-loop.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { bootstrap, createServiceHost } from '../../dist/main/bootstrap.bundle.js';

function stage(message) {
  process.stdout.write(`__EVOWORK_AGENT_LOOP_STAGE__${message}\n`);
}

const repoRoot = process.env.EVOWORK_E2E_REPO_ROOT;
const appServerPath = process.env.EVOWORK_APP_SERVER;
const apiKey = process.env.EVOWORK_AGENT_LOOP_KEY;
const modelId = process.env.EVOWORK_AGENT_LOOP_MODEL ?? 'evowork/kimi-k3';
const keyEnvName = process.env.EVOWORK_AGENT_LOOP_KEY_ENV ?? 'MOONSHOT_API_KEY';
if (!repoRoot || !appServerPath) throw new Error('缺少仓库或 app-server 路径。');
if (!apiKey) throw new Error('没有密钥就跑不了真模型（EVOWORK_AGENT_LOOP_KEY）。');

const e2eHome = mkdtempSync(join(tmpdir(), 'evowork-agent-loop-'));
const workspace = join(e2eHome, 'workspace');
mkdirSync(workspace, { recursive: true });

const GATEWAY_TOKEN = 'agent-loop-token';
const TARGET_FILE = 'hello.txt';
const FIRST_CONTENT = 'EVOWORK-OK';
const SECOND_CONTENT = 'EVOWORK-OK-2';

/** 先占一个端口再让出来：网关从 PORT 读端口，而它不会把自己选的端口说出来。 */
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

function waitFor(check, message, timeoutMs = 60_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const value = await check();
        if (value) return resolve(value);
      } catch {
        // 内核重启与窗口导航都有短暂空窗
      }
      if (Date.now() - started >= timeoutMs) return reject(new Error(message));
      setTimeout(poll, 250);
    };
    void poll();
  });
}

async function run() {
  let host;
  let gateway;
  try {
    const gatewayPort = await reservePort();
    /*
     * **真网关**，不是假的 —— 这条测试的全部意义就在于让请求真的穿过
     * `translate/to-chat.ts` 与 `translate/from-chat.ts`。
     * 密钥只出现在这个子进程的环境里。
     */
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
    );
    stage('gateway-ready');

    const kernelHome = join(e2eHome, '.evowork', 'kernel');
    mkdirSync(kernelHome, { recursive: true });
    writeFileSync(
      join(kernelHome, 'config.toml'),
      `model_provider = "evowork"

[model_providers.evowork]
name = "Agent Loop Gateway"
base_url = "${gatewayBaseUrl}"
wire_api = "responses"
env_key = "EVOWORK_GATEWAY_TOKEN"
stream_max_retries = 2

[permissions.evowork-workspace]
extends = ":workspace"

default_permissions = "evowork-workspace"
approval_policy = "on-request"

[otel]
environment = "test"
exporter = "none"
`,
    );

    const result = await bootstrap({
      electron: {
        app: {
          whenReady: () => app.whenReady(),
          on: (event, handler) => app.on(event, handler),
          quit: () => app.quit(),
          getVersion: () => app.getVersion(),
          getPath: () => e2eHome,
        },
        createWindow: (options) => new BrowserWindow({ ...options, show: false }),
        ipcMain: { handle: (channel, handler) => ipcMain.handle(channel, handler) },
        openExternal: async () => undefined,
      },
      appServerPath,
      configDir: join(repoRoot, 'config'),
      pluginsDir: join(repoRoot, 'plugins'),
      preloadPath: join(repoRoot, 'apps/desktop/dist/preload/index.bundle.cjs'),
      rendererHtmlPath: join(repoRoot, 'apps/desktop/dist/renderer/index.html'),
      createHost: (options) =>
        createServiceHost({
          ...options,
          env: {
            ...process.env,
            EVOWORK_GATEWAY_TOKEN: GATEWAY_TOKEN,
            EVOWORK_GATEWAY_URL: gatewayBaseUrl,
          },
        }),
    });
    host = result.host;
    const window = result.window;
    const evaluate = (source) => window.webContents.executeJavaScript(source, true);
    await waitFor(() => evaluate('Boolean(window.evowork)'), 'preload bridge 没有加载');
    /*
     * 审批一律自动通过。这条测试测的是**回路**，不是审批 ——
     * 审批本身另有一条测试（`skill-reference.e2e.mjs` 的命令 / 文件改动两张卡）。
     */
    await evaluate(
      `window.__e2eEvents = [];
       window.evowork.onUiEvent((event) => window.__e2eEvents.push(event));
       window.__e2eApproved = 0;
       window.evowork.onPendingApprovals((list) => {
         for (const item of list) {
           window.__e2eApproved += 1;
           void window.evowork.decideApproval({ id: item.id, decision: 'accept' });
         }
       });
       true`,
    );
    stage('preload-ready');

    const project = await evaluate(
      `window.evowork.createProject(${JSON.stringify({ name: 'AgentLoop', path: workspace })})`,
    );
    const workspaceId = project.projects[0]?.id;
    if (!workspaceId) throw new Error('没能创建测试项目。');

    const send = (text, threadId) =>
      evaluate(
        `window.evowork.send(${JSON.stringify({
          text,
          scenarioId: 'code',
          modelId,
          modeId: 'request-approval',
          workspaceId,
          ...(threadId ? { threadId } : {}),
        })})`,
      );
    const turnsDone = (threadId) =>
      evaluate(
        `window.__e2eEvents.filter((event) => event.type === 'turn-completed' && event.taskId === ${JSON.stringify(threadId)}).length`,
      );
    const failures = (threadId) =>
      evaluate(
        `JSON.stringify(window.__e2eEvents.filter((event) => event.type === 'turn-failed' && event.taskId === ${JSON.stringify(threadId)}))`,
      );

    // ── 第一轮：必须动手（写文件）+ 必须读回来（工具结果要进得了上下文）──
    const task = await send(
      `在当前工作目录下新建文件 ${TARGET_FILE}，内容写成 ${FIRST_CONTENT}（不要有多余字符），` +
        `然后把这个文件读回来，把你读到的内容原样告诉我。`,
    );
    const threadId = task.threadId;
    if (!threadId) throw new Error('第一轮没有建出任务。');
    await waitFor(async () => (await turnsDone(threadId)) >= 1, '第一轮没跑完', 180_000);
    const firstFailures = await failures(threadId);
    if (firstFailures !== '[]') throw new Error(`第一轮失败了：${firstFailures}`);

    const target = join(workspace, TARGET_FILE);
    if (!existsSync(target)) {
      throw new Error('模型没有真的写出文件 —— 工具调用这条链路没有走通。');
    }
    const written = readFileSync(target, 'utf8').trim();
    if (!written.includes(FIRST_CONTENT)) {
      throw new Error(`文件内容不对：${JSON.stringify(written)}`);
    }
    /*
     * **这一条才是坑 1 的证伪点。**
     *
     * 文件写出来只证明"工具被调用了"；模型能把**读回来的内容说出来**，才证明
     * `function_call_output` 真的变成了它看得见的 `role: "tool"` 消息。
     * 对不上时的典型表现是：模型反复调用同一个工具，或者开始编内容。
     */
    const firstAnswer = await evaluate(
      `JSON.stringify(window.__e2eEvents.filter((e) => e.type === 'item' && e.taskId === ${JSON.stringify(threadId)} && e.item.type === 'agentMessage').map((e) => e.item.text ?? ''))`,
    );
    if (!firstAnswer.includes(FIRST_CONTENT)) {
      throw new Error(`模型没把读到的内容说出来（工具结果可能根本没进上下文）：${firstAnswer}`);
    }
    const toolCalls = await evaluate(
      `window.__e2eEvents.filter((e) => e.type === 'item' && e.item.type === 'commandExecution').length`,
    );
    stage(
      `first-turn-verified tools=${toolCalls} approvals=${await evaluate('window.__e2eApproved')}`,
    );

    // ── 第二轮：同一个任务里再来一次，专门撞思维链回传 ──
    await send(`把 ${TARGET_FILE} 的内容改成 ${SECOND_CONTENT}，改完再读一次确认。`, threadId);
    await waitFor(async () => (await turnsDone(threadId)) >= 2, '第二轮没跑完', 180_000);
    const secondFailures = await failures(threadId);
    if (secondFailures !== '[]') {
      /*
       * 第二轮才失败，最常见的原因就是上一轮的 `reasoning_content` 没挂回去 ——
       * 厂商会回 400 并明说这件事。把原文带出来，别让它变成一句"第二轮失败了"。
       */
      throw new Error(`第二轮失败了（思维链回传是第一嫌疑）：${secondFailures}`);
    }
    const updated = readFileSync(target, 'utf8').trim();
    if (!updated.includes(SECOND_CONTENT)) {
      throw new Error(`第二轮没有改到文件：${JSON.stringify(updated)}`);
    }
    const reasoningItems = await evaluate(
      `window.__e2eEvents.filter((e) => e.type === 'item' && e.item.type === 'reasoning').length`,
    );
    stage(`second-turn-verified reasoning=${reasoningItems}`);

    process.stdout.write(
      `__EVOWORK_AGENT_LOOP__${JSON.stringify({
        ok: true,
        model: modelId,
        toolCalls,
        reasoningItems,
        approvals: await evaluate('window.__e2eApproved'),
        degraded: gatewayLog.includes('"degraded":true'),
      })}\n`,
    );
    await host.stop();
    gateway.kill();
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (host) await host.stop().catch(() => undefined);
    gateway?.kill();
    app.exit(1);
  }
}

void run();
