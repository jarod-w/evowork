import { StringDecoder } from 'node:string_decoder';

/** Test-only transport fault: native write completes, exactly one RPC response is lost. */
export function createMemoryRpcFaults() {
  let armed = false;
  let writes = 0;
  let dropped = 0;
  return {
    arm() {
      armed = true;
    },
    snapshot() {
      return { writes, dropped };
    },
    attach(child) {
      let input = '';
      let output = '';
      const inputDecoder = new StringDecoder('utf8');
      const outputDecoder = new StringDecoder('utf8');
      const lostIds = new Set();
      const write = child.stdin.write;
      child.stdin.write = function (chunk, ...args) {
        input += inputDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const lines = input.split('\n');
        input = lines.pop();
        for (const line of lines) {
          let request;
          try {
            request = JSON.parse(line);
          } catch {
            continue;
          }
          if (request.method === 'externalAgentConfig/import') {
            writes++;
            if (armed) {
              armed = false;
              lostIds.add(request.id);
            }
          }
        }
        return write.call(this, chunk, ...args);
      };
      const emit = child.stdout.emit;
      child.stdout.emit = function (event, ...args) {
        if (event !== 'data') return emit.call(this, event, ...args);
        output += outputDecoder.write(Buffer.isBuffer(args[0]) ? args[0] : Buffer.from(args[0]));
        const lines = output.split('\n');
        output = lines.pop();
        const kept = lines.filter((line) => {
          let response;
          try {
            response = JSON.parse(line);
          } catch {
            return true;
          }
          if (!response.method && lostIds.delete(response.id)) {
            dropped++;
            return false;
          }
          return true;
        });
        return kept.length ? emit.call(this, event, Buffer.from(kept.join('\n') + '\n')) : true;
      };
    },
  };
}
