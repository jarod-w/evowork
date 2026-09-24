/** 12 §7：这些分类必须由宿主基于已验证的 App 身份提供，不能来自工具参数。 */
export type ComputerUseAppKind =
  | 'ordinary'
  | 'browser'
  | 'terminal'
  | 'credentials'
  | 'system'
  | 'remote-desktop'
  | 'self'
  | 'unknown';
const HARD_DENIED = new Set([
  'com.evowork.desktop',
  'com.evowork.desktop.computer-use',
  'com.apple.loginwindow',
  'com.apple.securityagent',
  'com.apple.systempreferences',
  'com.apple.passwords',
  'com.apple.keychainaccess',
  'com.apple.terminal',
  'com.googlecode.iterm2',
  'dev.warp.warp-stable',
  'dev.warp.warp',
  'com.mitchellh.ghostty',
  'net.kovidgoyal.kitty',
  'org.alacritty',
  'com.apple.screensharing',
  'com.agilebits.onepassword7',
  'com.1password.1password',
]);
export interface ComputerUseAccess {
  enabled: boolean;
  enterpriseEnabled: boolean;
  source: 'interactive' | 'automation' | 'unknown';
  disclosed: boolean;
  locked: boolean;
  appId: string;
  appKind: ComputerUseAppKind;
  identityVerified: boolean;
  enterpriseAccess?: 'allow' | 'deny';
  userAccess?: 'allow' | 'deny';
  taskGranted: boolean;
  /** 持久准入需签名身份一致且企业允许持久授权。 */
  persistentIdentityMatches: boolean;
  allowPersistentApproval: boolean;
  /** 浏览器路由与策略继承尚未接通时必须是 false。 */
  browserFallbackApproved: boolean;
}
export type ComputerUseAccessDecision =
  'allow' | 'APP_DENIED' | 'POLICY_DENIED' | 'SCREEN_LOCKED' | 'COMPUTER_USE_UNATTENDED_DENIED';
export function decideComputerUseAccess(input: ComputerUseAccess): ComputerUseAccessDecision {
  if (input.source !== 'interactive') return 'COMPUTER_USE_UNATTENDED_DENIED';
  if (!input.enabled || !input.enterpriseEnabled || !input.disclosed) return 'POLICY_DENIED';
  if (input.locked) return 'SCREEN_LOCKED';
  if (
    !input.identityVerified ||
    HARD_DENIED.has(input.appId.toLowerCase()) ||
    !['ordinary', 'browser'].includes(input.appKind)
  )
    return 'POLICY_DENIED';
  if (input.appKind === 'browser' && !input.browserFallbackApproved) return 'POLICY_DENIED';
  if (input.enterpriseAccess === 'deny' || input.userAccess === 'deny') return 'APP_DENIED';
  if (
    input.taskGranted ||
    (input.userAccess === 'allow' &&
      input.allowPersistentApproval &&
      input.persistentIdentityMatches)
  )
    return 'allow';
  return 'APP_DENIED';
}

/** 临时发布闸门：宿主授权/来源/真实删除未接通前，不允许通过手工注册启动 CU。 */
export function isComputerUseTool(name: string): boolean {
  return /^(?:mcp__)?cua_repl__/.test(name);
}
