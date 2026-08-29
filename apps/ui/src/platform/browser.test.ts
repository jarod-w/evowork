import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBrowserPlatform } from './browser'

// Gives the test a handle to the <input type=file> the implementation
// creates internally (it never appends it to the document or exposes it),
// so we can dispatch the same events the real DOM would fire on it.
function interceptFileInput(): { getInput: () => HTMLInputElement } {
  let input: HTMLInputElement | undefined
  const original = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation((tagName: string, options?: ElementCreationOptions) => {
    const el = original(tagName, options)
    if (tagName === 'input') input = el as HTMLInputElement
    return el
  })
  return {
    getInput: () => {
      if (!input) throw new Error('input was not created yet')
      return input
    },
  }
}

function setInputFiles(input: HTMLInputElement, files: File[]): void {
  // `HTMLInputElement.files` is a read-only FileList in real browsers;
  // overriding it as an own property is the standard way to fake a user
  // selection in a DOM test.
  Object.defineProperty(input, 'files', { value: files, configurable: true })
}

describe('browser platform: pickFile()', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('resolves with the selected file on change', async () => {
    const { getInput } = interceptFileInput()
    const platform = createBrowserPlatform()

    const result = platform.pickFile()
    const input = getInput()
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })
    setInputFiles(input, [file])
    input.dispatchEvent(new Event('change'))

    await expect(result).resolves.toBe(file)
  })

  it('resolves with null (not a hung promise) when the native cancel event fires', async () => {
    const { getInput } = interceptFileInput()
    const platform = createBrowserPlatform()

    const result = platform.pickFile()
    const input = getInput()
    expect('oncancel' in input).toBe(true)
    input.dispatchEvent(new Event('cancel'))

    await expect(result).resolves.toBeNull()
  })

  it('resolves with null via the window-focus fallback when no cancel event fires', async () => {
    // Covers engines that never fire `cancel` on a file input: the
    // dialog closing without a `change` still returns focus to the
    // window, which is the only signal left to unstick the promise.
    const platform = createBrowserPlatform()

    const result = platform.pickFile()
    window.dispatchEvent(new Event('focus'))

    await expect(result).resolves.toBeNull()
  })

  it('ignores a late focus event once change has already settled the promise', async () => {
    const { getInput } = interceptFileInput()
    const platform = createBrowserPlatform()

    const result = platform.pickFile()
    const input = getInput()
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })
    setInputFiles(input, [file])
    input.dispatchEvent(new Event('change'))
    window.dispatchEvent(new Event('focus'))

    await expect(result).resolves.toBe(file)
  })

  it('resolves with the real file even when the focus fallback timer elapses before `change` is dispatched (adversarial ordering)', async () => {
    // Reproduces the race a naive "focus means cancel" fallback gets
    // wrong: the browser sets `input.files` synchronously the moment a
    // file is picked, *before* dispatching either `focus` or `change` --
    // so `files` is already populated here even though our `change`
    // listener hasn't run yet. The fallback's timeout callback must see
    // that non-empty `files` and refuse to settle null; only the later
    // `change` event should settle the promise, with the real File.
    vi.useFakeTimers()
    const { getInput } = interceptFileInput()
    const platform = createBrowserPlatform()

    const result = platform.pickFile()
    const input = getInput()
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' })
    setInputFiles(input, [file])
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(300)
    input.dispatchEvent(new Event('change'))

    await expect(result).resolves.toBe(file)
  })

  it('resolves with null once the focus fallback timer elapses with no file ever selected (true cancel)', async () => {
    // Regression guard for the fix above: confirms checking
    // `input.files.length` in the timeout callback didn't also block the
    // genuine-cancel path -- with no file ever assigned to the input, the
    // fallback must still settle null once its delay elapses.
    vi.useFakeTimers()
    const { getInput } = interceptFileInput()
    const platform = createBrowserPlatform()

    const result = platform.pickFile()
    getInput()
    window.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(300)

    await expect(result).resolves.toBeNull()
  })
})
