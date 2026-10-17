/** Local file delivery. Task identity comes exclusively from native MCP metadata. */
import { createInterface } from 'node:readline';
const tools = [
  {
    name: 'list_files',
    description:
      '分页列出本任务登记的文件与工作目录新发现的变化，每页至多100项。nextCursor 非空时传入 cursor 继续；只返回元数据。来源待确认的文件不能声称由本任务生成。',
    inputSchema: {
      type: 'object',
      properties: { cursor: { type: 'string' } },
      additionalProperties: false,
    },
  },
  ...['register_file', 'open_file'].map((name) => ({
    name,
    description:
      name === 'open_file'
        ? '在用户当前任务的结果区明确打开一个工作目录内文件。生成或更新交付文件后调用本工具；不依赖回复文案自动打开。'
        : '登记本任务实际生成或修改的工作目录内文件。仅登记已存在的普通文件，不能认领用户原有或其他任务文件。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } },
      required: ['path'],
      additionalProperties: false,
    },
  })),
];
function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
async function dispatch(message) {
  if (message.id === undefined) return;
  if (message.method === 'initialize')
    return send(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'evowork-workspace-files', version: '1.0.0' },
    });
  if (message.method === 'ping') return send(message.id, {});
  if (message.method === 'tools/list') return send(message.id, { tools });
  try {
    const params = message.params ?? {},
      meta = params._meta ?? {};
    if (
      message.method !== 'tools/call' ||
      !tools.some((tool) => tool.name === params.name) ||
      typeof meta.threadId !== 'string' ||
      typeof meta.sessionId !== 'string'
    )
      throw new Error('文件调用身份不可用。');
    const response = await fetch(process.env.EVOWORK_FILES_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + process.env.EVOWORK_FILES_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        threadId: meta.threadId,
        sessionId: meta.sessionId,
        name: params.name,
        arguments: params.arguments,
      }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error',
    });
    const result = await response.json();
    send(message.id, {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      ...(response.ok ? {} : { isError: true }),
    });
  } catch {
    send(message.id, {
      content: [{ type: 'text', text: '文件操作未完成，请检查本任务的文件记录后重试。' }],
      isError: true,
    });
  }
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  if (line.length > 65536) return;
  try {
    void dispatch(JSON.parse(line));
  } catch {
    /* malformed request never performs I/O */
  }
});
