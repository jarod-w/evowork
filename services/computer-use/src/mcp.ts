import { TOOLS, validateToolCall, ComputerUseError } from './protocol.js';
export interface McpHostCall {
  name: string;
  arguments: Record<string, unknown>;
  threadId: string;
  sessionId: string;
}
export interface McpContent {
  type: 'text' | 'image';
  text?: string;
  data?: string;
  mimeType?: string;
}
export function createComputerUseMcp(
  call: (input: McpHostCall) => Promise<{ content: McpContent[]; isError?: boolean }>,
) {
  let initialized = false;
  return async (raw: unknown): Promise<Record<string, unknown> | undefined> => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    const r = raw as Record<string, unknown>;
    if (r.id === undefined) return undefined;
    const respond = (result: unknown) => ({ jsonrpc: '2.0', id: r.id, result });
    const error = (code: number, message: string) => ({
      jsonrpc: '2.0',
      id: r.id,
      error: { code, message },
    });
    if (r.jsonrpc !== '2.0' || (typeof r.id !== 'string' && typeof r.id !== 'number'))
      return error(-32600, 'Invalid request');
    if (r.method === 'initialize') {
      initialized = true;
      return respond({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'cua_repl', version: '1.0.0' },
      });
    }
    if (!initialized) return error(-32002, 'Not initialized');
    if (r.method === 'ping') return respond({});
    if (r.method === 'tools/list') return respond({ tools: TOOLS });
    if (r.method !== 'tools/call') return error(-32601, 'Method not found');
    try {
      const p = r.params as Record<string, unknown> | undefined;
      if (!p || typeof p.name !== 'string') return error(-32602, 'Invalid parameters');
      const args = validateToolCall(p.name, p.arguments ?? {});
      const meta = p._meta as Record<string, unknown> | undefined;
      // 内核填充的工具调用 metadata；工具 arguments 不接受这些字段。
      if (
        !meta ||
        typeof meta.threadId !== 'string' ||
        typeof meta.sessionId !== 'string' ||
        !meta.threadId ||
        !meta.sessionId
      )
        throw new ComputerUseError('POLICY_DENIED');
      return respond(
        await call({
          name: p.name,
          arguments: args,
          threadId: meta.threadId,
          sessionId: meta.sessionId,
        }),
      );
    } catch (err) {
      const code = err instanceof ComputerUseError ? err.code : 'INTERNAL';
      return respond({
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, code, message: code }) }],
      });
    }
  };
}
