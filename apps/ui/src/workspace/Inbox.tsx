import { useState } from 'react'

import type { InboxItem, PendingClarification } from '../projection/fold'
import { riskLabel } from '../projection/format'
import { ApprovalCard } from './ApprovalCard'

interface InboxProps {
  items: InboxItem[]
  selectedRunId: string | null
  blobTexts: Map<string, string>
  readOnly: boolean
  busy: boolean
  onSelectRun: (runId: string) => void
  onDecide: (runId: string, approvalId: string, granted: boolean, note: string) => void
  onAnswer: (runId: string, questionId: string, optionId: string | null, freeText: string) => void
}

function parsePrompt(raw: string | undefined): { question: string; options: Record<string, string> } {
  if (!raw) return { question: '', options: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { question: raw, options: {} }
    const record = parsed as { question?: unknown; options?: unknown }
    const question = typeof record.question === 'string' ? record.question : raw
    const options =
      typeof record.options === 'object' && record.options !== null
        ? Object.fromEntries(
            Object.entries(record.options as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          )
        : {}
    return { question, options }
  } catch {
    return { question: raw, options: {} }
  }
}

function ClarificationCard({
  clarification,
  blobTexts,
  readOnly,
  busy,
  onAnswer,
}: {
  clarification: PendingClarification
  blobTexts: Map<string, string>
  readOnly: boolean
  busy: boolean
  onAnswer: (questionId: string, optionId: string | null, freeText: string) => void
}) {
  const prompt = parsePrompt(blobTexts.get(clarification.promptRef.content_hash))
  const defaultOption = clarification.options.find((option) => option.is_default)
  const [optionId, setOptionId] = useState(defaultOption?.id ?? clarification.options[0]?.id ?? '')
  const disabled = readOnly || busy

  return (
    <article className="card clarification-card" data-testid="clarification-card">
      <header>
        <span className="pill">澄清</span>
        <span className="muted">#{clarification.questionId}</span>
      </header>
      <p className="prompt">
        {prompt.question || '问题正文在 blob 里，尚未取回。'}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (disabled) return
          const freeText = String(new FormData(e.currentTarget).get('free_text') ?? '')
          onAnswer(clarification.questionId, optionId || null, freeText)
        }}
      >
        <ul className="options">
          {clarification.options.map((option) => (
            <li key={option.id}>
              <label>
                <input
                  type="radio"
                  name={`q-${clarification.questionId}`}
                  checked={optionId === option.id}
                  disabled={disabled}
                  onChange={() => setOptionId(option.id)}
                />
                {prompt.options[option.id] ?? option.id}
                {option.is_default ? <span className="muted"> 默认</span> : null}
              </label>
            </li>
          ))}
        </ul>
        <textarea name="free_text" rows={2} placeholder="补充说明（可选）" disabled={disabled} />
        <button type="submit" disabled={disabled}>
          回答
        </button>
      </form>
    </article>
  )
}

export function Inbox({
  items,
  selectedRunId,
  blobTexts,
  readOnly,
  busy,
  onSelectRun,
  onDecide,
  onAnswer,
}: InboxProps) {
  return (
    <section className="inbox" data-testid="inbox">
      <h2>
        待决策 <span className="count">{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="empty">没有待决策的事项。</p>
      ) : (
        <ul className="inbox-list">
          {items.map((item) => {
            const active = item.runId === selectedRunId
            if (item.kind === 'clarification') {
              return (
                <li key={`c-${item.runId}-${item.clarification.questionId}`} className={active ? 'active' : ''}>
                  <button type="button" className="inbox-jump" onClick={() => onSelectRun(item.runId)}>
                    {item.runId}
                  </button>
                  <ClarificationCard
                    clarification={item.clarification}
                    blobTexts={blobTexts}
                    readOnly={readOnly}
                    busy={busy}
                    onAnswer={(questionId, optionId, freeText) =>
                      onAnswer(item.runId, questionId, optionId, freeText)
                    }
                  />
                </li>
              )
            }
            return (
              <li key={`a-${item.runId}-${item.approval.approvalId}`} className={active ? 'active' : ''}>
                <button type="button" className="inbox-jump" onClick={() => onSelectRun(item.runId)}>
                  {item.runId} · {riskLabel(item.approval.risk)}
                </button>
                <ApprovalCard
                  approval={item.approval}
                  readOnly={readOnly}
                  busy={busy}
                  onDecide={(approvalId, granted, note) => onDecide(item.runId, approvalId, granted, note)}
                />
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
