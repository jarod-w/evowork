import type { BudgetSpec, CostCharged, Currency } from '@evowork/protocol'

import type { BudgetUsed } from '../projection/fold'
import { formatCostLine, formatMicros } from '../projection/format'

interface CostPaneProps {
  lines: CostCharged[]
  currency: Currency
  budget: BudgetSpec | null
  used: BudgetUsed
}

function cap(max: number | null | undefined, render: (n: number) => string): string {
  return max == null ? '不设限' : render(max)
}

export function CostPane({ lines, currency, budget, used }: CostPaneProps) {
  const total = lines.reduce((sum, line) => sum + line.amount_micros, 0)
  return (
    <section className="cost" data-testid="cost">
      <h2>成本</h2>
      <p className="cost-total" data-testid="cost-total">
        {formatMicros(total, currency)}
        <span className="muted"> · {lines.length} 笔</span>
      </p>
      <ul className="budget-dims" data-testid="cost-budget">
        <li>
          <span>金额上限</span>
          <span className="muted">
            {formatMicros(used.amount_micros, currency)} / {cap(budget?.max_amount_micros, (n) => formatMicros(n, currency))}
          </span>
        </li>
        <li>
          <span>token</span>
          <span className="muted">
            {used.tokens} / {cap(budget?.max_tokens, String)}
          </span>
        </li>
        <li>
          <span>时长</span>
          <span className="muted">
            {Math.floor(used.wall_ms / 1000)} 秒 / {cap(budget?.max_wall_seconds, (n) => `${n} 秒`)}
          </span>
        </li>
      </ul>
      {lines.length === 0 ? (
        <p className="empty">还没有出账事件。</p>
      ) : (
        <ul>
          {lines.map((line, index) => (
            <li key={`${line.dimension.run_id}-${index}`}>{formatCostLine(line)}</li>
          ))}
        </ul>
      )}
    </section>
  )
}
