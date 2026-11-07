import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
const original = globalThis.fetch;
let sequence = 0;
const safe = (value) =>
  typeof value === 'string' && /^[a-zA-Z0-9_./:-]{1,160}$/.test(value) ? value : undefined;
function jsonShape(value) {
  try {
    const parsed = JSON.parse(value.trim() || '{}');
    return {
      valid: true,
      root: parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed,
    };
  } catch (error) {
    const offset = /position\s+(\d+)/.exec(error.message);
    return { valid: false, root: 'invalid', ...(offset ? { position: Number(offset[1]) } : {}) };
  }
}
if (original && process.env.EVOWORK_TOOL_DIAGNOSTICS)
  globalThis.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    if (
      !/^https:\/\/(?:api\.xiaomimimo\.com|api\.deepseek\.com)\//.test(url) ||
      !url.endsWith('/chat/completions')
    )
      return original.apply(this, arguments);
    const id = ++sequence;
    let body = {};
    const requestBodyObserved = typeof init?.body === 'string';
    try {
      body = JSON.parse(init?.body ?? '{}');
    } catch {
      // 观察器不改变请求；无效 JSON 留给网关按原路径处理。
    }
    const names = (body.tools ?? []).map((t) => safe(t.function?.name ?? t.name)).filter(Boolean);
    const write = (row) => {
      let text = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, id, ...row });
      const key = process.env.EVOWORK_UI_MODEL_KEY;
      if (key) text = text.replaceAll(key, '[REDACTED]');
      fs.appendFileSync(process.env.EVOWORK_TOOL_DIAGNOSTICS, text + '\n');
    };
    write({
      type: 'request',
      requestBodyObserved,
      model: safe(body.model),
      toolNames: names,
      toolTypes: [...new Set((body.tools ?? []).map((t) => safe(t.type)).filter(Boolean))],
      parallelToolCalls: body.parallel_tool_calls,
      reasoningEffort: safe(body.reasoning_effort),
      thinkingType: safe(body.thinking?.type),
      maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
      toolChoice:
        typeof body.tool_choice === 'string'
          ? safe(body.tool_choice)
          : {
              type: safe(body.tool_choice?.type),
              name: safe(body.tool_choice?.function?.name ?? body.tool_choice?.name),
              mode: safe(body.tool_choice?.allowed_tools?.mode ?? body.tool_choice?.mode),
              allowedTools: (
                body.tool_choice?.allowed_tools?.tools ??
                body.tool_choice?.tools ??
                []
              )
                .map((t) => safe(t.function?.name ?? t.name))
                .filter(Boolean),
            },
    });
    try {
      const response = await original.apply(this, arguments);
      write({ type: 'response', status: response.status });
      if (
        response.body &&
        (response.headers.get('content-type') ?? '').includes('text/event-stream')
      ) {
        const copy = response.clone();
        (async () => {
          const reader = copy.body.getReader(),
            decoder = new TextDecoder(),
            calls = new Map(),
            finishes = new Set();
          let pending = '';
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              pending += decoder.decode(part.value, { stream: true });
              let at;
              while ((at = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, at);
                pending = pending.slice(at + 1);
                if (!line.startsWith('data:')) continue;
                let frame;
                try {
                  frame = JSON.parse(line.slice(5).trim());
                } catch {
                  continue;
                }
                for (const choice of frame.choices ?? []) {
                  if (choice.finish_reason) finishes.add(safe(choice.finish_reason));
                  for (const tool of choice.delta?.tool_calls ?? []) {
                    let call = calls.get(tool.index);
                    if (!call) {
                      call = {
                        name: '',
                        lastName: '',
                        nameFragments: 0,
                        args: '',
                        candidate: '',
                        last: '',
                        bytes: 0,
                        deltas: 0,
                        types: new Set(),
                        replays: 0,
                        truncated: false,
                        hash: crypto.createHash('sha256'),
                      };
                      calls.set(tool.index, call);
                    }
                    if (typeof tool.function?.name === 'string') {
                      call.name += tool.function.name;
                      call.lastName = tool.function.name;
                      call.nameFragments++;
                    }
                    if (tool.function?.arguments !== undefined) {
                      const arg = tool.function.arguments,
                        text = typeof arg === 'string' ? arg : JSON.stringify(arg);
                      call.types.add(
                        arg === null ? 'null' : Array.isArray(arg) ? 'array' : typeof arg,
                      );
                      call.bytes += Buffer.byteLength(text);
                      call.deltas++;
                      call.hash.update(text);
                      if (call.args.length + text.length <= 65536) call.args += text;
                      else call.truncated = true;
                      if (
                        call.candidate &&
                        call.candidate.length >= 8 &&
                        text.startsWith(call.candidate)
                      ) {
                        call.replays++;
                        call.candidate = text.slice(0, 65536);
                      } else if (call.candidate.length + text.length <= 65536)
                        call.candidate += text;
                      else call.truncated = true;
                      call.last = text.slice(0, 65536);
                    }
                  }
                }
              }
            }
            write({
              type: 'completed',
              functionNames: [...calls.values()].map((c) =>
                names.includes(c.name) ? c.name : 'unrecognized',
              ),
              finishReasons: [...finishes],
              argumentMetadata: [...calls.entries()].map(([index, c]) => ({
                index: Number.isInteger(index) ? index : undefined,
                nameFragments: c.nameFragments,
                lastNameKnown: names.includes(c.lastName),
                argumentBytes: c.bytes,
                argumentDeltas: c.deltas,
                argumentDeltaTypes: [...c.types],
                prefixReplayDeltas: c.replays,
                truncated: c.truncated,
                json: c.truncated ? undefined : jsonShape(c.args),
                candidateJson: c.truncated ? undefined : jsonShape(c.candidate),
                lastDeltaJson: jsonShape(c.last),
                argumentSha256: c.hash.digest('hex'),
              })),
            });
          } catch (error) {
            write({ type: 'observation-ended', errorClass: safe(error.name) });
          }
        })();
      }
      return response;
    } catch (error) {
      write({ type: 'transport-error', errorClass: safe(error.name) });
      throw error;
    }
  };
