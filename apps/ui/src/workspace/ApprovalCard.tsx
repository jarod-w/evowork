import type { PendingApproval } from '../projection/fold'
import { describeImpact, riskLabel } from '../projection/format'

interface ApprovalCardProps {
  approval: PendingApproval
  readOnly: boolean
  busy: boolean
  onDecide: (approvalId: string, granted: boolean, note: string) => void
}

export function ApprovalCard({ approval, readOnly, busy, onDecide }: ApprovalCardProps) {
  const impact = describeImpact(approval.impact)
  const disabled = readOnly || busy

  return (
    <article className={`card approval-card risk-${approval.risk}`} data-testid="approval-card">
      <header>
        <span className="pill">{riskLabel(approval.risk)}</span>
        <strong>{approval.tool ?? approval.effectId}</strong>
        <span className="muted">#{approval.approvalId}</span>
      </header>
      <section data-testid="impact-copy" data-impact-tone={impact.tone}>
        <h3>{impact.headline}</h3>
        <pre className="impact-body">{impact.body}</pre>
      </section>
      <form
        className="card-actions"
        onSubmit={(e) => {
          e.preventDefault()
          if (disabled) return
          const note = String(new FormData(e.currentTarget).get('note') ?? '')
          onDecide(approval.approvalId, true, note)
        }}
      >
        <input name="note" type="text" placeholder="备注（可选）" disabled={disabled} />
        <button type="submit" disabled={disabled}>
          批准
        </button>
        <button
          type="button"
          className="danger"
          disabled={disabled}
          onClick={(e) => {
            const form = e.currentTarget.form
            const note = form ? String(new FormData(form).get('note') ?? '') : ''
            onDecide(approval.approvalId, false, note)
          }}
        >
          驳回
        </button>
      </form>
    </article>
  )
}
