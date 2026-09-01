// Where the user fixes a daemon connection without a rebuild.
//
// This panel is the whole answer to P0-17's third bullet ("界面里没有任何
// 填 URL / token 的入口，装完之后没有补救手段"): the packaged `.app` had
// its URL and an empty token baked in at build time, so a client who
// double-clicked the dmg got a permanently empty window and no way out.
// It is deliberately reachable even while `connected` is false -- an
// unreachable settings screen is the same bug in a nicer shape.

import { useState } from 'react'

import {
  CLIENT_TOML_RELATIVE_PATH,
  describeConfigSource,
  type DaemonConnectionConfig,
  type ResolvedDaemonConfig,
} from '../daemon/config'

export interface DaemonSettingsProps {
  /** Settings currently in use, and which source they came from. */
  config: ResolvedDaemonConfig
  /**
   * What `~/.evowork/client.toml` yielded, or `null` for "no readable
   * file". Always `null` in the browser shell, which cannot read it.
   */
  clientToml: Partial<DaemonConnectionConfig> | null
  /** True when this shell can read `client.toml` at all (desktop only). */
  clientTomlSupported: boolean
  /** True when settings are currently persisted in this browser/webview. */
  hasSavedConfig: boolean
  /** The daemon connection error, if the last attempt failed. */
  error: string | null
  onSave(config: DaemonConnectionConfig): void
  onClear(): void
}

export function DaemonSettings({
  config,
  clientToml,
  clientTomlSupported,
  hasSavedConfig,
  error,
  onSave,
  onClear,
}: DaemonSettingsProps) {
  // Seeded once per mount. `App` gives this component a `key` derived
  // from the settings in use, so a save (or any other change to them)
  // remounts it and these initializers re-run with the new values --
  // rather than an effect that writes props into state on every change,
  // which is a cascading render and which oxlint's
  // `react(set-state-in-effect)` rule correctly objects to.
  const [baseUrl, setBaseUrl] = useState(config.baseUrl)
  const [token, setToken] = useState(config.token)
  const [revealToken, setRevealToken] = useState(false)

  const canFillFromClientToml = clientToml !== null && (clientToml.token ?? '') !== ''
  const dirty = baseUrl !== config.baseUrl || token !== config.token

  return (
    <section className="daemon-settings" data-testid="daemon-settings">
      <h2>daemon 连接</h2>

      <p className="muted" data-testid="daemon-settings-source">
        当前来自：{describeConfigSource(config.source)}
      </p>

      {config.source === 'default' ? (
        <p className="banner error" role="alert">
          token 为空。daemon 对空 bearer 一律回 401——填一个 token，或先在本机跑
          <code> evo-daemon</code>（它会把 token 写进 <code>~/{CLIENT_TOML_RELATIVE_PATH}</code>）。
        </p>
      ) : null}

      {error ? (
        <p className="banner error" role="alert" data-testid="daemon-settings-error">
          连接失败：{error}
        </p>
      ) : null}

      <form
        className="card-actions"
        onSubmit={(e) => {
          e.preventDefault()
          onSave({ baseUrl: baseUrl.trim(), token: token.trim() })
        }}
      >
        <label>
          daemon URL
          <input
            data-testid="daemon-settings-url"
            type="text"
            value={baseUrl}
            placeholder="http://127.0.0.1:4477"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label>
          token
          <input
            data-testid="daemon-settings-token"
            type={revealToken ? 'text' : 'password'}
            value={token}
            placeholder="evo-daemon 启动时打印/写入 client.toml 的那一串"
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <label className="inline">
          <input
            type="checkbox"
            data-testid="daemon-settings-reveal"
            checked={revealToken}
            onChange={(e) => setRevealToken(e.target.checked)}
          />
          显示 token
        </label>

        <button type="submit" data-testid="daemon-settings-save" disabled={baseUrl.trim() === ''}>
          {dirty ? '保存并重连' : '重连'}
        </button>

        {canFillFromClientToml ? (
          <button
            type="button"
            data-testid="daemon-settings-fill"
            onClick={() => {
              setBaseUrl(clientToml.baseUrl ?? config.baseUrl)
              setToken(clientToml.token ?? '')
            }}
          >
            从 client.toml 填入
          </button>
        ) : null}

        {hasSavedConfig ? (
          <button
            type="button"
            className="danger"
            data-testid="daemon-settings-clear"
            onClick={onClear}
          >
            清除已保存的设置
          </button>
        ) : null}
      </form>

      <p className="muted">
        {clientTomlSupported
          ? clientToml === null
            ? `没有读到 ~/${CLIENT_TOML_RELATIVE_PATH}。evo-daemon 首次启动时会写它。`
            : `已读到 ~/${CLIENT_TOML_RELATIVE_PATH}。`
          : `浏览器里读不了 ~/${CLIENT_TOML_RELATIVE_PATH}（网页无法读固定路径的文件），只能手填。`}
      </p>
    </section>
  )
}
