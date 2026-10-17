/** Shipping-kernel capability probe. Uses only isolated synthetic data and a local fake model. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { kernelProvenanceProblem } from './kernel-provenance.mjs';
import { createFakeGateway } from '../apps/desktop/test/e2e/harness/fake-gateway.mjs';

const repo = resolve(import.meta.dirname, '..');
const kernel = resolve(repo, 'build/kernel/mac-arm64/codex-app-server');
const problem = kernelProvenanceProblem(kernel, repo);
if (problem) throw new Error(problem);
const root = mkdtempSync('/private/tmp/evowork-workbuddy-probe-');
const home = join(root, 'kernel');
const cwd = join(root, 'workspace');
mkdirSync(home);
mkdirSync(cwd);
const gateway = createFakeGateway({ turnMarker: 'unused' });
const url = await gateway.listen();
const hookPath = join(root, 'receipt-hook.mjs');
writeFileSync(
  hookPath,
  `import { handlePostToolUse, serialize } from ${JSON.stringify(pathToFileURL(join(repo, 'services/policy/dist/index.js')).href)};
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString());
const result = handlePostToolUse(input, { home: ${JSON.stringify(root)}, now: () => Date.now(), readFile: () => undefined });
console.log(serialize(result.output));
`,
);
writeFileSync(
  join(home, 'hooks.json'),
  JSON.stringify({
    hooks: {
      PostToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: JSON.stringify(process.execPath) + ' ' + JSON.stringify(hookPath),
            },
          ],
        },
      ],
    },
  }),
);
writeFileSync(
  join(home, 'config.toml'),
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
[memories]
use_memories = true
generate_memories = false
dedicated_tools = true
extract_model = "e2e-model"
consolidation_model = "e2e-model"
`,
);
const child = spawn(kernel, [], {
  cwd,
  env: { ...process.env, HOME: root, CODEX_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const lifecycle = [{ kind: 'started', pid: child.pid }];
let closing = false;
child.on('exit', (code, signal) =>
  lifecycle.push({ kind: 'exited', code, signal, intentional: closing }),
);
child.stderr.on('data', () => {});
let seq = 0;
const pending = new Map();
const notices = [];
createInterface({ input: child.stdout }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
    else p.resolve(msg.result);
  } else notices.push(msg);
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('timeout: ' + method));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
async function until(check) {
  const end = Date.now() + 30000;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
try {
  await call('initialize', {
    clientInfo: { name: 'evowork_workbuddy_probe', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const hooks = await call('hooks/list');
  const entries = hooks.data.flatMap((d) => d.hooks);
  await call('config/batchWrite', {
    edits: entries.map((h) => ({
      keyPath: `hooks.state."${h.key}".trusted_hash`,
      value: h.currentHash,
      mergeStrategy: 'replace',
    })),
    reloadUserConfig: true,
  });
  for (const method of ['memory/write', 'memory/import', 'memories/add_ad_hoc_note', 'tool/call']) {
    await assert.rejects(call(method), (err) => {
      assert.equal(typeof err.code, 'number');
      assert.match(err.message, /unknown variant/u);
      return true;
    });
  }
  const filename = `2026-10-17T12-00-00-workbuddy-${'a'.repeat(32)}.md`;
  const note = '# WorkBuddy import\nPersonal preference: synthetic violet reports.\n';
  gateway.scriptWhen(
    'write',
    (v) => v.text.includes('WORKBUDDY_WRITE_PROBE') && !v.calls.includes('add_ad_hoc_note'),
    { tool: 'add_ad_hoc_note', args: { filename, note } },
  );
  gateway.scriptWhen(
    'done',
    (v) => v.text.includes('WORKBUDDY_WRITE_PROBE') && v.calls.includes('add_ad_hoc_note'),
    { kind: 'text', text: 'Note saved.' },
  );
  const started = await call('thread/start', { cwd, model: 'e2e-model' });
  const id = started.thread.id;
  const turn = await call('turn/start', {
    threadId: id,
    input: [
      { type: 'text', text: 'WORKBUDDY_WRITE_PROBE: remember the supplied synthetic preference.' },
    ],
  });
  await until(() =>
    notices.some(
      (n) =>
        n.method === 'turn/completed' &&
        n.params.threadId === id &&
        n.params.turn.id === turn.turn.id,
    ),
  );
  assert.equal(
    readFileSync(join(home, 'memories/extensions/ad_hoc/notes', filename), 'utf8'),
    note,
  );
  const raw = notices
    .filter((n) => n.method === 'rawResponseItem/completed' && n.params.threadId === id)
    .map((n) => n.params.item);
  assert.equal(raw.length, 0);
  const receipt = notices.find(
    (n) =>
      n.method === 'hook/completed' &&
      n.params.threadId === id &&
      n.params.run.status === 'completed' &&
      n.params.run.entries.some(
        (e) => e.kind === 'context' && e.text.startsWith(`EW_MEMORY_NOTE_V1:${filename}:`),
      ),
  );
  assert.ok(receipt, 'trusted native PostToolUse receipt missing');
  const history = await call('thread/read', { threadId: id, includeTurns: true });
  const historyItems = history.thread.turns.flatMap((t) => t.items).map((i) => i.type);
  const mcp = await call('mcpServer/tool/call', {
    threadId: id,
    server: 'memories',
    tool: 'add_ad_hoc_note',
    arguments: { filename, note },
  }).then(
    (r) => ({ result: r }),
    (e) => ({ code: e.code, message: e.message }),
  );
  assert.equal(mcp.code, -32603);
  assert.match(mcp.message, /unknown MCP server/u);
  assert.equal(lifecycle.length, 1, 'unexpected kernel exit');
  const report = {
    kernel: JSON.parse(
      readFileSync(join(repo, 'build/kernel/mac-arm64/KERNEL_PROVENANCE.json'), 'utf8'),
    ),
    genericWriteRpc: false,
    nativeAdHocTool: true,
    publicHookReceipt: true,
    rawEventsUsed: false,
    historyItems,
    mcpMemoryServer: false,
    lifecycle,
  };
  textReport(report);
  if (process.argv[2])
    writeFileSync(resolve(process.argv[2]), JSON.stringify(report, null, 2) + '\n');
} finally {
  closing = true;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
  }
  await gateway.close();
  rmSync(root, { recursive: true, force: true });
}
function textReport(value) {
  console.log(JSON.stringify(value, null, 2));
}
