/** Windows x64 基础版的宿主限制；不读取可绕过限制的环境开关。 */
export const WINDOWS_OCR_DISABLED =
  'Windows x64 基础版暂未开放 OCR，图片和扫描件可保留原文件引用。';

export function ocrDisabledReason(platform: string = process.platform): string | undefined {
  return platform === 'win32' ? WINDOWS_OCR_DISABLED : undefined;
}
