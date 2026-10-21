/** Bundled stdio MCP: propose only; the host authenticates the actual kernel call. */
import { createInterface } from 'node:readline';
export const tools = [
  {
    name: 'propose_next_actions',
    description:
      '每个回合结束前登记一次下一步状态，包括纯文本计划/说明和追问回合；不执行、不排队。当前请求范围内的工作必须先完成，不得转成建议。等待用户回答时 outcome=needs_input 且 actions=[]；没有有价值的下一步也返回空列表。用户明确说出的下一阶段目标应优先成为候选；“本轮只做分析、先不制作汇报”限制执行范围，不禁止建议，不应据此返回空列表。没有适合的下一步或用户不要建议时允许空列表。不要推荐已完成操作，不编造目标地址、文件或收件人。回合结束前提交，随后正常交付最终回复。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        outcome: { type: 'string', enum: ['delivered', 'needs_input'] },
        actions: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string', minLength: 1, maxLength: 80 },
              prompt: { type: 'string', minLength: 1, maxLength: 2000 },
              reason: { type: 'string', maxLength: 300 },
            },
            required: ['title', 'prompt'],
          },
        },
      },
      required: ['outcome', 'actions'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
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
      serverInfo: { name: 'evowork-next-actions', version: '1.0.0' },
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
      throw new Error();
    const response = await fetch(process.env.EVOWORK_NEXT_ACTIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.EVOWORK_NEXT_ACTIONS_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        threadId: meta.threadId,
        name: params.name,
        arguments: params.arguments ?? {},
      }),
      signal: AbortSignal.timeout(600_000),
      redirect: 'error',
    });
    const result = await response.json();
    send(message.id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      ...(response.ok ? {} : { isError: true }),
    });
  } catch {
    send(message.id, {
      content: [
        {
          type: 'text',
          text: '下一步建议未能保存。继续交付当前任务，不重试、不影响最终回复。',
        },
      ],
      isError: true,
    });
  }
}
if (process.env.EVOWORK_NEXT_ACTIONS_LIBRARY !== '1') {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', (line) => {
    if (line.length > 65536) return;
    try {
      void dispatch(JSON.parse(line));
    } catch {
      send(null, null, { code: -32700, message: 'Invalid JSON' });
    }
  });
}
