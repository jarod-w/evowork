/**
 * Hub 条目与本机条目的合并、更新判定、prompt 预算（13 §5.2–§5.6、§6）。**不出网。**
 *
 * 拉取与验签在 `@evowork/hub-client`，落盘在桌面宿主；这里只有能被单测钉住的规则。
 * 最要紧的一条是 5.4：**能力不扩大才静默更新**。没有它，签名和审计只在第一次安装时管用，
 * 之后谁拿到发布密钥，谁就能往所有客户端推任意代码。
 */
import {
  compareVersions,
  isVersion,
  matchesRange,
  type HubAudit,
  type HubIndexPayload,
  type HubItem,
  type HubItemKind,
  type HubRevocation,
} from '@evowork/hub-protocol';

import { AUDIT_RULES_VERSION, rankLevel, type Capabilities } from './audit.js';
import type { RiskLevel } from './types.js';

/* ── 本机装了什么（`~/.evowork/hub/installed.json`）───────────────────────── */

export interface HubInstalled {
  readonly sourceId: string;
  readonly kind: HubItemKind;
  readonly id: string;
  readonly version: string;
  /** 装这一版时**两边审计合起来**的结论 —— 下一版和它比（5.4）。 */
  readonly level: RiskLevel;
  readonly network: readonly string[];
  readonly commands: readonly string[];
  readonly hooks: boolean;
  readonly promptVisible: boolean;
  readonly transport?: 'stdio' | 'http' | 'sse' | undefined;
  readonly installedAt: number;
  /** 静默更新时保留的上一版（5.4「保留上一版，可以回滚」）。 */
  readonly previous?: HubInstalledSnapshot | undefined;
  /**
   * 云端说能力没扩大、本机下载重审后发现扩大了：这一版**没有**装，留在「需重新确认」。
   * 值是给用户看的原因；`heldVersion` 是被挡下的那一版。
   */
  readonly heldVersion?: string | undefined;
  readonly heldReason?: string | undefined;
  /** 被吊销：已停用，**没有删**（5.4）。 */
  readonly revokedReason?: string | undefined;
  /** 覆盖了同名的随包技能（5.5，HUB-Q7=A）。卸载时要把随包那份恢复。 */
  readonly overridesBundled?: boolean | undefined;
}

export interface HubInstalledSnapshot {
  readonly version: string;
  readonly level: RiskLevel;
  readonly network: readonly string[];
  readonly commands: readonly string[];
  readonly hooks: boolean;
}

export interface HubInstallState {
  readonly items: readonly HubInstalled[];
}

export function parseHubInstallState(text: string | undefined): HubInstallState {
  if (text === undefined || text.trim() === '') return { items: [] };
  try {
    const raw = JSON.parse(text) as { items?: unknown };
    if (!Array.isArray(raw.items)) return { items: [] };
    const items: HubInstalled[] = [];
    for (const r of raw.items as unknown[]) {
      const parsed = parseInstalled(r);
      if (parsed !== undefined) items.push(parsed);
    }
    return { items };
  } catch {
    return { items: [] };
  }
}

export function serializeHubInstallState(state: HubInstallState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function findInstalled(
  state: HubInstallState,
  kind: HubItemKind,
  id: string,
): HubInstalled | undefined {
  return state.items.find((i) => i.kind === kind && i.id === id);
}

export function upsertInstalled(state: HubInstallState, next: HubInstalled): HubInstallState {
  return {
    items: [...state.items.filter((i) => !(i.kind === next.kind && i.id === next.id)), next],
  };
}

export function removeInstalled(
  state: HubInstallState,
  kind: HubItemKind,
  id: string,
): HubInstallState {
  return { items: state.items.filter((i) => !(i.kind === kind && i.id === id)) };
}

function parseInstalled(raw: unknown): HubInstalled | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const kind =
    r.kind === 'skill' || r.kind === 'expert' || r.kind === 'connector' ? r.kind : undefined;
  const level = r.level === 'p0' || r.level === 'p1' || r.level === 'p2' ? r.level : undefined;
  const strs = (v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
  const network = strs(r.network);
  const commands = strs(r.commands);
  if (
    typeof r.sourceId !== 'string' ||
    kind === undefined ||
    typeof r.id !== 'string' ||
    typeof r.version !== 'string' ||
    level === undefined ||
    network === undefined ||
    commands === undefined ||
    typeof r.hooks !== 'boolean' ||
    typeof r.promptVisible !== 'boolean' ||
    typeof r.installedAt !== 'number'
  ) {
    return undefined;
  }
  const transport =
    r.transport === 'stdio' || r.transport === 'http' || r.transport === 'sse'
      ? r.transport
      : undefined;
  return {
    sourceId: r.sourceId,
    kind,
    id: r.id,
    version: r.version,
    level,
    network,
    commands,
    hooks: r.hooks,
    promptVisible: r.promptVisible,
    installedAt: r.installedAt,
    ...(transport !== undefined ? { transport } : {}),
    ...(parseSnapshot(r.previous) !== undefined ? { previous: parseSnapshot(r.previous) } : {}),
    ...(typeof r.heldVersion === 'string' ? { heldVersion: r.heldVersion } : {}),
    ...(typeof r.heldReason === 'string' ? { heldReason: r.heldReason } : {}),
    ...(typeof r.revokedReason === 'string' ? { revokedReason: r.revokedReason } : {}),
    ...(r.overridesBundled === true ? { overridesBundled: true } : {}),
  };
}

function parseSnapshot(raw: unknown): HubInstalledSnapshot | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const level = r.level === 'p0' || r.level === 'p1' || r.level === 'p2' ? r.level : undefined;
  const strs = (v: unknown) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
  const network = strs(r.network);
  const commands = strs(r.commands);
  if (
    typeof r.version !== 'string' ||
    level === undefined ||
    network === undefined ||
    commands === undefined ||
    typeof r.hooks !== 'boolean'
  ) {
    return undefined;
  }
  return { version: r.version, level, network, commands, hooks: r.hooks };
}

/* ── 审计：云端结论 × 本地重审（5.3）──────────────────────────────────── */

export interface LocalAudit extends Capabilities {
  readonly level: RiskLevel;
}

export type ReconciledAudit =
  | { readonly ok: true; readonly level: RiskLevel; readonly capabilities: Capabilities }
  | { readonly ok: false; readonly reason: string };

/**
 * 规则版本相同：等级必须一致，否则视为内容或索引被动过，**拒装**。
 * 规则版本不同（HUB-Q9=A 之后很常见）：取两边更严的等级、能力取并集，不拒装。
 */
export function reconcileAudit(
  cloud: HubAudit,
  local: LocalAudit,
  localRulesVersion: string = AUDIT_RULES_VERSION,
): ReconciledAudit {
  if (cloud.rulesVersion === localRulesVersion && cloud.level !== local.level) {
    return {
      ok: false,
      reason: `本机审计结论（${local.level.toUpperCase()}）与索引登记的（${cloud.level.toUpperCase()}）不一致，内容可能被改动过`,
    };
  }
  const level = rankLevel(cloud.level) >= rankLevel(local.level) ? cloud.level : local.level;
  return {
    ok: true,
    level,
    capabilities: {
      network: union(cloud.network, local.network),
      commands: union(cloud.commands, local.commands),
      hooks: cloud.hooks || local.hooks,
    },
  };
}

/**
 * 新版本比已装版本多了什么（5.4）。空数组 = 能力没有扩大。
 * 每一条都是给用户看的话：「有更新，需重新确认」时说清楚多了什么。
 */
export function capabilityGrowth(
  before: { readonly level: RiskLevel } & Capabilities,
  after: { readonly level: RiskLevel } & Capabilities,
): readonly string[] {
  const out: string[] = [];
  if (rankLevel(after.level) > rankLevel(before.level)) {
    out.push(`风险等级从 ${before.level.toUpperCase()} 升到 ${after.level.toUpperCase()}`);
  }
  const newHosts = after.network.filter((h) => !before.network.includes(h));
  if (newHosts.length > 0) out.push(`新增访问：${newHosts.join('、')}`);
  const newCommands = after.commands.filter((c) => !before.commands.includes(c));
  if (newCommands.length > 0) out.push(`新增会执行的脚本：${newCommands.join('、')}`);
  if (after.hooks && !before.hooks) out.push('新增 hooks');
  return out;
}

/* ── 吊销与更新判定（5.4）───────────────────────────────────────────────── */

export function findRevocation(
  revoked: readonly HubRevocation[],
  kind: HubItemKind,
  id: string,
  version: string,
): HubRevocation | undefined {
  return revoked.find(
    (r) =>
      r.id === id &&
      (r.kind === undefined || r.kind === kind) &&
      r.versions.some((range) => matchesRange(version, range)),
  );
}

export type HubUpdateDecision =
  | { readonly kind: 'none' }
  | { readonly kind: 'revoked'; readonly reason: string }
  | { readonly kind: 'needs-app-update'; readonly item: HubItem }
  | { readonly kind: 'silent'; readonly item: HubItem }
  | { readonly kind: 'reconfirm'; readonly item: HubItem; readonly why: readonly string[] };

/**
 * 已装条目遇到一份新索引时怎么办。
 *
 * 用的是**云端**结论做初判（还没下载）；真正静默更新之前，宿主会下载、本地重审，
 * 再用 `capabilityGrowth` 判一次 —— 云端说没扩大、本地审出来扩大了，照样转「需重新确认」。
 */
export function decideUpdate(
  installed: HubInstalled,
  index: HubIndexPayload,
  appVersion: string,
): HubUpdateDecision {
  const revocation = findRevocation(index.revoked, installed.kind, installed.id, installed.version);
  if (revocation !== undefined) return { kind: 'revoked', reason: revocation.reason };
  const item = index.items.find((i) => i.kind === installed.kind && i.id === installed.id);
  if (item === undefined || !isVersion(installed.version)) return { kind: 'none' };
  if (compareVersions(item.version, installed.version) <= 0) return { kind: 'none' };
  if (findRevocation(index.revoked, item.kind, item.id, item.version) !== undefined) {
    return { kind: 'none' };
  }
  if (!appSatisfies(item, appVersion)) return { kind: 'needs-app-update', item };
  if (installed.heldVersion === item.version && installed.heldReason !== undefined) {
    return { kind: 'reconfirm', item, why: [installed.heldReason] };
  }
  // stdio 连接器能做什么没法靠静态分析框住，「能力没扩大」证明不了，只能按扩大对待
  if (
    item.kind === 'connector' &&
    (item.connector?.transport === 'stdio' || installed.transport === 'stdio')
  ) {
    return { kind: 'reconfirm', item, why: ['本机程序类连接器的任何更新都要重新确认'] };
  }
  const why = capabilityGrowth(installed, item.audit);
  if (why.length > 0) return { kind: 'reconfirm', item, why };
  return { kind: 'silent', item };
}

export function appSatisfies(item: HubItem, appVersion: string): boolean {
  if (item.minAppVersion === undefined) return true;
  if (!isVersion(appVersion)) return false;
  return compareVersions(appVersion, item.minAppVersion) >= 0;
}

/* ── 目录里每一条的状态（5.6）──────────────────────────────────────────── */

export type HubEntryState =
  | 'available'
  | 'installed'
  | 'needs-reconfirm'
  | 'revoked'
  | 'needs-app-update'
  /** 4.5：索引过期，禁止新装。 */
  | 'expired';

export interface HubEntry {
  readonly sourceId: string;
  readonly kind: HubItemKind;
  readonly id: string;
  /** 索引里的最新版本；只剩本机记录时是已装版本。 */
  readonly version: string;
  readonly installedVersion?: string | undefined;
  readonly state: HubEntryState;
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly level: RiskLevel;
  readonly promptVisible: boolean;
  readonly license: string;
  readonly reason?: string | undefined;
  readonly minAppVersion?: string | undefined;
  readonly isNew: boolean;
  readonly canRollback: boolean;
  readonly publishedAt?: number | undefined;
}

/** 「新上架」：两周内发布的（5.6：只在插件页里标，侧栏和首页不放红点）。 */
export const HUB_NEW_WINDOW_SEC = 14 * 24 * 3600;

export function hubEntries(input: {
  readonly index?: HubIndexPayload | undefined;
  readonly expired: boolean;
  readonly installed: HubInstallState;
  readonly appVersion: string;
  readonly now: number;
}): readonly HubEntry[] {
  const out: HubEntry[] = [];
  const index = input.index;
  const seen = new Set<string>();
  for (const item of index?.items ?? []) {
    const key = `${item.kind}:${item.id}`;
    seen.add(key);
    const installed = findInstalled(input.installed, item.kind, item.id);
    const revokedLatest = findRevocation(index?.revoked ?? [], item.kind, item.id, item.version);
    let state: HubEntryState;
    let reason: string | undefined;
    if (installed?.revokedReason !== undefined) {
      state = 'revoked';
      reason = installed.revokedReason;
    } else if (installed !== undefined && index !== undefined) {
      const decision = decideUpdate(installed, index, input.appVersion);
      if (decision.kind === 'revoked') {
        state = 'revoked';
        reason = decision.reason;
      } else if (decision.kind === 'reconfirm') {
        state = 'needs-reconfirm';
        reason = decision.why.join('；');
      } else if (decision.kind === 'needs-app-update') {
        state = 'needs-app-update';
      } else {
        state = 'installed';
      }
    } else if (revokedLatest !== undefined) {
      // 没装、最新版又被吊销了：不列
      continue;
    } else if (!appSatisfies(item, input.appVersion)) {
      state = 'needs-app-update';
    } else if (input.expired) {
      state = 'expired';
    } else {
      state = 'available';
    }
    out.push({
      sourceId: index?.source.id ?? installed?.sourceId ?? '',
      kind: item.kind,
      id: item.id,
      version: item.version,
      ...(installed !== undefined ? { installedVersion: installed.version } : {}),
      state,
      displayName: item.interface.displayName,
      description: item.interface.description,
      category: item.interface.category,
      level: installed?.level ?? item.audit.level,
      promptVisible: item.promptVisible,
      license: item.license.spdx,
      ...(reason !== undefined ? { reason } : {}),
      ...(item.minAppVersion !== undefined ? { minAppVersion: item.minAppVersion } : {}),
      isNew:
        installed === undefined &&
        item.publishedAt !== undefined &&
        input.now - item.publishedAt <= HUB_NEW_WINDOW_SEC,
      canRollback: installed?.previous !== undefined,
      ...(item.publishedAt !== undefined ? { publishedAt: item.publishedAt } : {}),
    });
  }
  // 装着、但索引里已经没有它（或还没有索引）：照样列出来，否则用户没法卸载
  for (const installed of input.installed.items) {
    if (seen.has(`${installed.kind}:${installed.id}`)) continue;
    const revocation =
      index !== undefined
        ? findRevocation(index.revoked, installed.kind, installed.id, installed.version)
        : undefined;
    const reason = installed.revokedReason ?? revocation?.reason;
    out.push({
      sourceId: installed.sourceId,
      kind: installed.kind,
      id: installed.id,
      version: installed.version,
      installedVersion: installed.version,
      state: reason !== undefined ? 'revoked' : 'installed',
      displayName: installed.id,
      description: '',
      category: '未分类',
      level: installed.level,
      promptVisible: installed.promptVisible,
      license: '',
      ...(reason !== undefined ? { reason } : {}),
      isNew: false,
      canRollback: installed.previous !== undefined,
    });
  }
  return out;
}

/* ── prompt 预算（13 §6，HF6）─────────────────────────────────────────── */

/**
 * 内核技能目录的成本口径（`ext/skills/src/render.rs`，13 §12 V3 核对）：
 * 每个进目录的技能一行 `- <name>: <description> (file: <SKILL.md 路径>)`，描述截到 1024 字符，
 * 按 **4 字节 ≈ 1 token** 折算；预算是上下文窗口的 2%。
 */
const DESCRIPTION_CHARS = 1024;
const BYTES_PER_TOKEN = 4;
const CONTEXT_WINDOW_PERCENT = 2;

export interface CatalogCostEntry {
  readonly name: string;
  readonly description: string;
  readonly path: string;
}

export function skillCatalogCost(entries: readonly CatalogCostEntry[]): number {
  let total = 0;
  for (const e of entries) {
    const chars = [...e.description];
    const desc =
      chars.length > DESCRIPTION_CHARS
        ? `${chars.slice(0, DESCRIPTION_CHARS).join('')}...`
        : e.description;
    const line = `- ${e.name}: ${desc} (file: ${e.path})\n`;
    total += Math.ceil(Buffer.byteLength(line, 'utf8') / BYTES_PER_TOKEN);
  }
  return total;
}

export function skillCatalogBudget(contextWindow: number): number {
  return Math.max(1, Math.floor((contextWindow * CONTEXT_WINDOW_PERCENT) / 100));
}

function union(a: readonly string[], b: readonly string[]): readonly string[] {
  return [...new Set([...a, ...b])].sort();
}
