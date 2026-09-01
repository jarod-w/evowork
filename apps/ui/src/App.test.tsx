import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { Event, EventBody, HelloFrame, ServerStreamFrame } from '@evowork/protocol'

import App from './App'
import type { DaemonClient, DaemonClientStatus, DaemonSubscription } from './daemon/client'
import { render } from './workspace/renderTest'

const hello: HelloFrame = {
  op: 'hello',
  protocol_ver: '1.0',
  daemon_ver: '0.1.0-test',
  runlog_schema_ver: 1,
}

function event(runId: string, seq: number, body: EventBody): Event {
  return {
    run_id: runId,
    seq,
    recorded_at: `2026-08-31T00:00:${String(seq).padStart(2, '0')}Z`,
    actor: 'runtime',
    schema_ver: 1,
    body,
  }
}

function stubClient(options?: { onRpc?: (method: string, params: unknown) => Promise<unknown> }): {
  client: DaemonClient
  push: (frame: ServerStreamFrame) => void
} {
  let listener: ((frame: ServerStreamFrame) => void) | null = null
  const status: DaemonClientStatus = {
    connected: true,
    readOnly: false,
    protocolVersion: { major: 1, minor: 0 },
  }
  const client: DaemonClient = {
    hello: () => Promise.resolve(hello),
    rpc: <TParams, TResult>(method: string, params: TParams) =>
      (options?.onRpc?.(method, params) ?? Promise.resolve({})) as Promise<TResult>,
    subscribe: () => ({ unsubscribe() {} }),
    subscribeAll: (onEvent) => {
      listener = onEvent
      const sub: DaemonSubscription = { unsubscribe() {} }
      return sub
    },
    getStatus: () => ({ ...status }),
  }
  return {
    client,
    push: (frame) => listener?.(frame),
  }
}

describe('App workspace', () => {
  it('projects two pending approvals into Inbox and the run pane, and does not call unknown 无影响', async () => {
    const { client, push } = stubClient()
    const { host, unmount } = render(<App client={client} />)

    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      push({
        op: 'event',
        event: event('r-9', 0, {
          kind: 'run.created',
          run_id: 'r-9',
          workspace_id: 'w',
          principal: { kind: 'user', id: 'p' },
          trigger: { kind: 'manual', reference: 'ui' },
          budget: {},
          labels: {},
        }),
      })
      push({
        op: 'event',
        event: event('r-9', 1, {
          kind: 'tool.requested',
          effect_id: 'e-1',
          turn: 1,
          tool: 'shell.exec',
          params_ref: { content_hash: 'sha256:p', size: 1, mime: 'application/json' },
          params_digest: 'd',
          class: 'external',
          declared_targets: [],
          declared_egress: [],
          reversible: false,
          cites_referenced: [],
        }),
      })
      push({
        op: 'event',
        event: event('r-9', 2, {
          kind: 'impact.estimated',
          effect_id: 'e-1',
          targets: [],
          externals: [],
          precision: 'unknown',
        }),
      })
      push({
        op: 'event',
        event: event('r-9', 3, {
          kind: 'approval.requested',
          approval_id: 'a-1',
          effect_id: 'e-1',
          risk: 'l3',
          expires_at_ms: 4_000_000_000_000,
        }),
      })
      push({
        op: 'event',
        event: event('r-9', 4, {
          kind: 'approval.requested',
          approval_id: 'a-2',
          effect_id: 'e-2',
          risk: 'l2',
          expires_at_ms: 4_000_000_000_000,
        }),
      })
      push({
        op: 'event',
        event: event('r-9', 5, {
          kind: 'cost.charged',
          unit: 'call',
          quantity: 1,
          unit_price_micros: 2_000_000,
          amount_micros: 2_000_000,
          currency: 'CNY',
          price_table_ver: '1',
          dimension: { principal: 'p', run_id: 'r-9', tool: 'shell.exec' },
        }),
      })
      push({
        op: 'event',
        event: event('r-9', 6, {
          kind: 'artifact.emitted',
          artifact_id: 'art-1',
          path: 'report.txt',
          blob: { content_hash: 'sha256:art', size: 4, mime: 'text/plain' },
          cites: [],
        }),
      })
    })

    const inboxCards = host.querySelectorAll('[data-testid="inbox"] [data-testid="approval-card"]')
    expect(inboxCards.length).toBe(2)
    const runCards = host.querySelectorAll('[data-testid="run-approvals"] [data-testid="approval-card"]')
    expect(runCards.length).toBe(2)

    const unknownCopy = [...host.querySelectorAll('[data-testid="impact-copy"]')].find(
      (node) => node.getAttribute('data-impact-tone') === 'unknown',
    )
    expect(unknownCopy?.textContent).toContain('影响未知')
    expect(unknownCopy?.textContent).not.toMatch(/无影响/)
    expect(unknownCopy?.textContent).not.toMatch(/沙箱工作区/)

    expect(host.querySelector('[data-testid="cost-total"]')?.textContent).toContain('2.00')
    expect(host.querySelector('[data-testid="artifacts"]')?.textContent).toContain('report.txt')
    expect(host.querySelector('[data-testid="timeline"]')?.textContent).toContain('请求审批')

    unmount()
  })

  it('sends budget.amend through daemonClient.rpc when the exhausted-budget card is submitted', async () => {
    const rpc = vi.fn().mockResolvedValue({})
    const { client, push } = stubClient({ onRpc: rpc })
    const { host, unmount } = render(<App client={client} />)
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      push({
        op: 'event',
        event: event('r-b', 0, {
          kind: 'run.created',
          run_id: 'r-b',
          workspace_id: 'w',
          principal: { kind: 'user', id: 'p' },
          trigger: { kind: 'manual', reference: 'ui' },
          budget: { max_amount_micros: 300 },
          labels: {},
        }),
      })
      push({
        op: 'event',
        event: event('r-b', 1, {
          kind: 'cost.charged',
          unit: 'call',
          quantity: 1,
          unit_price_micros: 400,
          amount_micros: 400,
          currency: 'CNY',
          price_table_ver: '1',
          dimension: { principal: 'p', run_id: 'r-b' },
        }),
      })
      push({
        op: 'event',
        event: event('r-b', 2, {
          kind: 'run.suspended',
          reason: 'budget_exhausted',
        }),
      })
    })

    const cards = host.querySelectorAll('[data-testid="budget-card"]')
    expect(cards.length).toBeGreaterThanOrEqual(1)
    expect(host.querySelector('[data-testid="inbox"] [data-testid="budget-card"]')).toBeTruthy()
    expect(host.querySelector('[data-testid="run-budget"] [data-testid="budget-card"]')).toBeTruthy()

    const button = [...host.querySelectorAll('button')].find((el) => el.textContent === '提额并续跑')
    expect(button).toBeTruthy()
    await act(async () => {
      button?.click()
    })
    expect(rpc).toHaveBeenCalledWith(
      'budget.amend',
      expect.objectContaining({
        run_id: 'r-b',
        budget: expect.objectContaining({ max_amount_micros: expect.any(Number) }),
      }),
    )
    const sent = rpc.mock.calls.find((call) => call[0] === 'budget.amend')?.[1] as {
      budget: { max_amount_micros: number }
    }
    expect(sent.budget.max_amount_micros).toBeGreaterThan(400)
    unmount()
  })

  it('shows checkpoint count on the timeline instead of leaving the audit view empty', async () => {
    const { client, push } = stubClient()
    const { host, unmount } = render(<App client={client} />)
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      push({
        op: 'event',
        event: event('r-a', 0, {
          kind: 'run.created',
          run_id: 'r-a',
          workspace_id: 'w',
          principal: { kind: 'user', id: 'p' },
          trigger: { kind: 'manual', reference: 'ui' },
          budget: {},
          labels: {},
        }),
      })
      push({
        op: 'event',
        event: event('r-a', 1, {
          kind: 'checkpoint',
          checkpoint_id: 'r-a-cp1',
          state_hash: 'deadbeefcafebabe',
          reason: 'pre_approval',
        }),
      })
      push({
        op: 'event',
        event: event('r-a', 2, {
          kind: 'approval.denied',
          approval_id: 'a-1',
          by: { human: 'p' },
        }),
      })
    })

    expect(host.querySelector('[data-testid="audit-summary"]')?.textContent).toContain('1 个检查点')
    expect(host.querySelector('[data-testid="timeline"]')?.textContent).toContain('检查点')

    const checkpointTab = [...host.querySelectorAll('[data-testid="timeline-filter"] button')].find(
      (el) => el.textContent === '检查点',
    )
    expect(checkpointTab).toBeTruthy()
    await act(async () => {
      checkpointTab?.click()
    })
    const kinds = [...host.querySelectorAll('[data-testid="timeline"] li')].map((li) => li.getAttribute('data-kind'))
    expect(kinds).toEqual(['checkpoint'])
    unmount()
  })

  it('sends clarification.answer through daemonClient.rpc, not a local state patch', async () => {
    const rpc = vi.fn().mockResolvedValue({})
    const { client, push } = stubClient({ onRpc: rpc })
    const { host, unmount } = render(<App client={client} />)
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      push({
        op: 'event',
        event: event('r-3', 0, {
          kind: 'clarification.requested',
          question_id: 'q-1',
          prompt_ref: { content_hash: 'sha256:q', size: 2, mime: 'application/json' },
          options: [{ id: 'yes', is_default: true }],
        }),
      })
    })

    const button = [...host.querySelectorAll('button')].find((el) => el.textContent === '回答')
    expect(button).toBeTruthy()
    await act(async () => {
      button?.click()
    })
    expect(rpc).toHaveBeenCalledWith(
      'clarification.answer',
      expect.objectContaining({ run_id: 'r-3', question_id: 'q-1', option_id: 'yes' }),
    )
    unmount()
  })
})
