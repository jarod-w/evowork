import { StringDecoder } from 'node:string_decoder';

/** Test-only faults around the actual kernel transport; no model or kernel replacement. */
export function createDeliveryRpcFaults() {
  const rules = new Map();
  const counts = {};
  const held = [];
  let dropped = 0;
  return {
    arm(method, kind, persistent = false) {
      rules.set(method, { kind, persistent });
    },
    clear() {
      rules.clear();
    },
    release() {
      for (const resume of held.splice(0)) resume();
    },
    snapshot() {
      return { counts: { ...counts }, held: held.length, dropped };
    },
    attach(child) {
      const lost = new Set();
      const delayed = new Set();
      let incoming = '';
      let outgoing = '';
      const inputDecoder = new StringDecoder('utf8');
      const outputDecoder = new StringDecoder('utf8');
      const write = child.stdin.write;
      const emit = child.stdout.emit;
      const deliver = (message) =>
        emit.call(child.stdout, 'data', Buffer.from(JSON.stringify(message) + '\n'));
      child.stdin.write = function (chunk, ...args) {
        incoming += inputDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const lines = incoming.split('\n');
        incoming = lines.pop();
        for (const line of lines) {
          let request;
          try {
            request = JSON.parse(line);
          } catch {
            write.call(this, line + '\n');
            continue;
          }
          if (!request.method) {
            write.call(this, line + '\n');
            continue;
          }
          counts[request.method] = (counts[request.method] ?? 0) + 1;
          const rule = rules.get(request.method);
          if (rule && !rule.persistent) rules.delete(request.method);
          if (rule?.kind === 'reject' || rule?.kind === 'unavailable') {
            queueMicrotask(() =>
              deliver({
                id: request.id,
                error: {
                  code: rule.kind === 'reject' ? -32602 : -32601,
                  message: 'Controlled delivery fault',
                },
              }),
            );
          } else if (rule?.kind === 'hold-request') {
            held.push(() => write.call(this, line + '\n'));
          } else if (rule?.kind === 'drop-request') {
            dropped++;
          } else {
            if (rule?.kind === 'drop-response') lost.add(request.id);
            if (rule?.kind === 'hold-response') delayed.add(request.id);
            write.call(this, line + '\n');
          }
        }
        const cb = args.find((arg) => typeof arg === 'function');
        if (cb) queueMicrotask(cb);
        return true;
      };
      child.stdout.emit = function (event, ...args) {
        if (event !== 'data') return emit.call(this, event, ...args);
        outgoing += outputDecoder.write(Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(args[0]));
        const lines = outgoing.split('\n');
        outgoing = lines.pop();
        for (const line of lines) {
          let response;
          try {
            response = JSON.parse(line);
          } catch {
            emit.call(this, event, Buffer.from(line + '\n'));
            continue;
          }
          if (!response.method && lost.delete(response.id)) {
            dropped++;
            continue;
          }
          if (!response.method && delayed.delete(response.id)) {
            held.push(() => deliver(response));
            continue;
          }
          emit.call(this, event, Buffer.from(line + '\n'));
        }
        return true;
      };
    },
  };
}
