import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';

import { bootstrap, createServiceHost } from '../../dist/main/bootstrap.bundle.js';

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
let responseCount = 0;
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
  request.resume();
  responseCount += 1;
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const id = `resp_${responseCount}`;
  const itemId = `msg_${responseCount}`;
  sendEvent(response, { type: 'response.created', response: { id } });
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
    delta: `E2E response ${responseCount}`,
  });
  const finish = () => {
    sendEvent(response, {
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        id: itemId,
        role: 'assistant',
        content: [{ type: 'output_text', text: `E2E response ${responseCount}` }],
      },
    });
    sendEvent(response, { type: 'response.completed', response: { id, end_turn: true } });
    response.end('data: [DONE]\n\n');
  };
  if (responseCount === 1) heldResponse = finish;
  else finish();
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
    const enabledMemory = await evaluate(
      `window.evowork.setMemorySettings(${JSON.stringify({
        enabled: true,
        useMemories: true,
        generateMemories: true,
      })})`,
    );
    if (!enabledMemory.ok || !enabledMemory.view.generateMemories) {
      throw new Error('真实 app-server 没有重新启用记忆生成。');
    }
    stage('memory-settings-verified');

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

    process.stdout.write(
      `__EVOWORK_DESKTOP_E2E__${JSON.stringify({
        ok: true,
        threadId: first.threadId,
        skillPath: skill.path,
        queuedEditPreserved: true,
        memorySettingsVerified: true,
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
