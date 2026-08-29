import { useEffect, useMemo, useState } from 'react'
import { getPlatform } from './platform'
import type { Platform } from './platform'
import { createDaemonClient } from './daemon/client'
import type { DaemonClientStatus } from './daemon/client'

const CAPABILITIES: readonly (keyof Platform)[] = [
  'pickFile',
  'openExternal',
  'notify',
  'setAutoLaunch',
  'quit',
]

// There is no daemon HTTP/WS entrypoint yet (that lands in a later stage),
// so `daemonClient.hello()` below is expected to fail every time this runs
// today -- the UI is meant to show "not connected" until a real daemon
// exists to answer it. That is the point of wiring this up now: the call
// site is already correct, so plugging in a real daemon later needs no UI
// change (design doc 06 §6).
const daemonClient = createDaemonClient({
  baseUrl: 'http://localhost:4477',
  token: '',
})

function App() {
  const platform = useMemo(() => getPlatform(), [])
  const [daemonStatus, setDaemonStatus] = useState<DaemonClientStatus>(daemonClient.getStatus())
  const [daemonError, setDaemonError] = useState<string | null>(null)

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
        <p>
          kind: <strong>{platform.info.kind}</strong>
        </p>
        <ul>
          {CAPABILITIES.map((cap) => (
            <li key={cap}>
              {cap}: {platform.info.supports(cap) ? 'supported' : 'not supported'}
            </li>
          ))}
        </ul>
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
