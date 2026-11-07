import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { createDeliveryRpcFaults } from '../../services/kernel-adapter/test-support/delivery-rpc-faults.mjs';

it('retains RPC failure and resume identity metadata without copying private protocol payloads', () => {
  const child = { stdin: new PassThrough(), stdout: new EventEmitter() };
  const outgoing = [];
  child.stdout.on('data', (data) => outgoing.push(JSON.parse(data.toString())));
  const faults = createDeliveryRpcFaults();
  faults.attach(child);
  const exchange = (request, response) => {
    child.stdin.write(JSON.stringify(request) + '\n');
    child.stdout.emit('data', Buffer.from(JSON.stringify(response) + '\n'));
  };
  const error = {
    id: 1,
    error: { code: -32600, message: 'PRIVATE_ERROR_CONTENT', data: { secret: 'PRIVATE_DATA' } },
  };
  exchange({ id: 1, method: 'thread/resume', params: { threadId: 'PRIVATE_THREAD' } }, error);
  const resumed = {
    id: 2,
    result: {
      thread: { id: 'PRIVATE_THREAD', status: { type: 'idle' }, turns: [{ text: 'PRIVATE_BODY' }] },
    },
  };
  exchange({ id: 2, method: 'thread/resume', params: { threadId: 'PRIVATE_THREAD' } }, resumed);
  const other = {
    id: 3,
    result: { thread: { id: 'PRIVATE_OTHER_THREAD', status: { type: 'notLoaded' } } },
  };
  exchange({ id: 3, method: 'thread/resume', params: { threadId: 'PRIVATE_THREAD' } }, other);
  expect(outgoing).toEqual([error, resumed, other]);
  expect(faults.snapshot()).toMatchObject({
    counts: { 'thread/resume': 3 },
    held: 0,
    dropped: 0,
    rpcErrors: [{ method: 'thread/resume', code: -32600 }],
    resumeResults: [
      { success: false, sameThread: false, status: 'unknown' },
      { success: true, sameThread: true, status: 'idle' },
      { success: true, sameThread: false, status: 'notLoaded' },
    ],
  });
  expect(JSON.stringify(faults.snapshot())).not.toContain('PRIVATE_');
});
