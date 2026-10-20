import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createNextActions, type Adapter } from '@evowork/kernel-adapter';
import type { Store } from '@evowork/store';

export function patchNextActionsConfig(content: string, command: string, server: string): string {
  let skip = false;
  const kept = content.split('\n').filter((line) => {
    const section = /^\s*\[([^\]]+)\]/.exec(line)?.[1];
    if (section)
      skip =
        section === 'mcp_servers.next_actions' || section.startsWith('mcp_servers.next_actions.');
    return !skip;
  });
  return (
    kept.join('\n').trimEnd() +
    '\n\n[mcp_servers.next_actions]\ncommand = ' +
    JSON.stringify(command) +
    '\nargs = [' +
    JSON.stringify(server) +
    ']\nenv = { ELECTRON_RUN_AS_NODE = "1" }\nenv_vars = ["EVOWORK_NEXT_ACTIONS_ENDPOINT", "EVOWORK_NEXT_ACTIONS_TOKEN"]\nstartup_timeout_sec = 15\ntool_timeout_sec = 30\ndefault_tools_approval_mode = "approve"\n'
  );
}
export function createNextActionsHost(options: {
  store: Store;
  adapter: () => Adapter;
  changed: (threadId: string) => void;
}) {
  let token = randomBytes(32).toString('base64url');
  const service = createNextActions(options);
  async function call(threadId: string, name: string, raw: unknown) {
    if (name !== 'propose_next_actions') throw new Error('建议工具无效。');
    return service.propose(threadId, raw);
  }
  const server = createServer((req, res) => {
    if (
      req.method !== 'POST' ||
      req.url !== '/call' ||
      req.headers.authorization !== 'Bearer ' + token
    ) {
      res.writeHead(403).end();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 65536) req.destroy();
      else chunks.push(chunk);
    });
    req.on('end', () => {
      void (async () => {
        try {
          const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            threadId?: unknown;
            name?: unknown;
            arguments?: unknown;
          };
          if (typeof input.threadId !== 'string' || typeof input.name !== 'string')
            throw new Error('来源会话无效。');
          const result = await call(input.threadId, input.name, input.arguments);
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
              error: error instanceof Error ? error.message : '下一步建议失败。',
            }),
          );
        }
      })();
    });
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  void ready.catch(() => undefined);
  return {
    service,
    ready,
    call,
    get environment() {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('下一步建议服务未就绪。');
      return {
        EVOWORK_NEXT_ACTIONS_ENDPOINT: 'http://127.0.0.1:' + address.port + '/call',
        EVOWORK_NEXT_ACTIONS_TOKEN: token,
      };
    },
    rotate() {
      token = randomBytes(32).toString('base64url');
      service.interrupted();
    },
    close() {
      service.interrupted();
      server.close();
    },
  };
}
