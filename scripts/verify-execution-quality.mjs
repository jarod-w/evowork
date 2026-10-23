#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { arch, platform, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
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
const temp = await mkdtemp(join(tmpdir(), 'evowork-execution-wire-'));
const requests = [],
  notifications = [],
  pending = new Map();
let child,
  gateway,
  upstream,
  nextId = 1;
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
const waitFor = async (predicate) => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error('等待真实内核回合结束超时');
};
function request(method, params) {
  return new Promise((done, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} 超时`));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
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
      contents: `export {createGatewayServer} from './services/gateway/src/server.ts'; export {PROVIDERS} from './services/gateway/src/providers/registry.ts'; export {buildKernelModelCatalog} from './services/gateway/src/kernel-catalog.ts';`,
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: modulePath,
  });
  const api = await import(pathToFileURL(modulePath).href);
  let eofSeen = false;
  upstream = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const userText = body.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.content)
      .join('\n');
    const testCase = ['WIRE-LENGTH', 'WIRE-BAD-ARGS', 'WIRE-EOF', 'WIRE-OK'].find((marker) =>
      userText.includes(marker),
    );
    requests.push({ testCase, effort: body.reasoning_effort });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    let choice;
    if (testCase === 'WIRE-LENGTH')
      choice = { delta: { content: '响应不完整' }, finish_reason: 'length' };
    else if (testCase === 'WIRE-BAD-ARGS')
      choice = {
        delta: {
          tool_calls: [
            { index: 0, id: 'bad', function: { name: 'exec_command', arguments: '{"cmd":"' } },
          ],
        },
        finish_reason: 'tool_calls',
      };
    else if (testCase === 'WIRE-EOF' && !eofSeen) {
      eofSeen = true;
      choice = { delta: { content: '连接中断前的文字' } };
    } else if (
      testCase === 'WIRE-OK' &&
      !body.messages.some((message) => message.role === 'tool')
    ) {
      const tool = body.tools.find(
        (item) =>
          item.function.name === 'exec_command' || item.function.name.endsWith('__exec_command'),
      );
      assert.ok(tool, '内核未提供命令工具');
      choice = {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'valid',
              function: {
                name: tool.function.name,
                arguments: JSON.stringify({ cmd: 'printf 42 > verified.txt', yield_time_ms: 1000 }),
              },
            },
          ],
        },
        finish_reason: 'tool_calls',
      };
    } else choice = { delta: { content: '已完成核对' }, finish_reason: 'stop' };
    res.write(
      `data: ${JSON.stringify({ choices: [choice], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
    );
    if (choice.finish_reason) res.write('data: [DONE]\n\n');
    res.end();
  });
  const upstreamUrl = await listen(upstream);
  const model = {
    id: 'evowork/deepseek-flash',
    provider: 'deepseek',
    upstreamModel: 'deepseek-flash',
    displayName: 'Local wire probe',
    tier: 'standard',
    verified: false,
    unverified: [],
    notes: '',
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
  };
  gateway = api.createGatewayServer({
    models: { find: (id) => (id === model.id ? model : undefined), list: () => [model] },
    providers: api.PROVIDERS,
    configFor: () => ({ baseUrl: upstreamUrl, apiKey: 'local-test-placeholder' }),
    authenticate: () => true,
  });
  const gatewayUrl = await listen(gateway);
  const home = join(temp, 'kernel'),
    work = join(temp, 'work');
  await mkdir(home);
  await mkdir(work);
  await writeFile(
    join(home, 'catalog.json'),
    JSON.stringify(
      api.buildKernelModelCatalog(
        [{ id: model.id, displayName: model.displayName, maxContextTokens: 128000 }],
        'You are EvoWork. Execute the local test task.',
      ),
    ),
  );
  const template = await readFile(join(root, 'config/config.toml.template'), 'utf8');
  await writeFile(
    join(home, 'config.toml'),
    `model = "${model.id}"\nmodel_catalog_json = ${JSON.stringify(join(home, 'catalog.json'))}\n` +
      template
        .replace('http://127.0.0.1:8787/v1', `${gatewayUrl}/v1`)
        .replaceAll('memories = true', 'memories = false'),
  );
  child = spawn(binary, [], {
    cwd: work,
    env: {
      ...process.env,
      HOME: temp,
      CODEX_HOME: home,
      EVOWORK_GATEWAY_TOKEN: 'local-placeholder',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else notifications.push(message);
  });
  await request('initialize', {
    clientInfo: { name: 'evowork-execution-quality', version: '0' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write('{"method":"initialized"}\n');
  for (const [testCase, expected] of [
    ['WIRE-LENGTH', 'failed'],
    ['WIRE-BAD-ARGS', 'failed'],
    ['WIRE-EOF', 'completed'],
    ['WIRE-OK', 'completed'],
  ]) {
    const started = await request('thread/start', {
      cwd: work,
      model: model.id,
      ephemeral: true,
      permissions: ':workspace',
      approvalPolicy: 'never',
    });
    const threadId = started.thread.id;
    await request('turn/start', {
      threadId,
      model: model.id,
      effort: 'low',
      input: [{ type: 'text', text: testCase }],
    });
    await waitFor(() =>
      notifications.some(
        (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
      ),
    );
    const done = notifications.find(
      (message) => message.method === 'turn/completed' && message.params.threadId === threadId,
    );
    assert.equal(done.params.turn.status, expected, `${testCase} 终态错误`);
    if (testCase !== 'WIRE-OK') assert.equal(existsSync(join(work, 'verified.txt')), false);
    assert.ok(
      requests.filter((item) => item.testCase === testCase).every((item) => item.effort === 'low'),
    );
    console.log(`PASS ${testCase}: ${expected}，推理强度 low 已到达本机上游`);
  }
  assert.equal(await readFile(join(work, 'verified.txt'), 'utf8'), '42');
  assert.equal(
    requests.filter((item) => item.testCase === 'WIRE-EOF').length,
    2,
    '断流后未正常重试收尾',
  );
  console.log('PASS 正常工具调用落盘、残缺调用零执行、断流恢复；未调用厂商服务');
} finally {
  if (child) {
    child.kill();
    await new Promise((done) => child.once('exit', done));
  }
  await close(gateway);
  await close(upstream);
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
