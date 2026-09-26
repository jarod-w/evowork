import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { bootstrap, createServiceHost } from '../../dist/main/bootstrap.bundle.js';
import { seedMemorySummary } from '../../../../services/kernel-adapter/test-support/memory-fixture.mjs';

function stage(message) {
  process.stdout.write(`__EVOWORK_DESKTOP_E2E_STAGE__${message}\n`);
}

stage('module-loaded');

const repoRoot = process.env.EVOWORK_E2E_REPO_ROOT;
const appServerPath = process.env.EVOWORK_APP_SERVER;
if (!repoRoot || !appServerPath) throw new Error('桌面 E2E 缺少仓库或 app-server 路径。');

const e2eHome = mkdtempSync(join(tmpdir(), 'evowork-desktop-e2e-'));
const workspace = join(e2eHome, 'workspace');
mkdirSync(workspace, { recursive: true });

let heldResponse;
let failUpstream = false;
/**
 * 下一次模型请求怎么答（一次性）。
 *
 * 真模型的行为没法脚本化，而「停止 / 插话 / 追问」这三条链路都要求模型在**特定时刻**
 * 做特定的事。所以由测试逐次指定："这一次把流挂住"、"这一次调这个工具"。
 * 用完即清，后面的请求回到默认的"正常回一句话"。
 */
let nextScript;
/** 被挂住的那条响应；收尾时要放行，不然进程退不掉 */
let releaseHeld;
let responseCount = 0;
const responseBodies = [];
const gateway = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/v1/evowork/models') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        data: [
          {
            id: 'e2e-model',
            displayName: 'E2E Model',
            provider: 'private',
            upstreamModel: 'e2e-model',
            tier: 'standard',
            capabilities: {
              streaming: true,
              toolCalls: true,
              parallelToolCalls: true,
              reasoning: false,
              promptCache: false,
              imageInput: false,
              maxContextTokens: 32_000,
            },
            verified: true,
            verifiedAt: '2026-09-25',
            unverified: [],
            notes: 'desktop e2e',
            notices: [],
            credentialSource: 'private',
            layer: 'custom',
          },
        ],
      }),
    );
    return;
  }
  if (request.method !== 'POST' || url.pathname !== '/v1/responses') {
    response.writeHead(404).end();
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    responseBodies.push(Buffer.concat(chunks).toString('utf8'));
    responseCount += 1;
    const currentResponse = responseCount;
    if (nextScript) {
      const script = nextScript;
      nextScript = undefined;
      const id = `resp_${currentResponse}`;
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      });
      sendEvent(response, { type: 'response.created', response: { id } });
      if (script.kind === 'hold') {
        // 回一句话就**挂着不收尾** —— 回合会一直"在跑"，正好用来点停止 / 插话
        sendEvent(response, {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: `msg_${currentResponse}`, role: 'assistant', content: [] },
        });
        sendEvent(response, {
          type: 'response.output_text.delta',
          item_id: `msg_${currentResponse}`,
          output_index: 0,
          content_index: 0,
          delta: '正在写……',
        });
        releaseHeld = () => {
          sendEvent(response, {
            type: 'response.completed',
            response: { id, end_turn: true },
          });
          response.end('data: [DONE]\n\n');
          releaseHeld = undefined;
        };
        return;
      }
      // 工具调用：`output_item.done` 里给一个 function_call，内核会去执行它
      sendEvent(response, {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          id: `fc_${currentResponse}`,
          name: script.tool,
          arguments: JSON.stringify(script.args),
          call_id: `call_${currentResponse}`,
        },
      });
      // `end_turn: false`：工具调用之后回合还要继续
      sendEvent(response, { type: 'response.completed', response: { id, end_turn: false } });
      response.end('data: [DONE]\n\n');
      return;
    }
    if (failUpstream) {
      /*
       * 「上游断了」的样子：HTTP 200 + 流里一条 `response.failed`。
       * `upstream_disconnected` 是内核**认不出来**的 code，因此落到 `Retryable{message}`
       * （F32）—— 内核会退避重试，并在重试用完后把这条 message 显示给用户。
       */
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      });
      sendEvent(response, {
        type: 'response.created',
        response: { id: `resp_${currentResponse}` },
      });
      sendEvent(response, {
        type: 'response.failed',
        response: {
          id: `resp_${currentResponse}`,
          error: {
            code: 'upstream_disconnected',
            message: '与模型服务的连接中断，重试多次仍未成功。',
          },
        },
      });
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const id = `resp_${currentResponse}`;
    const itemId = `msg_${currentResponse}`;
    /*
     * 心跳帧（F30）。真网关在"活着但没东西可发"时会往流里塞它，靠它让内核那个
     * 300 秒的空闲计时器重来（F31）。这里把它混进 E2E 的假网关，是为了让
     * **真内核**替我们证明两件事：① 它不会因为这个类型报错 ② 它不会把它变成
     * 时间线上的一条 item（下面那些对话断言就是证据）。
     * 读源码只能读到"它在忽略清单里"，这条才是实测。
     */
    sendEvent(response, { type: 'response.in_progress', response: { id } });
    sendEvent(response, { type: 'response.created', response: { id } });
    sendEvent(response, { type: 'response.in_progress', response: { id } });
    sendEvent(response, {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: itemId, role: 'assistant', content: [] },
    });
    sendEvent(response, {
      type: 'response.output_text.delta',
      item_id: itemId,
      output_index: 0,
      content_index: 0,
      delta: `E2E response ${currentResponse}`,
    });
    const finish = () => {
      sendEvent(response, { type: 'response.in_progress', response: { id } });
      sendEvent(response, {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: itemId,
          role: 'assistant',
          content: [{ type: 'output_text', text: `E2E response ${currentResponse}` }],
        },
      });
      sendEvent(response, { type: 'response.completed', response: { id, end_turn: true } });
      response.end('data: [DONE]\n\n');
    };
    if (currentResponse === 1) heldResponse = finish;
    else finish();
  });
});

function sendEvent(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen(server.address().port));
  });
}

function waitFor(check, message, timeoutMs = 15_000) {
  const started = Date.now();
  return new Promise((resolveWait, reject) => {
    const poll = async () => {
      try {
        const value = await check();
        if (value) return resolveWait(value);
      } catch {
        // Renderer navigation and kernel restart both have short expected gaps.
      }
      if (Date.now() - started >= timeoutMs) return reject(new Error(message));
      setTimeout(poll, 50);
    };
    void poll();
  });
}

let host;
async function run() {
  try {
    stage('gateway-starting');
    const gatewayPort = await listen(gateway);
    const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}/v1`;
    const kernelHome = join(e2eHome, '.evowork', 'kernel');
    mkdirSync(kernelHome, { recursive: true });
    // 单独成段，既清楚表达这是协议配置，也避免边界 lint 把同一模板里的 URL 误判成记忆目录。
    const memoryConfig = `[features]
memories = true

[memories]
use_memories = true
generate_memories = true
disable_on_external_context = true`;
    writeFileSync(
      join(kernelHome, 'config.toml'),
      `model_provider = "evowork"

[model_providers.evowork]
name = "E2E Gateway"
base_url = "${gatewayBaseUrl}"
wire_api = "responses"
env_key = "EVOWORK_GATEWAY_TOKEN"

[permissions.evowork-workspace]
extends = ":workspace"

default_permissions = "evowork-workspace"
approval_policy = "never"

${memoryConfig}

[otel]
environment = "test"
exporter = "none"
`,
    );

    let kernelChild;
    stage('bootstrap-starting');
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
            EVOWORK_GATEWAY_TOKEN: 'e2e-token',
            EVOWORK_GATEWAY_URL: gatewayBaseUrl,
          },
          spawnFn: (command, args, spawnOptions) => {
            const child = spawn(command, args, spawnOptions);
            if (command === appServerPath) kernelChild = child;
            return child;
          },
        }),
    });
    stage('bootstrap-complete');
    host = result.host;
    const window = result.window;
    const evaluate = (source) => window.webContents.executeJavaScript(source, true);
    await waitFor(() => evaluate('Boolean(window.evowork)'), 'preload bridge 没有加载');
    stage('preload-ready');
    await evaluate(`
    window.__e2eEvents = [];
    window.__e2eNotices = [];
    window.evowork.onUiEvent((event) => window.__e2eEvents.push(event));
    window.evowork.onNotice((notice) => window.__e2eNotices.push(notice));
    true;
  `);

    const initialMemory = await evaluate('window.evowork.getMemorySettings()');
    if (
      !initialMemory.enabled ||
      initialMemory.version !== 'v1' ||
      initialMemory.statusSupported ||
      !initialMemory.useMemories ||
      !initialMemory.generateMemories ||
      !initialMemory.disableOnExternalContext
    ) {
      throw new Error(`真实 app-server 没有读到默认记忆设置：${JSON.stringify(initialMemory)}`);
    }
    const disabledMemory = await evaluate(
      `window.evowork.setMemorySettings(${JSON.stringify({
        enabled: true,
        useMemories: true,
        generateMemories: false,
      })})`,
    );
    if (!disabledMemory.ok || disabledMemory.view.generateMemories) {
      throw new Error('真实 app-server 没有保存记忆生成开关。');
    }
    stage('memory-settings-verified');

    // 只在测试里写入内核 fixture；生产代码仍只经 app-server 读取和控制记忆。
    const memoryMarker = 'EVOWORK_MEMORY_P1_MARKER';
    seedMemorySummary(kernelHome, memoryMarker);

    const project = await evaluate(
      `window.evowork.createProject(${JSON.stringify({ name: 'E2E', path: workspace })})`,
    );
    stage('project-created');
    if (!project.ok || !project.projects[0]?.id) throw new Error('真实窗口没能创建测试项目。');
    const workspaceId = project.projects[0].id;
    const context = await evaluate(
      `window.evowork.getComposerContext(${JSON.stringify({ workspaceId })})`,
    );
    const skill = context.mentions.find(
      (candidate) => candidate.category === 'skill' && candidate.name === 'skill-creator',
    );
    if (!skill?.path) throw new Error('真实 app-server 没有发现随包 skill-creator。');
    stage('skill-discovered');
    const reference = { type: 'skill', name: skill.name, path: skill.path };
    const first = await evaluate(
      `window.evowork.send(${JSON.stringify({
        text: '$skill-creator 创建一个测试技能',
        references: [reference],
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
      })})`,
    );
    await waitFor(() => heldResponse, '模型请求没有到达测试网关');
    stage('first-request-held');
    if (!responseBodies[0]?.includes(memoryMarker)) {
      throw new Error('真实 app-server 没有把本地记忆注入新任务的模型请求。');
    }
    const enabledMemory = await evaluate(
      `window.evowork.setMemorySettings(${JSON.stringify({
        enabled: true,
        useMemories: true,
        generateMemories: true,
        currentThreadId: first.threadId,
      })})`,
    );
    if (!enabledMemory.ok || !enabledMemory.view.generateMemories) {
      throw new Error('真实 app-server 没有重新启用记忆生成。');
    }
    const taskMemoryOff = await evaluate(
      `window.evowork.setTaskMemoryMode(${JSON.stringify({ threadId: first.threadId, enabled: false })})`,
    );
    const taskMemoryOn = await evaluate(
      `window.evowork.setTaskMemoryMode(${JSON.stringify({ threadId: first.threadId, enabled: true })})`,
    );
    if (!taskMemoryOff.ok || !taskMemoryOn.ok) {
      throw new Error('真实 app-server 不支持任务级记忆开关。');
    }
    const resetMemory = await evaluate('window.evowork.resetMemories()');
    if (!resetMemory.ok) throw new Error('真实 app-server 没有清空本地记忆。');
    stage('memory-task-controls-verified');
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-started' && event.taskId === ${JSON.stringify(first.threadId)})`,
        ),
      '首个真实回合没有开始',
    );

    const second = await evaluate(
      `window.evowork.send(${JSON.stringify({
        threadId: first.threadId,
        text: '$skill-creator 排队中的原始要求',
        references: [reference],
        modelId: 'e2e-model',
        modeId: 'request-approval',
      })})`,
    );
    if (!second.queued) throw new Error('运行中的第二条输入没有进入真实内核队列。');
    stage('second-request-queued');
    const queued = await evaluate(
      `window.evowork.listQueuedInputs(${JSON.stringify({ threadId: first.threadId })})`,
    );
    if (queued.length !== 1 || queued[0].references[0]?.path !== skill.path) {
      throw new Error('真实队列没有保留精确技能引用。');
    }
    const editedText = '$skill-creator 排队要求已编辑';
    const updated = await evaluate(
      `window.evowork.updateQueuedInput(${JSON.stringify({
        threadId: first.threadId,
        id: queued[0].id,
        text: editedText,
        references: [reference],
      })})`,
    );
    if (!updated) throw new Error('真实队列编辑失败。');
    const afterEdit = await evaluate(
      `window.evowork.listQueuedInputs(${JSON.stringify({ threadId: first.threadId })})`,
    );
    if (afterEdit[0]?.text !== editedText || afterEdit[0]?.references[0]?.path !== skill.path) {
      throw new Error('队列编辑后文本或技能引用丢失。');
    }

    heldResponse();
    heldResponse = undefined;
    stage('first-request-released');
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.filter((event) => event.type === 'turn-completed' && event.taskId === ${JSON.stringify(first.threadId)}).length >= 2`,
        ),
      '排队回合没有自动执行完成',
      30_000,
    );
    const beforeRestart = await evaluate(
      `window.evowork.openTask(${JSON.stringify({ threadId: first.threadId })})`,
    );
    const beforeRestartText = JSON.stringify(beforeRestart);
    if (!beforeRestartText.includes(editedText) || !beforeRestartText.includes(skill.path)) {
      throw new Error('完成后的真实任务历史没有保留编辑文本和技能引用。');
    }
    /*
     * F30 的实测面：心跳帧（上面假网关发的 `response.in_progress`）**不能**变成
     * 时间线上的条目。内核的状态枚举是 camelCase（`inProgress`），带下划线的
     * `in_progress` 只可能来自那个事件类型本身 —— 出现了就说明忽略清单不再成立，
     * 而那意味着真网关的心跳会在每个任务里刷出一串垃圾条目。
     */
    if (beforeRestartText.includes('in_progress')) {
      throw new Error('心跳帧进了时间线：F30（内核忽略 response.in_progress）已被上游推翻。');
    }
    stage('queue-history-verified');

    const crashedPid = kernelChild?.pid;
    kernelChild?.kill('SIGKILL');
    await waitFor(
      () => evaluate(`window.__e2eNotices.some((notice) => notice.kind === 'kernel-restarted')`),
      '真实 app-server 崩溃后没有自动恢复',
      30_000,
    );
    stage('kernel-restarted');
    const afterRestart = await evaluate(
      `window.evowork.openTask(${JSON.stringify({ threadId: first.threadId })})`,
    );
    const refreshedContext = await evaluate(
      `window.evowork.getComposerContext(${JSON.stringify({ workspaceId })})`,
    );
    const skillAfterRestart = refreshedContext.mentions.find(
      (candidate) => candidate.category === 'skill' && candidate.name === 'skill-creator',
    );
    if (
      !JSON.stringify(afterRestart).includes(editedText) ||
      skillAfterRestart?.path !== skill.path
    ) {
      throw new Error('内核重启后历史或技能根没有恢复。');
    }

    /*
     * ── 上游断了：内核自动重试 + 界面说出来（2026-09-26 的产品决策）──
     *
     * 这一段是**整条链路唯一能被真内核证伪的地方**：
     *   ① 我们发的 `error.code` 真的落进了内核的"可重试"分支（F32），而不是终止；
     *   ② 内核重试时发的 `error` + `willRetry` 真的一路到了渲染层（适配层刚订阅它）；
     *   ③ 重试用完之后，**网关写给用户的那句中文真的显示出来了**
     *      —— 这正是换掉 `server_is_overloaded` 的全部理由（F33）。
     * 读源码能读出前两条的形状，读不出它们串起来是否成立。
     */
    /*
     * ── 协议边界的四条链路（356a93f / 8f20cbb 只对**假内核**验过）──
     *
     * 那几处缺陷的共同点是"假内核收什么都说好"：漏一个必填字段会被真内核
     * 打回 -32600，回复形状不对则**连错都不报**，内核 `unwrap_or_else` 兜一个默认值。
     * 所以这一段全部用真 app-server 跑，而且**断言的是后果**（停下来了没有、
     * 插的话有没有进到模型请求里、答案有没有到工具），不是"发出去了没有"。
     */
    await evaluate(
      `window.__e2eApprovals = []; window.evowork.onPendingApprovals((list) => { window.__e2eApprovals = list; }); true`,
    );

    // ① 停止：`turn/interrupt` 少了 turnId 的话内核只回 -32600，按钮永远点不动
    nextScript = { kind: 'hold' };
    const stopTask = await evaluate(
      `window.evowork.send(${JSON.stringify({
        text: '写一份很长的报告',
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
      })})`,
    );
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-started' && event.taskId === ${JSON.stringify(stopTask.threadId)})`,
        ),
      '回合没有开始，停不了',
      20_000,
    );
    // 真内核**等到 TurnAborted 才应答**这个请求 —— 它能返回本身就是这条链路通了
    await evaluate(`window.evowork.interrupt(${JSON.stringify(stopTask.threadId)})`);
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-completed' && event.taskId === ${JSON.stringify(stopTask.threadId)} && event.status === 'interrupted')`,
        ),
      '「停止」没有真的停下这个回合',
      20_000,
    );
    if (releaseHeld) releaseHeld();
    stage('interrupt-verified');

    // ② 立即插话：`turn/steer` 少了 expectedTurnId 同样是 -32600
    nextScript = { kind: 'hold' };
    const steerTask = await evaluate(
      `window.evowork.send(${JSON.stringify({
        text: '列个提纲',
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
      })})`,
    );
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-started' && event.taskId === ${JSON.stringify(steerTask.threadId)})`,
        ),
      '回合没有开始，插不了话',
      20_000,
    );
    const steerMarker = '插话：只要三条';
    const steerResult = await evaluate(
      `window.evowork.send(${JSON.stringify({
        threadId: steerTask.threadId,
        text: steerMarker,
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
        steer: true,
      })})`,
    );
    if (steerResult?.notes?.length) {
      // 适配层在"没有活动回合"时会改成排队并说明 —— 那说明这条链路没走成
      throw new Error(`立即插话被改成了排队：${JSON.stringify(steerResult.notes)}`);
    }
    if (releaseHeld) releaseHeld();
    await waitFor(
      () => responseBodies.some((body) => body.includes(steerMarker)),
      '插话的内容没有进到模型请求里（expectedTurnId 不对时内核直接打回）',
      20_000,
    );
    stage('steer-verified');

    /*
     * ③ 追问与权限审批：**在产品当前配置下走不到**，所以这里钉住"走不到"这件事。
     *
     * 356a93f 修的两处回复形状（追问按问题 id 归位、权限回 `{permissions, scope}`）
     * 都是对的，但它们伺候的两条链路今天都发不起来：
     *   · `request_user_input` **只在 Plan 模式可用**（`tools/src/tool_config.rs:17-26`
     *     + `config_types.rs:700`），而 EvoWork 三档模式全是 `kernelMode: 'default'`；
     *     另一条路 `default_mode_request_user_input` 是 UnderDevelopment、默认关。
     *   · `request_permissions` 工具要 `Feature::RequestPermissionsTool`
     *     （`features/src/lib.rs:1219`，UnderDevelopment、默认关），所以根本不在工具清单里。
     *
     * 断言写成"现在是走不到的"而不是跳过：哪天内核把这两个开关翻过来，
     * 或者我们加了 Plan 模式，这条会**红**，那时候才轮到去验那两张卡真的能用。
     * 跳过的写法在那一天什么都不会说。
     */
    nextScript = {
      tool: 'request_user_input',
      args: {
        questions: [
          {
            id: 'fmt',
            header: '交付格式',
            question: '这份东西要 PPT 还是文档？',
            options: [
              { label: 'PPT（推荐）', description: '适合汇报' },
              { label: '文档', description: '适合存档' },
            ],
          },
        ],
      },
    };
    const askTask = await evaluate(
      `window.evowork.send(${JSON.stringify({
        text: '先问我一个问题再动手',
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
      })})`,
    );
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-completed' && event.taskId === ${JSON.stringify(askTask.threadId)})`,
        ),
      '追问那一轮没有跑完',
      30_000,
    );
    const toolOutput = (responseBodies.at(-1) ?? '').includes('request_user_input is unavailable')
      ? 'unavailable-in-default-mode'
      : 'ran';
    if (toolOutput !== 'unavailable-in-default-mode') {
      throw new Error(
        'request_user_input 现在能跑了 —— 追问审批卡因此变成活路径，去验一遍它的 questions[] 与逐题答案（356a93f 只对假内核验过）。',
      );
    }
    const approvalsAfterAsk = await evaluate(`window.__e2eApprovals.length`);
    if (approvalsAfterAsk !== 0) {
      throw new Error('追问竟然弹出了审批卡 —— 与上面那条互相矛盾，说明判据写错了。');
    }
    const offeredTools = JSON.parse(responseBodies[0] ?? '{}').tools ?? [];
    if (offeredTools.some((tool) => tool?.name === 'request_permissions')) {
      throw new Error(
        'request_permissions 进工具清单了 —— 权限审批卡因此变成活路径，去验一遍它回的 {permissions, scope}（同上，只对假内核验过）。',
      );
    }
    stage('approval-paths-pinned');

    failUpstream = true;
    const beforeRetry = responseCount;
    const retryTask = await evaluate(
      `window.evowork.send(${JSON.stringify({
        text: '断线重连自检',
        scenarioId: 'code',
        modelId: 'e2e-model',
        modeId: 'request-approval',
        workspaceId,
      })})`,
    );
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-retrying' && event.taskId === ${JSON.stringify(retryTask.threadId)})`,
        ),
      '内核在重试，界面却什么都没收到（适配层没订阅 error 通知时就是这个样子）',
      20_000,
    );
    // 真的重试了：同一个回合把网关打了不止一次
    await waitFor(
      () => responseCount >= beforeRetry + 2,
      '内核没有重试上游请求 —— error.code 大概率落到了"终止"那一支',
      20_000,
    );
    await waitFor(
      () =>
        evaluate(
          `window.__e2eEvents.some((event) => event.type === 'turn-failed' && event.taskId === ${JSON.stringify(retryTask.threadId)})`,
        ),
      '重试用完之后没有把失败告诉用户',
      30_000,
    );
    const retryAttempts = responseCount - beforeRetry;
    /*
     * 重试要**有尽头**，但尽头不是 `stream_max_retries` 那个数。
     *
     * 2026-09-26 实测：设成 2 时一个回合打了 **5～6 次**上游（默认 5 时是 **11 次**）——
     * 内核在重试用完之后还会**切一次传输通道并把计数清零**
     * （`core/src/responses_retry.rs:95-111`），于是真实上限大约是设置值的两倍多。
     * 只读代码会以为是 1+2=3；这条断言的存在就是为了让那个误差被测出来而不是被假设掉。
     */
    if (retryAttempts < 2 || retryAttempts > 8) {
      throw new Error(`重试次数不对：一个回合打了 ${retryAttempts} 次上游（预期 2–8）。`);
    }
    const failures = await evaluate(
      `JSON.stringify(window.__e2eEvents.filter((event) => event.type === 'turn-failed'))`,
    );
    if (!failures.includes('重试多次仍未成功')) {
      throw new Error('重试用完后，网关写给用户的那句话没有到达界面（message 被内核吃掉了）。');
    }
    stage('upstream-retry-verified');

    process.stdout.write(
      `__EVOWORK_DESKTOP_E2E__${JSON.stringify({
        ok: true,
        upstreamRetryAttempts: retryAttempts,
        threadId: first.threadId,
        skillPath: skill.path,
        queuedEditPreserved: true,
        memorySettingsVerified: true,
        memoryInjectionVerified: true,
        memoryTaskControlsVerified: true,
        recoveredAfterPid: crashedPid,
        responses: responseCount,
      })}\n`,
    );
    await host.stop();
    await new Promise((resolveClose) => gateway.close(resolveClose));
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (host) await host.stop().catch(() => undefined);
    await new Promise((resolveClose) => gateway.close(resolveClose));
    app.exit(1);
  }
}

// Electron 的 ready 事件要等 ESM 入口完成求值；这里不能顶层 await `run()`，
// 否则 `bootstrap()` 等 ready、ready 又等模块求值，测试会无输出地死锁。
void run();
