/**
 * 站点运行配置与功能开关（集中在一处，改版本、换链接、开关引导无需改组件）。
 */
export interface SiteConfig {
  readonly version: string;
  readonly releaseDate: string;
  /** 拿到 Apple Developer ID 公证签名后，改为 false（或注入 VITE_SHOW_MAC_UNSIGNED_GUIDE=false）即可全局隐藏未签名 xattr 引导卡。 */
  readonly showMacUnsignedGuide: boolean;
  /** 可选：企业版预约表单提交端点（支持 Webhook 或后端 API）。为空时启用无后端预览回执。 */
  readonly leadEndpoint: string;
  /** 企业联系兜底邮箱。 */
  readonly contactEmail: string;
  readonly links: {
    readonly github: string;
    readonly githubIssues: string;
    readonly githubReleases: string;
    readonly accountPortal: string;
    readonly macArm64Dmg: string;
    readonly windowsSetupExe: string;
  };
}

function readEnv(
  key: 'VITE_LEAD_ENDPOINT' | 'VITE_CONTACT_EMAIL' | 'VITE_SHOW_MAC_UNSIGNED_GUIDE',
): string {
  const value = import.meta.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export const SITE_CONFIG: SiteConfig = {
  version: '0.6.5',
  releaseDate: '2026-11',
  showMacUnsignedGuide: readEnv('VITE_SHOW_MAC_UNSIGNED_GUIDE') !== 'false',
  leadEndpoint: readEnv('VITE_LEAD_ENDPOINT'),
  contactEmail: readEnv('VITE_CONTACT_EMAIL') || 'enterprise@nucleant.cn',
  links: {
    github: 'https://github.com/jarod-w/evowork',
    githubIssues: 'https://github.com/jarod-w/evowork/issues',
    githubReleases: 'https://github.com/jarod-w/evowork/releases',
    accountPortal: 'https://account.nucleant.cn',
    macArm64Dmg: 'https://update.nucleant.cn/latest/EvoWork-0.6.5-mac-arm64-unsigned.dmg',
    windowsSetupExe: 'https://update.nucleant.cn/latest/EvoWork-0.6.5-win-x64-setup.exe',
  },
};
