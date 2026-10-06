import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { httpUrl } from './runtime.mjs';

function channel(url) {
  const socket = new WebSocket(url);
  let counter = 0;
  const pending = new Map();
  const listeners = new Map();
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('BROWSER_UNAVAILABLE')), {
      once: true,
    });
  });
  function close() {
    socket.close();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('USER_STOPPED'));
    }
    pending.clear();
  }
  socket.addEventListener('close', close);
  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      close();
      return;
    }
    const entry = pending.get(message.id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error('BROWSER_ACTION_FAILED'));
      else entry.resolve(message.result);
    } else if (message.method) {
      for (const listener of listeners.get(message.method) ?? [])
        Promise.resolve(listener(message.params)).catch(() => close());
    }
  });
  return {
    close,
    on(method, listener) {
      const list = listeners.get(method) ?? [];
      list.push(listener);
      listeners.set(method, list);
      return () =>
        listeners.set(
          method,
          (listeners.get(method) ?? []).filter((entry) => entry !== listener),
        );
    },
    async send(method, params = {}, sessionId) {
      await ready;
      if (socket.readyState !== WebSocket.OPEN) throw new Error('USER_STOPPED');
      const id = ++counter;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('TIMEOUT'));
        }, 30000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
  };
}
function chromeBinary() {
  const candidates =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : process.platform === 'win32'
        ? [
            join(
              process.env.PROGRAMFILES ?? 'C:\\Program Files',
              'Google/Chrome/Application/chrome.exe',
            ),
            join(
              process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
              'Google/Chrome/Application/chrome.exe',
            ),
          ]
        : (process.env.PATH ?? '')
            .split(':')
            .flatMap((directory) =>
              ['google-chrome', 'chromium', 'chromium-browser'].map((name) =>
                join(directory, name),
              ),
            );
  const binary = candidates.find(existsSync);
  if (!binary) throw new Error('BROWSER_UNAVAILABLE');
  return binary;
}
export function createBrowserDriver({
  downloadsDirectory = join(homedir(), 'Downloads'),
  fetchFn = fetch,
} = {}) {
  let child, page, browser, profile, starting;
  let originGuard;
  let closed = false;
  let deniedNavigation = false;
  const downloads = new Set();
  function close() {
    closed = true;
    for (const controller of downloads) controller.abort();
    page?.close();
    browser?.close();
    child?.kill();
    // Chrome 退出前还会写 profile，退出事件之后再清理，避免 ENOTEMPTY 竞态。
    if (profile && (!child || child.exitCode !== null || child.signalCode !== null)) {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      profile = undefined;
    }
  }
  async function start() {
    if (closed) throw new Error('USER_STOPPED');
    if (page) return;
    if (starting) return starting;
    starting = (async () => {
      profile = mkdtempSync(join(tmpdir(), 'evowork-browser-'));
      child = spawn(
        chromeBinary(),
        [
          '--remote-debugging-port=0',
          '--headless=new',
          '--no-first-run',
          '--disable-background-networking',
          '--disable-extensions',
          '--disable-component-extensions-with-background-pages',
          `--user-data-dir=${profile}`,
          'about:blank',
        ],
        { stdio: 'ignore' },
      );
      child.on('error', close);
      child.on('exit', close);
      const deadline = Date.now() + 8000;
      let endpoint;
      while (Date.now() < deadline) {
        if (closed) throw new Error('BROWSER_UNAVAILABLE');
        try {
          const { readFile } = await import('node:fs/promises');
          const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8'))
            .trim()
            .split('\n');
          if (/^\d+$/.test(port)) {
            endpoint = `http://127.0.0.1:${port}`;
            break;
          }
        } catch {
          /* 只等待本次专用 profile 的就绪文件。 */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!endpoint) throw new Error('BROWSER_UNAVAILABLE');
      const version = await (await fetchFn(`${endpoint}/json/version`)).json();
      const targets = await (await fetchFn(`${endpoint}/json/list`)).json();
      const target = targets.find((entry) => entry.type === 'page');
      if (!target?.webSocketDebuggerUrl || !version.webSocketDebuggerUrl)
        throw new Error('BROWSER_UNAVAILABLE');
      browser = channel(version.webSocketDebuggerUrl);
      page = channel(target.webSocketDebuggerUrl);
      // 新窗口、worker 和独立 iframe 在执行脚本前暂停；当前版本只支持一个受控页面。
      // 它们不能绕过当前页面的 Fetch origin 守卫；出现时结束整个专用浏览器。
      browser.on('Target.attachedToTarget', async ({ sessionId, targetInfo }) => {
        if (targetInfo.targetId !== target.id) {
          close();
          return;
        }
        await browser.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
        await browser.send('Target.detachFromTarget', { sessionId });
      });
      await browser.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [
          { type: 'tab', exclude: true },
          { type: 'browser', exclude: true },
          { type: 'browser_ui', exclude: true },
          {},
        ],
      });
      await browser.send('Browser.setDownloadBehavior', { behavior: 'deny' });
      await page.send('Page.enable');
      page.on('Fetch.requestPaused', async ({ requestId, request }) => {
        try {
          await originGuard(request.url);
          await page.send('Fetch.continueRequest', { requestId });
        } catch {
          deniedNavigation = true;
          await page.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
        }
      });
      await page.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      // 页面会派生专用 worker / iframe；浏览器层的自动附着不会递归到所有子目标。
      page.on('Target.attachedToTarget', () => close());
      await page.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
    })();
    try {
      await starting;
    } catch (error) {
      close();
      throw error;
    } finally {
      starting = undefined;
    }
  }
  async function evaluate(expression) {
    const result = await page.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error('BROWSER_ACTION_FAILED');
    return result.result.value;
  }
  return {
    close,
    setOriginGuard(guard) {
      originGuard = guard;
    },
    async navigate(url) {
      await start();
      deniedNavigation = false;
      let timer, unsubscribe;
      const loaded = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('TIMEOUT')), 30000);
        unsubscribe = page.on('Page.loadEventFired', resolve);
      });
      // 先挂拒绝处理，导航失败时不能留下未处理的超时 Promise。
      loaded.catch(() => {});
      try {
        const result = await page.send('Page.navigate', { url });
        if (result.errorText || deniedNavigation) throw new Error('POLICY_DENIED');
        await loaded;
        if (deniedNavigation) throw new Error('POLICY_DENIED');
      } finally {
        clearTimeout(timer);
        unsubscribe();
      }
    },
    async snapshot() {
      await start();
      if (deniedNavigation) throw new Error('POLICY_DENIED');
      const info = await evaluate(
        '({url: location.href, title: document.title, text: (document.body?.innerText ?? "").slice(0, 65536), scrollX: window.scrollX, scrollY: window.scrollY, oversizedField: [...document.querySelectorAll("input,textarea,[contenteditable]")].some(e => !["password", "file"].includes(e.type) && String(e.value ?? e.textContent ?? "").length > 65536), integrityText: JSON.stringify([(document.body?.innerText ?? ""), [...document.querySelectorAll("input,textarea,[contenteditable]")].filter(e => !["password", "file"].includes(e.type)).map(e => [e.name,e.value ?? e.textContent])])})',
      );
      if (info.oversizedField || Buffer.byteLength(info.integrityText) > 1024 * 1024)
        throw new Error('POLICY_DENIED');
      info.integrity = createHash('sha256').update(info.integrityText).digest('hex');
      delete info.integrityText;
      delete info.oversizedField;
      const root = await page.send('DOM.getDocument', { depth: -1, pierce: true });
      const elements = [];
      async function visit(node) {
        const attributes = Object.fromEntries(
          Array.from({ length: (node.attributes?.length ?? 0) / 2 }, (_, index) => [
            node.attributes[index * 2],
            node.attributes[index * 2 + 1],
          ]),
        );
        if (
          ['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT'].includes(node.nodeName) ||
          attributes.role === 'button' ||
          attributes.contenteditable === 'true'
        ) {
          if (elements.length >= 500) return;
          try {
            const { model } = await page.send('DOM.getBoxModel', { nodeId: node.nodeId });
            if (model.width > 0 && model.height > 0) {
              const object = await page.send('DOM.resolveNode', { nodeId: node.nodeId });
              const state = await page.send('Runtime.callFunctionOn', {
                objectId: object.object.objectId,
                functionDeclaration:
                  'function(){ return {text:(this.innerText || this.textContent || "").slice(0,1024), value:this.type === "password" ? "" : (this.value || "").slice(0,65536)} }',
                returnByValue: true,
              });
              elements.push({
                element_index: elements.length + 1,
                backendNodeId: node.backendNodeId,
                role: attributes.role ?? node.nodeName.toLowerCase(),
                label:
                  attributes['aria-label'] ??
                  attributes.title ??
                  attributes.placeholder ??
                  state.result.value.text,
                type: (attributes.type ?? '').toLowerCase(),
                editable:
                  ['INPUT', 'TEXTAREA'].includes(node.nodeName) ||
                  attributes.contenteditable === 'true',
                enabled:
                  !Object.hasOwn(attributes, 'disabled') && attributes['aria-disabled'] !== 'true',
                value: state.result.value.value,
                bounds: model.border,
              });
              await page.send('Runtime.releaseObject', { objectId: object.object.objectId });
            }
          } catch {
            /* 不可见/消失的元素不进入可操作清单。 */
          }
        }
        for (const child of [
          ...(node.children ?? []),
          ...(node.shadowRoots ?? []),
          ...(node.contentDocument ? [node.contentDocument] : []),
        ])
          await visit(child);
      }
      await visit(root.root);
      return { ...info, elements };
    },
    async screenshot() {
      await start();
      return (await page.send('Page.captureScreenshot', { format: 'png' })).data;
    },
    async action(name, element, args) {
      await start();
      if (deniedNavigation) throw new Error('POLICY_DENIED');
      if (name === 'browser_scroll') {
        const vertical = ['up', 'down'].includes(args.direction);
        const sign = ['down', 'right'].includes(args.direction) ? 1 : -1;
        await evaluate(
          `window.scrollBy(${vertical ? 0 : sign * args.pages * 500},${vertical ? sign * args.pages * 500 : 0})`,
        );
      } else if (name === 'browser_click') {
        const box = (await page.send('DOM.getBoxModel', { backendNodeId: element.backendNodeId }))
          .model.border;
        const x = (box[0] + box[4]) / 2,
          y = (box[1] + box[5]) / 2;
        const hit = await page.send('DOM.getNodeForLocation', {
          x: Math.floor(x),
          y: Math.floor(y),
        });
        const targetNode = await page.send('DOM.resolveNode', {
          backendNodeId: element.backendNodeId,
        });
        const hitNode = await page.send('DOM.resolveNode', { backendNodeId: hit.backendNodeId });
        try {
          const check = await page.send('Runtime.callFunctionOn', {
            objectId: targetNode.object.objectId,
            functionDeclaration: 'function(hit){return this === hit || this.contains(hit)}',
            arguments: [{ objectId: hitNode.object.objectId }],
            returnByValue: true,
          });
          if (check.result.value !== true) throw new Error('STALE_STATE');
        } finally {
          await page.send('Runtime.releaseObject', { objectId: targetNode.object.objectId });
          await page.send('Runtime.releaseObject', { objectId: hitNode.object.objectId });
        }
        await page.send('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
        await page.send('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: 'left',
          clickCount: 1,
        });
      } else {
        await page.send('DOM.focus', { backendNodeId: element.backendNodeId });
        if (name === 'browser_fill') {
          if (!element.editable) throw new Error('POLICY_DENIED');
          const resolved = await page.send('DOM.resolveNode', {
            backendNodeId: element.backendNodeId,
          });
          const changed = await page.send('Runtime.callFunctionOn', {
            objectId: resolved.object.objectId,
            functionDeclaration:
              'function(value){ if(this.tagName === "INPUT" || this.tagName === "TEXTAREA") { const proto = this.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype; Object.getOwnPropertyDescriptor(proto,"value").set.call(this,value); } else if(this.isContentEditable) this.textContent=value; else throw new Error(); this.dispatchEvent(new Event("input",{bubbles:true})); this.dispatchEvent(new Event("change",{bubbles:true})); }',
            arguments: [{ value: args.text }],
            returnByValue: true,
          });
          await page.send('Runtime.releaseObject', { objectId: resolved.object.objectId });
          if (changed.exceptionDetails) throw new Error('BROWSER_ACTION_FAILED');
        } else {
          const codes = {
            Enter: 13,
            Tab: 9,
            Escape: 27,
            Backspace: 8,
            Delete: 46,
            ArrowLeft: 37,
            ArrowUp: 38,
            ArrowRight: 39,
            ArrowDown: 40,
          };
          await page.send('Input.dispatchKeyEvent', {
            type: 'keyDown',
            key: args.key,
            windowsVirtualKeyCode: codes[args.key],
            ...(args.key === 'Enter' ? { text: '\r' } : {}),
          });
          await page.send('Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: args.key,
            windowsVirtualKeyCode: codes[args.key],
          });
        }
      }
    },
    async download(input, filename, guard) {
      await start();
      let url = httpUrl(input),
        response;
      const controller = new AbortController();
      downloads.add(controller);
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]);
      try {
        for (let hop = 0; hop < 6; hop++) {
          await guard(url.href);
          const cookies = (await page.send('Network.getCookies', { urls: [url.href] })).cookies;
          response = await fetchFn(url.href, {
            redirect: 'manual',
            signal,
            headers: cookies.length
              ? { Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ') }
              : {},
          });
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            const location = response.headers.get('location');
            if (!location) throw new Error('DOWNLOAD_FAILED');
            url = httpUrl(new URL(location, url).href);
            continue;
          }
          break;
        }
        if (!response?.ok || !response.body) throw new Error('DOWNLOAD_FAILED');
        const limit = 50 * 1024 * 1024;
        if (Number(response.headers.get('content-length')) > limit) {
          await response.body.cancel();
          throw new Error('DOWNLOAD_TOO_LARGE');
        }
        const suggested =
          filename ??
          /filename="([^"\r\n]+)"/i.exec(response.headers.get('content-disposition') ?? '')?.[1] ??
          basename(url.pathname) ??
          'download';
        const safe = basename(suggested)
          // eslint-disable-next-line no-control-regex -- 下载文件名的控制字符不能进入文件系统。
          .replace(/[\\/\x00-\x1f:*?"<>|]/g, '_')
          .slice(0, 180);
        if (!safe || safe === '.' || safe === '..') throw new Error('POLICY_DENIED');
        mkdirSync(downloadsDirectory, { recursive: true });
        const path = join(downloadsDirectory, `${randomUUID().slice(0, 8)}-${safe}`);
        if (closed) throw new Error('USER_STOPPED');
        const file = await open(path, 'wx', 0o600);
        let size = 0;
        try {
          for await (const chunk of response.body) {
            if (closed) throw new Error('USER_STOPPED');
            size += chunk.length;
            if (size > limit) throw new Error('DOWNLOAD_TOO_LARGE');
            await file.writeFile(chunk);
          }
          await file.close();
          return { path, bytes: size };
        } catch (error) {
          await file.close();
          await unlink(path);
          throw error;
        }
      } finally {
        downloads.delete(controller);
      }
    },
  };
}
