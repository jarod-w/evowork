/**
 * 审计留痕（10 §6，Q12 落地的两项之一）。
 *
 * ## 记什么、**不记什么**
 *
 * 记：时间、id、工具名、动作摘要、路径分类与摘要、审批结果与决策人、guardian 判定、退出码、用量。
 * **不记**：prompt 正文、文件内容、命令的完整输出 —— 与 09 §8 的日志约束同口径（Q14）。
 *
 * 这条在这里是**类型上做不到**的：`AuditRecord` 里没有能装正文的字段，
 * 路径只能以 pathKind + pathDigest 进去（复用 `@evowork/logging` 的同一套语义）。
 * 想记正文就得先改类型，而改类型会被 review 看见 —— 这比写一条"请不要记正文"的注释有用。
 *
 * ## 防篡改：每日一条链式哈希
 *
 * 10 §6 选的是轻量方案：今日链哈希 = H(昨日链哈希 + H(今日全部记录))。
 * 它挡不住有 root 权限的人重写整条链，但挡得住"悄悄删掉一条" ——
 * 而后者才是审计日志的现实威胁模型。引入签名基础设施的成本远超收益（原文如此）。
 */

import { createHash } from 'node:crypto';

export type AuditAction =
  | 'tool.pre'
  | 'tool.post'
  | 'permission.request'
  | 'permission.decided'
  | 'path.blocked'
  | 'guardian.verdict'
  | 'budget.exceeded'
  | 'concurrency.rejected'
  | 'session.end';

export type ApprovalResult = 'accept' | 'accept-for-session' | 'decline' | 'cancel' | 'timeout';

/**
 * 一条审计记录。
 *
 * 字段名与 store 的 `audit_log` 表一一对应。`agentIdentity` 与 `verificationRef`
 * 是 Q12「保留接口不实现」的具体含义：**表里有列、这里不给字段、永远不写**。
 */
export interface AuditRecord {
  readonly occurredAt: number;
  readonly action: AuditAction;
  readonly threadId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly toolName?: string | undefined;
  /** 动作摘要。**不是正文** —— 形如「写入 3 个文件」「执行 pip install（已截断）」 */
  readonly actionSummary?: string | undefined;
  /** 路径的分类（workspace / personal-dir / outside-workspace / 硬拦截规则名） */
  readonly pathKind?: string | undefined;
  /** 路径的摘要，不是路径本身 */
  readonly pathDigest?: string | undefined;
  readonly networkTarget?: string | undefined;
  readonly approvalResult?: ApprovalResult | undefined;
  /** 谁决定的：user / policy / timeout / guardian */
  readonly decidedBy?: string | undefined;
  readonly guardianRisk?: 'low' | 'medium' | 'high' | 'critical' | undefined;
  readonly exitCode?: number | undefined;
  readonly tokenUsage?: number | undefined;
}

/** 路径摘要：只保留可比对性，不保留可读性。与 `@evowork/logging` 的 digest 同口径。 */
export function pathDigest(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

/**
 * 动作摘要的构造。
 *
 * 命令**必须截断且只截尾部**（10 §3.2 的同一条理由：中间省略是注入的藏身处），
 * 而且这里比 UI 更短 —— 审计要的是"跑了什么类型的命令"，不是完整复现。
 */
export function summarizeCommand(command: string, limit = 80): string {
  const single = command.replace(/\s+/g, ' ').trim();
  // 省略号占 3 个字符，所以从 limit 里扣掉 —— 否则"上限 80"实际会产出 82 个字符，
  // 而调用方（数据库列宽、UI 宽度）是按 80 算的
  return single.length <= limit ? single : `${single.slice(0, limit - 3)}...`;
}

export interface DayDigestInput {
  /** 昨日的链式哈希；第一天传空串 */
  readonly previousChainHash: string;
  /** 当日全部记录，按 occurredAt 升序 */
  readonly records: readonly AuditRecord[];
}

/**
 * 计算当日的链式哈希。
 *
 * 记录先逐条规范化成稳定字符串再哈希 —— 直接 JSON 序列化会让字段顺序影响结果，
 * 而字段顺序在不同写入路径上不一定一致。
 */
export function dayChainHash(input: DayDigestInput): string {
  const daily = createHash('sha256');
  for (const record of input.records) daily.update(canonicalize(record));
  return createHash('sha256')
    .update(input.previousChainHash)
    .update(daily.digest('hex'))
    .digest('hex');
}

/** 验证一段链：任何一条被删改，从那一天起后面全部对不上。 */
export function verifyChain(
  days: readonly { readonly chainHash: string; readonly records: readonly AuditRecord[] }[],
  genesis = '',
): { readonly ok: boolean; readonly firstBrokenIndex?: number } {
  let previous = genesis;
  for (let index = 0; index < days.length; index += 1) {
    const day = days[index] as (typeof days)[number];
    const expected = dayChainHash({ previousChainHash: previous, records: day.records });
    if (expected !== day.chainHash) return { ok: false, firstBrokenIndex: index };
    previous = day.chainHash;
  }
  return { ok: true };
}

function canonicalize(record: AuditRecord): string {
  return Object.keys(record)
    .sort()
    .map((key) => `${key}=${String((record as unknown as Record<string, unknown>)[key] ?? '')}`)
    .join('');
}

/** 保留期（10 §6）：默认 90 天，**到期前提示**再清理。 */
export const RETENTION_DAYS = 90;
export const RETENTION_WARNING_DAYS = 7;

export function expiredBefore(now: number, retentionDays = RETENTION_DAYS): number {
  return now - retentionDays * 24 * 60 * 60 * 1000;
}
