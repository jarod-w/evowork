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
 * ③ **内核知不知道这个模型的上下文有多大**。内核不认识我们的任何模型，不给它一份
 *    `model_catalog_json` 就会对**每一个**模型套用兜底的 272k，而压缩是按它的 95% 提前触发的
 *    —— GLM 只有 128k，于是压缩永远等不到、厂商先拒。断言写在这条 E2E 里的理由是：
 *    目录**加载失败会让所有任务起不来**（第一版就是 `thread/start -32600`），
 *    而"加载成功但没被用上"是静默的，只有内核自己说得清。
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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { app } from 'electron';

import { bootApp, createE2EHome, writeKernelConfig } from './harness/boot.mjs';
import { createRunner, waitFor } from './harness/runner.mjs';

const { stage, report } = createRunner({
  stagePrefix: '__EVOWORK_AGENT_LOOP_STAGE__',
  resultPrefix: '__EVOWORK_AGENT_LOOP__',
});

const repoRoot = process.env.EVOWORK_E2E_REPO_ROOT;
const appServerPath = process.env.EVOWORK_APP_SERVER;
const apiKey = process.env.EVOWORK_AGENT_LOOP_KEY;
const modelId = process.env.EVOWORK_AGENT_LOOP_MODEL ?? 'evowork/kimi-k3';
const keyEnvName = process.env.EVOWORK_AGENT_LOOP_KEY_ENV ?? 'MOONSHOT_API_KEY';
if (!repoRoot || !appServerPath) throw new Error('缺少仓库或 app-server 路径。');
if (!apiKey) throw new Error('没有密钥就跑不了真模型（EVOWORK_AGENT_LOOP_KEY）。');

const { home, workspace, kernelHome } = createE2EHome('evowork-agent-loop-');

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
      250,
    );
    stage('gateway-ready');

    writeKernelConfig(
      kernelHome,
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

    /*
     * 这条**不传** `captureKernelProcess`：它会给宿主注入 spawnFn，而那会把端口上
     * 残留网关的回收换成「不扫描」（service-host.ts:1124）。这里起的是**真网关**，
     * 那个行为不能动。杀内核也只有 `skill-reference` 需要。
     */
    const desktop = await bootApp({
      repoRoot,
      appServerPath,
      home,
      hostEnv: {
        EVOWORK_GATEWAY_TOKEN: GATEWAY_TOKEN,
        EVOWORK_GATEWAY_URL: gatewayBaseUrl,
      },
      preloadTimeoutMs: 60_000,
    });
    host = desktop.host;
    const evaluate = desktop.evaluate;
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
    await waitFor(async () => (await turnsDone(threadId)) >= 1, '第一轮没跑完', 180_000, 250);
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
    await waitFor(async () => (await turnsDone(threadId)) >= 2, '第二轮没跑完', 180_000, 250);
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

    /*
     * ③ 内核真的用上了我们给的上下文大小吗。
     *
     * **这一条读了内核的 sqlite 日志，是 K2 的一次破例，所以写清楚为什么：**
     *   · 要证伪的是"目录加载成功、但内核仍然按兜底的 272k 对待我们的模型"
     *     （典型成因：slug 写得与我们发出去的 modelId 不一致）。这件事**只有内核知道**，
     *     它唯一说出来的地方就是那句 `Unknown model … fallback model metadata`。
     *   · 协议里其实有更干净的信号（`ThreadTokenUsage.model_context_window`），
     *     但它到适配层就停了（渲染层没有落点，`renderer-bridge` 的 default 分支丢掉）。
     *     哪天 token 用量接到 UI 上，这条断言就该换成那个信号。
     *   · 破例**只在这个 spec 里**，不进 harness：共享工具一旦提供"读内核内部"的访问器，
     *     下一个人就不必再写理由了（eslint 那条规则匹配的是 rollout / memories / thread_store，
     *     `logs_*.sqlite` 不在其中，所以这里也没有 inline disable 可写 —— 只能写清楚）。
     */
    const logFile = readdirSync(kernelHome).find((name) => /^logs_\d+\.sqlite$/.test(name));
    if (!logFile) throw new Error('没找到内核日志，这条断言无从谈起。');
    const db = new DatabaseSync(join(kernelHome, logFile), { readOnly: true });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM logs').get();
    const unknown = db
      .prepare(
        "SELECT COUNT(*) AS n FROM logs WHERE feedback_log_body LIKE '%Unknown model evowork/%'",
      )
      .get();
    db.close();
    // 读不到日志就**失败**，不要因为"查出来是 0"而假绿
    if (Number(rows?.n ?? 0) === 0) throw new Error('内核日志是空的，这条断言无从谈起。');
    if (Number(unknown?.n ?? 0) > 0) {
      throw new Error(
        `内核仍然不认识我们的模型（${unknown.n} 条 Unknown model evowork/…）——` +
          '模型目录要么没被加载，要么 slug 与我们发出去的 modelId 对不上。',
      );
    }
    /*
     * 判别力是实测过的：同一条查询在**加目录之前**那次运行的日志上返回 4，
     * 之后几次都是 0（2026-09-26）。所以它不是一条"永远为真"的断言。
     */
    stage(`model-catalog-verified logRows=${Number(rows?.n ?? 0)}`);

    report({
      ok: true,
      model: modelId,
      toolCalls,
      reasoningItems,
      approvals: await evaluate('window.__e2eApproved'),
      degraded: gatewayLog.includes('"degraded":true'),
    });
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
