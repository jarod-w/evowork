import { describe, expect, it } from 'vitest';
import { assessComputerUseAction } from '../src/computer-use-action.js';

describe('电脑操控业务动作风险', () => {
  it.each([
    ['发送邮件', 'send'],
    ['Submit', 'send'],
    ['删除文件', 'delete'],
    ['Pay now', 'payment'],
    ['取消预约', 'appointment'],
    ['Upload', 'upload'],
    ['创建密钥', 'account'],
    ['安装扩展', 'install'],
    ['提交报税', 'high-impact'],
  ])('从原生目标 %s 识别类别；界面文案不能提供授权', (label, category) => {
    expect(
      assessComputerUseAction(
        'click',
        {},
        { app: 'com.apple.TextEdit', role: 'AXButton', label, editable: false },
      ),
    ).toMatchObject({ category, confirmation: true });
  });
  it('只有明确的本地文本编辑可免额外业务确认；未知动作保守确认', () => {
    expect(
      assessComputerUseAction(
        'set_value',
        { value: '正文' },
        { app: 'com.apple.TextEdit', role: 'AXTextArea', label: '', editable: true },
      ),
    ).toMatchObject({ confirmation: false });
    expect(
      assessComputerUseAction(
        'click',
        {},
        { app: 'com.apple.TextEdit', role: 'AXButton', label: '继续', editable: false },
      ),
    ).toMatchObject({ category: 'unknown', confirmation: true });
    expect(
      assessComputerUseAction(
        'set_value',
        { value: '正文' },
        { app: 'other', role: 'AXTextArea', label: '', editable: true },
      ),
    ).toMatchObject({ confirmation: true });
  });
  it('换行、提交键、剪切与验证码不能被普通编辑规则放行', () => {
    const target = { app: 'com.apple.TextEdit', role: 'AXTextArea', label: '', editable: true };
    expect(assessComputerUseAction('type_text', { text: '正文\n' }, target).confirmation).toBe(
      true,
    );
    expect(assessComputerUseAction('press_key', { key: 'Enter' }, target).confirmation).toBe(true);
    expect(assessComputerUseAction('press_key', { key: 'Meta+X' }, target).category).toBe('delete');
    expect(assessComputerUseAction('click', {}, { ...target, label: 'CAPTCHA' }).blocked).toBe(
      true,
    );
  });
});
