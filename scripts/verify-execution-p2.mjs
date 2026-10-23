#!/usr/bin/env node
/** P2：真实模型生成图表、检查缺字并移动产物；实际宿主轮询与 SQLite 核对交付。密钥只读环境或隐藏 stdin。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { kernelProvenanceProblem } from './kernel-provenance.mjs';
const root = resolve(import.meta.dirname, '..');
let keys = { deepseek: process.env.EVOWORK_P2_DEEPSEEK_KEY, glm: process.env.EVOWORK_P2_GLM_KEY };
if (process.argv.includes('--credentials-stdin')) {
  const input = createInterface({ input: process.stdin });
  keys = await new Promise((done, reject) =>
    input.once('line', (line) => {
      try {
        done(JSON.parse(line));
      } catch {
        reject(new Error('Invalid credentials input'));
      } finally {
        input.close();
      }
    }),
  );
}
assert.ok(keys.deepseek && keys.glm, 'Missing requested model credentials');
const temp = await mkdtemp(join(tmpdir(), 'evowork-p2-real-'));
const binary =
  process.env.EVOWORK_APP_SERVER ??
  join(
    root,
    'build/kernel',
    `${platform() === 'darwin' ? 'mac' : platform()}-${arch()}`,
    'codex-app-server',
  );
assert.equal(kernelProvenanceProblem(binary, root), null);
const officePython =
  process.env.EVOWORK_OFFICE_PYTHON ?? join(homedir(), '.evowork/runtime/office/bin/python');
assert.ok(existsSync(officePython));
const configs = [
  {
    name: 'deepseek',
    provider: 'deepseek',
    model: 'deepseek-flash',
    base: 'https://api.deepseek.com',
    key: keys.deepseek,
  },
  {
    name: 'glm',
    provider: 'zhipu',
    model: 'glm-5.3-flash',
    base: 'https://open.bigmodel.cn/api/paas/v4',
    key: keys.glm,
  },
];
let gateway,
  child,
  store,
  services,
  sequence = 0,
  exits = 0;
const seen = [],
  notices = [],
  pending = new Map();
const wait = async (check, label, ms = 180000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${label} timed out`);
};
function rpc(method, params) {
  return new Promise((done, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out`));
    }, 30000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method} failed`));
      else done(message.result);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
async function turn(threadId, model, text) {
  const offset = notices.length;
  await rpc('turn/start', { threadId, model, effort: 'low', input: [{ type: 'text', text }] });
  await wait(
    () =>
      notices
        .slice(offset)
        .some((n) => n.method === 'turn/completed' && n.params.threadId === threadId),
    `${model} turn`,
  );
  const events = notices.slice(offset).filter((n) => n.params?.threadId === threadId);
  const completed = events.find((n) => n.method === 'turn/completed').params.turn;
  if (completed.status !== 'completed')
    console.log(
      JSON.stringify({
        case: 'native-turn-failed',
        model,
        errorInfo: completed.error?.codexErrorInfo ?? null,
        errorMessage: String(completed.error?.message ?? '')
          .slice(0, 500)
          .replaceAll(keys.deepseek, '[redacted]')
          .replaceAll(keys.glm, '[redacted]'),
        commandExits: events
          .filter((n) => n.method === 'item/completed' && n.params.item.type === 'commandExecution')
          .map((n) => n.params.item.exitCode),
        errorCategory: ['参数', '长度', '截断', '连接', '超时', '配额', '过滤'].filter((word) =>
          completed.error?.message?.includes(word),
        ),
        requests: seen,
      }),
    );
  assert.equal(completed.status, 'completed');
  assert.equal(exits, 0);
  return events;
}
function bars(svg) {
  const chart = svg.split('<g id="legend_')[0];
  return [...chart.matchAll(/<path\s+d="([^"]+)"[^>]*style="([^"]+)"/g)]
    .filter((m) => /fill: #(2fa37a|0169cc|923b0f|ba2623)/i.test(m[2]))
    .map((m) => {
      const points = [...m[1].matchAll(/[ML]\s*([-\d.]+)\s+([-\d.]+)/g)];
      return { start: Number(points[0]?.[2]), end: Number(points[2]?.[2]) };
    });
}
try {
  const module = join(temp, 'api.mjs');
  await build({
    stdin: {
      resolveDir: root,
      contents: `export {createLocalServices} from './apps/desktop/src/main/local-services.ts'; export {openStore} from './services/store/src/index.ts'; export {createGatewayServer,PROVIDERS,buildKernelModelCatalog,createModelRegistry} from './services/gateway/src/index.ts';`,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: module,
    banner: {
      js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
    },
  });
  const api = await import(pathToFileURL(module).href);
  const models = configs.map((p) => ({
    id: `p2/${p.name}`,
    provider: p.provider,
    upstreamModel: p.model,
    displayName: p.model,
    tier: 'standard',
    verified: false,
    unverified: [],
    notes: 'P2 real acceptance',
    credentialSource: 'byok',
    layer: 'custom',
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: true,
      promptCache: true,
      imageInput: false,
      maxContextTokens: 128000,
    },
  }));
  const wrapped = Object.fromEntries(
    Object.entries(api.PROVIDERS).map(([id, provider]) => [
      id,
      {
        ...provider,
        async send(request, config, signal) {
          const record = {
            model: request.model,
            effort: request.reasoning_effort,
            status: undefined,
          };
          seen.push(record);
          const result = await provider.send(request, config, signal);
          record.status = result.status;
          const source = result.lines;
          return {
            ...result,
            lines: (async function* () {
              for await (const line of source) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]')
                  try {
                    const frame = JSON.parse(line.slice(6));
                    for (const choice of frame.choices ?? [])
                      if (choice.finish_reason)
                        record.finish = ['stop', 'tool_calls', 'length', 'content_filter'].includes(
                          choice.finish_reason,
                        )
                          ? choice.finish_reason
                          : 'other';
                  } catch {
                    /* Shape-only diagnostics; the product still parses the original line. */
                  }
                yield line;
              }
            })(),
          };
        },
      },
    ]),
  );
  gateway = api.createGatewayServer({
    models: api.createModelRegistry(models),
    providers: wrapped,
    authenticate: () => true,
    configFor: (m) => {
      const p = configs.find((p) => p.provider === m.provider);
      return { baseUrl: p.base, apiKey: p.key };
    },
  });
  await new Promise((done, reject) => {
    gateway.once('error', reject);
    gateway.listen(0, '127.0.0.1', done);
  });
  const url = `http://127.0.0.1:${gateway.address().port}`;
  const home = join(temp, 'kernel'),
    work = join(temp, 'work'),
    scratch = join(temp, 'scratch'),
    artifactLog = join(temp, 'artifacts.jsonl');
  await mkdir(home);
  await mkdir(work);
  await mkdir(scratch);
  await writeFile(
    join(home, 'catalog.json'),
    JSON.stringify(
      api.buildKernelModelCatalog(
        models.map((m) => ({ id: m.id, displayName: m.displayName, maxContextTokens: 128000 })),
        '你是 EvoWork 执行智能体。实际执行用户已经授权的文件与图表任务，使用对应技能，检查退出码与质量状态，不能把缺字或未验收文件说成通过。',
      ),
    ),
  );
  const template = await readFile(join(root, 'config/config.toml.template'), 'utf8');
  await writeFile(
    join(home, 'config.toml'),
    `model = "${models[0].id}"\nmodel_catalog_json = ${JSON.stringify(join(home, 'catalog.json'))}\n` +
      template
        .replace('http://127.0.0.1:8787/v1', `${url}/v1`)
        .replaceAll('memories = true', 'memories = false'),
  );
  const env = {
    ...process.env,
    HOME: temp,
    CODEX_HOME: home,
    EVOWORK_GATEWAY_TOKEN: 'local-probe',
    EVOWORK_ARTIFACT_LOG: artifactLog,
    EVOWORK_ARTIFACT_SOCKET: '',
    EVOWORK_OFFICE_PYTHON: officePython,
  };
  delete env.EVOWORK_P2_DEEPSEEK_KEY;
  delete env.EVOWORK_P2_GLM_KEY;
  child = spawn(binary, [], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  child.on('exit', () => {
    exits++;
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else notices.push(message);
  });
  await rpc('initialize', {
    clientInfo: { name: 'evowork-p2-real', version: '0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  store = api.openStore({ path: join(temp, 'host.db') });
  services = api.createLocalServices({
    store,
    adapter: { setTaskName: async () => false },
    notify: () => undefined,
  });
  services.startArtifactReports(artifactLog, 60000);
  for (const p of configs) {
    const id = `p2/${p.name}`,
      dir = join(work, p.name),
      tmp = join(scratch, p.name);
    await mkdir(dir);
    await mkdir(tmp);
    const { thread } = await rpc('thread/start', {
      cwd: dir,
      model: id,
      ephemeral: true,
      permissions: ':workspace',
      approvalPolicy: 'never',
    });
    store.db
      .prepare(
        "INSERT INTO thread_projection (thread_id,cwd,derived_status,last_turn_status) VALUES (?,?,'running','inProgress')",
      )
      .run(thread.id, dir);
    services.watchWorkspace(dir);
    const from = seen.length,
      started = Date.now();
    await writeFile(
      join(tmp, 'missing.json'),
      JSON.stringify({
        chart: 'bar',
        title: '\u0378',
        categories: ['A'],
        series: [{ name: 'Value', values: [10] }],
      }),
    );
    const events = await turn(
      thread.id,
      id,
      `请实际用 charts 技能完成合成数据验收。先读 ${join(root, 'plugins/skills/charts/SKILL.md')}。解释器使用 ${officePython}，技能脚本使用绝对路径。中间 JSON 放 ${tmp}；交付目录 ${dir} 只放两张 SVG：percent.svg 是柱状图，分类 A/B，值 0.25/-0.5，value_format=percent，标题 Margin；mixed.svg 是 stacked-bar，分类 A，四个系列顺序 Income=100、Loss=-50、More income=20、More loss=-10，标题 Profit。来源写 synthetic test data。每张图按技能调用 mark_artifact 登记，检查渲染器返回 quality.status=passed。另用固定输入 ${join(tmp, 'missing.json')} 生成缺字样例到 ${join(tmp, 'missing.svg')}（不作为交付物、不登记）；单独执行这条渲染命令，保留退出码，不用 || true 等吞掉失败，不改字绕过检查。最后简短说明两张正常图已经交付，缺字样例检查未通过。不要修改渲染器或测试程序。`,
    );
    services.flushArtifactReports();
    const percent = await readFile(join(dir, 'percent.svg'), 'utf8'),
      mixed = await readFile(join(dir, 'mixed.svg'), 'utf8');
    assert.ok(
      percent.includes('0.0%') && /<!-- -[\d.]+% -->/.test(percent),
      'percentage axis missing',
    );
    const evidence = join(root, 'test-results/execution-p2', p.name);
    await mkdir(evidence, { recursive: true });
    await copyFile(join(dir, 'percent.svg'), join(evidence, 'percent.svg'));
    await copyFile(join(dir, 'mixed.svg'), join(evidence, 'mixed.svg'));
    const geometry = bars(mixed);
    assert.equal(geometry.length, 4, 'four stacked rectangles required');
    const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, 'stacked baseline mismatch');
    near(geometry[0].start, geometry[1].start);
    near(geometry[2].start, geometry[0].end);
    near(geometry[3].start, geometry[1].end);
    assert.ok(
      geometry[0].end < geometry[0].start && geometry[1].end > geometry[1].start,
      'positive and negative rectangles must straddle zero',
    );
    assert.ok(existsSync(join(tmp, 'missing.svg')));
    assert.ok(
      events.some(
        (n) =>
          n.method === 'item/completed' &&
          n.params.item.type === 'commandExecution' &&
          n.params.item.exitCode === 6,
      ),
      'missing glyph exit 6 not observed',
    );
    const rows = () =>
      store.db
        .prepare(
          'SELECT id,path,thread_id,version,content_hash,file_state FROM artifact WHERE thread_id=? ORDER BY path',
        )
        .all(thread.id);
    const before = rows();
    assert.equal(before.length, 2, 'two delivered artifact records required');
    assert.ok(before.every((r) => r.file_state === 'PRESENT'));
    const calls = seen.slice(from);
    assert.ok(calls.every((r) => r.model === p.model && r.status === 200 && r.effort === 'low'));
    console.log(
      JSON.stringify({
        case: 'native-chart-delivery-and-glyph',
        model: p.model,
        pass: true,
        requests: calls.length,
        elapsedMs: Date.now() - started,
      }),
    );
    await turn(
      thread.id,
      id,
      '请把刚交付的 percent.svg 和 mixed.svg 移到当前目录下新建的 archive 文件夹里，文件名、文件字节保持不变；只移动，不复制、不重新生成、不重新登记。实际执行后简短回复。',
    );
    await wait(
      () => rows().every((r) => r.path.includes('/archive/')),
      `${p.model} polling move`,
      10000,
    );
    const after = rows();
    assert.equal(after.length, 2);
    assert.deepEqual(after.map((r) => r.id).sort(), before.map((r) => r.id).sort());
    for (const record of after) {
      const original = before.find((r) => r.id === record.id);
      assert.equal(record.version, original.version);
      assert.equal(record.content_hash, original.content_hash);
      assert.equal(record.file_state, 'PRESENT');
    }
    assert.equal(
      store.db.prepare('SELECT COUNT(*) n FROM artifact WHERE path LIKE ?').get(dir + '/%').n,
      2,
      'duplicate artifacts after move',
    );
    console.log(
      JSON.stringify({
        case: 'native-file-move-and-host-polling',
        model: p.model,
        pass: true,
        records: after.length,
      }),
    );
  }
  assert.equal(exits, 0);
  console.log(
    'PASS 4/4: actual model-created charts and actual host polling moves; no keys or model bodies logged.',
  );
} finally {
  services?.stop();
  store?.close();
  if (child) {
    child.kill();
    await new Promise((done) => child.once('exit', done));
  }
  if (gateway) {
    gateway.closeAllConnections();
    await new Promise((done) => gateway.close(done));
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
