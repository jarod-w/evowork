import { afterEach, describe, expect, it } from 'vitest'

import { getPlatform } from './index'

// `window.__TAURI_INTERNALS__` is not part of the standard DOM types --
// Tauri injects it at runtime, not via a typed API. Declaring it here
// (rather than reaching for `any`/`@ts-expect-error`) is the "proper type
// extension" the task calls for.
declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
  }
}

describe('getPlatform()', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__
  })

  it('returns the browser platform outside a Tauri shell', () => {
    expect(getPlatform().info.kind).toBe('browser')
  })

  // FORCING FUNCTION -- read before touching this test.
  //
  // platform/tauri.ts (Task 3) does not exist yet, so getPlatform() must
  // throw a loud, honest error when it detects a Tauri shell rather than
  // silently handing back the browser implementation. This test pins down
  // exactly that *current, temporary* behavior.
  //
  // Linux dev machines and CI never run inside a real Tauri webview, so
  // `window.__TAURI_INTERNALS__` is never present there on its own -- no
  // automated signal will ever catch someone finishing Task 3 and
  // forgetting to wire the desktop branch of getPlatform() up to the real
  // implementation. This test is that signal, manufactured by shimming
  // the global Tauri injects.
  //
  // When Task 3 lands and getPlatform() actually calls into
  // platform/tauri.ts for the desktop case, THIS TEST IS EXPECTED TO GO
  // RED. That is success, not a regression: replace the assertions below
  // with assertions on the real desktop Platform (e.g.
  // `getPlatform().info.kind === 'desktop'`, and that its methods call
  // through to the Tauri bindings). Do not delete this test to make it
  // pass again -- a red run here is the whole point of the test existing.
  it('throws a clear "desktop shell not implemented yet" error inside a Tauri shell (current, temporary behavior)', () => {
    window.__TAURI_INTERNALS__ = {}

    expect(() => getPlatform()).toThrow(/tauri/i)
    expect(() => getPlatform()).toThrow(/has not been implemented yet/i)
  })
})
