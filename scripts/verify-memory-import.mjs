/** Native shipping-kernel probe; all source files and model responses are synthetic. */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { kernelProvenanceProblem } from './kernel-provenance.mjs';
const repoRoot = resolve(import.meta.dirname, '..');
const kernel =
  process.env.EVOWORK_APP_SERVER ?? resolve(repoRoot, 'build/kernel/mac-arm64/codex-app-server');
const problem = kernelProvenanceProblem(kernel, repoRoot);
if (problem) throw new Error(problem);
import { createFakeGateway } from '../apps/desktop/test/e2e/harness/fake-gateway.mjs';
import {
  consolidationCommand,
  consolidatedMemory,
} from '../services/kernel-adapter/test-support/claude-memory-fixture.mjs';
const gateway = createFakeGateway({ turnMarker: 'unused' });
const url = await gateway.listen();
const root = mkdtempSync('/private/tmp/evowork-import-probe-');
const kernelHome = join(root, 'kernel');
const cwd = join(root, 'project');
const memory = join(root, '.claude/projects/fixture-project/memory');
for (const p of [kernelHome, cwd, memory]) mkdirSync(p, { recursive: true });
writeFileSync(
  join(memory, 'MEMORY.md'),
  '# Project memory\nSynthetic project imports use violet reports.\n',
);
writeFileSync(
  join(memory, '../session.jsonl'),
  JSON.stringify({
    type: 'user',
    cwd,
    timestamp: new Date().toISOString(),
    message: { content: 'synthetic memory fixture' },
  }) + '\n',
);
writeFileSync(
  join(kernelHome, 'config.toml'),
  `model = "e2e-model"
model_provider = "test"
approval_policy = "never"
default_permissions = ":workspace"
[model_providers.test]
name = "test"
base_url = "${url}"
wire_api = "responses"
[features]
memories = true
external_agent_memory_import = true
[memories]
generate_memories = false
extract_model = "e2e-model"
consolidation_model = "e2e-model"
`,
);
const child = spawn(kernel, [], {
  cwd,
  env: { ...process.env, HOME: root, CODEX_HOME: kernelHome },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let seq = 0;
const pending = new Map();
const notices = [];
child.stderr.on('data', () => {});
createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined) {
    const item = pending.get(msg.id);
    if (item) {
      pending.delete(msg.id);
      clearTimeout(item.timer);
      if (msg.error) item.reject(new Error(JSON.stringify(msg.error)));
      else item.resolve(msg.result);
    }
  } else notices.push(msg);
});
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => reject(new Error('timeout ' + method)), 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
try {
  await call('initialize', {
    clientInfo: { name: 'evowork_import_probe', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const config = await call('config/read', { includeLayers: false });
  assert.equal(config.config.features.external_agent_memory_import, true);
  const readiness = await call('memory/status', {});
  assert.deepEqual(readiness, { v2ConsolidatedThreads: 0, v2Ready: false });
  await assert.rejects(call('memory/status', { minConsolidatedThreads: 0 }));
  // No public sync scheduler method in this shipping protocol; update detection/import is native.
  await assert.rejects(call('externalAgentConfig/sync', {}));
  console.log('shipping memory/status available; dedicated sync method unavailable');
  const found = await call('externalAgentConfig/detect', { includeHome: true });
  const item = found.items.find((i) => i.itemType === 'MEMORY');
  assert.ok(item, 'Memory item missing');
  const result = await call('externalAgentConfig/import', {
    migrationItems: [item],
    source: 'evowork-probe',
  });
  assert.ok(result.importId);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(notices.some((n) => n.method === 'externalAgentConfig/import/completed'));
  const history = await call('externalAgentConfig/import/readHistories');
  assert.equal(history.data[0].importId, result.importId);
  const again = await call('externalAgentConfig/detect', { includeHome: true });
  assert.ok(!again.items.some((i) => i.itemType === 'MEMORY'));
  console.log('native detect/import/history/deduplication passed');
  gateway.scriptWhen(
    'consolidation',
    (v) => v.text.includes('phase2_workspace_diff.md') && !v.calls.includes('exec_command'),
    { tool: 'exec_command', args: { cmd: consolidationCommand } },
  );
  gateway.scriptWhen('consolidation-done', (v) => v.text.includes('IMPORTED_EVIDENCE_READ'), {
    kind: 'text',
    text: 'Memory consolidation complete.',
  });
  const starter = await call('thread/start', { cwd, model: 'e2e-model' });
  await call('turn/start', {
    threadId: starter.thread.id,
    input: [{ type: 'text', text: 'IMPORT_CONSOLIDATION_TRIGGER' }],
  });
  const until = Date.now() + 45000;
  while (Date.now() < until && !consolidatedMemory(kernelHome)?.memory.includes('violet reports'))
    await new Promise((r) => setTimeout(r, 250));
  assert.ok(
    consolidatedMemory(kernelHome)?.memory.includes('violet reports'),
    'native consolidation did not derive imported memory',
  );
  const settle = Date.now() + 10000;
  while (!gateway.matchedBody('consolidation-done') && Date.now() < settle)
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    gateway.matchedBody('consolidation-done')?.includes('violet reports'),
    'consolidation model did not receive source evidence',
  );
  console.log('native consolidation passed');
  gateway.scriptWhen('memory-citation', (v) => v.text.includes('IMPORT_NEW_TASK'), {
    kind: 'text',
    text: 'Use violet reports.<oai-mem-citation><citation_entries>\nMEMORY.md:1-2|note=[Imported project reference]\n</citation_entries>\n<rollout_ids>\n</rollout_ids></oai-mem-citation>',
  });
  const task = await call('thread/start', { cwd, model: 'e2e-model' });
  await call('turn/start', {
    threadId: task.thread.id,
    input: [{ type: 'text', text: 'IMPORT_NEW_TASK' }],
  });
  const end = Date.now() + 10000;
  while (Date.now() < end && !gateway.requestBodies.some((b) => b.includes('IMPORT_NEW_TASK')))
    await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    gateway.requestBodies.some(
      (b) => b.includes('IMPORT_NEW_TASK') && b.includes('Imported project reference'),
    ),
    'new task did not receive memory route',
  );
  const citationDeadline = Date.now() + 10000;
  let cited;
  while (Date.now() < citationDeadline) {
    cited = notices.find(
      (n) =>
        n.method === 'item/completed' &&
        n.params.threadId === task.thread.id &&
        n.params.item.memoryCitation,
    );
    if (cited) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(cited?.params.item.memoryCitation.entries[0].path, 'MEMORY.md');
  const restored = await call('thread/read', { threadId: task.thread.id, includeTurns: true });
  assert.ok(
    restored.thread.turns
      .flatMap((t) => t.items)
      .some((i) => i.memoryCitation?.entries[0]?.path === 'MEMORY.md'),
  );
  console.log('new task memory injection, citation events and history passed');
  const blocked = await call('thread/start', {
    cwd,
    model: 'e2e-model',
    config: { 'memories.use_memories': false },
  });
  await call('turn/start', {
    threadId: blocked.thread.id,
    input: [{ type: 'text', text: 'IMPORT_BLOCKED_TASK' }],
  });
  const blockedEnd = Date.now() + 10000;
  while (
    Date.now() < blockedEnd &&
    !gateway.requestBodies.some((b) => b.includes('IMPORT_BLOCKED_TASK'))
  )
    await new Promise((r) => setTimeout(r, 100));
  const bodies = gateway.requestBodies.filter((b) => b.includes('IMPORT_BLOCKED_TASK'));
  assert.ok(bodies.length > 0);
  assert.ok(bodies.every((b) => !b.includes('Imported project reference')));
  console.log('native memory read opt-out passed');
} finally {
  child.kill();
  await new Promise((r) => child.once('exit', r));
  await gateway.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
