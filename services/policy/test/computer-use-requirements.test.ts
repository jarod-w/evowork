import { describe, expect, it } from 'vitest';
import {
  mergeComputerUseRequirements,
  computerUseEnterpriseAccess,
} from '../src/computer-use-requirements.js';
describe('电脑操控 requirements 分层合并', () => {
  it('无电脑操控约束的企业文件不整体禁用；管理员 allow 不替用户授权', () => {
    const p = mergeComputerUseRequirements(null, { allow_managed_hooks_only: true });
    expect(p.enabled).toBe(true);
    expect(computerUseEnterpriseAccess(p, 'com.apple.TextEdit')).toBeUndefined();
  });
  it('单层默认拒绝可显式准入单个应用，不能覆盖另一层默认拒绝', () => {
    const local = {
      computer_use: {
        default_app_access: 'deny',
        macos: { bundle_ids: { 'com.apple.TextEdit': 'allow' } },
      },
    };
    expect(
      computerUseEnterpriseAccess(mergeComputerUseRequirements(local), 'COM.APPLE.TEXTEDIT'),
    ).toBe('allow');
    expect(
      computerUseEnterpriseAccess(mergeComputerUseRequirements(local), 'com.apple.Notes'),
    ).toBe('deny');
    const kernel = { computerUse: { defaultAppAccess: 'deny' } };
    expect(
      computerUseEnterpriseAccess(
        mergeComputerUseRequirements(local, kernel),
        'com.apple.TextEdit',
      ),
    ).toBe('deny');
  });
  it('全局禁用、持久审批拒绝、bundle deny 都不因层顺序改变', () => {
    const deny = {
      allowBrowserAndComputerUse: false,
      computerUse: {
        allowPersistentApproval: false,
        macos: { bundleIds: { 'com.apple.TextEdit': 'deny' } },
      },
    };
    const allow = {
      allow_browser_and_computer_use: true,
      computer_use: {
        allow_persistent_approval: true,
        macos: { bundle_ids: { 'COM.APPLE.TEXTEDIT': 'allow' } },
      },
    };
    for (const layers of [
      [deny, allow],
      [allow, deny],
    ]) {
      const p = mergeComputerUseRequirements(...layers);
      expect(p.enabled).toBe(false);
      expect(p.persistentAllowed).toBe(false);
      expect(p.appAccess['com.apple.textedit']).toBe('deny');
    }
  });
  it.each([
    undefined,
    [],
    { computerUse: 'invalid' },
    { allowBrowserAndComputerUse: 'false' },
    { computer_use: { macos: { bundle_ids: { bad: 'maybe' } } } },
  ])('无法解析或未知取值保守禁用 %j', (layer) => {
    expect(mergeComputerUseRequirements(layer).enabled).toBe(false);
  });
});
