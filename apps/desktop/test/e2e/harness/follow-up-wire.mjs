import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Test-only upstream observation. No headers, credentials, prompt or response bodies are saved. */
export function installFollowUpWire(path) {
  const originalFetch = globalThis.fetch;
  let sequence = 0;
  globalThis.fetch = async function (input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname !== 'api.xiaomimimo.com' || !url.pathname.endsWith('/chat/completions'))
      return originalFetch.call(this, input, init);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {};
    const id = ++sequence;
    appendFileSync(
      path,
      JSON.stringify({
        type: 'request',
        pid: process.pid,
        id,
        at: Date.now(),
        endpoint: url.origin + url.pathname,
        model: body.model,
        markers: [
          ...new Set(
            JSON.stringify(body.messages ?? []).match(/REALFOLLOW_[A-Z]+_[a-f0-9]+/g) ?? [],
          ),
        ],
      }) + '\n',
    );
    let response;
    try {
      response = await originalFetch.call(this, input, init);
    } catch (error) {
      // A genuine transport failure can be retried by the product gateway. Preserve
      // its outcome without saving URLs, error messages, headers or credentials.
      const code = error?.cause?.code;
      appendFileSync(
        path,
        JSON.stringify({
          type: 'transport-error',
          pid: process.pid,
          id,
          at: Date.now(),
          name: ['AbortError', 'TimeoutError', 'TypeError'].includes(error?.name)
            ? error.name
            : 'Error',
          code:
            typeof code === 'string' &&
            /^(UND_ERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|ETIMEDOUT)$/.test(code)
              ? code
              : null,
        }) + '\n',
      );
      throw error;
    }
    appendFileSync(
      path,
      JSON.stringify({
        type: 'response',
        pid: process.pid,
        id,
        at: Date.now(),
        status: response.status,
      }) + '\n',
    );
    return response;
  };
}

export function createFollowUpObservedGatewayEntry(home, repoRoot) {
  const entry = join(home, 'follow-up-observed-gateway.mjs');
  writeFileSync(
    entry,
    `import { installFollowUpWire } from ${JSON.stringify(import.meta.url)};\n` +
      `installFollowUpWire(${JSON.stringify(join(home, 'follow-up-wire.jsonl'))});\n` +
      `const { main } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'dist/gateway/main.js')).href)});\nmain();\n`,
  );
  return entry;
}
