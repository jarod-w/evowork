// Desktop implementation of the `Platform` interface (see ./index.ts),
// backed by the Tauri 2 shell in `apps/ui/src-tauri`.
//
// **This is the only file in the entire repo allowed to import from the
// `@tauri-apps` package family** -- the core package and the official
// `plugin-*` packages that back the six `Platform` methods alike.
// `platform/index.ts` never imports this module at the top of the file
// (a static import would drag all of the below into the plain browser
// bundle, including the enterprise-WeChat mobile approval entry point)
// -- it reaches this module through a dynamic `import()` only once it
// has already detected a Tauri shell at runtime. See the comment on
// `getPlatform()` in ./index.ts for the full reasoning.
//
// Tauri 2 split what used to live in a single core JS package (v1)
// across that core package plus one plugin package per capability. None
// of the six `Platform` methods are covered by the core package itself,
// so this file reaches entirely for the `plugin-*` packages:
//
//   pickFile        -> @tauri-apps/plugin-dialog   (native file picker)
//                    + @tauri-apps/plugin-fs        (read the picked path
//                      into bytes, because Tauri's dialog only returns a
//                      filesystem path, not a web `File`/`Blob`)
//   openExternal    -> @tauri-apps/plugin-opener   (hand a URL to the OS)
//   notify          -> @tauri-apps/plugin-notification
//   setAutoLaunch   -> @tauri-apps/plugin-autostart (design doc 06 par 6:
//                      "tray/autostart")
//   quit            -> @tauri-apps/plugin-process  (terminate the app
//                      process, not just close the current window)
//   readClientToml  -> @tauri-apps/plugin-fs        (read one fixed path
//                      under $HOME; see the block comment on
//                      `readClientToml` below for the scope this needs)
//
// Each of these plugins must be registered in `src-tauri/src/main.rs`
// (`.plugin(tauri_plugin_xxx::init())`) or the calls below fail at
// runtime with a "plugin not registered" error -- that registration is
// shell wiring, not business logic, so it does not violate main.rs's
// "zero business logic" rule.

import { isTauri } from '@tauri-apps/api/core'
import { enable as enableAutoLaunch, disable as disableAutoLaunch } from '@tauri-apps/plugin-autostart'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { BaseDirectory, readFile, readTextFile } from '@tauri-apps/plugin-fs'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import { openUrl } from '@tauri-apps/plugin-opener'
import { exit } from '@tauri-apps/plugin-process'

import { CLIENT_TOML_RELATIVE_PATH } from '../daemon/config'

import type { Platform, PlatformInfo } from './index'

// All six capabilities are real OS-level operations on desktop -- unlike
// the browser shell, nothing here is structurally unsupported.
//
// Note the asymmetry with `readClientToml`: "supported" means the shell
// can perform the operation, not that it will find a file. A machine
// where `evo-daemon` has never run has no `~/.evowork/client.toml`, and
// `readClientToml()` correctly resolves `null` there while `supports()`
// stays `true` -- "this shell can read files" and "this file exists" are
// different questions and the caller needs both answers separately.
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

/**
 * Reads `~/.evowork/client.toml` -- the file `evo-daemon` writes on
 * first run, carrying the shared token and the URL it bound to
 * (`crates/evo-daemon/src/main.rs::write_client_toml`). This is the
 * desktop artifact's zero-configuration path onto a local daemon (P0-17).
 *
 * ## The capability this needs, and why it is narrow
 *
 * `pickFile()` gets away with `fs:allow-read-file` and NO standing
 * filesystem scope, because the dialog plugin grants a one-shot scope for
 * the exact path the user just picked (see
 * `src-tauri/capabilities/README.md`). Nothing does that here: this path
 * is chosen by the code, not by a user gesture through a plugin that
 * widens the scope as a side effect. So this call needs a *static* scope
 * entry, and `capabilities/default.json` carries one -- scoped to the
 * single literal file `$HOME/.evowork/client.toml`, attached to
 * `fs:allow-read-text-file` alone rather than to the plugin's global
 * scope. `tauri-plugin-fs` 2.5.1 honours per-command scopes: every fs
 * command takes both `GlobalScope<Entry>` and `CommandScope<Entry>`
 * (`src/commands.rs`), and `read_text_file` is no exception.
 *
 * That is a real widening of this shell's standing authority -- from
 * "nothing" to "one file" -- and README.md's "No `fs` scope is
 * configured here, on purpose" section was rewritten rather than left
 * standing next to a file that contradicts it.
 *
 * `BaseDirectory.Home` rather than an absolute path built in JS: it lets
 * the fs plugin resolve `$HOME` on the Rust side, which keeps this off
 * `@tauri-apps/api/path`'s `homeDir()` -- that would have been a second
 * IPC command needing its own permission, invisible to
 * `tauri.capabilities.test.ts` (which only scans `@tauri-apps/plugin-*`
 * specifiers, not the core `api` package).
 *
 * A missing file resolves `null`, not a throw. The plugin surfaces
 * "not found" as a rejection with no typed error code, so this cannot
 * distinguish it from a denied scope or an unreadable file -- and
 * deliberately does not try to: every one of those means the same thing
 * to the caller ("no settings to be had from here, ask the user"), and
 * inventing a distinction by string-matching the error message would be
 * a claim this code cannot back. The settings panel is the fallback in
 * all of those cases.
 */
async function readClientToml(): Promise<string | null> {
  try {
    return await readTextFile(CLIENT_TOML_RELATIVE_PATH, { baseDir: BaseDirectory.Home })
  } catch {
    return null
  }
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
  return { pickFile, openExternal, notify, setAutoLaunch, quit, readClientToml, info }
}
