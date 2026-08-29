// Browser fallback for the `Platform` interface (see ./index.ts). Runs
// when the app is loaded as a plain web page rather than inside the Tauri
// shell -- e.g. this M1 scaffold, or any future "run in a browser tab"
// mode.
//
// Two capabilities are structurally impossible from a web page:
// `setAutoLaunch` (no OS-level "start at login" hook) and `quit` (a page
// cannot terminate its own host process). Both report `supports() ===
// false` AND throw a clear error if called anyway -- never a silent
// no-op, so "this doesn't work here" is discoverable without trial and
// error.

import type { Platform, PlatformInfo } from './index'

const UNSUPPORTED = new Set<keyof Platform>(['setAutoLaunch', 'quit'])

function supports(cap: keyof Platform): boolean {
  return !UNSUPPORTED.has(cap)
}

function unsupported(cap: keyof Platform): never {
  throw new Error(
    `platform.${cap}() is not supported in the browser shell: a web page ` +
      'cannot control its host process (no autostart registration, no ' +
      'process exit). This capability only exists in the desktop (Tauri) ' +
      'shell.',
  )
}

function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'

    // The native file picker is modal: once `input.click()` opens it,
    // exactly one of these two signals eventually fires, and either one
    // is allowed to settle the promise -- the other must then become a
    // no-op instead of resolving a second time.
    let settled = false
    const settle = (file: File | null) => {
      if (settled) return
      settled = true
      window.removeEventListener('focus', onWindowFocus)
      resolve(file)
    }

    input.addEventListener('change', () => {
      settle(input.files?.[0] ?? null)
    })

    // Primary path: recent Chromium/Firefox fire a `cancel` event on the
    // <input> itself when the picker is dismissed without a selection.
    // Feature-detected because older engines don't support it.
    if ('oncancel' in input) {
      input.addEventListener('cancel', () => {
        settle(null)
      })
    }

    // Fallback heuristic, kept even where `cancel` is supported: the
    // picker is modal, so this window loses focus while it's open and
    // regains it the instant the dialog closes, cancel or pick alike.
    // `change` (a real pick) fires just before focus returns, so
    // deferring one macrotask lets `change` win that race and settle
    // first; if `cancel` already settled us, this is a no-op.
    const onWindowFocus = () => {
      window.setTimeout(() => settle(null), 0)
    }
    window.addEventListener('focus', onWindowFocus, { once: true })

    input.click()
  })
}

async function openExternal(url: string): Promise<void> {
  const win = window.open(url, '_blank', 'noopener,noreferrer')
  if (!win) {
    throw new Error(
      'platform.openExternal(): window.open() returned null (likely ' +
        'blocked by a popup blocker).',
    )
  }
}

async function notify(title: string, body: string): Promise<void> {
  if (!('Notification' in window)) {
    throw new Error(
      'platform.notify(): the Notification API is not available in this ' +
        'browser.',
    )
  }
  let permission = Notification.permission
  if (permission === 'default') {
    permission = await Notification.requestPermission()
  }
  if (permission !== 'granted') {
    throw new Error(
      'platform.notify(): notification permission was not granted.',
    )
  }
  new Notification(title, { body })
}

async function setAutoLaunch(_enabled: boolean): Promise<void> {
  unsupported('setAutoLaunch')
}

async function quit(): Promise<void> {
  unsupported('quit')
}

export function createBrowserPlatform(): Platform & { info: PlatformInfo } {
  const info: PlatformInfo = { kind: 'browser', supports }
  return { pickFile, openExternal, notify, setAutoLaunch, quit, info }
}
