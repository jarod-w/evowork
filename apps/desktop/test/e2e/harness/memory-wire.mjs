import { appendFileSync, writeFileSync } from 'node:fs';
import { Server } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Test-only observation: retain boolean evidence, never headers or request bodies. */
export function installMemoryWire(path) {
  const emit = Server.prototype.emit;
  Server.prototype.emit = function (event, ...args) {
    if (event === 'request') {
      const [request, response] = args;
      if (request.method === 'POST' && request.url?.split('?')[0].endsWith('/responses')) {
        const chunks = [];
        let size = 0;
        // Observe emitted bytes without adding a data listener (which would change stream flow).
        const requestEmit = request.emit;
        request.emit = function (name, ...values) {
          if (name === 'data') {
            const [chunk] = values;
            size += chunk.length;
            if (size <= 16 * 1024 * 1024) chunks.push(chunk);
          }
          if (name === 'end') {
            if (size > 16 * 1024 * 1024) throw new Error('Memory wire fixture limit exceeded');
            const body = JSON.parse(Buffer.concat(chunks).toString());
            const text = JSON.stringify(body);
            const developer = JSON.stringify(
              (body.input ?? []).filter((item) => item.role === 'developer'),
            );
            response.on('finish', () => {
              appendFileSync(
                `${path}.outcomes`,
                JSON.stringify({
                  model: body.model,
                  cases: [...new Set(text.match(/MEMORY_REAL_[A-Z_0-9]+/g) ?? [])],
                  status: response.statusCode,
                }) + '\n',
              );
            });
            appendFileSync(
              path,
              JSON.stringify({
                model: body.model,
                cases: [...new Set(text.match(/MEMORY_REAL_[A-Z_0-9]+/g) ?? [])],
                memoryContext:
                  developer.includes('## Memory') && developer.includes('MEMORY_SUMMARY'),
                alphaInDeveloper: developer.includes('ALPHA_WEEKLY_'),
                betaInDeveloper: developer.includes('BETA_WEEKLY_'),
                alphaAnywhere: text.includes('ALPHA_WEEKLY_'),
                betaAnywhere: text.includes('BETA_WEEKLY_'),
                personalInDeveloper: developer.includes('WB_PERSONAL_'),
                personalAnywhere: text.includes('WB_PERSONAL_'),
                consolidation: text.includes('## Memory Writing Agent: Phase 2 (Consolidation)'),
                sourceDiff: (body.input ?? []).some(
                  (item) =>
                    item.type === 'function_call_output' &&
                    JSON.stringify(item.output).includes('# Memory Workspace Diff') &&
                    JSON.stringify(item.output).includes('ALPHA_WEEKLY_') &&
                    JSON.stringify(item.output).includes('BETA_WEEKLY_') &&
                    JSON.stringify(item.output).includes('WB_PERSONAL_'),
                ),
                workbuddyImport: text.includes('WORKBUDDY_TEXT_IMPORT_V1'),
                workbuddyToolCall: (body.input ?? []).some(
                  (item) => item.type === 'function_call' && item.name === 'add_ad_hoc_note',
                ),
              }) + '\n',
            );
          }
          return requestEmit.call(this, name, ...values);
        };
      }
    }
    return emit.call(this, event, ...args);
  };
}

export function createObservedGatewayEntry(home, repoRoot) {
  const entry = join(home, 'observed-gateway.mjs');
  writeFileSync(
    entry,
    `import { installMemoryWire } from ${JSON.stringify(import.meta.url)};\n` +
      `installMemoryWire(${JSON.stringify(join(home, 'memory-wire.jsonl'))});\n` +
      `const { main } = await import(${JSON.stringify(pathToFileURL(join(repoRoot, 'dist/gateway/main.js')).href)});\nmain();\n`,
  );
  return entry;
}
