import type { CostCharged, Currency, Event, ImpactEstimated, ImpactTarget, RiskLevel } from '@evowork/protocol'

const EVENT_TITLES: Record<Event['body']['kind'], string> = {
  'run.created': '任务创建',
  'intent.declared': '意图',
  'run.suspended': '已挂起',
  'run.resumed': '已恢复',
  'run.completed': '完成',
  'run.failed': '失败',
  'env.sampled': '环境采样',
  'context.assembled': '上下文装配',
  'context.compacted': '上下文压缩',
  'model.requested': '模型请求',
  'model.responded': '模型响应',
  'plan.step': '计划',
  'tool.requested': '工具请求',
  'policy.evaluated': '策略求值',
  'impact.estimated': '影响预估',
  'approval.requested': '请求审批',
  'approval.granted': '已批准',
  'approval.denied': '已驳回',
  'approval.expired': '审批过期',
  'effect.dispatched': '已派发',
  'tool.result': '工具结果',
  'cost.charged': '出账',
  'budget.amended': '预算变更',
  'artifact.emitted': '产物',
  checkpoint: '检查点',
  'clarification.requested': '澄清',
  'clarification.answered': '已回答',
}

export function eventTitle(event: Event): string {
  return EVENT_TITLES[event.body.kind]
}

export function formatMicros(amountMicros: number, currency: Currency): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(amountMicros / 1_000_000)
}

export function formatCostLine(line: CostCharged): string {
  const qty = `${line.quantity} ${line.unit}`
  const amount = formatMicros(line.amount_micros, line.currency)
  const tool = line.dimension.tool ? ` · ${line.dimension.tool}` : ''
  return `${qty} → ${amount}${tool}`
}

export function riskLabel(risk: RiskLevel): string {
  switch (risk) {
    case 'l1':
      return 'L1'
    case 'l2':
      return 'L2'
    case 'l3':
      return 'L3 需人批准'
  }
}

/** Wall-clock check for the approval card. Daemon expiry is a Log event; this is display only. */
export function isApprovalExpired(expiresAtMs: number, nowMs: number = Date.now()): boolean {
  return nowMs >= expiresAtMs
}

function formatTarget(target: ImpactTarget): string {
  return `${target.op} ${target.resource.kind}:${target.resource.id}`
}

export interface ImpactCopy {
  headline: string
  body: string
  tone: 'unknown' | 'declared' | 'exact'
}

/**
 * Copy for an approval card's impact block.
 *
 * `unknown` is "we do not know", never "no impact", and never the
 * sandbox/allowlist sentence that 02 / impact.rs explicitly do not
 * guarantee. `exact` with an empty target list *is* preview saying
 * there is nothing to write — that case may say so.
 */
export function describeImpact(impact: ImpactEstimated | null): ImpactCopy {
  if (impact === null) {
    return {
      tone: 'unknown',
      headline: '影响预估尚未到达',
      body: '还没有对应的 impact.estimated 事件。在它到达之前，不能把空清单当成「没有影响」。',
    }
  }
  switch (impact.precision) {
    case 'unknown':
      return {
        tone: 'unknown',
        headline: '影响未知',
        body: '没有预览，也无法从参数静态提取目标。空清单表示不知道会触碰什么，不是「没有影响」。',
      }
    case 'declared_only':
      return {
        tone: 'declared',
        headline: '声明的目标（未经预览核对）',
        body:
          impact.targets.length === 0
            ? '声明清单为空，精度仍是 declared_only。'
            : impact.targets.map(formatTarget).join('\n'),
      }
    case 'exact':
      if (impact.targets.length === 0) {
        return {
          tone: 'exact',
          headline: '预览确认无写入目标',
          body: '工具 preview 返回了空清单。',
        }
      }
      return {
        tone: 'exact',
        headline: '预览确认的目标',
        body: impact.targets.map(formatTarget).join('\n'),
      }
  }
}

export function runStatusLabel(status: string): string {
  switch (status) {
    case 'running':
      return '运行中'
    case 'suspended':
      return '已挂起'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    default:
      return status
  }
}

export function awaitingLabel(reason: string | null): string | null {
  switch (reason) {
    case 'budget_exhausted':
      return '预算已用尽'
    case 'awaiting_approval':
      return '等待审批'
    case 'awaiting_human':
      return '等待澄清'
    case 'paused':
      return '已暂停'
    default:
      return null
  }
}

/** Whole-spec replacement must raise at least the exhausted amount dimension. */
export function suggestedAmountMicros(used: number, max: number | null | undefined): number {
  const floor = used + 1
  const doubled = Math.max(used, max ?? 0) * 2
  return Math.max(floor, doubled, 1)
}

export function yuanToMicros(yuan: number): number {
  return Math.round(yuan * 1_000_000)
}

export function microsToYuanInput(micros: number): string {
  return (micros / 1_000_000).toString()
}

export const GOVERNANCE_EVENT_KINDS: ReadonlySet<Event['body']['kind']> = new Set([
  'run.suspended',
  'run.resumed',
  'run.completed',
  'run.failed',
  'approval.requested',
  'approval.granted',
  'approval.denied',
  'approval.expired',
  'budget.amended',
  'checkpoint',
  'clarification.requested',
  'clarification.answered',
  'policy.evaluated',
  'impact.estimated',
])
