import { describe, expect, it } from 'vitest';

import { createFakeGateway } from '../../apps/desktop/test/e2e/harness/fake-gateway.mjs';

describe('确定性网关的预热与采样隔离', () => {
  it('内核预热不消费下一次采样的工具剧本', async () => {
    const gateway = createFakeGateway({ turnMarker: 'HELD-TURN' });
    const baseUrl = await gateway.listen();
    const request = async (body) => {
      const response = await fetch(`${baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return response.text();
    };
    try {
      gateway.scriptNext({ tool: 'exec_command', args: { cmd: 'echo expected-tool' } });
      const warmup = await request({ generate: false, input: [] });
      const sampled = await request({ input: [{ role: 'user', content: 'run the tool' }] });
      expect(warmup).not.toContain('function_call');
      expect(sampled).toContain('expected-tool');
    } finally {
      await gateway.close();
    }
  });
});
