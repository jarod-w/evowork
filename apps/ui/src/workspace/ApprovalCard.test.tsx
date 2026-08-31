import { describe, expect, it } from 'vitest'

import type { PendingApproval } from '../projection/fold'
import { ApprovalCard } from './ApprovalCard'
import { render } from './renderTest'

function approval(precision: 'unknown' | 'exact' | 'declared_only'): PendingApproval {
  return {
    runId: 'r-1',
    seq: 4,
    recordedAt: 't',
    approvalId: 'a-1',
    effectId: 'e-1',
    risk: 'l3',
    impactRef: null,
    impact: {
      effect_id: 'e-1',
      targets: [],
      externals: [],
      precision,
    },
    tool: 'shell.exec',
    expiresAtMs: 1,
  }
}

describe('ApprovalCard', () => {
  it('renders unknown impact as 影响未知, never as 无影响 or a sandbox guarantee', () => {
    const { host, unmount } = render(
      <ApprovalCard approval={approval('unknown')} readOnly={false} busy={false} onDecide={() => {}} />,
    )
    const copy = host.querySelector('[data-testid="impact-copy"]')
    expect(copy?.getAttribute('data-impact-tone')).toBe('unknown')
    expect(copy?.textContent).toContain('影响未知')
    expect(copy?.textContent).not.toMatch(/无影响/)
    expect(copy?.textContent).not.toMatch(/沙箱工作区/)
    expect(copy?.textContent).not.toMatch(/出口受白名单/)
    unmount()
  })

  it('lists every card the parent passes — the card itself does not collapse to one awaiting slot', () => {
    const first = approval('unknown')
    const second: PendingApproval = { ...first, approvalId: 'a-2', effectId: 'e-2', tool: 'fs.write' }
    const { host, unmount } = render(
      <>
        <ApprovalCard approval={first} readOnly={false} busy={false} onDecide={() => {}} />
        <ApprovalCard approval={second} readOnly={false} busy={false} onDecide={() => {}} />
      </>,
    )
    const cards = host.querySelectorAll('[data-testid="approval-card"]')
    expect(cards).toHaveLength(2)
    expect(host.textContent).toContain('a-1')
    expect(host.textContent).toContain('a-2')
    unmount()
  })
})
