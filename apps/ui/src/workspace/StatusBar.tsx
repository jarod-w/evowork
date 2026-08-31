import type { PlatformInfo } from '../platform'
import type { DaemonClientStatus } from '../daemon/client'

const CAPABILITIES = ['pickFile', 'openExternal', 'notify', 'setAutoLaunch', 'quit'] as const

interface StatusBarProps {
  platform: PlatformInfo | null
  daemon: DaemonClientStatus
  error: string | null
}

export function StatusBar({ platform, daemon, error }: StatusBarProps) {
  return (
    <footer className="status-bar" data-testid="status-bar">
      <span>
        platform: <strong>{platform?.kind ?? 'detecting'}</strong>
      </span>
      <span>
        daemon: <strong>{daemon.connected ? 'connected' : 'not connected'}</strong>
      </span>
      <span>read-only: {daemon.readOnly ? 'yes' : 'no'}</span>
      {error ? <span className="error">({error})</span> : null}
      {platform ? (
        <span className="caps">
          {CAPABILITIES.map((cap) => (
            <span key={cap} title={cap}>
              {cap}:{platform.supports(cap) ? 'on' : 'off'}
            </span>
          ))}
        </span>
      ) : null}
    </footer>
  )
}
