import type { Platform, PlatformInfo } from '../platform'
import type { DaemonClientStatus } from '../daemon/client'

const CAPABILITIES = [
  'pickFile',
  'openExternal',
  'notify',
  'setAutoLaunch',
  'quit',
  'readClientToml',
] as const

// Structure over discipline: a new `Platform` method that nobody adds to
// `CAPABILITIES` above is a COMPILE error here, not a capability quietly
// missing from the status bar. `readClientToml` was added to `Platform`
// on 2026-09-01 and this list would otherwise have kept reporting five
// -- the kind of drift that is invisible precisely because the row still
// looks complete.
//
// Reads as: "assert there is no `keyof Platform` left over once
// CAPABILITIES is subtracted". If one is left over, `Exclude<…>` is that
// method's name rather than `never`, and the type argument no longer
// satisfies the `extends never` constraint.
function assertEveryCapabilityListed<_Unlisted extends never>(): void {}
assertEveryCapabilityListed<Exclude<keyof Platform, (typeof CAPABILITIES)[number]>>()

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
