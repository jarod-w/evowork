// The one and only surface the UI is allowed to touch for native
// capabilities. Anything platform-specific hides behind this module; a
// future shell swap means rewriting a single adapter, not the app.
//
// Hard rule (design doc 06 §6): at most 5 methods on `Platform`. Adding a
// 6th needs a documented reason -- it is not a casual choice.
//
// IMPORTANT: this file must never import Tauri's JS bindings package.
// That import is only allowed inside `platform/tauri.ts` (Task 3).
// Importing it here would leak those bindings into every build target,
// including the plain browser build, and would fail CI check 9.

import { createBrowserPlatform } from './browser'

export interface Platform {
  pickFile(): Promise<File | null>
  openExternal(url: string): Promise<void>
  notify(title: string, body: string): Promise<void>
  setAutoLaunch(enabled: boolean): Promise<void>
  quit(): Promise<void>
}

export interface PlatformInfo {
  kind: 'browser' | 'desktop'
  supports(cap: keyof Platform): boolean
}

/**
 * Tauri 2 injects `window.__TAURI_INTERNALS__` into every webview it hosts.
 * A plain browser tab never sees this global, so its presence is a safe,
 * import-free way to tell the two shells apart at runtime.
 */
function isDesktopShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function getPlatform(): Platform & { info: PlatformInfo } {
  if (isDesktopShell()) {
    // Task 3 owns platform/tauri.ts, the only file allowed to import the
    // Tauri JS bindings. It does not exist yet, so a build actually running
    // inside a Tauri shell must fail loudly here instead of silently
    // falling back to the browser implementation (which would make
    // desktop-only bugs look like they "work" until someone tries the
    // unsupported capabilities).
    throw new Error(
      'getPlatform(): running inside a Tauri shell, but platform/tauri.ts ' +
        'has not been implemented yet (that is Task 3).',
    )
  }
  return createBrowserPlatform()
}
