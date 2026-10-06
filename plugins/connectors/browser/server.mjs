#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { TOOLS, createBrowserSession } from './runtime.mjs';
import { createBrowserDriver } from './cdp.mjs';
import { RESEARCH_ERRORS } from './research.mjs';
import { assessComputerUseAction } from './vendor/policy.mjs';

const pending = new Map();
let session,
  threadId,
  running,
  initialized = false;
function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function ask(message) {
  const id = `browser_${randomUUID()}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(false);
    }, 120000);
    pending.set(id, (reply) => {
      clearTimeout(timer);
      resolve(reply?.action === 'accept' && reply.content?.scope === 'confirm');
    });
    send({
      jsonrpc: '2.0',
      id,
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message,
        requestedSchema: {
          type: 'object',
          properties: { scope: { type: 'string', enum: ['confirm', 'deny'] } },
          required: ['scope'],
        },
      },
    });
  });
}
function stop() {
  session?.stop();
  for (const resolve of pending.values()) resolve(undefined);
  pending.clear();
}
async function handle(message) {
  if (message.jsonrpc !== '2.0') return;
  if (pending.has(message.id) && !message.method) {
    pending.get(message.id)(message.result);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'notifications/cancelled') {
    if (message.params?.requestId === running) stop();
    return;
  }
  if (message.id === undefined) return;
  const result = (value) => send({ jsonrpc: '2.0', id: message.id, result: value });
  if (message.method === 'initialize') {
    initialized = true;
    result({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'evowork-browser', version: '1.0.0' },
    });
    return;
  }
  if (!initialized) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32002, message: 'Not initialized' } });
    return;
  }
  if (message.method === 'tools/list') {
    result({ tools: TOOLS });
    return;
  }
  if (message.method === 'ping') {
    result({});
    return;
  }
  if (message.method !== 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
    return;
  }
  try {
    const meta = message.params?._meta;
    if (
      !meta ||
      typeof meta.threadId !== 'string' ||
      !meta.threadId ||
      typeof meta.sessionId !== 'string' ||
      !meta.sessionId ||
      running !== undefined
    )
      throw new Error('POLICY_DENIED');
    running = message.id;
    if (threadId !== meta.threadId) {
      stop();
      threadId = meta.threadId;
      session = createBrowserSession({
        driver: createBrowserDriver(),
        ask,
        assessAction: assessComputerUseAction,
      });
    }
    result(await session.call(message.params.name, message.params.arguments ?? {}));
  } catch (error) {
    // 不把 HTTP 正文、页面 JS 异常、cookies 或模型输入复制进错误日志。
    const code = /^[A-Z_]+$/.test(error.message) ? error.message : 'INTERNAL';
    result({
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            code,
            ...(RESEARCH_ERRORS[code] ? { message: RESEARCH_ERRORS[code] } : {}),
            requires_refresh: code === 'STALE_STATE',
          }),
        },
      ],
    });
  } finally {
    if (running === message.id) running = undefined;
  }
}
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  try {
    void handle(JSON.parse(line));
  } catch {
    /* 畸形帧不回显正文。 */
  }
});
lines.on('close', stop);
process.on('SIGTERM', () => {
  stop();
  process.exit(0);
});
process.on('exit', stop);
