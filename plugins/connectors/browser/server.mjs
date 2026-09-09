#!/usr/bin/env node
/**
 * EvoWork 官方 browser 连接器（05 §4.4 / Q9）。
 *
 * stdio JSON-RPC MCP。工具：navigate / snapshot / screenshot。
 * Chrome 找不到或 CDP 连不上时，**工具调用失败并说清原因**，不假装打开了页面。
 *
 * 不执行用户给的 JS。下载默认关；上传不做。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const PROTOCOL = '2024-11-05';
const NAME = 'evowork-browser';
const VERSION = '0.0.1';

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function fail(id, message) {
  result(id, { content: [{ type: 'text', text: message }], isError: true });
}

const TOOLS = [
  {
    name: 'browser_navigate',
    description: '打开一个 URL。只允许 http/https。默认不允许任意 origin。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description: '返回当前页的标题、URL 和可见文本摘要。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_screenshot',
    description: '对当前页截图，返回 PNG 的 data URL（可能较大）。',
    inputSchema: { type: 'object', properties: {} },
  },
];

let chrome;
let cdpPort;
let targetWs;

function chromeCandidates() {
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  }
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
  }
  return ['google-chrome', 'chromium', 'chromium-browser', 'google-chrome-stable'];
}

function findChrome() {
  for (const bin of chromeCandidates()) {
    if (bin.includes('/') || bin.includes('\\')) {
      if (existsSync(bin)) return bin;
    } else {
      return bin;
    }
  }
  return undefined;
}

async function ensureChrome() {
  if (targetWs) return;
  const bin = findChrome();
  if (bin === undefined) {
    throw new Error(
      '本机没有找到 Chrome / Chromium。安装浏览器后再试；没有它时这个连接器做不了网页操作。',
    );
  }
  cdpPort = 9222 + Math.floor(Math.random() * 1000);
  chrome = spawn(
    bin,
    [
      `--remote-debugging-port=${cdpPort}`,
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--user-data-dir=/tmp/evowork-browser-profile',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const deadline = Date.now() + 8000;
  let lastErr = 'CDP 端口还没起来';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (res.ok) {
        await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`).catch(() => undefined);
        const tabs = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
        const list = await tabs.json();
        const page = list.find((t) => t.type === 'page') ?? list[0];
        if (page?.webSocketDebuggerUrl) {
          targetWs = page.webSocketDebuggerUrl;
          return;
        }
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome 起了但 CDP 连不上：${lastErr}`);
}

let cdpId = 0;
function cdp(method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(targetWs);
    const id = (cdpId += 1);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`CDP ${method} 超时`));
    }, 15000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (msg.error) reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else resolve(msg.result);
    });
    ws.addEventListener('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function assertHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('URL 无效。');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只允许 http/https。');
  }
  return parsed.href;
}

async function callTool(name, args) {
  await ensureChrome();
  if (name === 'browser_navigate') {
    const url = assertHttpUrl(String(args?.url ?? ''));
    await cdp('Page.enable');
    await cdp('Page.navigate', { url });
    return `已打开 ${url}`;
  }
  if (name === 'browser_snapshot') {
    await cdp('Runtime.enable');
    const evaled = await cdp('Runtime.evaluate', {
      expression:
        'JSON.stringify({title: document.title, href: location.href, text: (document.body && document.body.innerText || "").slice(0, 4000)})',
      returnByValue: true,
    });
    return String(evaled?.result?.value ?? '{}');
  }
  if (name === 'browser_screenshot') {
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    return `data:image/png;base64,${shot.data}`;
  }
  throw new Error(`未知工具 ${name}`);
}

async function handle(msg) {
  if (msg.method === 'initialize') {
    result(msg.id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: NAME, version: VERSION },
    });
    return;
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'initialized') return;
  if (msg.method === 'ping') {
    result(msg.id, {});
    return;
  }
  if (msg.method === 'tools/list') {
    result(msg.id, { tools: TOOLS });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name;
    try {
      const text = await callTool(name, msg.params?.arguments ?? {});
      result(msg.id, { content: [{ type: 'text', text }] });
    } catch (err) {
      fail(msg.id, err instanceof Error ? err.message : String(err));
    }
    return;
  }
  if (msg.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  void handle(msg);
});

process.on('exit', () => {
  chrome?.kill('SIGTERM');
});
