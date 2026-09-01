// Browser fallback for the `Platform` interface (see ./index.ts). Runs
// when the app is loaded as a plain web page rather than inside the Tauri
// shell -- e.g. this M1 scaffold, or any future "run in a browser tab"
// mode.
//
// Three capabilities are structurally impossible from a web page:
// `setAutoLaunch` (no OS-level "start at login" hook), `quit` (a page
// cannot terminate its own host process), and `readClientToml` (a page
// cannot read a file at a fixed absolute path -- the only file bytes it
// ever sees are ones the user hands it through a picker). All three
// report `supports() === false` AND throw a clear error if called anyway
// -- never a silent no-op, so "this doesn't work here" is discoverable
// without trial and error.
//
// `readClientToml` returning `null` here instead of throwing would have
// been convenient for its one caller (App.tsx's bootstrap treats "no
// file" and "cannot read files" the same way), and that is exactly why
// it does not: `null` is this method's legitimate "the file is not
// there" answer on desktop, so reusing it for "this shell has no
// filesystem" would make the two indistinguishable at the seam. The
// caller checks `supports()` first.

import type { Platform, PlatformInfo } from './index'

const UNSUPPORTED = new Set<keyof Platform>(['setAutoLaunch', 'quit', 'readClientToml'])

function supports(cap: keyof Platform): boolean {
  return !UNSUPPORTED.has(cap)
}

function unsupported(cap: keyof Platform): never {
  throw new Error(
    `platform.${cap}() is not supported in the browser shell: a web page ` +
      'cannot control its host process (no autostart registration, no ' +
      'process exit) and cannot read a file at a fixed absolute path. ' +
      'This capability only exists in the desktop (Tauri) shell.',
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
    //
    // Safari has never shipped the `cancel` event on <input type=file>,
    // so on Safari -- which is exactly the engine every user of this
    // browser shell is on, since it's opened from an enterprise-WeChat
    // approval link on iOS -- this fallback isn't a rare edge case, it's
    // the ONLY path that ever unsticks a cancelled pick.
    //
    // A naive version of this fallback assumes `change` always wins the
    // race and unconditionally settles null the instant focus returns.
    // That assumption is false: nothing guarantees the browser dispatches
    // (or that we finish handling) `change` before the `focus` event's
    // callback runs. An adversarial-but-real ordering -- focus fires,
    // this callback runs, *then* `change` arrives with a real File --
    // reproduces the bug directly: a real selection gets reported as
    // null, and the later `change` is silently swallowed by the
    // `settled` guard above.
    //
    // The fix: don't infer "cancelled" from focus alone. The browser
    // sets `input.files` synchronously the moment the user picks a file,
    // before it dispatches `change` or returns focus to this window -- so
    // by the time this callback runs, `input.files` already reflects the
    // truth even if the `change` *event* hasn't been handled yet. Check
    // it: a non-empty `files` means a file was actually picked (`change`
    // is either on its way or already handled, in which case `settle` is
    // already a no-op), so only an EMPTY `files` list means a real cancel.
    //
    // The delay can't be 0ms: that gives the browser no room to flush
    // `input.files` and dispatch `change` before we've already decided
    // "no file" -- 0ms is exactly what reproduces the adversarial
    // ordering above. 300ms is the value the community's "focus +
    // timeout" cancel-detection pattern has converged on; it's cheap
    // (the user already closed a modal dialog, so a third-of-a-second
    // is imperceptible) and gives `change` a real window to land.
    const onWindowFocus = () => {
      window.setTimeout(() => {
        if (input.files && input.files.length > 0) return
        settle(null)
      }, 300)
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

async function readClientToml(): Promise<string | null> {
  unsupported('readClientToml')
}

export function createBrowserPlatform(): Platform & { info: PlatformInfo } {
  const info: PlatformInfo = { kind: 'browser', supports }
  return { pickFile, openExternal, notify, setAutoLaunch, quit, readClientToml, info }
}
