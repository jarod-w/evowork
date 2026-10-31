/** 真网关子进程接收续期 IPC：新请求用新令牌，在途流不被中断。 */
import { build } from 'esbuild';
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}
it('跨进程更新托管令牌后，原流完成且网关 PID 不变', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'evowork-token-ipc-'));
  let stream;
  const credentials = [];
  const cloud = createServer((request, response) => {
    credentials.push(request.headers.authorization);
    if (request.url.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [] }));
    } else {
      stream = response;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"type":"response.created","id":"original-stream"}\n\n');
    }
  });
  let child;
  try {
    const cloudPort = await listen(cloud);
    const reserve = createServer();
    const port = await listen(reserve);
    await new Promise((resolve) => reserve.close(resolve));
    const entry = join(directory, 'main.js');
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
    await build({
      entryPoints: [join(ROOT, 'services/gateway/src/main.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      logLevel: 'silent',
    });
    child = fork(entry, [], {
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: {
        PORT: String(port),
        HOST: '127.0.0.1',
        EVOWORK_GATEWAY_TOKENS: 'local-test-token',
        EVOWORK_UPSTREAM_BASE_URL: `http://127.0.0.1:${cloudPort}`,
        EVOWORK_ACCESS_JWT: 'old-test-token',
      },
    });
    const pid = child.pid;
    const base = `http://127.0.0.1:${port}`;
    const headers = { authorization: 'Bearer local-test-token' };
    const until = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < until) {
      if (child.exitCode !== null) throw new Error(`Gateway exited: ${child.exitCode}`);
      try {
        ready = (await fetch(`${base}/v1/evowork/models`, { headers })).ok;
      } catch {
        /* 端口尚未监听。 */
      }
      if (ready) break;
      await pause(25);
    }
    expect(ready).toBe(true);
    const response = await fetch(`${base}/v1/responses`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'hosted/test', input: [], stream: true }),
    });
    expect(response.status).toBe(200);
    const ongoing = response.text();
    expect(stream.writableEnded).toBe(false);
    await new Promise((resolve, reject) =>
      child.send({ type: 'evowork-account-token', accessToken: 'new-test-token' }, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
    let usedNewToken = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await fetch(`${base}/v1/evowork/models`, { headers });
      usedNewToken = credentials.at(-1) === 'Bearer new-test-token';
      if (usedNewToken) break;
      await pause(25);
    }
    expect(usedNewToken).toBe(true);
    expect(stream.writableEnded).toBe(false);
    stream.end('data: [DONE]\n\n');
    expect(await ongoing).toContain('original-stream');
    expect(child.pid).toBe(pid);
    expect(child.exitCode).toBeNull();
  } finally {
    stream?.end();
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
    cloud.closeAllConnections();
    await new Promise((resolve) => cloud.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
}, 20_000);
