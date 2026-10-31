/**
 * 本机「打开方式」应用探测与唤起（macOS LaunchServices）。
 *
 * 只在主进程使用，渲染层只拿到经过过滤的 `ResultOpenAppView` 列表，
 * 且用特定应用打开时必须在 `renderer-bridge` 先核对该 `appId` 在本机返回的可选名单内。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ResultOpenAppView } from '../shared/ipc.js';

const execFileAsync = promisify(execFile);

/** K5：对外不展示上游品牌应用名。 */
const UPSTREAM_BRAND_APP_NAME = /codex|chatgpt|openai/i;

export interface RawOpenAppEntry {
  readonly path: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly iconDataUrl?: string | undefined;
}

export function filterAndSortOpenApps(
  entries: readonly RawOpenAppEntry[],
): readonly ResultOpenAppView[] {
  const seen = new Set<string>();
  const filtered: ResultOpenAppView[] = [];
  for (const entry of entries) {
    const path = typeof entry.path === 'string' ? entry.path.trim() : '';
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    if (!path || !name) continue;
    if (UPSTREAM_BRAND_APP_NAME.test(name)) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    filtered.push({
      id: path,
      name,
      isDefault: Boolean(entry.isDefault),
      ...(typeof entry.iconDataUrl === 'string' &&
      entry.iconDataUrl.startsWith('data:image/png;base64,')
        ? { iconDataUrl: entry.iconDataUrl }
        : {}),
    });
  }
  return filtered.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}

const JXA_LIST_OPEN_APPS_SCRIPT = `
ObjC.import("AppKit");
function iconDataUrl(ws, appPath) {
  try {
    const img = ws.iconForFile(appPath);
    if (!img) return undefined;
    const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
      null, 32, 32, 8, 4, true, false, $.NSCalibratedRGBColorSpace, 0, 0
    );
    $.NSGraphicsContext.saveGraphicsState;
    $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep));
    img.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationCopy, 1.0);
    $.NSGraphicsContext.restoreGraphicsState;
    const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
    if (!png) return undefined;
    const b64 = ObjC.unwrap(png.base64EncodedStringWithOptions(0));
    return b64 ? "data:image/png;base64," + b64 : undefined;
  } catch (e) {
    return undefined;
  }
}
function run(argv) {
  const target = argv[0];
  if (!target) return "[]";
  const ws = $.NSWorkspace.sharedWorkspace;
  const u = $.NSURL.fileURLWithPath(target);
  const defApp = ws.URLForApplicationToOpenURL(u);
  const defPath = defApp ? ObjC.unwrap(defApp.path) : "";
  const allApps = ws.URLsForApplicationsToOpenURL(u);
  const fm = $.NSFileManager.defaultManager;
  const res = [];
  if (allApps) {
    const n = allApps.count;
    for (let i = 0; i < n; i++) {
      const a = allApps.objectAtIndex(i);
      const p = ObjC.unwrap(a.path);
      if (!p) continue;
      const name = ObjC.unwrap(fm.displayNameAtPath(p)).replace(/\\.app$/i, "");
      res.push({ path: p, name, isDefault: p === defPath, iconDataUrl: iconDataUrl(ws, p) });
    }
  }
  return JSON.stringify(res);
}
`;

export async function listMacOpenApps(filePath: string): Promise<readonly ResultOpenAppView[]> {
  if (process.platform !== 'darwin') return [];
  try {
    const { stdout } = await execFileAsync(
      'osascript',
      ['-l', 'JavaScript', '-e', JXA_LIST_OPEN_APPS_SCRIPT, filePath],
      { timeout: 3000, maxBuffer: 2 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout.trim()) as unknown;
    if (!Array.isArray(parsed)) return [];
    return filterAndSortOpenApps(parsed as readonly RawOpenAppEntry[]);
  } catch {
    return [];
  }
}

export async function openFileWithMacApp(filePath: string, appPath: string): Promise<void> {
  await execFileAsync('open', ['-a', appPath, filePath], { timeout: 5000 });
}
