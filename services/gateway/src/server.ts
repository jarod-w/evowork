/**
 * HTTP 层。用 Node 内置 `http`，不引框架。
 *
 * 理由不是"轻量"这种口号，而是 Q14 的**企业私有部署包**：那份包要能在客户的机器上
 * 用最少的依赖跑起来，且每个依赖都要过一遍客户的合规（K5 的 `THIRD_PARTY_NOTICES`）。
 * 一个 40 行的路由换掉一棵依赖树，在这个场景下是划算的。
 *
 * 三个端点：
 *   · `POST /v1/responses`        —— 内核唯一会调的（`{base_url}/responses`）
 *   · `GET  /v1/evowork/models`   —— 桌面 App 读能力声明（D2「降级必须显式」的落点）
 *   · `GET  /healthz` / `/readyz` —— 部署探活
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { errorFields, type Logger } from '@evowork/logging';

import type { CapabilityLookup } from './capabilities.js';
import { MODELS_ENDPOINT_PATH, toCatalogEntry, type ModelCatalogResponse } from './catalog.js';
import { forwardHosted } from './forward.js';
import type { ResolvedModel } from './layers.js';
import { ModelNotConfiguredError, runPipeline, type PipelineDeps } from './pipeline.js';
import { toSseData, type ResponsesRequest } from './protocol.js';

export interface ServerOptions extends PipelineDeps {
  /**
   * **收窄成合并层的结果**（`layers.ts`）：目录端点必须透出 `credentialSource`
   * 与 `denied`，而基类型里没有它们。`PipelineDeps` 那一侧仍是基类型 ——
   * 管道不需要知道模型来自哪一层，它只发请求。
   */
  readonly models: CapabilityLookup<ResolvedModel>;
  readonly logger?: Logger;
  /** 请求体上限。默认 32MB —— 上下文可以很大，但不该无上限 */
  readonly maxBodyBytes?: number;
  /**
   * 鉴权：校验 `Authorization` 头。
   *
   * 云端托管形态下由 identity 服务签发；私有部署形态下客户自己实现（Q14：客户自持密钥）。
   * 默认**拒绝所有请求** —— 一个默认放行的网关一旦被误部署到公网，代价是别人用我们的额度。
   */
  readonly authenticate?: (authorization: string | undefined) => Promise<boolean> | boolean;
  /**
   * hosted 模型的转发（D11）。本机网关常驻时，内核仍打 loopback；
   * 标了 `credentialSource = hosted` 的请求转到云端，**不走本机厂商 key**。
   */
  readonly hostedForward?:
    | {
        readonly upstreamBaseUrl: string;
        readonly accessJwt: string;
        readonly fetchImpl?: typeof fetch;
      }
    | undefined;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

export function createGatewayServer(options: ServerOptions): Server {
  const logger = options.logger;
  const maxBodyBytes = options.maxBodyBytes ?? 32 * 1024 * 1024;
  const authenticate = options.authenticate ?? (() => false);

  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      logger?.error('gateway.http.unhandled', errorFields(err));
      if (!res.headersSent) {
        res.writeHead(500, JSON_HEADERS);
        res.end(JSON.stringify({ error: { message: '网关内部错误' } }));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const requestId = `req_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    if (req.method === 'GET' && (url.pathname === '/healthz' || url.pathname === '/readyz')) {
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && url.pathname === MODELS_ENDPOINT_PATH) {
      if (!(await authenticate(req.headers.authorization))) {
        unauthorized(res);
        return;
      }
      /*
       * 能力声明：桌面 App 据此渲染下拉、徽标与拒绝说明（03 §4.5 / §8）。
       *
       * **这里列出的就是"现在真的能选"的模型** —— `main.ts` 的 `availableModels()`
       * 已经把没配密钥的厂商筛掉了。这一点是模型下拉不走内核 `model/list` 的决定性理由
       * （F24，见 `catalog.ts` 的头注释）：内核不知道哪家有密钥。
       *
       * 形状由 `catalog.ts` 的具名类型定义，消费侧 import 同一个类型。
       */
      const body: ModelCatalogResponse = { data: options.models.list().map(toCatalogEntry) };
      res.writeHead(200, JSON_HEADERS);
      res.end(JSON.stringify(body));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/v1/responses') {
      if (!(await authenticate(req.headers.authorization))) {
        unauthorized(res);
        return;
      }
      await handleResponses(req, res, requestId);
      return;
    }

    res.writeHead(404, JSON_HEADERS);
    res.end(JSON.stringify({ error: { message: `未知端点：${url.pathname}` } }));
  }

  function unauthorized(res: ServerResponse): void {
    res.writeHead(401, JSON_HEADERS);
    res.end(JSON.stringify({ error: { message: '鉴权失败', code: 'unauthorized' } }));
  }

  async function handleResponses(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
  ): Promise<void> {
    let raw: string;
    try {
      raw = await readBody(req, maxBodyBytes);
    } catch (err) {
      logger?.warn('gateway.http.body_rejected', errorFields(err));
      res.writeHead(413, JSON_HEADERS);
      res.end(JSON.stringify({ error: { message: '请求体过大' } }));
      return;
    }

    let request: ResponsesRequest;
    try {
      request = JSON.parse(raw) as ResponsesRequest;
    } catch {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ error: { message: '请求体不是合法 JSON' } }));
      return;
    }
    if (!request.model || !Array.isArray(request.input)) {
      res.writeHead(400, JSON_HEADERS);
      res.end(JSON.stringify({ error: { message: '缺少 model 或 input' } }));
      return;
    }

    /*
     * 被企业策略停用的模型：**目录里列它，请求里拒它**（11 §4.1 / §12 第 6 条）。
     *
     * 两件事必须都做。只从目录里删掉，用户就会在任务失败时收到一句
     * "未配置的模型"——而真实原因是组织停用了它，那是他自己改不了的事；
     * 只在目录里标停用而这里放行，则第②层根本不是禁令（R11 的缓解手段作废）。
     *
     * 拒绝的话用 `denied` 的原文，不改写：它已经是一句能直接显示给用户的话。
     */
    const resolved = options.models.find(request.model);
    const denied = resolved?.denied;
    if (denied !== undefined) {
      logger?.warn('gateway.request.denied_model', {
        model: safeToken(request.model),
        reason: 'DENIED_BY_POLICY',
      });
      res.writeHead(403, JSON_HEADERS);
      res.end(JSON.stringify({ error: { message: denied, code: 'model_denied' } }));
      return;
    }

    if (resolved?.credentialSource === 'hosted') {
      const fwd = options.hostedForward;
      if (!fwd || fwd.accessJwt === '' || fwd.upstreamBaseUrl === '') {
        res.writeHead(401, JSON_HEADERS);
        res.end(
          JSON.stringify({
            error: {
              message: '这个模型需要登录后使用。',
              code: 'not_signed_in',
            },
          }),
        );
        return;
      }
      const abortFwd = new AbortController();
      req.on('aborted', () => abortFwd.abort());
      try {
        const out = await forwardHosted({
          upstreamBaseUrl: fwd.upstreamBaseUrl,
          accessJwt: fwd.accessJwt,
          body: raw,
          signal: abortFwd.signal,
          logger,
          ...(safeToken(request.model) ? { model: safeToken(request.model) } : {}),
          ...(fwd.fetchImpl ? { fetchImpl: fwd.fetchImpl } : {}),
        });
        res.writeHead(out.status, {
          'content-type': out.contentType,
          'cache-control': 'no-cache, no-transform',
          'x-accel-buffering': 'no',
        });
        if (out.body) {
          const reader = out.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) res.write(Buffer.from(value));
          }
        }
        res.end();
      } catch (err) {
        logger?.error('gateway.forward.failed', errorFields(err));
        if (!res.headersSent) {
          res.writeHead(502, JSON_HEADERS);
          res.end(JSON.stringify({ error: { message: '转发托管模型失败' } }));
        } else {
          res.end();
        }
      }
      return;
    }

    // 客户端断开就取消上游请求：不取消的话被用户中断的任务仍在烧 token（Q11 的预算会失真）
    const abort = new AbortController();
    req.on('aborted', () => abort.abort());
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });

    try {
      const events = runPipeline(request, { requestId, signal: abort.signal }, options);

      /**
       * **先取第一个事件，再写响应头。**
       *
       * `runPipeline` 是 generator，它的同步校验（模型是否配置）要等到第一次 `next()`
       * 才会执行。若先写 200 再迭代，"未配置的模型"会变成**一个 200 + 空 SSE 流** ——
       * 内核那边的表现是任务静默地什么都没发生，而 HTTP 状态码是成功的。
       * 这个 bug 是被 server 测试抓到的，代价（多一行 await）远小于它的排查成本。
       */
      const iterator = events[Symbol.asyncIterator]();
      const first = await iterator.next();

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // 关掉代理层缓冲：否则流式会被攒成一整块，用户看到的是"卡很久然后一次全出来"
        'x-accel-buffering': 'no',
      });

      if (!first.done) {
        res.write(toSseData(first.value));
        for (
          let next = await iterator.next();
          !next.done && !res.writableEnded;
          next = await iterator.next()
        ) {
          res.write(toSseData(next.value));
        }
      }
      // 内核的 SSE 解析以 `[DONE]` 或流结束为终止条件；两者都发以兼容
      if (!res.writableEnded) res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      if (err instanceof ModelNotConfiguredError) {
        logger?.warn('gateway.request.unknown_model', { model: safeToken(err.modelId) });
        res.writeHead(400, JSON_HEADERS);
        res.end(
          JSON.stringify({
            error: {
              message: `未配置的模型：${err.modelId}。请在设置里选择一个可用模型。`,
              code: 'model_not_found',
            },
          }),
        );
        return;
      }
      logger?.error('gateway.request.failed', errorFields(err));
      if (!res.headersSent) {
        res.writeHead(502, JSON_HEADERS);
        res.end(JSON.stringify({ error: { message: '网关处理失败' } }));
      } else {
        res.end();
      }
    }
  }
}

/** 模型 id 是我们自己配的枚举值，但请求里可以是任意字符串 —— 入日志前要过一遍形状。 */
function safeToken(value: string): string | undefined {
  return /^[A-Za-z][A-Za-z0-9_./:-]{0,63}$/.test(value) ? value : undefined;
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new Error(`请求体超过 ${maxBytes} 字节`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}
