/**
 * 渲染层桌面平台识别（01 §3.2）。
 *
 * - `macos`：`hiddenInset` 交通灯浮在左上角，侧边栏保留 52 高交通灯标题栏带；
 * - `windows`：`titleBarStyle: 'hidden'` + `titleBarOverlay`，侧边栏与主区共用 44 高一体化顶栏，
 *   右侧为原生 `— □ ✕` 预留安全区；
 * - `other`：Linux 等系统标题栏环境，侧边栏同样不渲染 macOS 交通灯空行。
 */
export type DesktopPlatform = 'macos' | 'windows' | 'other';

export interface NavigatorPlatformHint {
  readonly platform?: string | undefined;
  readonly userAgent?: string | undefined;
}

export function detectDesktopPlatform(
  nav: NavigatorPlatformHint | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
): DesktopPlatform {
  const platform = nav?.platform ?? '';
  const userAgent = nav?.userAgent ?? '';
  if (platform.startsWith('Mac') || userAgent.includes('Macintosh')) {
    return 'macos';
  }
  if (platform.startsWith('Win') || userAgent.includes('Windows')) {
    return 'windows';
  }
  return 'other';
}

export function currentDesktopPlatform(): DesktopPlatform {
  if (typeof document !== 'undefined') {
    const datasetPlatform = document.documentElement.dataset.platform;
    if (
      datasetPlatform === 'macos' ||
      datasetPlatform === 'windows' ||
      datasetPlatform === 'other'
    ) {
      return datasetPlatform;
    }
  }
  return detectDesktopPlatform();
}
