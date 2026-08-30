import { useEffect, useState } from 'react'
import { getPlatform } from './platform'
import type { Platform, PlatformInfo } from './platform'
import { createDaemonClient } from './daemon/client'
import type { DaemonClientStatus } from './daemon/client'

const CAPABILITIES: readonly (keyof Platform)[] = [
  'pickFile',
  'openExternal',
  'notify',
  'setAutoLaunch',
  'quit',
]

// `daemonClient.hello()` talks to the local daemon at /v1/hello. Until
// `evo-daemon` is running with a matching token, this page shows
// "not connected" -- that's expected. Set VITE_DAEMON_TOKEN (and
// optionally VITE_DAEMON_URL) from data_dir/client.toml; the call site
// itself does not change (design doc 06 §6).
const daemonClient = createDaemonClient({
  baseUrl: import.meta.env.VITE_DAEMON_URL ?? 'http://localhost:4477',
  token: import.meta.env.VITE_DAEMON_TOKEN ?? '',
})

function App() {
  // getPlatform() is async (see platform/index.ts): the desktop branch
  // reaches `platform/tauri.ts` through a dynamic import so the Tauri JS
  // bindings never land in the browser bundle. `null` means "still
  // resolving" -- on every real target (browser or desktop) that's a
  // single microtask, never a visible loading state in practice.
  const [platformInfo, setPlatformInfo] = useState<PlatformInfo | null>(null)
  const [daemonStatus, setDaemonStatus] = useState<DaemonClientStatus>(daemonClient.getStatus())
  const [daemonError, setDaemonError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    getPlatform().then((platform) => {
      if (!cancelled) setPlatformInfo(platform.info)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    daemonClient
      .hello()
      .then(() => {
        if (!cancelled) setDaemonStatus(daemonClient.getStatus())
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setDaemonStatus(daemonClient.getStatus())
        setDaemonError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: '2rem', maxWidth: 480 }}>
      <h1>evowork</h1>

      <section>
        <h2>Platform</h2>
        {platformInfo ? (
          <>
            <p>
              kind: <strong>{platformInfo.kind}</strong>
            </p>
            <ul>
              {CAPABILITIES.map((cap) => (
                <li key={cap}>
                  {cap}: {platformInfo.supports(cap) ? 'supported' : 'not supported'}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>detecting...</p>
        )}
      </section>

      <section>
        <h2>Daemon</h2>
        <p>
          status: <strong>{daemonStatus.connected ? 'connected' : 'not connected'}</strong>
        </p>
        <p>read-only: {daemonStatus.readOnly ? 'yes' : 'no'}</p>
        {daemonError && (
          <p style={{ color: '#a33' }}>
            ({daemonError})
          </p>
        )}
      </section>
    </main>
  )
}

export default App
