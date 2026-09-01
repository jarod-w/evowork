// Where the UI's daemon connection settings come from, and in what
// order. Pure logic: no IO, no `window`, no Tauri -- every input is
// passed in, so every precedence rule below is directly testable
// (`config.test.ts`).
//
// This module exists because of P0-17 (docs/STATUS.md §四): before it,
// `App.tsx` baked `http://localhost:4477` and
// `import.meta.env.VITE_DAEMON_TOKEN ?? ''` into the bundle at BUILD
// time. A packaged `.app` therefore shipped an EMPTY token, and the
// daemon's `/v1/hello` answers `401` to an empty bearer -- so the
// desktop artifact could not reach a daemon even when one was running,
// and the UI offered no way to fix that after install. Measured on
// 2026-09-01 against `evo-daemon --token demo-token-abc`:
// `Authorization: Bearer ` -> 401, correct token -> 200.

/**
 * Default daemon origin.
 *
 * `127.0.0.1`, deliberately NOT `localhost`. `evo-daemon` binds a single
 * IPv4 socket (`clap` default `127.0.0.1:4477`, one `TcpListener`), so
 * `http://[::1]:4477` is refused outright -- verified 2026-09-01 with
 * curl: `[::1]` gave a connection failure while `127.0.0.1` gave 200.
 * `localhost` resolves to both families on macOS, which leaves the
 * outcome up to whether the HTTP stack in question falls back from a
 * refused ::1 to 127.0.0.1. curl does; WKWebView's behaviour here is not
 * something this repo has measured. Naming the IPv4 literal removes the
 * question instead of relying on the answer.
 */
export const DEFAULT_DAEMON_URL = 'http://127.0.0.1:4477'

/** `localStorage` key holding the user's saved settings, if any. */
export const DAEMON_SETTINGS_STORAGE_KEY = 'evowork.daemon.connection'

/** Path, relative to the user's home directory, that `evo-daemon` writes. */
export const CLIENT_TOML_RELATIVE_PATH = '.evowork/client.toml'

export interface DaemonConnectionConfig {
  baseUrl: string
  token: string
}

/**
 * Which of the four inputs actually supplied the settings in use. Shown
 * in the UI so "why am I not connected" is answerable without a devtools
 * session -- `default` in particular means "nobody configured anything,
 * the token is empty, expect a 401".
 */
export type DaemonConfigSource = 'saved' | 'build-time' | 'client-toml' | 'default'

export interface ResolvedDaemonConfig extends DaemonConnectionConfig {
  source: DaemonConfigSource
}

/**
 * The subset of `Storage` this module needs. Keeps tests free of jsdom's
 * real `localStorage` and makes the "storage throws" path (Safari private
 * mode, disabled site data) expressible.
 */
export interface DaemonSettingsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/**
 * Reads the `token` / `url` keys out of the `client.toml` that
 * `evo-daemon` writes (`crates/evo-daemon/src/main.rs::write_client_toml`,
 * which emits exactly `token = "…"` and `url = "…"`).
 *
 * **This is NOT a TOML parser and does not claim to be one.** It scans
 * top-level `key = "value"` lines and stops at the first table header,
 * which is everything the file evo-daemon writes needs. It does not
 * handle multi-line strings, literal (single-quoted) strings, escape
 * sequences inside values, inline tables, or arrays -- a file using any
 * of those yields no value for the affected key rather than a wrong one.
 * If `client.toml` ever grows beyond two flat string keys, replace this
 * with a real parser instead of extending it.
 *
 * Stopping at the first `[table]` header is the one non-obvious rule
 * here, and it is a correctness rule, not tidiness: without it a
 * hand-edited file with an unrelated `[other]` section containing its own
 * `token = "…"` would hand the UI that section's value as if it were the
 * daemon's.
 */
export function parseClientToml(raw: string): Partial<DaemonConnectionConfig> {
  const result: Partial<DaemonConnectionConfig> = {}

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    // Any table header ends the top-level table; nothing after it belongs
    // to the daemon's own two keys.
    if (line.startsWith('[')) break

    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"\\]*)"\s*(?:#.*)?$/.exec(line)
    if (!match) continue

    const [, key, value] = match
    if (key === 'token') result.token = value
    else if (key === 'url') result.baseUrl = value
  }

  return result
}

/**
 * Reads previously saved settings. Returns `null` for "nothing saved",
 * and also for anything unreadable -- a corrupt or hand-mangled entry
 * must not wedge the app into a permanently broken state with no way
 * back, so it degrades to the next source in `resolveDaemonConfig` and
 * the user can save over it from the settings panel.
 */
export function loadSavedConfig(storage: DaemonSettingsStorage): DaemonConnectionConfig | null {
  let raw: string | null
  try {
    raw = storage.getItem(DAEMON_SETTINGS_STORAGE_KEY)
  } catch {
    // Storage access itself can throw (Safari private browsing, site
    // data blocked). Not having saved settings is a normal state, so
    // there is nothing to report here.
    return null
  }
  if (raw === null) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { baseUrl, token } = parsed as Partial<Record<keyof DaemonConnectionConfig, unknown>>
    if (typeof baseUrl !== 'string' || typeof token !== 'string') return null
    if (baseUrl === '') return null
    return { baseUrl, token }
  } catch {
    return null
  }
}

/** Persists settings. Throws if storage is unavailable -- see `loadSavedConfig`. */
export function saveConfig(storage: DaemonSettingsStorage, config: DaemonConnectionConfig): void {
  storage.setItem(DAEMON_SETTINGS_STORAGE_KEY, JSON.stringify(config))
}

/** Forgets saved settings, so resolution falls back to the other sources. */
export function clearSavedConfig(storage: DaemonSettingsStorage): void {
  storage.removeItem(DAEMON_SETTINGS_STORAGE_KEY)
}

export interface DaemonConfigInputs {
  /** From `loadSavedConfig`. What the user last saved in the settings panel. */
  saved: DaemonConnectionConfig | null
  /** `import.meta.env.VITE_DAEMON_URL` / `VITE_DAEMON_TOKEN`, baked at build time. */
  buildTime: Partial<DaemonConnectionConfig> | null
  /** From `parseClientToml`, when a `client.toml` was readable. */
  clientToml: Partial<DaemonConnectionConfig> | null
}

/**
 * Picks the settings to connect with.
 *
 * Precedence, highest first:
 *
 *  1. `saved` -- an explicit act by the person at the keyboard. It wins
 *     over `client.toml` on purpose: someone who typed a token into the
 *     settings panel is usually pointing the UI at a *different* daemon
 *     than the local one that wrote `client.toml`, and having the local
 *     file silently override that would be unfixable from the UI.
 *  2. `buildTime` -- how the browser/dev entry has always been
 *     configured (`VITE_DAEMON_TOKEN=… pnpm dev`). Above `client.toml`
 *     so that an explicitly-built bundle keeps behaving as built.
 *  3. `clientToml` -- zero-configuration path for the desktop artifact:
 *     `evo-daemon` wrote both the URL and the token there on first run.
 *  4. defaults -- `DEFAULT_DAEMON_URL` and an EMPTY token.
 *
 * `baseUrl` and `token` are resolved as one unit, not field-by-field: a
 * token belongs to the daemon that issued it, so filling the URL from
 * one source and the token from another produces a pair that was never
 * valid anywhere. The `source` returned therefore describes both fields.
 *
 * A source with a blank/absent `baseUrl` is skipped entirely rather than
 * half-used; a blank token is NOT a reason to skip a source (the daemon
 * may legitimately have been started with `--token ""`... it may not, it
 * rejects that -- but an empty token from an explicit source is still
 * that source's answer, and reporting `source: 'saved'` with a 401 is
 * more debuggable than silently falling through to a different daemon).
 */
export function resolveDaemonConfig(inputs: DaemonConfigInputs): ResolvedDaemonConfig {
  const candidates: ReadonlyArray<[DaemonConfigSource, Partial<DaemonConnectionConfig> | null]> = [
    ['saved', inputs.saved],
    ['build-time', inputs.buildTime],
    ['client-toml', inputs.clientToml],
  ]

  for (const [source, candidate] of candidates) {
    if (!candidate) continue
    const baseUrl = candidate.baseUrl?.trim()
    if (!baseUrl) continue
    return { baseUrl, token: candidate.token ?? '', source }
  }

  return { baseUrl: DEFAULT_DAEMON_URL, token: '', source: 'default' }
}

/**
 * Human-readable label for a source, for the settings panel and the
 * status bar. Kept next to the type so a new `DaemonConfigSource`
 * variant is a compile error here rather than a silent `undefined` in
 * the UI.
 */
export function describeConfigSource(source: DaemonConfigSource): string {
  switch (source) {
    case 'saved':
      return '本机已保存的设置'
    case 'build-time':
      return '构建时注入（VITE_DAEMON_URL / VITE_DAEMON_TOKEN）'
    case 'client-toml':
      return `~/${CLIENT_TOML_RELATIVE_PATH}`
    case 'default':
      return '内置默认值（token 为空，会被 daemon 以 401 拒绝）'
  }
}
