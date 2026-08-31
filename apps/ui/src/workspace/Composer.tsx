import { useState } from 'react'

interface ComposerProps {
  connected: boolean
  readOnly: boolean
  busy: boolean
  onCreate: (intent: string) => void
}

export function Composer({ connected, readOnly, busy, onCreate }: ComposerProps) {
  const [intent, setIntent] = useState('')
  const disabled = !connected || readOnly || busy || intent.trim().length === 0

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        if (disabled) return
        onCreate(intent.trim())
        setIntent('')
      }}
    >
      <textarea
        value={intent}
        onChange={(e) => setIntent(e.target.value)}
        placeholder="声明意图，起一个 run…"
        rows={2}
        disabled={!connected || readOnly || busy}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            if (!disabled) {
              onCreate(intent.trim())
              setIntent('')
            }
          }
        }}
      />
      <button type="submit" disabled={disabled}>
        开始
      </button>
    </form>
  )
}
