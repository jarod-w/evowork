import { describe, expect, it } from 'vitest';
import { decideComputerUseAccess, handlePreToolUse, type ComputerUseAccess } from '../src/index.js';
const access: ComputerUseAccess = {
  enabled: true,
  enterpriseEnabled: true,
  source: 'interactive',
  disclosed: true,
  locked: false,
  appId: 'com.apple.TextEdit',
  appKind: 'ordinary',
  identityVerified: true,
  taskGranted: false,
  persistentIdentityMatches: true,
  allowPersistentApproval: true,
  browserFallbackApproved: false,
};
describe('电脑操控准入', () => {
  it('默认拒绝，任务授权或有效持久授权才允许', () => {
    expect(decideComputerUseAccess(access)).toBe('APP_DENIED');
    expect(decideComputerUseAccess({ ...access, taskGranted: true })).toBe('allow');
    expect(decideComputerUseAccess({ ...access, userAccess: 'allow' })).toBe('allow');
    expect(
      decideComputerUseAccess({ ...access, userAccess: 'allow', persistentIdentityMatches: false }),
    ).toBe('APP_DENIED');
    expect(
      decideComputerUseAccess({ ...access, userAccess: 'allow', allowPersistentApproval: false }),
    ).toBe('APP_DENIED');
  });
  it.each([
    'com.apple.Terminal',
    'com.googlecode.iterm2',
    'dev.warp.Warp-Stable',
    'com.apple.systempreferences',
    'com.evowork.desktop',
    'com.apple.Passwords',
  ])('硬禁止优先于所有 allow：%s', (appId) => {
    expect(
      decideComputerUseAccess({
        ...access,
        appId,
        taskGranted: true,
        userAccess: 'allow',
        enterpriseAccess: 'allow',
      }),
    ).toBe('POLICY_DENIED');
  });
  it('未知应用类别、签名、浏览器回退均保守拒绝', () => {
    for (const change of [
      { appKind: 'unknown' as const },
      { identityVerified: false },
      { appKind: 'browser' as const },
      { disclosed: false },
      { enabled: false },
    ]) {
      expect(decideComputerUseAccess({ ...access, taskGranted: true, ...change })).toBe(
        'POLICY_DENIED',
      );
    }
  });
  it('企业/user deny 不被任务授权覆盖，无人值守与未知来源均拒绝', () => {
    expect(
      decideComputerUseAccess({ ...access, taskGranted: true, enterpriseAccess: 'deny' }),
    ).toBe('APP_DENIED');
    expect(decideComputerUseAccess({ ...access, taskGranted: true, userAccess: 'deny' })).toBe(
      'APP_DENIED',
    );
    for (const source of ['automation', 'unknown'] as const)
      expect(decideComputerUseAccess({ ...access, source, taskGranted: true })).toBe(
        'COMPUTER_USE_UNATTENDED_DENIED',
      );
  });
  it('现有 hook 在完全访问下仍挡住未就绪 CU，审计不复制工具参数', () => {
    for (const tool_name of ['mcp__cua_repl__click', 'cua_repl__get_app_state']) {
      const result = handlePreToolUse(
        {
          session_id: 't',
          turn_id: 'turn',
          cwd: '/work',
          hook_event_name: 'PreToolUse',
          tool_name,
          tool_use_id: 'call',
          permission_mode: 'danger-full-access',
          tool_input: { text: 'PRIVATE_BODY', source: 'interactive' },
        },
        { home: '/home/user', now: () => 1 },
      );
      expect(result.output?.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(JSON.stringify(result.audit)).not.toContain('PRIVATE_BODY');
      expect(result.audit[0]?.approvalResult).toBe('decline');
    }
  });
});
