/** Stdio MCP transport. Provider credentials and file bytes never enter this process. */
import { createInterface } from 'node:readline';
const tools = [
  {
    name: 'image_generate',
    description:
      '生成一张 AI 图片。每次先展示最终提示词、模型和费用确认，完成后返回真实 PNG 产物与 imageRef。禁止自动重试付费请求。',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', minLength: 1, maxLength: 8000 } },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'image_edit',
    description:
      '编辑一张用户明确选择或本任务生成的图片。imageRef 只能来自选图消息或先前图片工具结果；不接受任意路径、URL。每次需上传与费用确认。原图保留。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 8000 },
        imageRef: { type: 'string', minLength: 1 },
      },
      required: ['prompt', 'imageRef'],
      additionalProperties: false,
    },
  },
];
function send(id, result, error) {
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n',
  );
}
async function dispatch(message) {
  if (message.id === undefined) return;
  if (message.method === 'initialize')
    return send(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'evowork-image-generation', version: '1.0.0' },
    });
  if (message.method === 'ping') return send(message.id, {});
  if (message.method === 'tools/list') return send(message.id, { tools });
  if (message.method !== 'tools/call')
    return send(message.id, null, { code: -32601, message: 'Unknown method' });
  try {
    const params = message.params ?? {},
      meta = params._meta ?? {};
    if (
      !tools.some((t) => t.name === params.name) ||
      typeof meta.threadId !== 'string' ||
      typeof meta.sessionId !== 'string'
    )
      throw new Error('IMAGE_CONTEXT_DENIED');
    const response = await fetch(process.env.EVOWORK_IMAGE_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.EVOWORK_IMAGE_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        threadId: meta.threadId,
        sessionId: meta.sessionId,
        name: params.name,
        arguments: params.arguments,
      }),
      signal: AbortSignal.timeout(600_000),
      redirect: 'error',
    });
    const result = await response.json();
    send(message.id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      ...(response.ok && result.status === 'completed' ? {} : { isError: true }),
    });
  } catch {
    send(message.id, {
      content: [
        {
          type: 'text',
          text: 'IMAGE_CALL_INTERRUPTED：结果可能未知，查看本任务图片操作记录。不要自动重试付费请求。',
        },
      ],
      isError: true,
    });
  }
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (line.length > 65536) return;
  try {
    void dispatch(JSON.parse(line));
  } catch {
    send(null, null, { code: -32700, message: 'Invalid JSON' });
  }
});
