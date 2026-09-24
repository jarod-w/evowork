import { describe, expect, it } from 'vitest';
import { ComputerUseSession, TOOLS, validateToolCall } from '../src/index.js';

const window = {
  app: 'com.apple.TextEdit',
  processId: 12,
  windowId: 'w1',
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  scale: 2,
};
const base = { app: window.app, state_id: 's1' };
const valid: Record<string, Record<string, unknown>> = {
  list_apps: {},
  get_app_state: { app: window.app },
  click: { ...base, element_index: 0 },
  drag: { ...base, from_x: 0, from_y: 0, to_x: 20, to_y: 20 },
  paste: { ...base, text: 'hello', format: 'plain' },
  perform_secondary_action: { ...base, element_index: 0, action: 'ShowMenu' },
  press_key: { ...base, key: 'Tab' },
  scroll: { ...base, x: 0, y: 0, direction: 'down', pages: 1 },
  select_text: { ...base, element_index: 0, text: 'hello', mode: 'replace' },
  set_value: { ...base, element_index: 0, value: 'hello' },
  type_text: { ...base, text: 'hello' },
};
describe('固定工具协议', () => {
  it('11 个工具只有两个只读；所有写操作要求 state_id', () => {
    expect(TOOLS).toHaveLength(11);
    expect(TOOLS.filter((t) => t.annotations.readOnlyHint).map((t) => t.name)).toEqual([
      'list_apps',
      'get_app_state',
    ]);
    for (const tool of TOOLS) {
      expect(validateToolCall(tool.name, valid[tool.name])).toEqual(valid[tool.name]);
      if (!tool.annotations.readOnlyHint) {
        const args = { ...valid[tool.name] };
        delete args.state_id;
        expect(() => validateToolCall(tool.name, args)).toThrow('POLICY_DENIED');
      }
      expect(() =>
        validateToolCall(tool.name, { ...valid[tool.name], session_token: 'secret' }),
      ).toThrow('POLICY_DENIED');
    }
  });
  it.each([
    ['click', {}],
    ['click', { element_index: 0, x: 0, y: 0 }],
    ['click', { x: 1 }],
    ['click', { x: NaN, y: 1 }],
    ['click', { element_index: -1 }],
    ['click', { element_index: 1.5 }],
    ['click', { element_index: 0, click_count: 4 }],
    ['scroll', { x: 0, y: 0, direction: 'down', pages: 6 }],
    ['press_key', { key: 'Meta+Tab' }],
    ['press_key', { key: 'Meta+Space' }],
    ['drag', { from_x: 0, from_y: 0, to_x: 1, to_y: 1, duration_ms: 2001 }],
    ['type_text', { text: 'x'.repeat(65537) }],
  ])('拒绝越界或歧义参数 %s', (name, args) => {
    expect(() => validateToolCall(name, { ...base, ...args })).toThrow('POLICY_DENIED');
  });
  it('不暴露 eval 且错误不回显正文', () => {
    expect(() => validateToolCall('eval', { text: 'private' })).toThrow(/^POLICY_DENIED$/);
  });
});
describe('一次观测只允许一次动作', () => {
  it('先读后写，成功或失败的动作均不可重用', () => {
    const session = new ComputerUseSession('t', 'turn');
    expect(() => session.consume('missing', window)).toThrow('STALE_STATE');
    const id = session.observe(window, [1]);
    session.consume(id, window, { element_index: 1 });
    expect(() => session.consume(id, window)).toThrow('STALE_STATE');
    const next = session.observe(window, [1]);
    expect(() => session.consume(next, window, { element_index: 2 })).toThrow('ELEMENT_NOT_FOUND');
    expect(() => session.consume(next, window)).toThrow('STALE_STATE');
  });
  it('30 秒、窗口、进程、应用、缩放变化都使状态失效', () => {
    let now = 0;
    const session = new ComputerUseSession('t', 'turn', () => now);
    const id = session.observe(window, []);
    now = 30000;
    expect(() => session.consume(id, window)).toThrow('STALE_STATE');
    for (const change of [
      { app: 'other' },
      { processId: 13 },
      { windowId: 'w2' },
      { x: 1 },
      { width: 900 },
      { scale: 1 },
    ]) {
      const state = session.observe(window, []);
      expect(() => session.consume(state, { ...window, ...change })).toThrow('STALE_STATE');
    }
  });
  it('坐标必须明确允许回退且在窗口内', () => {
    const session = new ComputerUseSession('t', 'turn');
    expect(() => session.consume(session.observe(window, []), window, { x: 1, y: 1 })).toThrow(
      'POLICY_DENIED',
    );
    for (const target of [{ x: 800, y: 1 }, { x: -1, y: 0 }, { x: NaN, y: 1 }, { x: 1 }]) {
      expect(() => session.consume(session.observe(window, [], true), window, target)).toThrow(
        'POLICY_DENIED',
      );
    }
    session.consume(session.observe(window, [], true), window, { x: 799, y: 599 });
  });
  it('第 80 次提醒，第 101 次拒绝；停止后不能再次观察', () => {
    const session = new ComputerUseSession('t', 'turn');
    for (let i = 1; i <= 100; i++) {
      expect(session.consume(session.observe(window, []), window).warnBudget).toBe(i >= 80);
    }
    expect(() => session.consume(session.observe(window, []), window)).toThrow('POLICY_DENIED');
    expect(() => session.observe(window, [])).toThrow('USER_STOPPED');
  });
  it.each([
    [10, undefined],
    [5, 'ELEMENT_NOT_FOUND'],
  ] as const)('连续无变化/相同失败停止 %s', (count, failure) => {
    const session = new ComputerUseSession('t', 'turn');
    for (let i = 0; i < count; i++) session.complete(false, failure);
    expect(() => session.observe(window, [])).toThrow('USER_STOPPED');
  });
  it('不同回合不能复用状态；停止撤销已有状态', () => {
    const a = new ComputerUseSession('t', 'a');
    const b = new ComputerUseSession('t', 'b');
    const id = a.observe(window, []);
    expect(() => b.consume(id, window)).toThrow('STALE_STATE');
    a.stop();
    expect(() => a.consume(id, window)).toThrow('USER_STOPPED');
  });
});
