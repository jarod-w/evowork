import { afterEach, describe, expect, it, vi } from 'vitest'

import { getPlatform } from './index'

// `window.__TAURI_INTERNALS__` and `window.isTauri` are not part of the
// standard DOM types -- Tauri injects both at runtime, not via a typed
// API. Declaring them here (rather than reaching for `any`/
// `@ts-expect-error`) is the "proper type extension" the task calls for.
// `__TAURI_INTERNALS__` is what `platform/index.ts`'s own `isDesktopShell()`
// sniffs; `isTauri` is the separate flag Tauri's core JS binding package
// reads inside its own `isTauri()` helper, which `platform/tauri.ts` uses
// as a second, independent signal (see its module comment) -- shimming
// both is what lets this suite exercise `platform/tauri.ts`'s *real*,
// unmocked `isTauri()` guard instead of stubbing it out.
declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown
    isTauri?: boolean
  }
}

// This suite runs in jsdom, never inside a real Tauri webview, so every
// Tauri plugin `platform/tauri.ts` touches has to be mocked -- these
// stand in for the native side that would otherwise answer them. (The
// bare core JS binding package is deliberately NOT mocked here -- see
// the comment above `declare global` -- so it is not imported by this
// file at all, keeping `platform/tauri.ts` the only file in the repo
// that does.) They are declared once at module scope (hoisted above the
// imports below by vitest, same as jest) so both
// `getPlatform()` (via its dynamic `import('./tauri')`) and this file's
// direct imports of the mocked modules resolve to the same mock
// instances.
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: vi.fn() }))
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-autostart', () => ({ enable: vi.fn(), disable: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
vi.mock('@tauri-apps/plugin-process', () => ({ exit: vi.fn() }))

const { open: mockOpen } = await import('@tauri-apps/plugin-dialog')
const { readFile: mockReadFile } = await import('@tauri-apps/plugin-fs')
const {
  isPermissionGranted: mockIsPermissionGranted,
  requestPermission: mockRequestPermission,
  sendNotification: mockSendNotification,
} = await import('@tauri-apps/plugin-notification')
const { enable: mockEnable, disable: mockDisable } = await import('@tauri-apps/plugin-autostart')
const { openUrl: mockOpenUrl } = await import('@tauri-apps/plugin-opener')
const { exit: mockExit } = await import('@tauri-apps/plugin-process')

describe('getPlatform()', () => {
  afterEach(() => {
    delete window.__TAURI_INTERNALS__
    delete window.isTauri
    // clear, not reset: every test that consumes a mock's return value
    // sets it explicitly (`mockResolvedValue`) before calling into the
    // platform, so clearing just the call history between tests is
    // enough to keep them independent -- no mock here needs a
    // persistent default implementation across tests.
    vi.clearAllMocks()
  })

  it('returns the browser platform outside a Tauri shell', async () => {
    expect((await getPlatform()).info.kind).toBe('browser')
  })

  // FORCING FUNCTION -- read before touching this test.
  //
  // This test used to shim `window.__TAURI_INTERNALS__` and assert that
  // getPlatform() threw a "platform/tauri.ts has not been implemented
  // yet" placeholder error -- back when Task 3 (this task) hadn't landed
  // yet. That assertion going red the moment Task 3 wired up the real
  // desktop implementation was the whole point of the test: Linux dev
  // machines and CI never run inside a real Tauri webview, so nothing
  // else would ever have caught someone finishing Task 3 and forgetting
  // to actually hook `getPlatform()` up to `platform/tauri.ts`.
  //
  // That is exactly what happened -- this is Task 3, landing now -- so
  // per the instruction left here, the assertions below have been
  // replaced with assertions on the real desktop `Platform`, and the
  // test (and this comment) were kept rather than deleted. Do not delete
  // this test on some future refactor either: it is still the only
  // automated signal that `getPlatform()`'s desktop branch is actually
  // wired to `platform/tauri.ts`, as opposed to, say, someone
  // accidentally routing it back to the browser implementation.
  it('returns the real desktop Platform inside a Tauri shell (Task 3: wired up)', async () => {
    window.__TAURI_INTERNALS__ = {}
    window.isTauri = true

    const platform = await getPlatform()

    expect(platform.info.kind).toBe('desktop')
    // All five capabilities are real OS-level operations on desktop --
    // unlike the browser shell, nothing is structurally unsupported.
    expect(platform.info.supports('setAutoLaunch')).toBe(true)
    expect(platform.info.supports('quit')).toBe(true)
  })

  it('rejects if the desktop branch is reached without the real Tauri isTauri() signal (belt-and-suspenders guard)', async () => {
    // Only `__TAURI_INTERNALS__` is shimmed, not `isTauri` -- exercises
    // `createDesktopPlatform()`'s own guard (see platform/tauri.ts)
    // independently of `getPlatform()`'s own `isDesktopShell()` check.
    window.__TAURI_INTERNALS__ = {}

    await expect(getPlatform()).rejects.toThrow(/isTauri/)
  })

  describe('desktop Platform methods call through to the Tauri bindings', () => {
    // One `getPlatform()` call per test, all inside a Tauri shell --
    // establishes the precondition each of the method-wiring assertions
    // below builds on.
    async function desktopPlatform() {
      window.__TAURI_INTERNALS__ = {}
      window.isTauri = true
      return getPlatform()
    }

    it('pickFile() calls the dialog plugin, then reads the picked path via the fs plugin', async () => {
      vi.mocked(mockOpen).mockResolvedValue('/Users/demo/report.pdf')
      vi.mocked(mockReadFile).mockResolvedValue(new Uint8Array([1, 2, 3]))

      const platform = await desktopPlatform()
      const file = await platform.pickFile()

      expect(mockOpen).toHaveBeenCalledWith({ multiple: false, directory: false })
      expect(mockReadFile).toHaveBeenCalledWith('/Users/demo/report.pdf')
      expect(file?.name).toBe('report.pdf')
    })

    it('pickFile() resolves null without touching the fs plugin when the dialog is cancelled', async () => {
      vi.mocked(mockOpen).mockResolvedValue(null)

      const platform = await desktopPlatform()
      const file = await platform.pickFile()

      expect(file).toBeNull()
      expect(mockReadFile).not.toHaveBeenCalled()
    })

    it('openExternal() calls the opener plugin with the given URL', async () => {
      vi.mocked(mockOpenUrl).mockResolvedValue(undefined)

      const platform = await desktopPlatform()
      await platform.openExternal('https://example.com/approval/42')

      expect(mockOpenUrl).toHaveBeenCalledWith('https://example.com/approval/42')
    })

    it('notify() calls the notification plugin once permission is granted', async () => {
      vi.mocked(mockIsPermissionGranted).mockResolvedValue(true)

      const platform = await desktopPlatform()
      await platform.notify('Run finished', 'Exit code 0')

      expect(mockSendNotification).toHaveBeenCalledWith({
        title: 'Run finished',
        body: 'Exit code 0',
      })
    })

    it('notify() throws instead of calling the notification plugin when permission is denied', async () => {
      vi.mocked(mockIsPermissionGranted).mockResolvedValue(false)
      vi.mocked(mockRequestPermission).mockResolvedValue('denied')

      const platform = await desktopPlatform()

      await expect(platform.notify('title', 'body')).rejects.toThrow(/permission/i)
      expect(mockSendNotification).not.toHaveBeenCalled()
    })

    it('setAutoLaunch(true) calls the autostart plugin\'s enable(), not disable()', async () => {
      const platform = await desktopPlatform()
      await platform.setAutoLaunch(true)

      expect(mockEnable).toHaveBeenCalledOnce()
      expect(mockDisable).not.toHaveBeenCalled()
    })

    it('setAutoLaunch(false) calls the autostart plugin\'s disable(), not enable()', async () => {
      const platform = await desktopPlatform()
      await platform.setAutoLaunch(false)

      expect(mockDisable).toHaveBeenCalledOnce()
      expect(mockEnable).not.toHaveBeenCalled()
    })

    it('quit() calls the process plugin\'s exit()', async () => {
      const platform = await desktopPlatform()
      await platform.quit()

      expect(mockExit).toHaveBeenCalledWith(0)
    })
  })
})
