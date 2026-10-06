#!/usr/bin/env node
/** 真实 Chrome + 本机合成页面；不使用用户 profile、真实网站或实际业务数据。 */
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { createBrowserDriver } from '../plugins/connectors/browser/cdp.mjs';
import { createBrowserSession } from '../plugins/connectors/browser/runtime.mjs';
import { searchSources } from '../plugins/connectors/browser/research.mjs';
import { assessComputerUseAction } from '../services/policy/src/computer-use-action.ts';

const directory = mkdtempSync(join(tmpdir(), 'ew-browser-verify-'));
let posted = '',
  requests = 0,
  submissions = 0;
let blockedRequests = 0;
let researchSideRequests = 0;
const blocked = createServer((_request, response) => {
  blockedRequests++;
  response.end('must not arrive');
});
await new Promise((resolve) => blocked.listen(0, '127.0.0.1', resolve));
const blockedUrl = `http://127.0.0.1:${blocked.address().port}`;
const server = createServer(async (request, response) => {
  requests++;
  if (request.url.startsWith('/research-side')) {
    researchSideRequests++;
    response.end('must not arrive');
    return;
  }
  if (request.url === '/article') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><title>公开研究文章</title>
      <link rel="stylesheet" href="/research-side-style"><nav>导航噪音</nav>
      <main><h1>公开研究文章</h1><p>${'可以核实的公开正文。'.repeat(20)}</p><p>第二段内容。</p>
      <form><input value="私密值"><p>表单文字</p></form><div style="display:none">隐藏资料</div></main>
      <script>fetch('/research-side-script'); new Worker('/worker.js')</script>
      <img src="/research-side-image"><iframe src="${blockedUrl}/research-side-frame"></iframe>`);
    return;
  }
  if (request.url === '/search-fixture') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<title>本地搜索结构</title><a href="https://noise.test">导航</a><ol id="b_results"><li class="b_algo"><h2><a href="/article">公开研究文章</a></h2><div class="b_caption"><p>公开摘要</p></div></li></ol>',
    );
    return;
  }
  if (request.url === '/missing') {
    response.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<title>404</title><p>这不是来源正文</p>');
    return;
  }
  if (request.url === '/binary') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"unsupported":true}');
    return;
  }
  if (request.url === '/redirect') {
    response.writeHead(302, { location: blockedUrl });
    response.end();
    return;
  }
  if (request.url === '/worker.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' });
    response.end(`fetch('${blockedUrl}')`);
    return;
  }
  if (['/worker', '/shared-worker', '/service-worker'].includes(request.url)) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const action =
      request.url === '/worker'
        ? "new Worker('/worker.js')"
        : request.url === '/shared-worker'
          ? "new SharedWorker('/worker.js')"
          : "navigator.serviceWorker.register('/worker.js')";
    response.end(`<button onclick="${action}">启动 worker</button>`);
    return;
  }
  if (request.url === '/popup') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<button onclick="window.open('${blockedUrl}')">打开新窗口</button>`);
    return;
  }
  if (request.url === '/report') {
    response.writeHead(200, {
      'content-type': 'text/csv',
      'content-disposition': 'attachment; filename="report.csv"',
    });
    response.end('item,value\nlocal,42\n');
    return;
  }
  if (request.method === 'POST') {
    submissions++;
    for await (const chunk of request) posted += chunk;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<p>已收到测试内容</p>');
    return;
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(
    '<!doctype html><title>本地浏览器验收</title><form method="POST"><input name="message" aria-label="测试正文" value="before"><button type="submit">发送</button></form><div style="height:2000px">本地合成内容</div>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const approvals = [];
const session = createBrowserSession({
  driver: createBrowserDriver({ downloadsDirectory: directory }),
  ask: async (message) => {
    approvals.push(message);
    return true;
  },
  assessAction: assessComputerUseAction,
});
const read = async () => JSON.parse((await session.call('browser_snapshot', {})).content[0].text);
try {
  const researchDriver = createBrowserDriver();
  const researchSession = createBrowserSession({
    driver: researchDriver,
    ask: async () => true,
    assessAction: assessComputerUseAction,
  });
  try {
    await researchDriver.navigate(`${url}/search-fixture`, { research: true });
    const found = searchSources(
      await researchDriver.research('search', 'bing'),
      'bing',
      5,
      new Date().toISOString(),
    );
    assert.equal(found.length, 1);
    assert.equal(found[0].url, `${url}/article`);
    const article = JSON.parse(
      (await researchSession.call('browser_read_page', { url: found[0].url })).content[0].text,
    );
    assert.equal(article.sources[0].id, found[0].id);
    assert.equal(article.sources[0].kind, 'page');
    assert.ok(article.sources[0].excerpt.includes('第二段内容。'));
    for (const noise of ['私密值', '表单文字', '隐藏资料', '导航噪音', 'fetch'])
      assert.ok(!article.sources[0].excerpt.includes(noise));
    assert.equal(researchSideRequests, 0, '研究执行了脚本或请求了页面子资源');
    assert.equal(blockedRequests, 0, '研究 iframe 绕过 origin 守卫');
    await assert.rejects(
      researchSession.call('browser_read_page', { url: `${url}/missing` }),
      /PAGE_HTTP_ERROR/,
    );
    await assert.rejects(
      researchSession.call('browser_read_page', { url: `${url}/binary` }),
      /PAGE_UNSUPPORTED/,
    );
  } finally {
    researchSession.stop();
  }
  await session.call('browser_navigate', { url });
  let state = await read();
  assert.equal(state.title, '本地浏览器验收');
  const input = state.elements.find((entry) => entry.label === '测试正文');
  assert.ok(input);
  await session.call('browser_fill', {
    state_id: state.state_id,
    element_index: input.element_index,
    text: '本地合成正文',
  });
  await assert.rejects(
    session.call('browser_fill', {
      state_id: state.state_id,
      element_index: input.element_index,
      text: '不应该写入',
    }),
    /STALE_STATE/,
  );
  state = await read();
  assert.equal(state.elements.find((entry) => entry.label === '测试正文').value, '本地合成正文');
  await session.call('browser_scroll', { state_id: state.state_id, direction: 'down', pages: 1 });
  state = await read();
  assert.ok(state.scrollY > 0);
  await session.call('browser_scroll', { state_id: state.state_id, direction: 'up', pages: 1 });
  state = await read();
  await session.call('browser_press_key', {
    state_id: state.state_id,
    element_index: input.element_index,
    key: 'ArrowLeft',
  });
  state = await read();
  const image = (await session.call('browser_screenshot', {})).content[0];
  assert.equal(image.type, 'image');
  assert.equal(Buffer.from(image.data, 'base64').subarray(1, 4).toString(), 'PNG');
  const submit = state.elements.find((entry) => entry.label === '发送');
  await session.call('browser_click', {
    state_id: state.state_id,
    element_index: submit.element_index,
  });
  for (let attempt = 0; attempt < 30 && !posted; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(new URLSearchParams(posted).get('message'), '本地合成正文');
  assert.ok(
    approvals.some(
      (message) => message.includes('发送或提交内容') && message.includes('本地合成正文'),
    ),
  );
  const downloaded = JSON.parse(
    (await session.call('browser_download', { url: `${url}/report` })).content[0].text,
  );
  assert.equal(readFileSync(downloaded.path, 'utf8'), 'item,value\nlocal,42\n');
  assert.ok(approvals.some((message) => message.startsWith('下载文件')));
  const guarded = createBrowserSession({
    driver: createBrowserDriver({ downloadsDirectory: directory }),
    ask: async (message) => !message.includes(blockedUrl),
    assessAction: assessComputerUseAction,
  });
  try {
    await assert.rejects(
      guarded.call('browser_navigate', { url: `${url}/redirect` }),
      /POLICY_DENIED/,
    );
    assert.equal(blockedRequests, 0, '拒绝新 origin 后仍发送了导航请求');
    await assert.rejects(
      guarded.call('browser_download', { url: `${url}/redirect` }),
      /POLICY_DENIED/,
    );
    assert.equal(blockedRequests, 0, '下载重定向绕过 origin 准入');
    await guarded.call('browser_navigate', { url: `${url}/popup` });
    const popup = JSON.parse((await guarded.call('browser_snapshot', {})).content[0].text);
    // popup 可能在 mouseReleased 返回后创建；无论动作何时返回，后续读取都必须被关闭。
    try {
      await guarded.call('browser_click', { state_id: popup.state_id, element_index: 1 });
    } catch (error) {
      assert.match(error.message, /USER_STOPPED|BROWSER_ACTION_FAILED/);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(guarded.call('browser_snapshot', {}), /USER_STOPPED/);
    assert.equal(blockedRequests, 0, '新窗口发送了绕过准入的请求');
  } finally {
    guarded.stop();
  }
  // 三类 worker 各重复三次，抓「先断 CDP 释放暂停、后停 Chrome」的竞态。
  for (const workerPath of ['/worker', '/shared-worker', '/service-worker']) {
    for (let iteration = 0; iteration < 3; iteration++) {
      const workerSession = createBrowserSession({
        driver: createBrowserDriver(),
        ask: async () => true,
        assessAction: assessComputerUseAction,
      });
      try {
        await workerSession.call('browser_navigate', { url: `${url}${workerPath}` });
        const state = JSON.parse(
          (await workerSession.call('browser_snapshot', {})).content[0].text,
        );
        try {
          await workerSession.call('browser_click', { state_id: state.state_id, element_index: 1 });
        } catch (error) {
          assert.match(error.message, /USER_STOPPED|BROWSER_ACTION_FAILED/);
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        await assert.rejects(workerSession.call('browser_snapshot', {}), /USER_STOPPED/);
        assert.equal(blockedRequests, 0, `${workerPath} 在暂停释放后执行了跨 origin fetch`);
      } finally {
        workerSession.stop();
      }
    }
  }
  const declining = createBrowserSession({
    driver: createBrowserDriver(),
    ask: async (message) => !message.includes('发送或提交内容'),
    assessAction: assessComputerUseAction,
  });
  try {
    await declining.call('browser_navigate', { url });
    const before = submissions;
    const state = JSON.parse((await declining.call('browser_snapshot', {})).content[0].text);
    const submit = state.elements.find((entry) => entry.label === '发送');
    await assert.rejects(
      declining.call('browser_click', {
        state_id: state.state_id,
        element_index: submit.element_index,
      }),
      /APP_DENIED/,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(submissions, before, '拒绝提交后仍产生了 POST 请求');
  } finally {
    declining.stop();
  }
  console.log(
    `真实 Chrome 验收通过：搜索结构、正文与来源编号、拒绝 HTTP 错误/非网页、研究零脚本/子资源、导航、元素快照、批准输入、状态消费、PNG 截图、滚动、有限按键、发送前确认、表单提交、显式下载、拒绝后零请求、导航/下载跨 origin 拦截、新窗口/worker 暂停关闭（${requests} 次本机请求）。`,
  );
} finally {
  session.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  blocked.closeAllConnections();
  await new Promise((resolve) => blocked.close(resolve));
  rmSync(directory, { recursive: true, force: true });
}
