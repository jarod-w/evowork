import { describe, expect, it } from 'vitest'

import type { ImpactEstimated } from '@evowork/protocol'

import { describeImpact, formatMicros, isApprovalExpired } from './format'

function impact(precision: ImpactEstimated['precision'], targets: ImpactEstimated['targets'] = []): ImpactEstimated {
  return { effect_id: 'e-1', targets, externals: [], precision }
}

describe('describeImpact()', () => {
  it('does not paint unknown as 无影响, 安全, or a sandbox/allowlist guarantee', () => {
    const copy = describeImpact(impact('unknown', []))
    expect(copy.tone).toBe('unknown')
    expect(copy.headline).toBe('影响未知')
    expect(copy.body).toContain('不是「没有影响」')
    const joined = `${copy.headline}\n${copy.body}`
    expect(joined).not.toMatch(/无影响/)
    expect(joined).not.toMatch(/安全/)
    expect(joined).not.toMatch(/沙箱工作区/)
    expect(joined).not.toMatch(/出口受白名单/)
  })

  it('does not invent impact when the estimated event has not arrived', () => {
    const copy = describeImpact(null)
    expect(copy.tone).toBe('unknown')
    expect(copy.body).toContain('不能把空清单当成「没有影响」')
    expect(`${copy.headline}\n${copy.body}`).not.toMatch(/无影响/)
  })

  it('may say 无写入目标 only for exact + empty preview', () => {
    const copy = describeImpact(impact('exact', []))
    expect(copy.tone).toBe('exact')
    expect(copy.headline).toBe('预览确认无写入目标')
  })

  it('lists declared targets without calling them verified', () => {
    const copy = describeImpact(
      impact('declared_only', [{ resource: { kind: 'file', id: 'a.txt' }, op: 'create' }]),
    )
    expect(copy.tone).toBe('declared')
    expect(copy.headline).toContain('未经预览核对')
    expect(copy.body).toContain('create file:a.txt')
  })
})

describe('formatMicros()', () => {
  it('renders micros as a major-unit currency amount', () => {
    expect(formatMicros(1_250_000, 'CNY')).toContain('1.25')
  })
})

describe('isApprovalExpired()', () => {
  it('treats a 1970 deadline as expired and a far-future one as live', () => {
    expect(isApprovalExpired(1, 1_756_461_600_000)).toBe(true)
    expect(isApprovalExpired(4_000_000_000_000, 1_756_461_600_000)).toBe(false)
  })
})
