// The one and only surface the UI is allowed to touch for native
// capabilities. Anything platform-specific hides behind this module; a
// future shell swap means rewriting a single adapter, not the app.
//
// Hard rule (design doc 06 §6): at most 5 methods on `Platform`. Adding a
// 6th needs a documented reason -- it is not a casual choice.
//
// IMPORTANT: this file must never *statically* import Tauri's JS
// bindings package, or anything that transitively does. That import
// (the `@tauri-apps` package family -- core plus the `plugin-*`
// packages it pulls in) is only allowed inside `platform/tauri.ts`
// (Task 3). A static `import ... from './tauri'` at the top of this
// file would put it on this module's dependency graph unconditionally
// -- Rollup cannot prove
// the desktop branch below is dead code just because it happens not to
// run in a browser, so it would bundle `tauri.ts` (and its plugin
// packages) into *every* build target, including the plain browser
// build that a phone opens from an enterprise-WeChat approval link
// (design doc 06 §4) and that Task 1's review measured at zero
// `tauri-apps` references in `dist/assets/*.js`. That is a property
// worth keeping, not just an incidental measurement -- so the desktop
// branch below reaches `tauri.ts` through a dynamic `import()` instead,
// which Rollup *can* split into a separate chunk that a browser build
// never fetches. The cost is that `getPlatform()` has to be async (it
// wasn't before this task); the only call site (`App.tsx`) resolves it
// once in an effect. That is a much smaller blast radius than shipping
// Tauri's JS bindings to every phone that opens an approval link.

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

export async function getPlatform(): Promise<Platform & { info: PlatformInfo }> {
  if (isDesktopShell()) {
    // Dynamic import, not a top-level static one -- see the file-level
    // comment above for why. This is the only place in the repo that
    // reaches into platform/tauri.ts.
    const { createDesktopPlatform } = await import('./tauri')
    return createDesktopPlatform()
  }
  return createBrowserPlatform()
}
