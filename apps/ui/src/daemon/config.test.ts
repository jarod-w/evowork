import { describe, expect, it } from 'vitest'

import {
  DAEMON_SETTINGS_STORAGE_KEY,
  DEFAULT_DAEMON_URL,
  clearSavedConfig,
  describeConfigSource,
  loadSavedConfig,
  parseClientToml,
  resolveDaemonConfig,
  saveConfig,
} from './config'
import type { DaemonSettingsStorage } from './config'

/** In-memory `DaemonSettingsStorage`, optionally one that throws. */
function fakeStorage(options?: {
  throwOnGet?: boolean
  throwOnSet?: boolean
  initial?: string
}): DaemonSettingsStorage & { readonly items: Map<string, string> } {
  const items = new Map<string, string>()
  if (options?.initial !== undefined) items.set(DAEMON_SETTINGS_STORAGE_KEY, options.initial)
  return {
    items,
    getItem(key) {
      if (options?.throwOnGet) throw new Error('storage unavailable')
      return items.get(key) ?? null
    },
    setItem(key, value) {
      if (options?.throwOnSet) throw new Error('quota exceeded')
      items.set(key, value)
    },
    removeItem(key) {
      items.delete(key)
    },
  }
}

describe('parseClientToml', () => {
  // The exact bytes `evo-daemon` writes -- see
  // `crates/evo-daemon/src/main.rs::write_client_toml`, which emits these
  // two lines and nothing else. Copied verbatim rather than paraphrased:
  // this is the one input shape that has to work.
  const AS_WRITTEN_BY_DAEMON = 'token = "demo-token-abc"\nurl = "http://127.0.0.1:4477"\n'

  it('reads token and url out of the file evo-daemon actually writes', () => {
    expect(parseClientToml(AS_WRITTEN_BY_DAEMON)).toEqual({
      token: 'demo-token-abc',
      baseUrl: 'http://127.0.0.1:4477',
    })
  })

  it('tolerates CRLF line endings, blank lines, comments, and extra spacing', () => {
    const raw = '# evowork\r\n\r\n  token   =  "t1"   # the shared token\r\nurl="http://host:1"\r\n'
    expect(parseClientToml(raw)).toEqual({ token: 't1', baseUrl: 'http://host:1' })
  })

  it('ignores keys it does not know about', () => {
    expect(parseClientToml('token = "t"\nnonsense = "x"\n')).toEqual({ token: 't' })
  })

  it('returns nothing for an empty or key-less file rather than inventing defaults', () => {
    expect(parseClientToml('')).toEqual({})
    expect(parseClientToml('# only a comment\n')).toEqual({})
  })

  // The one rule in this parser that is about correctness rather than
  // convenience. Without the "stop at the first table header" step, the
  // scan would run past `[other]` and hand back that section's token as
  // if it were the daemon's -- a wrong value, which is strictly worse
  // than no value.
  it('stops at the first table header instead of reading another section\'s token', () => {
    const raw = ['token = "real"', '', '[other]', 'token = "not-the-daemons"'].join('\n')
    expect(parseClientToml(raw)).toEqual({ token: 'real' })
  })

  it('yields no value (not a wrong one) for TOML shapes it does not support', () => {
    // Literal (single-quoted) strings, and values containing an escape:
    // both documented as unsupported on `parseClientToml`.
    expect(parseClientToml("token = 'single-quoted'\n")).toEqual({})
    expect(parseClientToml('token = "has\\"escape"\n')).toEqual({})
  })
})

describe('loadSavedConfig / saveConfig / clearSavedConfig', () => {
  it('round-trips a saved config', () => {
    const storage = fakeStorage()
    saveConfig(storage, { baseUrl: 'http://host:2', token: 'tok' })
    expect(loadSavedConfig(storage)).toEqual({ baseUrl: 'http://host:2', token: 'tok' })
  })

  it('returns null when nothing has been saved', () => {
    expect(loadSavedConfig(fakeStorage())).toBeNull()
  })

  it('returns null instead of throwing when storage access itself throws', () => {
    expect(loadSavedConfig(fakeStorage({ throwOnGet: true }))).toBeNull()
  })

  it.each([
    ['not JSON at all', 'not json'],
    ['JSON that is not an object', '"a string"'],
    ['an object missing token', '{"baseUrl":"http://h"}'],
    ['an object with a non-string token', '{"baseUrl":"http://h","token":42}'],
    ['an object with an empty baseUrl', '{"baseUrl":"","token":"t"}'],
  ])('degrades to null for a corrupt saved entry (%s)', (_label, initial) => {
    // A corrupt entry must not wedge the app: it falls through to the
    // next source, and the settings panel can save over it.
    expect(loadSavedConfig(fakeStorage({ initial }))).toBeNull()
  })

  it('propagates a storage write failure rather than reporting a save that did not happen', () => {
    expect(() => saveConfig(fakeStorage({ throwOnSet: true }), { baseUrl: 'http://h', token: 't' })).toThrow()
  })

  it('clearSavedConfig removes the entry', () => {
    const storage = fakeStorage({ initial: '{"baseUrl":"http://h","token":"t"}' })
    clearSavedConfig(storage)
    expect(loadSavedConfig(storage)).toBeNull()
  })
})

describe('resolveDaemonConfig', () => {
  const saved = { baseUrl: 'http://saved:1', token: 'saved-token' }
  const buildTime = { baseUrl: 'http://build:2', token: 'build-token' }
  const clientToml = { baseUrl: 'http://toml:3', token: 'toml-token' }

  it('prefers saved settings over everything else', () => {
    expect(resolveDaemonConfig({ saved, buildTime, clientToml })).toEqual({
      ...saved,
      source: 'saved',
    })
  })

  it('prefers build-time settings over client.toml', () => {
    expect(resolveDaemonConfig({ saved: null, buildTime, clientToml })).toEqual({
      ...buildTime,
      source: 'build-time',
    })
  })

  it('falls back to client.toml -- the desktop artifact\'s zero-config path', () => {
    expect(resolveDaemonConfig({ saved: null, buildTime: null, clientToml })).toEqual({
      ...clientToml,
      source: 'client-toml',
    })
  })

  // This is the P0-17 state itself: a bundle built with no VITE_* vars,
  // on a machine where evo-daemon has never run. It must report
  // `default`, because that is the one source the UI has to warn about --
  // the token is empty and every request will come back 401.
  it('reports the default source, with an empty token, when nothing is configured', () => {
    expect(resolveDaemonConfig({ saved: null, buildTime: null, clientToml: null })).toEqual({
      baseUrl: DEFAULT_DAEMON_URL,
      token: '',
      source: 'default',
    })
  })

  // `evo-daemon` binds one IPv4 socket, so `http://[::1]:4477` is
  // refused. Measured 2026-09-01: curl to `[::1]:4477` failed to connect
  // while `127.0.0.1:4477` returned 200. Naming the literal keeps the
  // outcome off whether a given HTTP stack retries the other family.
  it('defaults to the IPv4 literal, not "localhost"', () => {
    expect(DEFAULT_DAEMON_URL).toBe('http://127.0.0.1:4477')
    expect(DEFAULT_DAEMON_URL).not.toContain('localhost')
  })

  it('skips a source with no usable baseUrl instead of half-using it', () => {
    expect(
      resolveDaemonConfig({
        saved: null,
        buildTime: { baseUrl: '   ', token: 'orphaned-token' },
        clientToml,
      }),
    ).toEqual({ ...clientToml, source: 'client-toml' })
  })

  // The url/token pair is resolved as a unit on purpose: a token belongs
  // to the daemon that issued it, so taking the URL from one source and
  // the token from another produces a pair that was never valid.
  it('does not mix fields across sources', () => {
    const resolved = resolveDaemonConfig({
      saved: null,
      buildTime: { baseUrl: 'http://build:2' },
      clientToml,
    })
    expect(resolved).toEqual({ baseUrl: 'http://build:2', token: '', source: 'build-time' })
    expect(resolved.token).not.toBe(clientToml.token)
  })
})

describe('describeConfigSource', () => {
  it('has a label for every source, and says out loud that the default 401s', () => {
    expect(describeConfigSource('saved')).toContain('保存')
    expect(describeConfigSource('build-time')).toContain('VITE_DAEMON_TOKEN')
    expect(describeConfigSource('client-toml')).toContain('client.toml')
    expect(describeConfigSource('default')).toContain('401')
  })
})
