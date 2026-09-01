import { useState } from 'react'

import type { BudgetSpec, Currency } from '@evowork/protocol'

import type { BudgetUsed } from '../projection/fold'
import {
  formatMicros,
  microsToYuanInput,
  suggestedAmountMicros,
  yuanToMicros,
} from '../projection/format'

export interface BudgetAmendPayload {
  budget: BudgetSpec
  reason: string
}

interface BudgetCardProps {
  budget: BudgetSpec | null
  used: BudgetUsed
  currency: Currency
  readOnly: boolean
  busy: boolean
  onAmend: (payload: BudgetAmendPayload) => void
}

function dim(label: string, used: string, max: string) {
  return (
    <li>
      <span>{label}</span>
      <span className="muted">
        {used} / {max}
      </span>
    </li>
  )
}

export function BudgetCard({ budget, used, currency, readOnly, busy, onAmend }: BudgetCardProps) {
  const currentMax = budget?.max_amount_micros ?? null
  const defaultMicros = suggestedAmountMicros(used.amount_micros, currentMax)
  const [amountYuan, setAmountYuan] = useState(microsToYuanInput(defaultMicros))
  const [tokens, setTokens] = useState(budget?.max_tokens != null ? String(budget.max_tokens) : '')
  const [wallSeconds, setWallSeconds] = useState(
    budget?.max_wall_seconds != null ? String(budget.max_wall_seconds) : '',
  )
  const disabled = readOnly || busy

  return (
    <article className="card budget-card" data-testid="budget-card">
      <header>
        <span className="pill">预算</span>
        <strong>额度已用尽</strong>
      </header>
      <p className="muted">提额会写一条 budget.amended，然后续跑。不抹已出的账。</p>
      <ul className="budget-dims" data-testid="budget-used">
        {dim(
          '金额',
          formatMicros(used.amount_micros, currency),
          currentMax == null ? '不设限' : formatMicros(currentMax, currency),
        )}
        {dim('token', String(used.tokens), budget?.max_tokens == null ? '不设限' : String(budget.max_tokens))}
        {dim(
          '时长',
          `${Math.floor(used.wall_ms / 1000)} 秒`,
          budget?.max_wall_seconds == null ? '不设限' : `${budget.max_wall_seconds} 秒`,
        )}
      </ul>
      <form
        className="card-actions"
        onSubmit={(e) => {
          e.preventDefault()
          if (disabled) return
          const yuan = Number(amountYuan)
          const nextTokens = tokens.trim() === '' ? null : Number(tokens)
          const nextWall = wallSeconds.trim() === '' ? null : Number(wallSeconds)
          const nextAmount = amountYuan.trim() === '' || Number.isNaN(yuan) ? null : yuanToMicros(yuan)
          const reason = String(new FormData(e.currentTarget).get('reason') ?? '')
          onAmend({
            budget: {
              ...budget,
              max_amount_micros: nextAmount,
              max_tokens: nextTokens != null && !Number.isNaN(nextTokens) ? nextTokens : null,
              max_wall_seconds: nextWall != null && !Number.isNaN(nextWall) ? nextWall : null,
            },
            reason,
          })
        }}
      >
        <label>
          金额上限（{currency}）
          <input
            data-testid="budget-amount"
            type="number"
            min="0"
            step="any"
            value={amountYuan}
            disabled={disabled}
            onChange={(e) => setAmountYuan(e.target.value)}
          />
        </label>
        <label>
          token 上限
          <input
            type="number"
            min="0"
            step="1"
            value={tokens}
            disabled={disabled}
            placeholder="不设限"
            onChange={(e) => setTokens(e.target.value)}
          />
        </label>
        <label>
          时长上限（秒）
          <input
            type="number"
            min="0"
            step="1"
            value={wallSeconds}
            disabled={disabled}
            placeholder="不设限"
            onChange={(e) => setWallSeconds(e.target.value)}
          />
        </label>
        <input name="reason" type="text" placeholder="提额理由（可选，进 blob）" disabled={disabled} />
        <button type="submit" disabled={disabled}>
          提额并续跑
        </button>
      </form>
    </article>
  )
}
