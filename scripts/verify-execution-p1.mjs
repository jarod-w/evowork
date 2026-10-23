#!/usr/bin/env node
/**
 * P1 的真实厂商 + 产品网关 + 发货内核验收。只用合成输入，不打印模型正文或凭据。
 * 密钥从 EVOWORK_P1_DEEPSEEK_KEY / EVOWORK_P1_GLM_KEY 读取；也可用 --credentials-stdin
 * 传入一行 {deepseek: ..., glm: ...}，便于交互终端关闭回显后注入。密钥不会进入内核子进程。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, homedir, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { kernelProvenanceProblem } from './kernel-provenance.mjs';

const root = resolve(import.meta.dirname, '..');
const installedPython = join(homedir(), '.evowork/runtime/office/bin/python');
const officePython =
  process.env.EVOWORK_OFFICE_PYTHON ?? (existsSync(installedPython) ? installedPython : 'python3');
let credentials = {
  deepseek: process.env.EVOWORK_P1_DEEPSEEK_KEY,
  glm: process.env.EVOWORK_P1_GLM_KEY,
};
if (process.argv.includes('--credentials-stdin')) {
  const input = createInterface({ input: process.stdin });
  credentials = await new Promise((done, reject) => {
    input.once('line', (line) => {
      try {
        done(JSON.parse(line));
      } catch {
        reject(new Error('凭据输入格式错误'));
      } finally {
        input.close();
      }
    });
  });
}
assert.ok(credentials.deepseek && credentials.glm, '缺少本轮两家测试凭据');
const temp = await mkdtemp(join(tmpdir(), 'evowork-p1-real-'));
const binary =
  process.env.EVOWORK_APP_SERVER ??
  join(
    root,
    'build/kernel',
    `${platform() === 'darwin' ? 'mac' : platform()}-${arch()}`,
    'codex-app-server',
  );
assert.equal(kernelProvenanceProblem(binary, root), null);
const providers = [
  {
    name: 'deepseek',
    provider: 'deepseek',
    model: 'deepseek-flash',
    base: 'https://api.deepseek.com',
    key: credentials.deepseek,
  },
  {
    name: 'glm',
    provider: 'zhipu',
    model: 'glm-5.3-flash',
    base: 'https://open.bigmodel.cn/api/paas/v4',
    key: credentials.glm,
  },
];
const listen = (server) =>
  new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`));
  });
const close = async (server) => {
  if (server) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
};
const wait = async (predicate, label, ms = 180000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`${label} 超时`);
};
let gateway, relay, child;
const seen = [],
  notices = [],
  pending = new Map();
let sequence = 0;
function rpc(method, params) {
  return new Promise((done, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, 30000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method} 失败`));
      else done(message.result);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}
try {
  const modulePath = join(temp, 'api.mjs');
  await build({
    stdin: {
      resolveDir: root,
      contents: `export {createGatewayServer,PROVIDERS,buildKernelModelCatalog,createModelRegistry} from './services/gateway/src/index.ts';`,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: modulePath,
  });
  const api = await import(pathToFileURL(modulePath).href);
  const models = providers.flatMap((p) =>
    [true, false].map((streaming) => ({
      id: `p1/${p.name}/${streaming ? 'stream' : 'whole'}`,
      provider: p.provider,
      upstreamModel: p.model,
      displayName: p.model,
      tier: 'standard',
      verified: false,
      unverified: [],
      notes: 'Real P1 probe',
      credentialSource: 'byok',
      layer: 'custom',
      capabilities: {
        streaming,
        toolCalls: true,
        parallelToolCalls: true,
        reasoning: true,
        promptCache: true,
        imageInput: false,
        maxContextTokens: 128000,
      },
    })),
  );
  const registry = api.createModelRegistry(models);
  const wrapped = Object.fromEntries(
    Object.entries(api.PROVIDERS).map(([id, provider]) => [
      id,
      {
        ...provider,
        async send(request, config, signal) {
          const record = {
            provider: id,
            model: request.model,
            stream: request.stream,
            effort: request.reasoning_effort,
            aborted: false,
            status: undefined,
          };
          seen.push(record);
          signal?.addEventListener(
            'abort',
            () => {
              record.aborted = true;
            },
            { once: true },
          );
          const result = await provider.send(request, config, signal);
          record.status = result.status;
          return result;
        },
      },
    ]),
  );
  gateway = api.createGatewayServer({
    models: registry,
    providers: wrapped,
    configFor: (model) => {
      const p = providers.find((p) => p.provider === model.provider);
      return { baseUrl: p.base, apiKey: p.key };
    },
    authenticate: () => true,
  });
  const url = await listen(gateway);
  const home = join(temp, 'kernel'),
    work = join(temp, 'work');
  await mkdir(home);
  await mkdir(work);
  const fixture = join(work, 'verify_formulas.py');
  await writeFile(
    fixture,
    `import json,sys,subprocess\nfrom pathlib import Path\nfrom openpyxl import load_workbook\nw=Path(sys.argv[1]); renderer=sys.argv[2]\ncols=[{'header':'Input'},{'header':'N','type':'number'},{'header':'M','type':'number'},{'header':'Count','type':'number','formula':'=COUNTIF(A2:A4,"*")'},{'header':'Product','type':'number','formula':'=SUMPRODUCT(B2:B3,C2:C3)'}]\ncontent={'sheets':[{'name':'Data','columns':cols,'rows':[[10,1,3,None,None],['abc',2,4,None,None],[None,0,0,None,None]]}]}\np=w/'content.json';p.write_text(json.dumps(content));out=w/'checked.xlsx'\nr=subprocess.run([sys.executable,renderer,'--content',str(p),'--out',str(out)],capture_output=True,text=True);assert r.returncode==0,'valid generation failed'\nassert json.loads(r.stdout)['quality']['status']=='passed'\nb=load_workbook(out,data_only=True);assert b.active['D2'].value==1;assert b.active['E2'].value==11\nbefore=out.read_bytes();content['sheets'][0]['columns'][4]['formula']='=SUMPRODUCT(B2:C2,B2:B3)';p.write_text(json.dumps(content))\nr=subprocess.run([sys.executable,renderer,'--content',str(p),'--out',str(out),'--overwrite'],capture_output=True,text=True);assert r.returncode==2,'mismatched dimensions not rejected';assert out.read_bytes()==before,'old output changed'\n(w/'formula-proof.json').write_text(json.dumps({'count':1,'product':11,'invalidExit':2,'preserved':True}));print('FORMULA_CHECK_OK')\n`,
  );
  const catalog = api.buildKernelModelCatalog(
    models.map((m) => ({ id: m.id, displayName: m.displayName, maxContextTokens: 128000 })),
    '你是 EvoWork。执行用户已授权的本机测试命令，检查退出码后简短报告结果。',
  );
  await writeFile(join(home, 'catalog.json'), JSON.stringify(catalog));
  const template = await readFile(join(root, 'config/config.toml.template'), 'utf8');
  await writeFile(
    join(home, 'config.toml'),
    `model = "${models[0].id}"\nmodel_catalog_json = ${JSON.stringify(join(home, 'catalog.json'))}\n` +
      template
        .replace('http://127.0.0.1:8787/v1', `${url}/v1`)
        .replaceAll('memories = true', 'memories = false'),
  );
  const childEnv = {
    ...process.env,
    HOME: temp,
    CODEX_HOME: home,
    EVOWORK_GATEWAY_TOKEN: 'local-probe',
    EVOWORK_OFFICE_PYTHON: officePython,
  };
  delete childEnv.EVOWORK_P1_DEEPSEEK_KEY;
  delete childEnv.EVOWORK_P1_GLM_KEY;
  child = spawn(binary, [], { cwd: work, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  let exits = 0;
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
    clientInfo: { name: 'evowork-p1-real', version: '0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  for (const p of providers) {
    for (const streaming of [true, false]) {
      const id = `p1/${p.name}/${streaming ? 'stream' : 'whole'}`,
        dir = join(work, `${p.name}-${streaming ? 'stream' : 'whole'}`);
      await mkdir(dir);
      const command = streaming
        ? 'printf 42 > native.txt'
        : `${JSON.stringify(officePython)} ${JSON.stringify(fixture)} ${JSON.stringify(dir)} ${JSON.stringify(join(root, 'plugins/skills/spreadsheets/container_tools/render.py'))}`;
      const started = Date.now(),
        from = seen.length;
      const { thread } = await rpc('thread/start', {
        cwd: dir,
        model: id,
        ephemeral: true,
        permissions: ':workspace',
        approvalPolicy: 'never',
      });
      await rpc('turn/start', {
        threadId: thread.id,
        model: id,
        effort: 'low',
        input: [
          {
            type: 'text',
            text: `请实际调用命令工具执行这条已授权的本机验收命令，检查退出码；不要只给我命令，也不要修改验收脚本。命令：${command}。退出码为 0 后仅回复“验收通过”。`,
          },
        ],
      });
      await wait(
        () => notices.some((n) => n.method === 'turn/completed' && n.params.threadId === thread.id),
        `${p.model} native`,
      );
      const done = notices.find(
        (n) => n.method === 'turn/completed' && n.params.threadId === thread.id,
      );
      assert.equal(done.params.turn.status, 'completed');
      assert.equal(exits, 0);
      if (streaming) assert.equal(await readFile(join(dir, 'native.txt'), 'utf8'), '42');
      else
        assert.deepEqual(JSON.parse(await readFile(join(dir, 'formula-proof.json'), 'utf8')), {
          count: 1,
          product: 11,
          invalidExit: 2,
          preserved: true,
        });
      const calls = seen.slice(from);
      assert.ok(calls.length >= 2);
      assert.ok(
        calls.every(
          (r) =>
            r.model === p.model && r.stream === streaming && r.status === 200 && r.effort === 'low',
        ),
      );
      console.log(
        JSON.stringify({
          case: streaming ? 'native-stream-tool' : 'native-whole-formula',
          model: p.model,
          pass: true,
          requests: calls.length,
          elapsedMs: Date.now() - started,
        }),
      );
    }
  }
  // Actual hosted HTTP hop -> actual BYOK gateway -> actual vendor stream; cancel as soon as a real frame arrives.
  const hosted = models
    .filter((m) => m.capabilities.streaming)
    .map((m) => ({ ...m, credentialSource: 'hosted', layer: 'tenant' }));
  relay = api.createGatewayServer({
    models: api.createModelRegistry(hosted),
    providers: {},
    configFor: () => {
      throw new Error('unexpected-local-key');
    },
    authenticate: () => true,
    hostedForward: { upstreamBaseUrl: url, accessJwt: 'local-probe' },
  });
  const relayUrl = await listen(relay);
  for (const p of providers) {
    const from = seen.length,
      abort = new AbortController(),
      started = Date.now();
    const response = await fetch(`${relayUrl}/v1/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: abort.signal,
      body: JSON.stringify({
        model: `p1/${p.name}/stream`,
        input: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: '请逐项列出从1到200的平方，每行一项，不要省略。' },
            ],
          },
        ],
        reasoning: { effort: 'low' },
      }),
    });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const step = await reader.read();
    assert.ok(step.value?.length);
    const at = Date.now();
    abort.abort();
    void reader.cancel().catch(() => undefined);
    await wait(() => seen.slice(from).some((r) => r.aborted), `${p.model} hosted stop`, 3000);
    assert.equal(seen.length - from, 1);
    assert.equal(seen.at(-1).model, p.model);
    assert.equal(seen.at(-1).status, 200);
    console.log(
      JSON.stringify({
        case: 'hosted-stop-real-provider',
        model: p.model,
        pass: true,
        cancelMs: Date.now() - at,
        elapsedMs: Date.now() - started,
      }),
    );
  }
  assert.equal(exits, 0);
  console.log('PASS 6/6：两家真实模型，流式命令、非流式公式工具链与托管停止；未输出或保存密钥。');
} finally {
  if (child) {
    child.kill();
    await new Promise((done) => child.once('exit', done));
  }
  await close(relay);
  await close(gateway);
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
