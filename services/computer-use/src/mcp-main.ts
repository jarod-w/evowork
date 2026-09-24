import { connect } from 'node:net';
import { createComputerUseMcp } from './mcp.js';
import type { McpContent } from './mcp.js';
import { encodeFrame, FrameDecoder } from './framing.js';
import { ComputerUseError } from './protocol.js';
const path = process.env.EVOWORK_CUA_SOCKET;
const token = process.env.EVOWORK_CUA_SESSION_TOKEN;
if (!path || !token) process.exit(1);
let sequence = 0;
const handle = createComputerUseMcp(
  (payload) =>
    new Promise((resolve, reject) => {
      const socket = connect(path);
      const decoder = new FrameDecoder();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new ComputerUseError('TIMEOUT'));
      }, 30000);
      socket.on('connect', () =>
        socket.write(encodeFrame({ token, sequence: ++sequence, payload })),
      );
      socket.on('data', (chunk: Buffer) => {
        try {
          for (const value of decoder.push(chunk)) {
            const reply = value as {
              ok?: boolean;
              result?: { content: McpContent[]; isError?: boolean };
            };
            if (!reply.ok || !reply.result) reject(new ComputerUseError('POLICY_DENIED'));
            else resolve(reply.result);
            socket.end();
          }
        } catch {
          socket.destroy();
          reject(new ComputerUseError('INTERNAL'));
        }
      });
      socket.on('error', () => reject(new ComputerUseError('INTERNAL')));
      socket.on('close', () => {
        clearTimeout(timer);
        reject(new ComputerUseError('USER_STOPPED'));
      });
    }),
);
let input = '';
let queue = Promise.resolve();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  input += chunk;
  if (Buffer.byteLength(input) > 1024 * 1024) process.exit(1);
  let end: number;
  while ((end = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    queue = queue
      .then(async () => {
        let request: unknown;
        try {
          request = JSON.parse(line);
        } catch {
          process.stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Parse error' },
            }) + '\n',
          );
          return;
        }
        const response = await handle(request);
        if (response) process.stdout.write(JSON.stringify(response) + '\n');
      })
      .catch(() => process.exit(1));
  }
});
