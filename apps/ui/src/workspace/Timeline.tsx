import { useState } from 'react'

import type { Event } from '@evowork/protocol'

import { eventTitle } from '../projection/format'

interface TimelineProps {
  events: Event[]
}

function summary(event: Event): string {
  const body = event.body
  switch (body.kind) {
    case 'tool.requested':
      return body.tool
    case 'tool.result':
      return `${body.status}${body.taint === 'tainted' ? ' · tainted' : ''}`
    case 'plan.step':
      return body.intent
    case 'approval.requested':
      return `${body.risk} · ${body.approval_id}`
    case 'impact.estimated':
      return body.precision
    case 'artifact.emitted':
      return body.path
    case 'cost.charged':
      return `${body.amount_micros} ${body.currency}`
    case 'run.failed':
      return body.error.code
    case 'policy.evaluated':
      return `${body.decision} · ${body.reason_code}`
    default:
      return `#${event.seq}`
  }
}

export function Timeline({ events }: TimelineProps) {
  const [open, setOpen] = useState<Set<number>>(() => new Set())

  return (
    <section className="timeline" data-testid="timeline">
      <h2>时间线</h2>
      {events.length === 0 ? (
        <p className="empty">还没有事件。</p>
      ) : (
        <ol>
          {events.map((event) => {
            const expanded = open.has(event.seq)
            return (
              <li key={event.seq} data-kind={event.body.kind}>
                <button
                  type="button"
                  className="event-row"
                  onClick={() =>
                    setOpen((prev) => {
                      const next = new Set(prev)
                      if (next.has(event.seq)) next.delete(event.seq)
                      else next.add(event.seq)
                      return next
                    })
                  }
                >
                  <span className="seq">{event.seq}</span>
                  <span className="kind">{eventTitle(event)}</span>
                  <span className="summary">{summary(event)}</span>
                </button>
                {expanded ? <pre className="event-payload">{JSON.stringify(event.body, null, 2)}</pre> : null}
              </li>
            )
          })}
        </ol>
      )}
    </section>
  )
}
