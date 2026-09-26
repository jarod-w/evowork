/**
 * 脚本化的假模型网关（供 `skill-reference.e2e.mjs` 用）。
 *
 * 真模型的行为没法脚本化，而「停止 / 插话 / 审批 / 断线重试」这几条链路都要求模型在
 * **特定时刻**做特定的事。所以由测试逐次指定：「这一次把流挂住」「这一次调这个工具」
 * 「接下来 N 次假装上游断了」。用完即清，后面的请求回到默认的「正常回一句话」。
 *
 * 它同时是几条**内核实测面**的载体：心跳帧（F30）、可重试错误码（F32 / F33）、
 * 重试之后的 token 记账 —— 那些事只有真 app-server 能证伪，这个文件负责把它们喂进去。
 *
 * 与 `agent-loop.e2e.mjs` 的真网关是互补关系，不是替代：假的测**真内核**，
 * 真的测**真翻译层**（`to-chat.ts` / `from-chat.ts`）。两条都要留。
 */
import { createServer } from 'node:http';

/** 成功那一次要报的用量。内核的 token 账就是从这里来的 */
export const DEFAULT_USAGE = { input_tokens: 1234, output_tokens: 56, total_tokens: 1290 };

function sendEvent(response, event) {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * 建一个假网关。返回的是**控制面**，不是 server：
 * 第 2 步要从进程外驱动它，露出去的必须是「让它这一次怎么答」这种动作。
 *
 * `turnMarker` 是第一条需求里的一段字，用来认领「哪个请求是那个回合的」——
 * **不能按到达顺序认**：内核在一次会话里不止发我们这一个模型请求（prewarm、
 * 记忆提取都可能先到），按「第一个请求」认会偶发看错请求，表现成「记忆没注入」。
 */
/** 目录里一条模型。能力位对这些测试无所谓，但字段少一个前端就渲染不出来。 */
function catalogEntry({ id, displayName }) {
  return {
    id,
    displayName,
    provider: 'private',
    upstreamModel: id,
    tier: 'standard',
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: true,
      reasoning: false,
      promptCache: false,
      imageInput: false,
      maxContextTokens: 32_000,
    },
    verified: true,
    verifiedAt: '2026-09-25',
    unverified: [],
    notes: 'desktop e2e',
    notices: [],
    credentialSource: 'private',
    layer: 'custom',
  };
}

/** 默认只发一个模型：断言型 E2E 一直是这么跑的，别因为 UI 测试要两个就把它改了。 */
const DEFAULT_MODELS = Object.freeze([{ id: 'e2e-model', displayName: 'E2E Model' }]);

export function createFakeGateway({ turnMarker, usage = DEFAULT_USAGE, models = DEFAULT_MODELS }) {
  if (!turnMarker) throw new Error('假网关需要 turnMarker 才能认领回合请求。');

  /** 下一次模型请求怎么答（一次性） */
  let nextScript;
  /** 还要让上游失败几次（0 = 正常回答）。计数而不是开关：重试之后必须能成功，才测得到用量。 */
  let failUpstream = 0;
  /** 被认领的那个回合的收尾函数：扣住不发，等测试放行（用来造出「正在运行」的窗口） */
  let claimedTurn;
  let turnClaimed = false;
  /** 被 `kind: 'hold'` 挂住的那条响应的收尾函数；收尾时要放行，不然进程退不掉 */
  let releaseScriptedTurn;
  let requestCount = 0;
  /** 内核发给网关的**请求**正文（不是响应）—— 断言「插的话有没有进到模型请求里」靠它 */
  const requestBodies = [];

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/v1/evowork/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: models.map(catalogEntry) }));
      return;
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/responses') {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requestBodies.push(Buffer.concat(chunks).toString('utf8'));
      requestCount += 1;
      const current = requestCount;
      if (nextScript) {
        const script = nextScript;
        nextScript = undefined;
        const id = `resp_${current}`;
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });
        sendEvent(response, { type: 'response.created', response: { id } });
        if (script.kind === 'hold') {
          // 回一句话就**挂着不收尾** —— 回合会一直"在跑"，正好用来点停止 / 插话
          sendEvent(response, {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', id: `msg_${current}`, role: 'assistant', content: [] },
          });
          sendEvent(response, {
            type: 'response.output_text.delta',
            item_id: `msg_${current}`,
            output_index: 0,
            content_index: 0,
            delta: '正在写……',
          });
          releaseScriptedTurn = () => {
            sendEvent(response, {
              type: 'response.completed',
              response: { id, end_turn: true },
            });
            response.end('data: [DONE]\n\n');
            releaseScriptedTurn = undefined;
          };
          return;
        }
        if (script.kind === 'text') {
          /*
           * 让模型回一段**指定的**正文。给 Visualizer 那几条旅程用：
           * mermaid / evowork-chart / html 三类受控 fence 只有在真回合的
           * assistant 消息里才会被渲染，而默认那句 `E2E response N` 里没有它们。
           */
          const itemId = `msg_${current}`;
          sendEvent(response, {
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', id: itemId, role: 'assistant', content: [] },
          });
          sendEvent(response, {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'message',
              id: itemId,
              role: 'assistant',
              content: [{ type: 'output_text', text: script.text }],
            },
          });
          sendEvent(response, {
            type: 'response.completed',
            response: { id, end_turn: true, usage },
          });
          response.end('data: [DONE]\n\n');
          return;
        }
        // 工具调用：`output_item.done` 里给一个 function_call，内核会去执行它
        sendEvent(response, {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'function_call',
            id: `fc_${current}`,
            name: script.tool,
            arguments: JSON.stringify(script.args),
            call_id: `call_${current}`,
          },
        });
        // `end_turn: false`：工具调用之后回合还要继续
        sendEvent(response, { type: 'response.completed', response: { id, end_turn: false } });
        response.end('data: [DONE]\n\n');
        return;
      }
      if (failUpstream > 0) {
        failUpstream -= 1;
        /*
         * 「上游断了」的样子：HTTP 200 + 流里一条 `response.failed`。
         * `upstream_disconnected` 是内核**认不出来**的 code，因此落到 `Retryable{message}`
         * （F32）—— 内核会退避重试，并在重试用完后把这条 message 显示给用户。
         */
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
        });
        sendEvent(response, {
          type: 'response.created',
          response: { id: `resp_${current}` },
        });
        sendEvent(response, {
          type: 'response.failed',
          response: {
            id: `resp_${current}`,
            error: {
              code: 'upstream_disconnected',
              message: '与模型服务的连接中断，重试多次仍未成功。',
            },
          },
        });
        response.end('data: [DONE]\n\n');
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const id = `resp_${current}`;
      const itemId = `msg_${current}`;
      /*
       * 心跳帧（F30）。真网关在"活着但没东西可发"时会往流里塞它，靠它让内核那个
       * 300 秒的空闲计时器重来（F31）。这里把它混进 E2E 的假网关，是为了让
       * **真内核**替我们证明两件事：① 它不会因为这个类型报错 ② 它不会把它变成
       * 时间线上的一条 item（spec 里那些对话断言就是证据）。
       * 读源码只能读到"它在忽略清单里"，这条才是实测。
       */
      sendEvent(response, { type: 'response.in_progress', response: { id } });
      sendEvent(response, { type: 'response.created', response: { id } });
      sendEvent(response, { type: 'response.in_progress', response: { id } });
      sendEvent(response, {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: itemId, role: 'assistant', content: [] },
      });
      sendEvent(response, {
        type: 'response.output_text.delta',
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        delta: `E2E response ${current}`,
      });
      const finish = () => {
        sendEvent(response, { type: 'response.in_progress', response: { id } });
        sendEvent(response, {
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: itemId,
            role: 'assistant',
            content: [{ type: 'output_text', text: `E2E response ${current}` }],
          },
        });
        sendEvent(response, {
          type: 'response.completed',
          response: { id, end_turn: true, usage },
        });
        response.end('data: [DONE]\n\n');
      };
      // 按内容认领这个回合的请求（见 `turnMarker`），不按到达顺序
      if (!turnClaimed && requestBodies.at(-1)?.includes(turnMarker)) {
        turnClaimed = true;
        claimedTurn = finish;
      } else {
        finish();
      }
    });
  });

  return {
    /** 监听随机端口，返回内核 config.toml 里要写的 base_url */
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () =>
          resolve(`http://127.0.0.1:${server.address().port}/v1`),
        );
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },

    /** 下一次请求按这个剧本答：`{ kind: 'hold' }` · `{ kind: 'text', text }` · `{ tool, args }` */
    scriptNext(script) {
      nextScript = script;
    },
    /** 接下来 `times` 次默认响应假装上游断线；之后恢复正常回答 */
    failNextUpstream(times) {
      failUpstream = times;
    },

    /** 带 `turnMarker` 的那个请求到了没有（它被扣住，用来造出「正在运行」的窗口） */
    turnClaimed: () => Boolean(claimedTurn),
    /** 放行被认领的那个回合 */
    releaseClaimedTurn() {
      if (!claimedTurn) throw new Error('那个回合的请求还没到，放行不了。');
      claimedTurn();
      claimedTurn = undefined;
    },
    /** 有没有一条被 `kind: 'hold'` 挂住的响应等着收尾 */
    scriptedTurnHeld: () => Boolean(releaseScriptedTurn),
    /** 放行被挂住的那条；没有就什么都不做（调用点常在断言之后，不该因此炸掉） */
    releaseScriptedTurn() {
      if (releaseScriptedTurn) releaseScriptedTurn();
    },

    requestCount: () => requestCount,
    /** 活引用：断言要在后续请求到达后重新扫一遍 */
    requestBodies,
    /** 成功那一次报的用量，断言 token 记账时要用 */
    usage,
  };
}
