import { describe, expect, it } from 'vitest';
import { parseGoalCommand } from '../src/shared/goal-command.js';

describe('goal 命令边界', () => {
  it('仅完整命令执行本地控制，普通路径和引用保留为正文', () => {
    for (const text of [
      '/goals example',
      '/goalkeeper',
      '请解释 /goal pause',
      '/tmp/goal',
      '正文\n/goal pause',
    ])
      expect(parseGoalCommand(text)).toBeUndefined();
    expect(parseGoalCommand(' /goal\n ')).toEqual({ action: 'show' });
    for (const action of ['pause', 'resume', 'clear'])
      expect(parseGoalCommand(`/goal ${action}`)).toEqual({ action });
    expect(parseGoalCommand('/goal pause the service\n验证测试')).toEqual({
      action: 'create',
      objective: 'pause the service\n验证测试',
    });
  });
});
