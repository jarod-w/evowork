// Workspace view = fold of the Run Log. The UI does not keep a second
// copy of run status, pending approvals, artifacts, or cost — those are
// projections of the same events the daemon wrote (design doc 01 / 06).
// Applying the same event twice is a no-op: subscribeAll reconnects from
// seq 0, so the fold must be idempotent on (run_id, seq).

import type {
  ArtifactEmitted,
  ApprovalRequested,
  BlobRef,
  BudgetSpec,
  ClarificationOption,
  CostCharged,
  Event,
  ImpactEstimated,
  RiskLevel,
} from '@evowork/protocol'

export type RunStatus = 'running' | 'suspended' | 'completed' | 'failed'

export interface PendingApproval {
  runId: string
  seq: number
  recordedAt: string
  approvalId: string
  effectId: string
  risk: RiskLevel
  impactRef: BlobRef | null
  /** Joined from `impact.estimated` for the same effect_id. */
  impact: ImpactEstimated | null
  /** Joined from `tool.requested` for the same effect_id. */
  tool: string | null
  expiresAtMs: number
}

export interface PendingClarification {
  runId: string
  seq: number
  recordedAt: string
  questionId: string
  options: ClarificationOption[]
  promptRef: BlobRef
}

export interface ArtifactView {
  runId: string
  seq: number
  artifactId: string
  path: string
  blob: BlobRef
  cites: string[]
  supersedes: string | null
}

export interface RunView {
  runId: string
  status: RunStatus
  lastSeq: number
  turn: number
  principal: string | null
  budget: BudgetSpec | null
  intentRef: BlobRef | null
  events: Event[]
  pendingApprovals: PendingApproval[]
  pendingClarification: PendingClarification | null
  artifacts: ArtifactView[]
  costs: CostCharged[]
  /** effect_id → last tool name / impact, used to join approval cards. */
  effects: Record<string, { tool: string | null; impact: ImpactEstimated | null }>
}

export type InboxItem =
  | { kind: 'clarification'; runId: string; clarification: PendingClarification }
  | { kind: 'approval'; runId: string; approval: PendingApproval }

export interface WorkspaceView {
  runs: RunView[]
  inbox: InboxItem[]
}

export function emptyWorkspace(): WorkspaceView {
  return { runs: [], inbox: [] }
}

function emptyRun(runId: string): RunView {
  return {
    runId,
    status: 'running',
    lastSeq: 0,
    turn: 0,
    principal: null,
    budget: null,
    intentRef: null,
    events: [],
    pendingApprovals: [],
    pendingClarification: null,
    artifacts: [],
    costs: [],
    effects: {},
  }
}

function rebuildInbox(runs: RunView[]): InboxItem[] {
  const items: InboxItem[] = []
  for (const run of runs) {
    if (run.pendingClarification) {
      items.push({
        kind: 'clarification',
        runId: run.runId,
        clarification: run.pendingClarification,
      })
    }
    for (const approval of run.pendingApprovals) {
      items.push({ kind: 'approval', runId: run.runId, approval })
    }
  }
  items.sort((a, b) => {
    const at = a.kind === 'clarification' ? a.clarification.recordedAt : a.approval.recordedAt
    const bt = b.kind === 'clarification' ? b.clarification.recordedAt : b.approval.recordedAt
    const byTime = at.localeCompare(bt)
    if (byTime !== 0) return byTime
    const as = a.kind === 'clarification' ? a.clarification.seq : a.approval.seq
    const bs = b.kind === 'clarification' ? b.clarification.seq : b.approval.seq
    return as - bs
  })
  return items
}

function withRun(view: WorkspaceView, runId: string, update: (run: RunView) => RunView): WorkspaceView {
  const index = view.runs.findIndex((run) => run.runId === runId)
  const current = index >= 0 ? view.runs[index] : emptyRun(runId)
  const nextRun = update(current)
  const runs = view.runs.slice()
  if (index >= 0) runs[index] = nextRun
  else runs.push(nextRun)
  return { runs, inbox: rebuildInbox(runs) }
}

function effectEntry(
  run: RunView,
  effectId: string,
): { tool: string | null; impact: ImpactEstimated | null } {
  return run.effects[effectId] ?? { tool: null, impact: null }
}

function patchEffect(
  run: RunView,
  effectId: string,
  patch: Partial<{ tool: string | null; impact: ImpactEstimated | null }>,
): RunView {
  const prev = effectEntry(run, effectId)
  const next = { ...prev, ...patch }
  const effects = { ...run.effects, [effectId]: next }
  const pendingApprovals = run.pendingApprovals.map((item) =>
    item.effectId === effectId ? { ...item, tool: next.tool, impact: next.impact } : item,
  )
  return { ...run, effects, pendingApprovals }
}

function asArtifact(runId: string, seq: number, body: ArtifactEmitted): ArtifactView {
  return {
    runId,
    seq,
    artifactId: body.artifact_id,
    path: body.path,
    blob: body.blob,
    cites: body.cites,
    supersedes: body.supersedes ?? null,
  }
}

function asApproval(run: RunView, event: Event, body: ApprovalRequested): PendingApproval {
  const joined = effectEntry(run, body.effect_id)
  return {
    runId: run.runId,
    seq: event.seq,
    recordedAt: event.recorded_at,
    approvalId: body.approval_id,
    effectId: body.effect_id,
    risk: body.risk,
    impactRef: body.impact_ref ?? null,
    impact: joined.impact,
    tool: joined.tool,
    expiresAtMs: body.expires_at_ms,
  }
}

export function applyEvent(view: WorkspaceView, event: Event): WorkspaceView {
  return withRun(view, event.run_id, (run) => {
    if (run.events.some((existing) => existing.seq === event.seq)) {
      return run
    }
    const events = [...run.events, event].sort((a, b) => a.seq - b.seq)
    let next: RunView = { ...run, events, lastSeq: Math.max(run.lastSeq, event.seq) }
    const body = event.body
    switch (body.kind) {
      case 'run.created':
        next = {
          ...next,
          status: 'running',
          principal: body.principal.id,
          budget: body.budget,
        }
        break
      case 'intent.declared':
        next = { ...next, intentRef: body.intent_ref }
        break
      case 'run.suspended':
        next = { ...next, status: 'suspended' }
        break
      case 'run.resumed':
        next = { ...next, status: 'running' }
        break
      case 'run.completed':
        next = { ...next, status: 'completed' }
        break
      case 'run.failed':
        next = { ...next, status: 'failed' }
        break
      case 'env.sampled':
        next = { ...next, turn: body.turn }
        break
      case 'tool.requested':
        next = patchEffect(next, body.effect_id, { tool: body.tool })
        break
      case 'impact.estimated':
        next = patchEffect(next, body.effect_id, { impact: body })
        break
      case 'approval.requested':
        next = {
          ...next,
          pendingApprovals: [...next.pendingApprovals, asApproval(next, event, body)],
        }
        break
      case 'approval.granted':
      case 'approval.denied':
      case 'approval.expired':
        next = {
          ...next,
          pendingApprovals: next.pendingApprovals.filter((item) => item.approvalId !== body.approval_id),
        }
        break
      case 'clarification.requested':
        next = {
          ...next,
          pendingClarification: {
            runId: next.runId,
            seq: event.seq,
            recordedAt: event.recorded_at,
            questionId: body.question_id,
            options: body.options,
            promptRef: body.prompt_ref,
          },
        }
        break
      case 'clarification.answered':
        if (next.pendingClarification?.questionId === body.question_id) {
          next = { ...next, pendingClarification: null }
        }
        break
      case 'artifact.emitted':
        next = { ...next, artifacts: [...next.artifacts, asArtifact(next.runId, event.seq, body)] }
        break
      case 'cost.charged':
        next = { ...next, costs: [...next.costs, body] }
        break
      default:
        break
    }
    return next
  })
}

export function applyEvents(view: WorkspaceView, events: Event[]): WorkspaceView {
  return events.reduce(applyEvent, view)
}

export function totalCostMicros(run: RunView): number {
  return run.costs.reduce((sum, line) => sum + line.amount_micros, 0)
}

export function workspaceCostMicros(view: WorkspaceView): number {
  return view.runs.reduce((sum, run) => sum + totalCostMicros(run), 0)
}
