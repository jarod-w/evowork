#!/usr/bin/env node
/** 真内核 + 产品适配/宿主链路；假网关只控制模型输出，不替代目标运行时。 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir, arch, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createFakeGateway } from '../apps/desktop/test/e2e/harness/fake-gateway.mjs';
import { kernelProvenanceProblem } from './kernel-provenance.mjs';

const root = resolve(import.meta.dirname, '..');
const binary =
  process.env.EVOWORK_APP_SERVER ??
  join(
    root,
    'build/kernel',
    `${platform() === 'darwin' ? 'mac' : platform()}-${arch()}`,
    'codex-app-server',
  );
assert.equal(kernelProvenanceProblem(binary, root), null);
const home = await mkdtemp(join(tmpdir(), 'evowork-goal-'));
const gateway = createFakeGateway({ turnMarker: 'GOAL-BUDGET-HOLD' });
let adapter;
let store;
const events = [];
async function waitFor(predicate, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`目标探针超时：${label}`);
}

try {
  const apiFile = join(home, 'api.mjs');
  await build({
    stdin: {
      resolveDir: root,
      contents: `
    export { createAdapter, createSpawnLauncher, BUILTIN_SCENARIOS } from './services/kernel-adapter/src/index.ts';
    export { openStore } from './services/store/src/index.ts';
    export { createRendererActions } from './apps/desktop/src/main/renderer-bridge.ts';
    export { createTaskEnvironments } from './apps/desktop/src/main/task-environments.ts';
  `,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: apiFile,
  });
  const api = await import(pathToFileURL(apiFile).href);
  const kernelHome = join(home, 'kernel');
  await mkdir(join(kernelHome, 'startup'), { recursive: true });
  const url = await gateway.listen();
  const template = await readFile(join(root, 'config/config.toml.template'), 'utf8');
  await writeFile(
    join(kernelHome, 'config.toml'),
    template
      .replace('http://127.0.0.1:8787/v1', url)
      .replace('memories = true', 'memories = false'),
  );
  store = api.openStore({ path: join(home, 'store.sqlite') });
  const createAdapter = () =>
    api.createAdapter({
      store,
      scenarios: api.BUILTIN_SCENARIOS.map((s) => ({ ...s, model: 'test/model' })),
      sessionOptions: {
        launcher: api.createSpawnLauncher({
          appServerPath: binary,
          kernelHome,
          extraEnv: { EVOWORK_GATEWAY_TOKEN: 'local-probe' },
        }),
        clientInfo: { name: 'evowork-goal-probe', version: '0.0.0' },
      },
      readInstructions: () => 'You are EvoWork. Complete the user task and verify the result.',
      onUiEvent: (event) => events.push(event),
    });
  const actions = () =>
    api.createRendererActions({
      adapter,
      store,
      appName: 'EvoWork',
      appVersion: '0.0.0',
      environments: api.createTaskEnvironments({
        store,
        home: homedir(),
        dataDir: home,
        projectRoot: () => undefined,
      }),
    });
  adapter = createAdapter();
  await adapter.start();

  gateway.scriptWhen('first', (r) => r.text.includes('GOAL-CONTINUE'), {
    kind: 'text',
    text: '第一轮未完成，继续验证。',
  });
  gateway.scriptWhen(
    'complete',
    (r) => r.text.includes('GOAL-CONTINUE') && r.tools.includes('update_goal'),
    { tool: 'update_goal', args: { status: 'complete' } },
  );
  const continued = await actions().send({ text: '/goal GOAL-CONTINUE 完成并验证目标' });
  await waitFor(
    async () => (await adapter.getGoal(continued.threadId))?.status === 'complete',
    '自动续跑后完成',
  );
  assert.ok(
    events.filter((e) => e.type === 'turn-started' && e.threadId === continued.threadId).length >=
      2,
    '没有自动开始第二轮',
  );
  assert.ok(gateway.matchedBody('complete'), '模型未调用完成工具');
  assert.equal((await adapter.getGoal(continued.threadId)).tokenBudget, null);
  console.log('PASS 自动续跑两轮、模型完成工具、无预算目标');

  gateway.scriptWhen('pause-first', (r) => r.text.includes('GOAL-PERSIST'), { kind: 'hold' });
  const persisted = await actions().send({ text: '/goal GOAL-PERSIST 保留暂停目标' });
  await waitFor(() => gateway.scriptedTurnHeld(), '首轮运行');
  await actions().setTaskGoal({ threadId: persisted.threadId, status: 'paused' });
  gateway.releaseScriptedTurn();
  await waitFor(
    () => events.some((e) => e.type === 'turn-completed' && e.threadId === persisted.threadId),
    '暂停后首轮结束',
  );
  assert.equal((await adapter.getGoal(persisted.threadId)).status, 'paused');
  await adapter.stop();
  adapter = createAdapter();
  await adapter.start();
  assert.equal((await actions().getTaskGoal({ threadId: persisted.threadId })).status, 'paused');
  gateway.scriptWhen(
    'resume',
    (r) => r.text.includes('GOAL-PERSIST') && r.tools.includes('update_goal'),
    { tool: 'update_goal', args: { status: 'complete' } },
  );
  await actions().setTaskGoal({ threadId: persisted.threadId, status: 'active' });
  await waitFor(
    async () => (await adapter.getGoal(persisted.threadId))?.status === 'complete',
    '重启后恢复并完成',
  );
  await actions().clearTaskGoal({ threadId: persisted.threadId });
  assert.equal(await adapter.getGoal(persisted.threadId), undefined);
  console.log('PASS 暂停、内核重启后持久化、恢复自动执行、清除');

  const budgeted = await actions().send({ text: '/goal GOAL-BUDGET-HOLD 预算耗尽后暂停' });
  await waitFor(() => gateway.turnClaimed(), '预算任务首轮运行');
  await actions().setTaskGoal({ threadId: budgeted.threadId, tokenBudget: 1 });
  gateway.releaseClaimedTurn();
  await waitFor(
    async () => (await adapter.getGoal(budgeted.threadId))?.status === 'budgetLimited',
    '预算耗尽',
  );
  const goal = await adapter.getGoal(budgeted.threadId);
  assert.ok(goal.tokensUsed > 0);
  assert.equal(store.threads.get(budgeted.threadId).budget_limit, 1);
  console.log('PASS 内核预算计量、预算耗尽停止、投影同步');
} finally {
  gateway.releaseScriptedTurn();
  if (gateway.turnClaimed()) gateway.releaseClaimedTurn();
  await adapter?.stop();
  store?.close();
  await gateway.close();
  await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
