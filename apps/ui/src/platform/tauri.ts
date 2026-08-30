// Desktop implementation of the `Platform` interface (see ./index.ts),
// backed by the Tauri 2 shell in `apps/ui/src-tauri`.
//
// **This is the only file in the entire repo allowed to import from the
// `@tauri-apps` package family** -- the core package and the official
// `plugin-*` packages that back the five `Platform` methods alike.
// `platform/index.ts` never imports this module at the top of the file
// (a static import would drag all of the below into the plain browser
// bundle, including the enterprise-WeChat mobile approval entry point)
// -- it reaches this module through a dynamic `import()` only once it
// has already detected a Tauri shell at runtime. See the comment on
// `getPlatform()` in ./index.ts for the full reasoning.
//
// Tauri 2 split what used to live in a single core JS package (v1)
// across that core package plus one plugin package per capability. None
// of the five `Platform` methods are covered by the core package itself,
// so this file reaches entirely for the `plugin-*` packages:
//
//   pickFile      -> @tauri-apps/plugin-dialog   (native file picker)
//                  + @tauri-apps/plugin-fs        (read the picked path
//                    into bytes, because Tauri's dialog only returns a
//                    filesystem path, not a web `File`/`Blob`)
//   openExternal  -> @tauri-apps/plugin-opener   (hand a URL to the OS)
//   notify        -> @tauri-apps/plugin-notification
//   setAutoLaunch -> @tauri-apps/plugin-autostart (design doc 06 par 6:
//                    "tray/autostart")
//   quit          -> @tauri-apps/plugin-process  (terminate the app
//                    process, not just close the current window)
//
// Each of these plugins must be registered in `src-tauri/src/main.rs`
// (`.plugin(tauri_plugin_xxx::init())`) or the calls below fail at
// runtime with a "plugin not registered" error -- that registration is
// shell wiring, not business logic, so it does not violate main.rs's
// "zero business logic" rule.

import { isTauri } from '@tauri-apps/api/core'
import { enable as enableAutoLaunch, disable as disableAutoLaunch } from '@tauri-apps/plugin-autostart'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { readFile } from '@tauri-apps/plugin-fs'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { openUrl } from '@tauri-apps/plugin-opener'
import { exit } from '@tauri-apps/plugin-process'

import type { Platform, PlatformInfo } from './index'

// All five capabilities are real OS-level operations on desktop -- unlike
// the browser shell, nothing here is structurally unsupported.
function supports(_cap: keyof Platform): boolean {
  return true
}

function basename(path: string): string {
  // Tauri's dialog plugin returns native OS paths (`\` on Windows, `/`
  // on macOS/Linux); split on both rather than assuming one separator.
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] || path
}

async function pickFile(): Promise<File | null> {
  const path = await openFileDialog({ multiple: false, directory: false })
  if (path === null) return null

  // The dialog plugin only ever hands back a filesystem path -- turning
  // that into the web `File` object the `Platform` interface promises
  // (so callers don't need a second, desktop-only code path) means
  // reading the bytes ourselves via the fs plugin.
  const bytes = await readFile(path)
  return new File([bytes], basename(path))
}

async function openExternal(url: string): Promise<void> {
  await openUrl(url)
}

async function notify(title: string, body: string): Promise<void> {
  let granted = await isPermissionGranted()
  if (!granted) {
    const permission = await requestPermission()
    granted = permission === 'granted'
  }
  if (!granted) {
    throw new Error(
      'platform.notify(): notification permission was not granted.',
    )
  }
  sendNotification({ title, body })
}

async function setAutoLaunch(enabled: boolean): Promise<void> {
  if (enabled) {
    await enableAutoLaunch()
  } else {
    await disableAutoLaunch()
  }
}

async function quit(): Promise<void> {
  await exit(0)
}

export function createDesktopPlatform(): Platform & { info: PlatformInfo } {
  // Belt-and-suspenders: `platform/index.ts` already gates the dynamic
  // `import()` of this module on its own `__TAURI_INTERNALS__` sniff
  // (necessarily import-free, since that file loads on every build
  // target). `isTauri()` is the official, separate signal Tauri itself
  // injects (`globalThis.isTauri`) -- checking it here catches this
  // module ever being constructed outside a real Tauri webview (e.g. a
  // future refactor that imports it directly, bypassing
  // `getPlatform()`) without relying on index.ts's heuristic being
  // right forever. This is also the one legitimate use this file has
  // for the bare core package -- every actual `Platform` method below
  // is covered by a `plugin-*` package instead (see the file-level
  // comment).
  if (!isTauri()) {
    throw new Error(
      'createDesktopPlatform(): called outside a Tauri webview (isTauri() ' +
        'returned false). Use getPlatform() from platform/index.ts instead ' +
        'of importing this module directly.',
    )
  }

  const info: PlatformInfo = { kind: 'desktop', supports }
  return { pickFile, openExternal, notify, setAutoLaunch, quit, info }
}
