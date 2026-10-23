import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createModelRegistry, type ModelRegistryEntry } from '../src/capabilities.js';
import { runPipeline } from '../src/pipeline.js';
import { PRIVATE } from '../src/providers/registry.js';

const model: ModelRegistryEntry = {
  id: 'test',
  provider: 'private',
  upstreamModel: 'test',
  displayName: 'Test',
  tier: 'standard',
  verified: false,
  unverified: [],
  notes: '',
  capabilities: {
    streaming: false,
    toolCalls: true,
    parallelToolCalls: false,
    reasoning: true,
    promptCache: true,
    imageInput: false,
    maxContextTokens: 32000,
  },
};
describe('响应体限制必须在实际 HTTP 字节流上生效', () => {
  it.each(['stalled-error', 'oversized-error', 'json'])(
    '%s：真实 provider 读取与取消连接',
    async (mode) => {
      let closed = false;
      let request: { stream?: boolean } | undefined;
      const upstream = createServer(async (req, res) => {
        let body = '';
        for await (const part of req) body += part;
        request = JSON.parse(body) as { stream?: boolean };
        res.on('close', () => {
          closed = true;
        });
        res.writeHead(mode === 'json' ? 200 : 503, { 'content-type': 'application/json' });
        if (mode === 'stalled-error') res.write('{"error":');
        else if (mode === 'oversized-error')
          res.write('x'.repeat(64 * 1024 + 1)); // No newline: line splitting must also be bounded.
        else {
          const data = Buffer.from(
            JSON.stringify({
              choices: [{ message: { content: '中文42' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
            }),
          );
          const split = data.indexOf(Buffer.from('中文')) + 1;
          res.write(data.subarray(0, split));
          res.end(data.subarray(split));
        }
      });
      await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
      try {
        const events = [];
        for await (const event of runPipeline(
          { model: 'test', input: [] },
          { requestId: 'http' },
          {
            models: createModelRegistry([model]),
            providers: { private: PRIVATE },
            configFor: () => ({
              baseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
              apiKey: 'fake',
            }),
            upstreamFirstChunkMs: 100,
            upstreamIdleMs: 50,
          },
        ))
          events.push(event);
        expect(request?.stream).toBe(false);
        expect(events.at(-1)?.type).toBe(
          mode === 'json' ? 'response.completed' : 'response.failed',
        );
        if (mode === 'json')
          expect(events).toContainEqual(
            expect.objectContaining({ type: 'response.output_text.delta', delta: '中文42' }),
          );
        else await vi.waitFor(() => expect(closed).toBe(true), { timeout: 500, interval: 10 });
      } finally {
        upstream.closeAllConnections();
        await new Promise<void>((r) => upstream.close(() => r()));
      }
    },
  );
});
