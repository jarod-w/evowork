import { useMemo, useState } from 'react'

import type { Event } from '@evowork/protocol'

import type { CheckpointView } from '../projection/fold'
import { GOVERNANCE_EVENT_KINDS, eventTitle } from '../projection/format'

export type TimelineFilter = 'all' | 'governance' | 'checkpoint'

interface TimelineProps {
  events: Event[]
  checkpoints: CheckpointView[]
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
    case 'run.suspended':
      return body.reason
    case 'budget.amended':
      return body.budget.max_amount_micros == null
        ? '金额不设限'
        : `金额 ${body.budget.max_amount_micros}`
    case 'checkpoint':
      return `${body.reason} · ${body.state_hash.slice(0, 12)}`
    default:
      return `#${event.seq}`
  }
}

function matchesFilter(event: Event, filter: TimelineFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'checkpoint') return event.body.kind === 'checkpoint'
  return GOVERNANCE_EVENT_KINDS.has(event.body.kind)
}

export function Timeline({ events, checkpoints }: TimelineProps) {
  const [open, setOpen] = useState<Set<number>>(() => new Set())
  const [filter, setFilter] = useState<TimelineFilter>('all')
  const visible = useMemo(() => events.filter((event) => matchesFilter(event, filter)), [events, filter])

  return (
    <section className="timeline" data-testid="timeline">
      <h2>时间线</h2>
      <p className="audit-summary" data-testid="audit-summary">
        {checkpoints.length === 0
          ? '还没有检查点。verify 会报 VACUOUS。'
          : `${checkpoints.length} 个检查点，可回放核对。`}
      </p>
      <div className="timeline-filters" data-testid="timeline-filter" role="tablist">
        {(
          [
            ['all', '全部'],
            ['governance', '治理 / 审计'],
            ['checkpoint', '检查点'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={filter === id}
            className={filter === id ? 'active' : ''}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="empty">{events.length === 0 ? '还没有事件。' : '这一层没有事件。'}</p>
      ) : (
        <ol>
          {visible.map((event) => {
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
