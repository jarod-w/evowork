/**
 * 错误映射（`providers/registry.ts`）。
 *
 * ## 这个文件是被真实 endpoint 逼出来的
 *
 * 2026-09-05 拿到三把 key 跑探针之前，错误映射只有"按 code 查表 + 按状态码兜底"两条路，
 * 看起来够用。Kimi 的一个 404 把它戳穿了：
 *
 *   `{"error":{"message":"...","type":"resource_not_found_error"}}`  ← **没有 code**
 *
 * 于是查表查不到、关键字匹配没得匹配、404 又不在兜底名单里 —— 这个永远不会成功的请求
 * 落到了"原样返回"，而内核对**映射不上的错误一律当可重试**（`sse/responses.rs:461-470`）。
 * 用户看到的是任务卡了很久然后失败。
 *
 * 三家的错误形状各不相同，这里逐家钉住实测到的那一种。
 */
import { describe, expect, it } from 'vitest';

import { UPSTREAM_DISCONNECTED } from '../src/idle.js';
import {
  DEEPSEEK,
  MOONSHOT,
  PRIVATE,
  ZHIPU,
  extractError,
  isContextOverflow,
} from '../src/providers/registry.js';

describe('错误体解析：三家三种形状（2026-09-05 实测）', () => {
  it('DeepSeek：code 与 type 都有', () => {
    const parsed = extractError({
      error: {
        message: 'Model Not Exist',
        type: 'invalid_request_error',
        code: 'invalid_request_error',
      },
    });
    expect(parsed.code).toBe('invalid_request_error');
  });

  it('**Kimi：只有 type，没有 code** —— 语义必须从 type 里取', () => {
    const parsed = extractError({
      error: { message: 'not found', type: 'resource_not_found_error' },
    });
    // 只看 code 的那一版在这里返回 undefined，于是整条错误落到"可重试"
    expect(parsed.code).toBe('resource_not_found_error');
  });

  it('GLM：数字 code', () => {
    expect(extractError({ error: { code: '1214', message: 'x' } }).code).toBe('1214');
  });
});

describe('永久性错误必须映射到 invalid_prompt（否则内核会一直重试）', () => {
  it('Kimi 的未知模型 404 —— 这是探针抓到的那一个', () => {
    const mapped = MOONSHOT.mapError(404, {
      error: { message: 'model not found', type: 'resource_not_found_error' },
    });
    // invalid_prompt → 内核的 ApiError::InvalidRequest：不重试，且把 message 给用户
    expect(mapped.code).toBe('invalid_prompt');
  });

  it('GLM 的未知模型 400 + 未登记的数字 code → 靠状态码兜底', () => {
    expect(ZHIPU.mapError(400, { error: { code: '1214', message: 'x' } }).code).toBe(
      'invalid_prompt',
    );
  });

  it('DeepSeek 的未知模型 400', () => {
    expect(
      DEEPSEEK.mapError(400, { error: { code: 'invalid_request_error', message: 'x' } }).code,
    ).toBe('invalid_prompt');
  });

  it('401 / 403 也是永久错误 —— 重试一个无效密钥没有意义', () => {
    expect(DEEPSEEK.mapError(401, { error: { message: 'bad key' } }).code).toBe('invalid_prompt');
    expect(DEEPSEEK.mapError(403, { error: { message: 'forbidden' } }).code).toBe('invalid_prompt');
  });
});

describe('可重试与配额类错误保持原样', () => {
  it('429 → rate_limit_exceeded', () => {
    expect(DEEPSEEK.mapError(429, {}).code).toBe('rate_limit_exceeded');
  });

  it('402 → insufficient_quota（内核会停下来告诉用户）', () => {
    expect(DEEPSEEK.mapError(402, {}).code).toBe('insufficient_quota');
  });

  it('5xx → 内核会**重试**的那一类，而不是"模型满了，换一个吧"', () => {
    /*
     * 5xx 是最该重试的一类。`server_is_overloaded` 看着贴切，实际是内核里的**终止**态
     * （`protocol/src/error.rs:402`）且会丢掉 message —— 用它等于"厂商抖一下就整回合失败，
     * 还告诉用户去换模型"。认不出来的 code 才落到 `Retryable{message}`。
     */
    expect(DEEPSEEK.mapError(503, {}).code).toBe(UPSTREAM_DISCONNECTED);
    expect(DEEPSEEK.mapError(503, {}).code).not.toBe('server_is_overloaded');
  });

  it('上下文超限走 context_length_exceeded（内核标满用量、下一回合先压缩，不该被当成永久错误）', () => {
    expect(MOONSHOT.mapError(400, { error: { code: 'content_too_long', message: 'x' } }).code).toBe(
      'context_length_exceeded',
    );
  });
});

/**
 * 上下文超长要按**原文**认（2026-10-06）。
 *
 * 认不出来的后果不是"报错难看"，是任务卡死：映射成 `invalid_prompt` 时内核不标满用量、
 * 下一回合不压缩，原样重发再失败。反过来，误认的代价是白压缩一次、把别的错说成超长 ——
 * 所以下面一半用例守的是"不该认的别认"。
 */
describe('上下文超长：按报错原文认', () => {
  /** DeepSeek 原话，2026-10-05 用约 115 万 token 的合成请求实测（request_id 已去掉） */
  const DEEPSEEK_OVERFLOW = {
    error: {
      message:
        "This model's maximum context length is 1048576 tokens. However, you requested 1150031 tokens (1150030 in the messages, 1 in the completion). Please reduce the length of the messages or completion.",
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_request_error',
    },
  };

  it('**DeepSeek 的超长与"模型不存在"同一个码**，靠原文分开 —— 前者要压缩，后者是永久错误', () => {
    expect(DEEPSEEK.mapError(400, DEEPSEEK_OVERFLOW).code).toBe('context_length_exceeded');
    // 同一个码、别的原文：照旧是永久错误（这句是替身，DeepSeek 未知模型的原文没记下来）
    expect(
      DEEPSEEK.mapError(400, {
        error: {
          message: 'Model Not Exist',
          type: 'invalid_request_error',
          code: 'invalid_request_error',
        },
      }).code,
    ).toBe('invalid_prompt');
  });

  it('vLLM 一类自部署服务：code 是数字、type 是 BadRequestError，同样靠原文认（**按常见格式推断，未实测**）', () => {
    const vllm = {
      object: 'error',
      message:
        "This model's maximum context length is 32768 tokens. However, you requested 40211 tokens (40211 in the messages, 0 in the completion). Please reduce the length of the messages or completion.",
      type: 'BadRequestError',
      param: null,
      code: 400,
    };
    expect(PRIVATE.mapError(400, vllm).code).toBe('context_length_exceeded');
  });

  it('流里夹带的超长报错（HTTP 200）同样认', () => {
    expect(DEEPSEEK.mapError(200, DEEPSEEK_OVERFLOW.error).code).toBe('context_length_exceeded');
  });

  it('OpenAI Responses 的说法也认（内核自己用例里那句）', () => {
    expect(
      isContextOverflow(
        400,
        'Your input exceeds the context window of this model. Please adjust your input and try again.',
      ),
    ).toBe(true);
  });

  it('**输出上限设大了不是超长** —— 压缩消息解决不了它，认成超长只会白压缩一次', () => {
    expect(
      PRIVATE.mapError(400, {
        error: {
          message:
            'max_tokens is too large: 100000. This model supports at most 8192 completion tokens.',
          type: 'invalid_request_error',
        },
      }).code,
    ).toBe('invalid_prompt');
  });

  it('鉴权失败、限流、服务端故障里就算夹着这句也不改判 —— 只在 400 / 413 / 422 / 流内报错上认', () => {
    // 不带 code 的报错体：只剩状态码与原文，看的就是"状态码不对时原文不起作用"
    const textOnly = { error: { message: DEEPSEEK_OVERFLOW.error.message } };
    expect(DEEPSEEK.mapError(401, textOnly).code).toBe('invalid_prompt');
    expect(DEEPSEEK.mapError(429, textOnly).code).toBe('rate_limit_exceeded');
    expect(DEEPSEEK.mapError(503, textOnly).code).toBe(UPSTREAM_DISCONNECTED);
  });
});
