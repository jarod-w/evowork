import { describe, it, expect } from 'vitest';
import { completedTurnAnswer } from '../../apps/desktop/test/e2e/harness/turn-answer.mjs';
const message = (text, extra = {}) => ({
  type: 'agentMessage',
  _turnId: 'current',
  completed: true,
  text,
  ...extra,
});
describe('同一回合公开交付答案', () => {
  it('保留 Stop 补报前的交付，末条确认不能抹去已经给用户的编号', () => {
    expect(
      completedTurnAnswer([
        message('NORTH-123 SOUTH-456'),
        { type: 'hookPrompt', _turnId: 'current' },
        { type: 'mcpToolCall', _turnId: 'current', tool: 'propose_next_actions' },
        message('本次需求已经交付完毕'),
      ]),
    ).toBe('NORTH-123 SOUTH-456\n本次需求已经交付完毕');
  });
  it('工具输出和推理中的编号不能冒充用户收到的答案', () => {
    expect(
      completedTurnAnswer([
        { type: 'commandExecution', _turnId: 'current', output: 'NORTH-123 SOUTH-456' },
        { type: 'reasoning', _turnId: 'current', text: 'NORTH-123 SOUTH-456' },
      ]),
    ).toBe('');
  });
  it('不能拿上一回合的编号补当前答案', () => {
    expect(
      completedTurnAnswer([message('NORTH-OLD', { _turnId: 'old' }), message('UNKNOWN')]),
    ).toBe('UNKNOWN');
  });
  it('新回合尚未交付时不能回退到旧答案', () => {
    expect(
      completedTurnAnswer([
        message('OLD', { _turnId: 'old' }),
        { type: 'userMessage', _turnId: 'current' },
        { type: 'commandExecution', _turnId: 'current' },
      ]),
    ).toBe('');
  });
  it('显式 commentary 和未完成消息不计入交付', () => {
    expect(
      completedTurnAnswer([
        message('progress', { phase: 'commentary' }),
        message('pending', { completed: false }),
      ]),
    ).toBe('');
  });
  it('旧接口缺少回合字段时以最后一条用户消息为边界', () => {
    expect(
      completedTurnAnswer([
        { type: 'agentMessage', text: 'OLD' },
        { type: 'userMessage', content: [] },
        { type: 'agentMessage', text: 'NEW' },
      ]),
    ).toBe('NEW');
  });
});
