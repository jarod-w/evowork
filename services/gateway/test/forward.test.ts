/**
 * 本机网关的 hosted 转发（D11 / 11 §12 第 16 条）。
 *
 * Q14 对这一跳一视同仁：日志里不能出现 prompt。
 */
import { createLogger, memorySink } from '@evowork/logging';
import { describe, expect, it } from 'vitest';

import { forwardHosted, hostedModelsUrl, hostedResponsesUrl } from '../src/forward.js';

describe('hostedResponsesUrl', () => {
  it('base 已经以 /v1 结尾时只补 /responses', () => {
    expect(hostedResponsesUrl('https://id.example/v1')).toBe('https://id.example/v1/responses');
  });

  it('models 端点同样只补一次 /v1', () => {
    expect(hostedModelsUrl('https://gw.corp.example/v1')).toBe(
      'https://gw.corp.example/v1/evowork/models',
    );
  });
});

describe('forwardHosted', () => {
  it('把整段请求体转到上游，日志里只有 status / 时延 / 模型，没有正文', async () => {
    const sink = memorySink();
    const logger = createLogger({ service: 'gateway', sink });
    const secret = '把data下的三张表合并按季度对比毛利率';
    let posted: string | undefined;
    const out = await forwardHosted({
      upstreamBaseUrl: 'https://cloud.example/v1',
      accessJwt: 'jwt-placeholder',
      body: JSON.stringify({ model: 'evowork/hosted-flash', input: secret }),
      model: 'evowork/hosted-flash',
      logger,
      fetchImpl: (async (url, init) => {
        expect(String(url)).toBe('https://cloud.example/v1/responses');
        expect((init?.headers as Record<string, string>).authorization).toBe(
          'Bearer jwt-placeholder',
        );
        posted = String(init?.body);
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch,
    });
    expect(out.status).toBe(200);
    expect(posted).toContain(secret);
    const logText = sink.text();
    expect(logText).toContain('gateway.forward.completed');
    expect(logText).not.toContain(secret);
  });
});
