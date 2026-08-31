import type { CostCharged, Currency } from '@evowork/protocol'

import { formatCostLine, formatMicros } from '../projection/format'

interface CostPaneProps {
  lines: CostCharged[]
  currency: Currency
}

export function CostPane({ lines, currency }: CostPaneProps) {
  const total = lines.reduce((sum, line) => sum + line.amount_micros, 0)
  return (
    <section className="cost" data-testid="cost">
      <h2>成本</h2>
      <p className="cost-total" data-testid="cost-total">
        {formatMicros(total, currency)}
        <span className="muted"> · {lines.length} 笔</span>
      </p>
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
