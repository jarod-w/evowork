import { useMemo } from 'react'
import { getPlatform } from './platform'
import type { Platform } from './platform'

const CAPABILITIES: readonly (keyof Platform)[] = [
  'pickFile',
  'openExternal',
  'notify',
  'setAutoLaunch',
  'quit',
]

function App() {
  const platform = useMemo(() => getPlatform(), [])

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
        <p>status: not connected (daemonClient is Task 2)</p>
      </section>
    </main>
  )
}

export default App
