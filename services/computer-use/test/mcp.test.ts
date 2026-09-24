import { describe, expect, it, vi } from 'vitest';
import { createComputerUseMcp, FrameDecoder, encodeFrame, MAX_FRAME_BYTES } from '../src/index.js';
describe('MCP 固定入口', () => {
  it('握手后列出固定工具，可信 metadata 与工具参数分离', async () => {
    const call = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const server = createComputerUseMcp(call);
    expect(await server({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toHaveProperty(
      'error.code',
      -32002,
    );
    await server({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    const list = await server({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect((list?.result as { tools: unknown[] }).tools).toHaveLength(11);
    const request = {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_apps', arguments: {}, _meta: { threadId: 't', sessionId: 's' } },
    };
    await server(request);
    expect(call).toHaveBeenCalledWith({
      name: 'list_apps',
      arguments: {},
      threadId: 't',
      sessionId: 's',
    });
    call.mockClear();
    const denied = await server({
      ...request,
      params: { name: 'list_apps', arguments: { threadId: 't' } },
    });
    expect(denied).toHaveProperty('result.isError', true);
    expect(call).not.toHaveBeenCalled();
    expect(await server({ jsonrpc: '2.0', id: 5, method: 'eval' })).toHaveProperty(
      'error.code',
      -32601,
    );
  });
  it('内部异常不回显屏幕正文', async () => {
    const server = createComputerUseMcp(async () => {
      throw new Error('PRIVATE_SCREEN');
    });
    await server({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    const result = await server({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'list_apps', _meta: { threadId: 't', sessionId: 's' } },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SCREEN');
    expect(result).toHaveProperty('result.isError', true);
  });
});
describe('本机长度帧', () => {
  it('拆包/粘包不丢帧；大于预算的帧头立即拒绝', () => {
    const first = encodeFrame({ a: '中' }),
      next = encodeFrame({ b: 2 });
    const decoder = new FrameDecoder();
    expect(decoder.push(first.subarray(0, 2))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(2), next]))).toEqual([{ a: '中' }, { b: 2 }]);
    const bad = Buffer.alloc(4);
    bad.writeUInt32BE(MAX_FRAME_BYTES + 1);
    expect(() => decoder.push(bad)).toThrow('INVALID_FRAME');
  });
});
