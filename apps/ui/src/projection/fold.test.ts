import { describe, expect, it } from 'vitest'

import type { Event, EventBody } from '@evowork/protocol'

import { applyEvent, applyEvents, emptyWorkspace, totalCostMicros } from './fold'

function event(runId: string, seq: number, body: EventBody, recordedAt = `t-${seq}`): Event {
  return {
    run_id: runId,
    seq,
    recorded_at: recordedAt,
    actor: 'runtime',
    schema_ver: 1,
    body,
  }
}

const blob = { content_hash: 'sha256:aa', size: 1, mime: 'text/plain' }

describe('applyEvent()', () => {
  it('is a no-op when the same (run_id, seq) arrives twice', () => {
    const created = event('r-1', 0, {
      kind: 'run.created',
      run_id: 'r-1',
      workspace_id: 'w',
      principal: { kind: 'user', id: 'p' },
      trigger: { kind: 'manual', reference: 'ui' },
      budget: {},
      labels: {},
    })
    const once = applyEvent(emptyWorkspace(), created)
    const twice = applyEvent(once, created)
    expect(twice.runs[0].events).toHaveLength(1)
  })

  it('lists every pending approval, not just one awaiting slot', () => {
    const view = applyEvents(emptyWorkspace(), [
      event('r-1', 0, {
        kind: 'run.created',
        run_id: 'r-1',
        workspace_id: 'w',
        principal: { kind: 'user', id: 'p' },
        trigger: { kind: 'manual', reference: 'ui' },
        budget: {},
        labels: {},
      }),
      event('r-1', 1, {
        kind: 'tool.requested',
        effect_id: 'e-1',
        turn: 1,
        tool: 'fs.write',
        params_ref: blob,
        params_digest: 'd',
        class: 'write',
        declared_targets: [],
        declared_egress: [],
        reversible: true,
        cites_referenced: [],
      }),
      event('r-1', 2, {
        kind: 'tool.requested',
        effect_id: 'e-2',
        turn: 1,
        tool: 'shell.exec',
        params_ref: blob,
        params_digest: 'd',
        class: 'external',
        declared_targets: [],
        declared_egress: [],
        reversible: false,
        cites_referenced: [],
      }),
      event('r-1', 3, {
        kind: 'approval.requested',
        approval_id: 'a-1',
        effect_id: 'e-1',
        risk: 'l2',
        expires_at_ms: 1,
      }),
      event('r-1', 4, {
        kind: 'approval.requested',
        approval_id: 'a-2',
        effect_id: 'e-2',
        risk: 'l3',
        expires_at_ms: 1,
      }),
    ])

    const run = view.runs[0]
    expect(run.pendingApprovals.map((item) => item.approvalId)).toEqual(['a-1', 'a-2'])
    expect(run.pendingApprovals.map((item) => item.tool)).toEqual(['fs.write', 'shell.exec'])
    expect(view.inbox.filter((item) => item.kind === 'approval')).toHaveLength(2)
  })

  it('drops a pending approval on granted / denied', () => {
    const requested = applyEvents(emptyWorkspace(), [
      event('r-1', 0, {
        kind: 'approval.requested',
        approval_id: 'a-1',
        effect_id: 'e-1',
        risk: 'l3',
        expires_at_ms: 1,
      }),
      event('r-1', 1, {
        kind: 'approval.requested',
        approval_id: 'a-2',
        effect_id: 'e-2',
        risk: 'l2',
        expires_at_ms: 1,
      }),
    ])
    const granted = applyEvent(
      requested,
      event('r-1', 2, {
        kind: 'approval.granted',
        approval_id: 'a-1',
        by: 'runtime',
        via: 'ui',
      }),
    )
    expect(granted.runs[0].pendingApprovals.map((item) => item.approvalId)).toEqual(['a-2'])

    const denied = applyEvent(
      granted,
      event('r-1', 3, {
        kind: 'approval.denied',
        approval_id: 'a-2',
        by: { human: 'p' },
      }),
    )
    expect(denied.runs[0].pendingApprovals).toEqual([])
    expect(denied.inbox).toEqual([])
  })

  it('drops a pending approval on approval.expired', () => {
    const requested = applyEvent(
      emptyWorkspace(),
      event('r-1', 0, {
        kind: 'approval.requested',
        approval_id: 'a-1',
        effect_id: 'e-1',
        risk: 'l3',
        expires_at_ms: 1,
      }),
    )
    expect(requested.runs[0].pendingApprovals).toHaveLength(1)
    const expired = applyEvent(
      requested,
      event('r-1', 1, {
        kind: 'approval.expired',
        approval_id: 'a-1',
      }),
    )
    expect(expired.runs[0].pendingApprovals).toEqual([])
    expect(expired.inbox).toEqual([])
  })

  it('puts a clarification on the inbox and removes it when answered', () => {
    const asked = applyEvent(
      emptyWorkspace(),
      event('r-1', 0, {
        kind: 'clarification.requested',
        question_id: 'q-1',
        prompt_ref: blob,
        options: [
          { id: 'yes', is_default: true },
          { id: 'no', is_default: false },
        ],
      }),
    )
    expect(asked.inbox).toHaveLength(1)
    expect(asked.inbox[0]).toMatchObject({ kind: 'clarification', runId: 'r-1' })

    const answered = applyEvent(
      asked,
      event('r-1', 1, {
        kind: 'clarification.answered',
        question_id: 'q-1',
        by: { human: 'p' },
        option_id: 'yes',
      }),
    )
    expect(answered.inbox).toEqual([])
    expect(answered.runs[0].pendingClarification).toBeNull()
  })

  it('keeps both artifacts when a later write supersedes the same path', () => {
    const view = applyEvents(emptyWorkspace(), [
      event('r-1', 0, {
        kind: 'artifact.emitted',
        artifact_id: 'art-1',
        path: 'report.txt',
        blob: { ...blob, content_hash: 'sha256:old' },
        cites: [],
      }),
      event('r-1', 1, {
        kind: 'artifact.emitted',
        artifact_id: 'art-2',
        path: 'report.txt',
        blob: { ...blob, content_hash: 'sha256:new' },
        cites: [],
        supersedes: 'art-1',
      }),
    ])
    expect(view.runs[0].artifacts).toHaveLength(2)
    expect(view.runs[0].artifacts[1].supersedes).toBe('art-1')
  })

  it('sums cost.charged rather than reading a side table', () => {
    const view = applyEvents(emptyWorkspace(), [
      event('r-1', 0, {
        kind: 'cost.charged',
        unit: 'input_token',
        quantity: 10,
        unit_price_micros: 100,
        amount_micros: 1000,
        currency: 'CNY',
        price_table_ver: '1',
        dimension: { principal: 'p', run_id: 'r-1' },
      }),
      event('r-1', 1, {
        kind: 'cost.charged',
        unit: 'call',
        quantity: 1,
        unit_price_micros: 250,
        amount_micros: 250,
        currency: 'CNY',
        price_table_ver: '1',
        dimension: { principal: 'p', run_id: 'r-1', tool: 'fs.write' },
      }),
    ])
    expect(totalCostMicros(view.runs[0])).toBe(1250)
  })

  it('joins impact.estimated onto a later approval.requested for the same effect', () => {
    const view = applyEvents(emptyWorkspace(), [
      event('r-1', 0, {
        kind: 'impact.estimated',
        effect_id: 'e-1',
        targets: [],
        externals: [],
        precision: 'unknown',
      }),
      event('r-1', 1, {
        kind: 'approval.requested',
        approval_id: 'a-1',
        effect_id: 'e-1',
        risk: 'l3',
        expires_at_ms: 1,
      }),
    ])
    expect(view.runs[0].pendingApprovals[0].impact?.precision).toBe('unknown')
  })
})
