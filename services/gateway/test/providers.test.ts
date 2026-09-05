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

import { DEEPSEEK, MOONSHOT, ZHIPU, extractError } from '../src/providers/registry.js';

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

  it('5xx → server_is_overloaded', () => {
    expect(DEEPSEEK.mapError(503, {}).code).toBe('server_is_overloaded');
  });

  it('上下文超限走 context_length_exceeded（内核会压缩后重试，不该被当成永久错误）', () => {
    expect(MOONSHOT.mapError(400, { error: { code: 'content_too_long', message: 'x' } }).code).toBe(
      'context_length_exceeded',
    );
  });
});
