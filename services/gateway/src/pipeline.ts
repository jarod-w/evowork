/**
 * 一次请求的完整管道：Responses 请求 → Chat → 上游 → Responses 事件流。
 *
 * 把它与 HTTP 层分开，是为了能在测试里**不起服务器**就跑完整条链路
 * （给一个假 provider，断言吐出来的事件序列）。R1 说网关工作量最容易被低估，
 * 而低估的部分几乎全在这条链路的语义细节里 —— 那些细节必须能被单独测。
 */
import { digest, errorFields, type Logger } from '@evowork/logging';

import {
  CAPABILITY_COPY,
  DEGRADE_COPY,
  type CapabilityLookup,
  type DegradeReason,
  type ModelRegistryEntry,
} from './capabilities.js';
import {
  DEFAULT_FIRST_CHUNK_MS,
  DEFAULT_UPSTREAM_IDLE_MS,
  raceIdle,
  stalledMessage,
  STALLED,
  UPSTREAM_DISCONNECTED,
} from './idle.js';
import { EVENT, type ResponsesEvent, type ResponsesRequest } from './protocol.js';
import type { Provider, ProviderConfig } from './providers/types.js';
import { createTranslator, type ChatChunk } from './translate/from-chat.js';
import { toChatRequest, UnsupportedInputError } from './translate/to-chat.js';

export interface PipelineDeps {
  readonly models: CapabilityLookup;
  readonly providers: Readonly<Record<string, Provider>>;
  readonly configFor: (model: ModelRegistryEntry) => ProviderConfig;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly newResponseId?: () => string;
  /**
   * 上游**两片之间**最多允许安静多久（默认见 `idle.ts`）。超过就判这条流已经死了。
   *
   * 在这之前网关对"上游不说话"没有任何判断：`for await` 会一直等下去，
   * 而等到最后替我们做判断的是内核 —— 300 秒后它发
   * `stream disconnected before completion: idle timeout waiting for SSE`，
   * 一句英文、没有原因、也不告诉用户能不能重试。现在这个判断挪到网关：
   * 我们知道是上游断了，就说上游断了。
   *
   * `0` = 不看门（只有测试会这么用）。
   */
  readonly upstreamIdleMs?: number;
  /**
   * 拿到响应头之后、**第一片**到达之前的等待上限。默认 300 秒。
   *
   * 与上一项分开，是因为它们量级本来就不同：首片要等上游读完整个上下文
   * （长上下文 + 思考模型能到分钟级），而流动起来之后的 120 秒空档只意味着连接死了。
   * 给首片一个更松的预算，是为了不把"本来会成功的慢回合"改成失败 ——
   * 修一个超时缺陷时最容易顺手造出来的正是这种回归。
   */
  readonly upstreamFirstChunkMs?: number;
}

export interface PipelineRequestContext {
  readonly requestId: string;
  readonly signal?: AbortSignal;
}

export class ModelNotConfiguredError extends Error {
  override readonly name = 'ModelNotConfiguredError';
  constructor(readonly modelId: string) {
    super(`未配置的模型：${modelId}`);
  }
}

/**
 * 跑一次请求，产出 Responses 事件序列（async generator）。
 *
 * **不落盘任何正文**（Q14）：这条链路里唯一接触 prompt 的地方是 `toChatRequest`
 * 与 `fetch` 的 body，两者都不写日志。日志里只有 `promptDigest` + 计量 + 错误码。
 */
export async function* runPipeline(
  request: ResponsesRequest,
  ctx: PipelineRequestContext,
  deps: PipelineDeps,
): AsyncGenerator<ResponsesEvent> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const responseId = (deps.newResponseId ?? defaultResponseId)();

  const model = deps.models.find(request.model);
  if (!model) {
    // **不静默回落到别的模型**（03 §8：不静默降级到其他模型）——
    // 用户选了一个模型，得到另一个模型的答案是最坏的一种"贴心"
    throw new ModelNotConfiguredError(request.model);
  }
  const provider = deps.providers[model.provider];
  if (!provider) throw new ModelNotConfiguredError(request.model);

  const log = deps.logger?.child({
    requestId: ctx.requestId,
    provider: model.provider,
    model: model.id,
  });

  const promptDigest = digest(
    // 摘要基于结构而不是正文长度，便于判断"是不是同一条 prompt 又来了一次"
    JSON.stringify({ instructions: request.instructions ?? '', input: request.input }),
  );
  log?.info('gateway.request.started', {
    promptDigest,
    itemCount: request.input.length,
    fileCount: request.tools?.length ?? 0,
  });

  const translator = createTranslator({ responseId, capabilities: model.capabilities });

  let converted;
  try {
    converted = toChatRequest(request, model.upstreamModel, model.capabilities);
  } catch (err) {
    if (err instanceof UnsupportedInputError) {
      // 能力缺失 → **显式失败**（D2），并把用户能看懂的话放在 message 里
      log?.warn('gateway.request.rejected', { degradeReason: err.reason });
      yield* translator.fail({
        code: 'invalid_prompt',
        type: 'invalid_request_error',
        message: err.userMessage,
      });
      return;
    }
    throw err;
  }

  const degradations = new Set<DegradeReason>(converted.degradations);
  const config = deps.configFor(model);

  /*
   * 看门狗要能**真的掐断上游**：只发一条 `response.failed` 而让 socket 挂着，
   * 那条请求仍在上游那边计费、也仍占着本机的连接池（Q11 的预算会失真）。
   * 与客户端的取消合成一个信号，两个方向任意一个都能结束这次上游请求。
   */
  const watchdog = new AbortController();
  const upstreamSignal = ctx.signal
    ? AbortSignal.any([ctx.signal, watchdog.signal])
    : watchdog.signal;

  let upstream;
  try {
    upstream = await provider.send(converted.request, config, upstreamSignal);
  } catch (err) {
    log?.error('gateway.upstream.unreachable', errorFields(err));
    yield* translator.fail({
      // 连不上是典型的瞬时故障 → 让内核自动重试（见 `UPSTREAM_DISCONNECTED`）。
      // 这句话只有重试用完才会被显示，所以写的是"试过了"的口气
      code: UPSTREAM_DISCONNECTED,
      message: '连不上模型服务，重试多次仍未成功。检查一下网络，或到设置里换一个模型。',
    });
    return;
  }

  if (upstream.status >= 400) {
    const body = await collectJson(upstream.lines);
    const mapped = provider.mapError(upstream.status, body);
    const safeMapped = safeCode(mapped.code);
    log?.warn('gateway.upstream.error', {
      statusCode: upstream.status,
      ...(safeMapped ? { errorCode: safeMapped } : {}),
      durationMs: now() - startedAt,
    });
    yield* translator.fail(mapped);
    return;
  }

  let firstTokenAt: number | undefined;
  let sawDone = false;

  const idleMs = deps.upstreamIdleMs ?? DEFAULT_UPSTREAM_IDLE_MS;
  const firstChunkMs = deps.upstreamFirstChunkMs ?? DEFAULT_FIRST_CHUNK_MS;
  const lines = upstream.lines[Symbol.asyncIterator]();
  /**
   * 已经要来、还没到的那一片。**必须跨轮保留**：看门狗赢了这一轮之后再调一次
   * `lines.next()` 就是对同一个迭代器的并发 next，行会错乱（而且错得很难看出来）。
   */
  let pending: Promise<IteratorResult<string>> | undefined;
  let sawLine = false;

  try {
    for (;;) {
      pending ??= lines.next();
      const budget = sawLine ? idleMs : firstChunkMs;
      const step = await raceIdle(pending, budget);
      if (step === STALLED) {
        // 放弃这一片，但**必须接住它后面的拒绝**：abort 之后它几乎一定会 reject，
        // 没人接的 promise 拒绝在 Node 里是直接把网关进程带走
        void pending.catch(() => undefined);
        pending = undefined;
        watchdog.abort();
        log?.warn('gateway.stream.stalled', {
          reason: 'UPSTREAM_IDLE',
          waitedMs: budget,
          durationMs: now() - startedAt,
        });
        /*
         * **可重试**（`UPSTREAM_DISCONNECTED` 那里写了为什么是这个 code）。
         *
         * 2026-09-26 第一版选的是终止（`invalid_prompt`），理由是"重试期间界面一片空白，
         * 用户要对着转圈等十分钟"。那个理由已经不成立：适配层现在会把内核的
         * `error` + `willRetry` 显示成「上游断了，正在尝试重新连接（2/5）」，
         * 而「停止」按钮也在同一天被修好了。剩下的就是一个朴素事实 ——
         * **卡死的连接重来一次经常就好了**，而让用户手点一次没有任何额外信息量。
         *
         * 代价是真的：每次重试都会把整段上下文重发给上游（Q11 的预算），
         * 最坏是 `stream_max_retries` × 这个 budget。config 模板因此把重试次数从 5 降到 2。
         */
        yield* translator.fail({
          code: UPSTREAM_DISCONNECTED,
          message: stalledMessage('模型服务', budget),
        });
        return;
      }
      pending = undefined;
      if (step.done) break;
      sawLine = true;
      const line = step.value;
      const payload = parseSseData(line);
      if (payload === undefined) continue;
      if (payload === '[DONE]') {
        sawDone = true;
        break;
      }

      let chunk: ChatChunk;
      try {
        chunk = JSON.parse(payload) as ChatChunk;
      } catch {
        // 上游偶发的坏帧：跳过一帧比让整个回合失败好。
        // 但要记一笔 —— 频繁出现说明上游或我们的行拆分有问题
        log?.warn('gateway.stream.bad_frame', { byteSize: payload.length });
        continue;
      }

      // 上游在流里报错（有些实现不用 HTTP 状态码）
      const inlineError = (chunk as { error?: unknown }).error;
      if (inlineError) {
        const mapped = provider.mapError(200, inlineError);
        const safeInline = safeCode(mapped.code);
        log?.warn('gateway.stream.inline_error', {
          ...(safeInline ? { errorCode: safeInline } : {}),
        });
        yield* translator.fail(mapped);
        return;
      }

      const events = translator.push(chunk);
      if (events.length > 0 && firstTokenAt === undefined) {
        firstTokenAt = now();
        log?.debug('gateway.stream.first_token', { ttfbMs: firstTokenAt - startedAt });
      }
      yield* events;
    }
  } catch (err) {
    log?.error('gateway.stream.aborted', errorFields(err));
    yield* translator.fail({
      code: UPSTREAM_DISCONNECTED,
      message:
        '与模型服务的连接中断，重试多次仍未成功。可以再点一次「重试」，或到设置里换一个模型。',
    });
    return;
  } finally {
    /*
     * **关掉上游的迭代器。**
     *
     * 这一条是把 `for await` 换成手写循环之后欠下的：`for await` 在 break / return
     * 时会自动调 `return()`，而那一下正是"取消 ReadableStream、把连接还回去"的地方。
     * 手写循环不会，于是每一次提前离开（`[DONE]`、流内错误、调用方中断）
     * 都会漏一条还开着的上游连接 —— 表现是几十个任务之后网关开始变慢。
     *
     * 拒绝要接住：看门狗那条路刚 abort 过，这一下大概率抛。
     */
    void lines.return?.().catch(() => undefined);
  }

  if (!sawDone) {
    // 流没有正常收尾（连接被掐断）。仍然收尾一次：**已经产生的内容不该丢**，
    // 但要在日志里记下来 —— 这类"半截响应"是上游质量的重要信号
    log?.warn('gateway.stream.truncated', { durationMs: now() - startedAt });
  }

  const finishEvents = translator.finish();
  for (const reason of translator.degradations()) degradations.add(reason);
  yield* finishEvents;

  const usageEvent = finishEvents.find((e) => e.type === EVENT.completed) as
    | {
        response?: {
          usage?: {
            input_tokens: number;
            output_tokens: number;
            input_tokens_details?: { cached_tokens: number };
          };
        };
      }
    | undefined;
  const usage = usageEvent?.response?.usage;

  log?.info('gateway.request.completed', {
    statusCode: upstream.status,
    durationMs: now() - startedAt,
    ...(firstTokenAt ? { ttfbMs: firstTokenAt - startedAt } : {}),
    ...(usage
      ? {
          tokensIn: usage.input_tokens,
          tokensOut: usage.output_tokens,
          tokensCached: usage.input_tokens_details?.cached_tokens ?? 0,
          cacheHit: (usage.input_tokens_details?.cached_tokens ?? 0) > 0,
        }
      : {}),
    degraded: degradations.size > 0,
    ...(degradations.size > 0 ? { degradeReason: [...degradations][0] } : {}),
  });
}

/**
 * 入日志前把上游的错误码过一遍形状。
 *
 * 纵深防御：`mapCommonError` 的兜底分支会**原样转发上游的 code**（转发给内核是对的，
 * 内核要靠它判断该不该重试），但那个值是上游控制的字符串 ——
 * 直接写进日志字段等于给上游一个往我们日志里写东西的口子。
 * `@evowork/logging` 的字段注册表也会拦（这个函数是它的第二道），
 * 但在这里显式过一遍能让"为什么日志里有时没有 errorCode"变得可解释。
 */
function safeCode(code: string | undefined): string | undefined {
  return code && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : undefined;
}

function defaultResponseId(): string {
  return `resp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 取 SSE 行的 data 载荷。非 data 行（注释、event:、空行）返回 undefined。 */
export function parseSseData(line: string): string | undefined {
  if (!line.startsWith('data:')) return undefined;
  const payload = line.slice(5).trim();
  return payload.length > 0 ? payload : undefined;
}

async function collectJson(lines: AsyncIterable<string>): Promise<unknown> {
  const parts: string[] = [];
  for await (const line of lines) parts.push(line);
  const text = parts.join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** 供 UI 用的能力文案（03 §4.5 的徽标 + 03 §8 的拒绝说明）。 */
export function capabilityNotices(model: ModelRegistryEntry): string[] {
  const notices: string[] = [];
  for (const [key, copy] of Object.entries(CAPABILITY_COPY)) {
    if (!copy) continue;
    const enabled = model.capabilities[key as keyof typeof model.capabilities];
    if (enabled === false) notices.push(copy);
  }
  return notices;
}

export function degradeNotices(reasons: readonly DegradeReason[]): string[] {
  return reasons.map((r) => DEGRADE_COPY[r]);
}
