/** Focused native memory verification; all model responses and inputs are synthetic. */
import assert from 'node:assert/strict';
import { app } from 'electron';
import {
  seedMemorySummary,
  ageMemoryInput,
  memoryConsolidationIdle,
  ageMemoryConsolidation,
} from '../../../../services/kernel-adapter/test-support/memory-fixture.mjs';
import { bootApp, createE2EHome, writeKernelConfig } from './harness/boot.mjs';
import { createFakeGateway } from './harness/fake-gateway.mjs';
import { createRunner, removeE2EHome, waitFor } from './harness/runner.mjs';

const { stage, report } = createRunner({
  stagePrefix: '__EVOWORK_DESKTOP_E2E_STAGE__',
  resultPrefix: '__EVOWORK_DESKTOP_E2E__',
});
const repoRoot = process.env.EVOWORK_E2E_REPO_ROOT;
const appServerPath = process.env.EVOWORK_APP_SERVER;
const { home, workspace, kernelHome } = createE2EHome('evowork-memory-e2e-');
const marker = 'EVOWORK_MEMORY_READ_CONTROL_MARKER';
const gateway = createFakeGateway({
  turnMarker: 'UNUSED_HOLD_MARKER',
  models: [
    { id: 'e2e-model', displayName: '任务模型' },
    { id: 'e2e-extract', displayName: '提取模型' },
    { id: 'e2e-consolidate', displayName: '整理模型' },
  ],
});
let host;

async function run() {
  try {
    const url = await gateway.listen();
    const memoryConfig = `[features]
memories = true
[memories]
use_memories = true
generate_memories = true
disable_on_external_context = true`;
    writeKernelConfig(
      kernelHome,
      `model_provider = "evowork"
default_permissions = "evowork-workspace"
approval_policy = "on-request"
[model_providers.evowork]
name = "E2E"
base_url = "${url}"
wire_api = "responses"
env_key = "EVOWORK_GATEWAY_TOKEN"
[permissions.evowork-workspace]
extends = ":workspace"
${memoryConfig}
[[skills.config]]
name = "openai-docs"
enabled = false
`,
    );
    seedMemorySummary(kernelHome, marker);
    const desktop = await bootApp({
      repoRoot,
      appServerPath,
      home,
      captureKernelProcess: true,
      hostEnv: { EVOWORK_GATEWAY_TOKEN: 'e2e-token', EVOWORK_GATEWAY_URL: url },
    });
    host = desktop.host;
    const call = (method, input) =>
      desktop.evaluate(
        `window.evowork.${method}(${input === undefined ? '' : JSON.stringify(input)})`,
      );
    await desktop.evaluate(
      'window.__memoryEvents = []; window.__memoryNotices = []; window.evowork.onUiEvent(e => window.__memoryEvents.push(e)); window.evowork.onNotice(n => window.__memoryNotices.push(n)); true;',
    );
    const project = await call('createProject', { name: '记忆验收', path: workspace });
    assert.equal(project.ok, true);
    const workspaceId = project.projects[0].id;
    const settings = {
      enabled: true,
      useMemories: true,
      generateMemories: true,
      disableOnExternalContext: false,
    };
    assert.equal((await call('setMemorySettings', settings)).view.disableOnExternalContext, false);
    assert.equal(
      (
        await call('setMemorySettings', {
          enabled: true,
          useMemories: false,
          generateMemories: true,
        })
      ).view.disableOnExternalContext,
      false,
    );
    await call('setMemorySettings', settings);
    stage('external-context-setting-preserved');
    const send = async (text, useMemories) => {
      const result = await call('send', {
        text,
        workspaceId,
        modelId: 'e2e-model',
        ...(useMemories === undefined ? {} : { useMemories }),
      });
      await waitFor(
        () =>
          desktop.evaluate(
            `window.__memoryEvents.some(e => e.type === 'turn-completed' && e.taskId === ${JSON.stringify(result.threadId)})`,
          ),
        '真实任务没有完成',
      );
      return result;
    };
    const allowed = await send('MEMORY_ALLOWED_TASK');
    assert.ok(
      gateway.requestBodies.some(
        (body) => body.includes('MEMORY_ALLOWED_TASK') && body.includes(marker),
      ),
      '默认读取没有注入记忆',
    );
    const noRead = await send('MEMORY_BLOCKED_TASK', false);
    assert.ok(
      gateway.requestBodies.some((body) => body.includes('MEMORY_BLOCKED_TASK')),
      '禁读任务没有请求模型',
    );
    assert.ok(
      gateway.requestBodies
        .filter((body) => body.includes('MEMORY_BLOCKED_TASK'))
        .every((body) => !body.includes(marker)),
      '禁读任务泄漏记忆',
    );
    stage('native-read-control-verified');
    await waitFor(() => memoryConsolidationIdle(kernelHome), '初始记忆后台流程未结束');
    ageMemoryConsolidation(kernelHome);
    // A completed synthetic task is aged by the test fixture, never by production code.
    ageMemoryInput(kernelHome, noRead.threadId);
    const extractionOutput = JSON.stringify({
      raw_memory: 'Synthetic reusable preference: use concise reports.',
      rollout_summary: 'Synthetic memory test task completed successfully.',
      rollout_slug: 'memory-test',
    });
    gateway.scriptWhen(
      'extract',
      (view) => JSON.parse(view.text).text?.format?.type === 'json_schema',
      { kind: 'text', text: extractionOutput },
    );
    gateway.scriptWhen('consolidate', (view) => JSON.parse(view.text).model === 'e2e-consolidate', {
      kind: 'text',
      text: 'Synthetic consolidation finished.',
    });
    const chosen = await call('setMemorySettings', {
      ...settings,
      extractModel: 'e2e-extract',
      consolidationModel: 'e2e-consolidate',
    });
    assert.equal(chosen.ok, true);
    await send('MEMORY_GENERATION_TRIGGER');
    await waitFor(() => gateway.matchedBody('extract'), '真实内核没有启动记忆提取', 30000);
    assert.equal(JSON.parse(gateway.matchedBody('extract')).model, 'e2e-extract');
    // Native global consolidation can become pending while another startup owns its lease.
    await waitFor(() => memoryConsolidationIdle(kernelHome), '记忆后台租约没有释放');
    ageMemoryConsolidation(kernelHome);
    await send('MEMORY_CONSOLIDATION_TRIGGER');
    await waitFor(() => gateway.matchedBody('consolidate'), '真实内核没有启动记忆整理', 30000);
    assert.equal(JSON.parse(gateway.matchedBody('consolidate')).model, 'e2e-consolidate');
    stage('native-extraction-and-consolidation-models-verified');
    const reset = await call('setMemorySettings', {
      ...settings,
      extractModel: null,
      consolidationModel: null,
    });
    assert.equal(reset.ok, true);
    assert.equal(reset.view.extractModel, undefined);
    assert.equal(reset.view.consolidationModel, undefined);
    await waitFor(() => memoryConsolidationIdle(kernelHome), '指定模型整理未结束');
    ageMemoryInput(kernelHome, allowed.threadId);
    ageMemoryConsolidation(kernelHome);
    gateway.scriptWhen(
      'extract-default',
      (view) => JSON.parse(view.text).text?.format?.type === 'json_schema',
      { kind: 'text', text: extractionOutput },
    );
    await send('MEMORY_DEFAULT_MODEL_TRIGGER');
    await waitFor(() => gateway.matchedBody('extract-default'), '跟随任务模型未启动提取');
    assert.equal(JSON.parse(gateway.matchedBody('extract-default')).model, 'e2e-model');
    stage('native-default-model-verified');
    const prior = desktop.kernelPid();
    desktop.killKernel();
    await waitFor(() => desktop.kernelPid() && desktop.kernelPid() !== prior, '内核没有重启');
    await waitFor(
      () => desktop.evaluate('window.__memoryNotices.some(n => n.kind === "kernel-restarted")'),
      '内核没有完成任务恢复',
      30000,
    );
    await call('send', {
      threadId: noRead.threadId,
      text: 'MEMORY_BLOCKED_AFTER_RESTART',
      modelId: 'e2e-model',
    });
    await waitFor(
      () => gateway.requestBodies.some((body) => body.includes('MEMORY_BLOCKED_AFTER_RESTART')),
      '恢复任务没有发送',
    );
    assert.ok(
      gateway.requestBodies
        .filter((body) => body.includes('MEMORY_BLOCKED_AFTER_RESTART'))
        .every((body) => !body.includes(marker)),
      '恢复后禁读选择丢失',
    );
    stage('read-choice-survived-kernel-restart');
    report({
      ok: true,
      memoryReadControl: true,
      externalContextSetting: true,
      extractionAndConsolidationModels: true,
      readChoiceAfterRestart: true,
    });
    await host.stop();
    await gateway.close();
    removeE2EHome(home);
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(
      'Synthetic model calls:',
      gateway.requestBodies.map((body) => {
        const parsed = JSON.parse(body);
        return { model: parsed.model, format: parsed.text?.format?.type };
      }),
    );
    console.error(`测试夹具保留于 ${home}`);
    if (host) await host.stop().catch(() => undefined);
    await gateway.close();
    app.exit(1);
  }
}
void run();
