import { describe, expect, it } from 'vitest';

import { BUILTIN_FIELDS, FieldPolicyViolation, isValidValue } from '../src/fields.js';
import { createLogger, memorySink } from '../src/logger.js';

describe('字段注册表（Q14 的第二层防线）', () => {
  it('未注册的字段名进不去 —— 白名单而不是黑名单', () => {
    const sink = memorySink();
    const log = createLogger({ service: 'gateway', sink });

    // `prompt` 不在注册表里，所以它连"被过滤"的机会都没有：它一开始就不是合法字段
    expect(() => log.info('gateway.request.started', { prompt: '帮我写一份周报' })).toThrow(
      FieldPolicyViolation,
    );
    // 黑名单方案漏掉的那类字段名（想不到的）同样被拦
    expect(() => log.info('gateway.request.started', { userUtterance: 'x' })).toThrow(
      FieldPolicyViolation,
    );
    expect(sink.records).toHaveLength(0);
  });

  it('注册过的字段名 + 不符合形状的值也进不去 —— 字段名安全不代表值安全', () => {
    const sink = memorySink();
    const log = createLogger({ service: 'audit', sink });

    // reason 是 code 形状（大写下划线），装不下一句自然语言
    expect(() => log.info('audit.tool.denied', { reason: '因为客户鹏程公司要求先审批' })).toThrow(
      FieldPolicyViolation,
    );
    // 但正常的原因码可以
    log.info('audit.tool.denied', { reason: 'MACHINE_OFFLINE' });
    expect(sink.records).toHaveLength(1);
  });

  it('事件名自身也受约束 —— 否则它就是一个自由文本入口', () => {
    const log = createLogger({ service: 'gateway', sink: memorySink() });
    expect(() => log.info('用户说：帮我写周报', {})).toThrow(FieldPolicyViolation);
    expect(() => log.info('Gateway.Request', {})).toThrow(FieldPolicyViolation);
  });

  it('生产模式丢弃而不是抛错，且丢弃方向永远是"少写"', () => {
    const sink = memorySink();
    const log = createLogger({ service: 'gateway', sink, onViolation: 'drop' });

    log.info('gateway.request.completed', {
      requestId: 'req-1',
      tokensIn: 120,
      prompt: '这段绝对不能出现',
      reason: '这也不是合法的 code',
    });

    expect(sink.records).toHaveLength(1);
    const line = sink.text();
    expect(line).not.toContain('这段绝对不能出现');
    expect(line).toContain('"tokensIn":120');
    // 丢了两个字段，且这件事本身被记下来（否则静默丢弃会掩盖埋点写错）
    expect(sink.records[0]?.fields.droppedFields).toBe(2);
  });

  it('null / undefined 视为「不写」，不算违规', () => {
    const sink = memorySink();
    const log = createLogger({ service: 'store', sink });
    log.info('store.migration.done', { schemaVersion: 3, shareId: undefined, threadId: null });
    expect(sink.records[0]?.fields).toEqual({ schemaVersion: 3 });
  });

  it('child logger 继承基础字段，且基础字段同样过校验', () => {
    const sink = memorySink();
    const log = createLogger({ service: 'gateway', sink, base: { provider: 'deepseek' } });
    log.child({ requestId: 'req-7' }).info('gateway.stream.first_token', { ttfbMs: 812 });
    expect(sink.records[0]?.fields).toEqual({
      provider: 'deepseek',
      requestId: 'req-7',
      ttfbMs: 812,
    });
  });

  it('形状校验逐档成立', () => {
    expect(isValidValue('count', 12)).toBe(true);
    expect(isValidValue('count', -1)).toBe(false);
    expect(isValidValue('count', 1.5)).toBe(false);
    expect(isValidValue('duration', 12.5)).toBe(true);
    expect(isValidValue('bool', true)).toBe(true);
    expect(isValidValue('bool', 'true')).toBe(false);
    expect(isValidValue('id', 'thread_01JABCD')).toBe(true);
    expect(isValidValue('id', 'thread id with space')).toBe(false);
    expect(isValidValue('token', 'thread/list')).toBe(true);
    expect(isValidValue('token', '9lives')).toBe(false);
    expect(isValidValue('code', 'APPROVAL_TIMEOUT')).toBe(true);
    // 小写也合法：内核与三家模型的真实错误码都是小写形态
    expect(isValidValue('code', 'context_length_exceeded')).toBe(true);
    expect(isValidValue('code', 'ECONNREFUSED')).toBe(true);
    expect(isValidValue('code', '429')).toBe(true);
    // 但仍然装不下一句自然语言：空白与中文都进不来
    expect(isValidValue('code', 'approval timeout')).toBe(false);
    expect(isValidValue('code', '因为客户要求先审批')).toBe(false);
    expect(isValidValue('code', 'x'.repeat(65))).toBe(false);
    expect(isValidValue('digest', 'a3f9c1d2e4b50617')).toBe(true);
    expect(isValidValue('digest', 'not-hex')).toBe(false);
  });

  it('内置字段表覆盖 Q14 允许的三样与 10 §6 要求的审计维度', () => {
    // Q14：只记 token 计数、时延、错误码
    for (const f of [
      'tokensIn',
      'tokensOut',
      'tokensCached',
      'durationMs',
      'latencyMs',
      'errorCode',
    ]) {
      expect(BUILTIN_FIELDS[f]).toBeDefined();
    }
    // 10 §6「不记什么」：这些名字不该在表里存在
    for (const f of [
      'prompt',
      'content',
      'body',
      'output',
      'stdout',
      'diff',
      'title',
      'path',
      'label',
    ]) {
      expect(BUILTIN_FIELDS[f]).toBeUndefined();
    }
  });
});
