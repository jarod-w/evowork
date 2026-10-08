/**
 * 插件 Hub 的本机宿主（13 §4.4–§5.6，H1）。
 *
 * 三层各管一件事，这里只接线：
 * - `@evowork/hub-client`：出网、验签、缓存、下载（**唯一出网的那一层**，K6）
 * - `@evowork/catalog`：本地重审、能力比较、更新判定（不出网）
 * - 这里：什么时候允许拉（HUB-Q3=B）、落盘到哪、怎么停用与回滚
 *
 * 落盘继续走 catalog-host 的老位置（13 §3「落盘继续走 catalog-host 现有的安装路径」）：
 * 技能 `~/.evowork/skills/<id>/` + 内核 `skills/`，专家 `~/.evowork/agents/<id>.toml`，
 * 连接器 `connectors.json`。Hub 自己的状态在 `~/.evowork/hub/`。
 */
import { join } from 'node:path';

import {
  AUDIT_RULES_VERSION,
  auditSkillFiles,
  capabilityGrowth,
  decideUpdate,
  extractCapabilities,
  findInstalled,
  hubEntries,
  listSkills,
  parseAgentToml,
  parseConnectorStore,
  parseFrontmatter,
  parseHubInstallState,
  patchMcpServersToml,
  reconcileAudit,
  removeInstalled,
  riskLabel,
  serializeConnectorStore,
  serializeHubInstallState,
  skillCatalogBudget,
  skillCatalogCost,
  HUB_REVOKED_MARKER,
  SOURCE_MARKER_FILE,
  upsertConnector,
  upsertInstalled,
  applyAllowlist,
  withOfficialLaunch,
  type AuditFile,
  type Capabilities,
  type HubInstalled,
  type HubInstallState,
  type RiskLevel,
  type StoredConnector,
} from '@evowork/catalog';
import {
  downloadItem,
  readCachedIndex,
  refreshIndex,
  type HubClientPorts,
  type HubSource,
  type RefreshOutcome,
  type VerifiedIndex,
} from '@evowork/hub-client';
import {
  compareVersions,
  isUpstreamPackage,
  isVersion,
  type HubItem,
  type HubItemKind,
  type TarFile,
} from '@evowork/hub-protocol';

import type {
  HubCatalogView,
  HubEntryView,
  HubItemRef,
  HubStatusView,
  SkillBudgetView,
} from '../shared/ipc.js';
import { officialBrowser, type CatalogPorts } from './catalog-host.js';

export interface HubHostPorts {
  readonly catalog: CatalogPorts;
  readonly client: HubClientPorts;
  /** 没配（部署时没给地址，或 App 里还没有钉死的公钥）→ 整个 Hub 不出网，如实说。 */
  readonly source?: HubSource | undefined;
  readonly sourceName: string;
  readonly appVersion: string;
  /** 部署时的 `EVOWORK_HUB_OFFICIAL=off`（4.7 ②）。 */
  readonly officialOff: boolean;
  /**
   * 企业策略包的 `disableOfficialHub`（13 §4.7 ①）。按**最后一份有效策略包**执行：
   * 策略包过期不放开（R11）—— 那由策略包一侧保证，这里只读结果。
   */
  readonly orgDisabled?: (() => boolean) | undefined;
  /**
   * 企业离线包（4.7 ③，`EVOWORK_HUB_BUNDLE`）。有值时 `client.fetch` 只读那个目录、不碰网络，
   * 所以「自动拉」不受 Q30 的零请求约束（没有请求）；白名单只能从已签名的索引里删条目。
   */
  readonly offline?:
    | {
        readonly builtAt?: number | undefined;
        readonly allowlist?: ReadonlySet<string> | undefined;
      }
    | undefined;
  readonly signedIn: () => boolean;
  /** stdio 连接器的 JS 用 Electron 自己充当 node（HUB-Q6a=A）。 */
  readonly nodeRuntime: {
    readonly command: string;
    readonly env: Readonly<Record<string, string>>;
  };
  /** 办公运行时的 python；没装 → undefined。 */
  readonly pythonCommand: () => string | undefined;
  /** 只允许产品固定的共享组件，不执行内容包里的安装代码。 */
  readonly officeRuntime?:
    | {
        readonly status: () => {
          readonly installed: boolean;
          readonly outdated?: boolean | undefined;
          readonly supported: boolean;
          readonly downloadSize?: string | undefined;
        };
        readonly install: () => Promise<{
          readonly ok: boolean;
          readonly message?: string | undefined;
        }>;
      }
    | undefined;
  /** 5.5：Hub 版本覆盖随包技能时，按路径停用 / 恢复随包那一份。 */
  readonly setSkillEnabledByPath?: ((path: string, enabled: boolean) => Promise<void>) | undefined;
  /** 写完 `config.toml` 的 mcp_servers 之后让内核重读。 */
  readonly reloadMcp?: (() => Promise<void>) | undefined;
  readonly now: () => number;
  /** 最近一次拉取的结果（warning 条用）。宿主与桥接层共用同一个对象。 */
  readonly runtime: HubRuntime;
}

export interface HubMutation {
  readonly ok: boolean;
  readonly refused?: string | undefined;
  readonly needsConfirm?: boolean | undefined;
  readonly audit?:
    | {
        readonly skillId: string;
        readonly subject: 'hub';
        readonly level: RiskLevel;
        readonly findings: readonly string[];
        readonly worstCase?: string | undefined;
      }
    | undefined;
}

export interface InstallHubInput extends HubItemRef {
  readonly acknowledge?: boolean | undefined;
  readonly confirmName?: string | undefined;
}

/** 05 §7 的原句：**不提供重试**。 */
export const HUB_INTEGRITY_REFUSAL = '签名校验失败';
export const HUB_STDIO_WORST_CASE =
  '它会以你的身份在这台电脑上运行程序，能读写你能读写的所有文件。';
/** 5.6：不静默截断。 */
export const HUB_BUDGET_WARNING = '已启用的技能太多，模型将看不到部分技能的说明';
/** 5.6：未登录、开关关着。 */
export const HUB_SIGNED_OUT_CAPTION = '登录或在设置中开启后，可以获取 EvoWork 精选内容';
export const HUB_OFF_CAPTION = '这台电脑的部署配置停用了 EvoWork 精选内容';
/** 13 §4.7 ① 的原句。 */
export const HUB_ORG_OFF_CAPTION = '你所在的组织已停用 EvoWork 精选内容';
export const HUB_UNCONFIGURED_CAPTION = '这个版本还没有接入 EvoWork 精选源';

/**
 * 支持的最小上下文窗口（13 §6：核心层预算按它算）。128K 原本取自 `known-models.ts`
 * 里内置模型的最小值；2026-10-05 那张表按厂商文档订正后内置三家都是 1M 级，
 * **这里有意不跟着放大**：内核按每个模型的真实窗口算技能目录预算，表外的自定义模型可以比 1M 小
 * （默认 256k，手改 `models.toml` 可以更小），按 1M 算的预算在它们身上会漏报截断。
 * 128K 对 32K / 64K 的模型仍偏大，还没处理。
 */
export const HUB_MIN_CONTEXT_WINDOW = 128_000;

/* ── 状态与偏好 ─────────────────────────────────────────────────────────── */

function hubDir(ports: HubHostPorts): string {
  return join(ports.catalog.userRoot, 'hub');
}

function statePath(ports: HubHostPorts): string {
  return join(hubDir(ports), 'installed.json');
}

function prefsPath(ports: HubHostPorts): string {
  return join(hubDir(ports), 'prefs.json');
}

export function readHubState(ports: HubHostPorts): HubInstallState {
  return parseHubInstallState(ports.catalog.io.readText(statePath(ports)));
}

function writeHubState(ports: HubHostPorts, state: HubInstallState): void {
  ports.catalog.mkdirp(hubDir(ports));
  ports.catalog.writeText(statePath(ports), serializeHubInstallState(state));
}

/** 「未登录时也获取 EvoWork 精选内容」（HUB-Q3=B），默认关。 */
export function readFetchWhenSignedOut(ports: HubHostPorts): boolean {
  const raw = ports.catalog.io.readText(prefsPath(ports));
  if (raw === undefined) return false;
  try {
    return (JSON.parse(raw) as { fetchWhenSignedOut?: unknown }).fetchWhenSignedOut === true;
  } catch {
    return false;
  }
}

export function writeFetchWhenSignedOut(ports: HubHostPorts, enabled: boolean): void {
  ports.catalog.mkdirp(hubDir(ports));
  ports.catalog.writeText(prefsPath(ports), `${JSON.stringify({ fetchWhenSignedOut: enabled })}\n`);
}

/**
 * 能不能**自动**拉（启动 + 每小时）。Q30 / HUB-Q3=B：零请求管的是自动 / 后台请求 ——
 * 登录了才自动拉；未登录要用户在设置里打开（打开这个动作本身就是显式授权）。
 */
export function canAutoFetch(ports: HubHostPorts): boolean {
  if (ports.source === undefined || orgOff(ports)) return false;
  // 离线包：读的是本机目录，不是请求
  if (ports.offline !== undefined) return true;
  if (ports.officialOff) return false;
  return ports.signedIn() || readFetchWhenSignedOut(ports);
}

/** 插件页的「刷新」= 显式触发，开关关着也可以点一次拉一次。部署时关掉的不行。 */
export function canManualFetch(ports: HubHostPorts): boolean {
  if (ports.source === undefined || orgOff(ports)) return false;
  return ports.offline !== undefined || !ports.officialOff;
}

function orgOff(ports: HubHostPorts): boolean {
  return ports.orgDisabled?.() === true;
}

/**
 * 组织关掉官方源之后，已装的精选条目**停用并写明原因，不静默删除**（4.7 ①）。
 * 「停止更新」不够：管理员的意思是「不要用外部内容」。幂等，可以随时调。
 */
export async function enforceOrganizationPolicy(ports: HubHostPorts): Promise<number> {
  if (!orgOff(ports)) return 0;
  let n = 0;
  for (const installed of readHubState(ports).items) {
    if (installed.revokedReason !== undefined) continue;
    await revoke(ports, installed, HUB_ORG_OFF_CAPTION, 'organization');
    n += 1;
  }
  return n;
}

/* ── 拉取 ───────────────────────────────────────────────────────────────── */

export interface HubRuntime {
  last?: RefreshOutcome | undefined;
}

/**
 * 拉一次索引，然后按 5.4 处理已装条目（吊销立即停用、能力不扩大的静默更新）。
 * `trigger = 'auto'` 时先过 `canAutoFetch`，不满足就**一个请求都不发**。
 */
export async function refreshHub(
  ports: HubHostPorts,
  runtime: HubRuntime,
  trigger: 'auto' | 'manual',
): Promise<HubMutation> {
  await enforceOrganizationPolicy(ports);
  const allowed = trigger === 'auto' ? canAutoFetch(ports) : canManualFetch(ports);
  if (!allowed || ports.source === undefined) {
    return { ok: false, refused: statusCaption(ports) ?? '现在不能获取 EvoWork 精选内容。' };
  }
  const outcome = await refreshIndex(ports.client, ports.source);
  runtime.last = outcome;
  const index = outcome.index !== undefined ? effective(ports, outcome.index) : undefined;
  if (index !== undefined) await applyHubUpdates(ports, index);
  if (outcome.status === 'rejected') return { ok: false, refused: outcome.reason };
  if (outcome.status === 'unreachable') {
    return { ok: false, refused: unreachableCopy(ports, index) };
  }
  return { ok: true };
}

function cachedIndex(ports: HubHostPorts): VerifiedIndex | undefined {
  const index =
    ports.source !== undefined ? readCachedIndex(ports.client, ports.source) : undefined;
  return index !== undefined ? effective(ports, index) : undefined;
}

/** 离线包的企业白名单：只删不加（4.7 ③）。 */
function effective(ports: HubHostPorts, index: VerifiedIndex): VerifiedIndex {
  const allow = ports.offline?.allowlist;
  return allow === undefined ? index : { ...index, payload: applyAllowlist(index.payload, allow) };
}

/**
 * 5.4：吊销 → 立即停用（不删）；能力不扩大 → 静默更新并保留上一版；其余只改卡片状态。
 * 静默更新前**下载并本地重审**：云端说没扩大、本机审出来扩大了，照样挡下来转「需重新确认」。
 */
export async function applyHubUpdates(ports: HubHostPorts, index: VerifiedIndex): Promise<void> {
  let state = readHubState(ports);
  for (const installed of state.items) {
    if (installed.sourceId !== index.payload.source.id) continue;
    const decision = decideUpdate(installed, index.payload, ports.appVersion);
    if (decision.kind === 'revoked') {
      if (installed.revokedReason === undefined) {
        await revoke(ports, installed, decision.reason, 'revocation');
        state = readHubState(ports);
      }
      continue;
    }
    if (decision.kind !== 'silent' || index.expired) continue;
    const prepared = await prepare(ports, decision.item);
    if (!prepared.ok) continue;
    const growth = capabilityGrowth(installed, { level: prepared.level, ...prepared.capabilities });
    if (growth.length > 0) {
      state = upsertInstalled(state, {
        ...installed,
        heldVersion: decision.item.version,
        heldReason: growth.join('；'),
      });
      writeHubState(ports, state);
      continue;
    }
    const dependency = officeDependency(ports, decision.item, prepared.files);
    if (!dependency.ok || dependency.missing) {
      state = upsertInstalled(state, {
        ...installed,
        heldVersion: decision.item.version,
        heldReason: dependency.ok ? '需要安装或更新办公组件，请手动更新并确认' : dependency.refused,
      });
      writeHubState(ports, state);
      continue;
    }
    const written = await writeItem(ports, decision.item, prepared, installed);
    if (written.ok) state = readHubState(ports);
  }
}

/* ── 视图 ───────────────────────────────────────────────────────────────── */

export function hubStatus(ports: HubHostPorts, runtime: HubRuntime): HubStatusView {
  const index = cachedIndex(ports);
  const signedIn = ports.signedIn();
  const fetchMode: HubStatusView['fetchMode'] =
    ports.source === undefined
      ? 'unconfigured'
      : orgOff(ports)
        ? 'org-off'
        : ports.offline !== undefined
          ? 'offline'
          : ports.officialOff
            ? 'off'
            : canAutoFetch(ports)
              ? 'auto'
              : 'manual-only';
  const last = runtime.last;
  const warning =
    last?.status === 'rejected'
      ? `收到的目录没有通过校验，已丢弃，继续显示缓存：${last.reason}`
      : last?.status === 'unreachable'
        ? unreachableCopy(ports, index)
        : index?.expired === true
          ? `EvoWork 精选的目录已过期（更新于 ${formatTime(index.fetchedAt)}），暂时不能安装新内容`
          : undefined;
  const caption = statusCaption(ports);
  return {
    configured: ports.source !== undefined,
    sourceName: ports.sourceName,
    fetchMode,
    signedIn,
    fetchWhenSignedOut: readFetchWhenSignedOut(ports),
    canRefresh: canManualFetch(ports),
    expired: index?.expired === true,
    ...(index !== undefined ? { fetchedAt: index.fetchedAt } : {}),
    ...(warning !== undefined ? { warning } : {}),
    ...(caption !== undefined ? { caption } : {}),
  };
}

function statusCaption(ports: HubHostPorts): string | undefined {
  if (ports.source === undefined) return HUB_UNCONFIGURED_CAPTION;
  if (orgOff(ports)) return HUB_ORG_OFF_CAPTION;
  if (ports.offline !== undefined) {
    // §14：离线环境吊销滞后 —— 至少让人看见这份内容是什么时候打的包
    return ports.offline.builtAt !== undefined
      ? `离线内容，更新于 ${formatTime(ports.offline.builtAt)}`
      : '离线内容';
  }
  if (ports.officialOff) return HUB_OFF_CAPTION;
  if (!ports.signedIn() && !readFetchWhenSignedOut(ports)) return HUB_SIGNED_OUT_CAPTION;
  return undefined;
}

function unreachableCopy(ports: HubHostPorts, index: VerifiedIndex | undefined): string {
  // 05 §7 的原文案
  return index !== undefined
    ? `${ports.sourceName}暂时无法访问，显示的是缓存内容（更新于 ${formatTime(index.fetchedAt)}）`
    : `${ports.sourceName}暂时无法访问`;
}

export function hubCatalogView(ports: HubHostPorts, runtime: HubRuntime): HubCatalogView {
  const index = cachedIndex(ports);
  const entries: HubEntryView[] = hubEntries({
    index: index?.payload,
    expired: index?.expired === true,
    installed: readHubState(ports),
    appVersion: ports.appVersion,
    now: ports.now(),
  }).map((e) => ({
    kind: e.kind,
    id: e.id,
    version: e.version,
    ...(e.installedVersion !== undefined ? { installedVersion: e.installedVersion } : {}),
    state: e.state,
    displayName: e.displayName,
    description: e.description,
    category: e.category,
    riskLevel: e.level,
    riskLabel: riskLabel(e.level),
    license: e.license,
    promptVisible: e.promptVisible,
    isNew: e.isNew,
    canRollback: e.canRollback,
    ...(e.reason !== undefined ? { reason: e.reason } : {}),
    ...(e.minAppVersion !== undefined ? { minAppVersion: e.minAppVersion } : {}),
  }));
  // 4.7 ①：组织停用后不显示精选条目，只留已装的（停用状态，可以卸载）
  const visible = orgOff(ports)
    ? entries
        .filter((e) => e.installedVersion !== undefined)
        .map((e) => ({
          ...e,
          state: 'revoked' as const,
          reason: HUB_ORG_OFF_CAPTION,
          canRollback: false,
        }))
    : entries;
  return { status: hubStatus(ports, runtime), entries: visible };
}

/**
 * 进 prompt 的技能目录占了多少预算（13 §6 / HF6）。
 *
 * 数的是内核 `skills/list` 里**启用**的技能 —— 套件带进来的插件技能也在里面（9.1 第 7 条）——
 * 减去写了 `allow_implicit_invocation: false` 的（HF7：启用但不进 prompt）。
 */
export function skillBudgetView(
  ports: { readonly io: CatalogPorts['io'] },
  skills: readonly {
    readonly name: string;
    readonly description: string;
    readonly path: string;
    readonly enabled: boolean;
  }[],
  contextWindow: number = HUB_MIN_CONTEXT_WINDOW,
): SkillBudgetView {
  const visible = skills.filter((s) => s.enabled && !hiddenFromPrompt(ports, s.path));
  const used = skillCatalogCost(visible);
  const budget = skillCatalogBudget(contextWindow);
  return {
    used,
    budget,
    over: used > budget,
    ...(used > budget ? { warning: HUB_BUDGET_WARNING } : {}),
  };
}

function hiddenFromPrompt(
  ports: { readonly io: CatalogPorts['io'] },
  skillMdPath: string,
): boolean {
  const dir = skillMdPath.replace(/[/\\]SKILL\.md$/i, '');
  const yaml = ports.io.readText(join(dir, 'agents', 'openai.yaml'));
  return yaml !== undefined && /allow_implicit_invocation\s*:\s*false/.test(yaml);
}

/* ── 安装 ───────────────────────────────────────────────────────────────── */

interface Prepared {
  readonly ok: true;
  readonly files: readonly TarFile[];
  readonly level: RiskLevel;
  readonly capabilities: Capabilities;
  readonly findings: readonly string[];
  readonly worstCase?: string | undefined;
}

type PrepareResult = Prepared | { readonly ok: false; readonly refused: string };

/** 下载 → 校验 → 本地重审 → 与云端结论对账（5.3）。 */
async function prepare(ports: HubHostPorts, item: HubItem): Promise<PrepareResult> {
  if (ports.source === undefined) return { ok: false, refused: HUB_UNCONFIGURED_CAPTION };
  // 离线包不含没写许可的条目（它们只做索引、内容在上游，HUB-Q5a=A），离线模式下不出网去取
  if (ports.offline !== undefined && isUpstreamPackage(item.package)) {
    return { ok: false, refused: '这一项不在离线包里（它的内容只能从上游代码托管站下载）。' };
  }
  const downloaded = await downloadItem(ports.client, ports.source, item);
  if (!downloaded.ok) {
    if (downloaded.kind === 'integrity') return { ok: false, refused: HUB_INTEGRITY_REFUSAL };
    return {
      ok: false,
      refused:
        downloaded.host !== undefined
          ? `没能下载：需要能访问 ${downloaded.host}`
          : `没能下载：${downloaded.reason}`,
    };
  }
  const auditFiles = toAuditFiles(downloaded.files);
  const local = auditSkillFiles(auditFiles);
  const capabilities = extractCapabilities(auditFiles);
  const reconciled = reconcileAudit(
    item.audit,
    { level: local.level, ...capabilities },
    AUDIT_RULES_VERSION,
  );
  if (!reconciled.ok) return { ok: false, refused: reconciled.reason };
  let level = reconciled.level;
  let worstCase = local.worstCase;
  const findings = local.findings.map((f) => f.detail);
  // HUB-Q6=B：stdio 连接器一律 P2
  if (item.kind === 'connector' && item.connector?.transport === 'stdio') {
    level = 'p2';
    worstCase = HUB_STDIO_WORST_CASE;
    findings.unshift('这个连接器会在本机运行程序，不在任务的沙箱里。');
  }
  for (const host of reconciled.capabilities.network) {
    if (!findings.some((f) => f.includes(host))) findings.push(`会访问 ${host}`);
  }
  return {
    ok: true,
    files: downloaded.files,
    level,
    capabilities: reconciled.capabilities,
    findings,
    ...(worstCase !== undefined ? { worstCase } : {}),
  };
}

export async function installHubItem(
  ports: HubHostPorts,
  input: InstallHubInput,
): Promise<HubMutation> {
  if (ports.source === undefined) return { ok: false, refused: HUB_UNCONFIGURED_CAPTION };
  if (ports.officialOff && ports.offline === undefined)
    return { ok: false, refused: HUB_OFF_CAPTION };
  if (orgOff(ports)) return { ok: false, refused: HUB_ORG_OFF_CAPTION };
  const index = cachedIndex(ports);
  if (index === undefined)
    return { ok: false, refused: '还没有拿到 EvoWork 精选的目录，请先刷新。' };
  if (index.expired) {
    return {
      ok: false,
      refused: `EvoWork 精选的目录已过期（更新于 ${formatTime(index.fetchedAt)}），暂时不能安装新内容。`,
    };
  }
  const item = index.payload.items.find((i) => i.kind === input.kind && i.id === input.id);
  if (item === undefined) return { ok: false, refused: '目录里没有这一项。' };
  const installed = findInstalled(readHubState(ports), item.kind, item.id);
  const entry = hubEntries({
    index: index.payload,
    expired: false,
    installed: readHubState(ports),
    appVersion: ports.appVersion,
    now: ports.now(),
  }).find((e) => e.kind === item.kind && e.id === item.id);
  if (entry === undefined || entry.state === 'revoked') {
    return { ok: false, refused: `已吊销：${entry?.reason ?? '这一项不能再安装'}` };
  }
  if (entry.state === 'needs-app-update')
    return { ok: false, refused: '需要更新 EvoWork 才能安装这个版本。' };
  if (
    installed !== undefined &&
    entry.state === 'installed' &&
    installed.version === item.version
  ) {
    return { ok: false, refused: '已经装上了最新版本。' };
  }

  const prepared = await prepare(ports, item);
  if (!prepared.ok) return { ok: false, refused: prepared.refused };

  const dependency = officeDependency(ports, item, prepared.files);
  if (!dependency.ok) return dependency;
  const findings = [...prepared.findings];
  if (dependency.missing)
    findings.push(
      `需要安装或更新办公组件（${ports.officeRuntime?.status().downloadSize ?? '共享运行环境'}），确认后将自动下载并安装；企业离线环境可使用办公组件离线包。`,
    );
  if (installed !== undefined) {
    findings.unshift(
      ...capabilityGrowth(installed, { level: prepared.level, ...prepared.capabilities }),
    );
  }
  const needsAck =
    dependency.missing ||
    prepared.level !== 'p0' ||
    (installed !== undefined && findings.length > 0);
  if (needsAck && input.acknowledge !== true) {
    return {
      ok: false,
      needsConfirm: true,
      audit: {
        skillId: item.id,
        subject: 'hub',
        level: prepared.level,
        findings,
        ...(prepared.worstCase !== undefined ? { worstCase: prepared.worstCase } : {}),
      },
    };
  }
  if (prepared.level === 'p2' && input.confirmName !== item.id) {
    return { ok: false, refused: `这一项是高风险，请输入名称「${item.id}」确认。` };
  }
  if (dependency.missing) {
    try {
      const result = await ports.officeRuntime?.install();
      if (!result?.ok)
        return { ok: false, refused: result?.message ?? '办公组件安装失败，请重试。' };
      const checked = officeDependency(ports, item, prepared.files);
      if (!checked.ok) return checked;
      if (checked.missing)
        return { ok: false, refused: '办公组件尚未就绪，请到设置中修复后重试。' };
    } catch {
      return { ok: false, refused: '办公组件安装失败，请重试；技能尚未安装。' };
    }
  }
  return writeItem(ports, item, prepared, installed);
}

/** 读取已校验内容包中的声明；未知依赖不能退化为“无依赖”。 */
function officeDependency(
  ports: HubHostPorts,
  item: HubItem,
  files: readonly TarFile[],
):
  | { readonly ok: true; readonly missing: boolean }
  | { readonly ok: false; readonly refused: string } {
  if (item.kind !== 'skill') return { ok: true, missing: false };
  const file = files.find((f) => f.path === 'interface.json');
  if (!file) return { ok: true, missing: false };
  try {
    const raw = JSON.parse(Buffer.from(file.bytes).toString('utf8')) as {
      runtimeDependencies?: unknown;
    };
    const deps = raw.runtimeDependencies;
    if (deps === undefined) return { ok: true, missing: false };
    if (!Array.isArray(deps) || deps.some((d: unknown) => d !== 'office'))
      return { ok: false, refused: '技能声明了不支持的运行组件，请更新应用或联系发布者。' };
    if (deps.length === 0) return { ok: true, missing: false };
    const status = ports.officeRuntime?.status();
    if (status?.installed && status.outdated !== true) return { ok: true, missing: false };
    if (!status?.supported) return { ok: false, refused: '当前应用或系统不支持所需的办公组件。' };
    return { ok: true, missing: true };
  } catch {
    return { ok: false, refused: '技能的运行组件声明格式不正确。' };
  }
}

/**
 * 落盘。新装与更新同一条路：更新时沿用用户已有的信任状态，不碰用户的选择。
 */
async function writeItem(
  ports: HubHostPorts,
  item: HubItem,
  prepared: Prepared,
  installed: HubInstalled | undefined,
): Promise<HubMutation> {
  let overridesBundled: boolean | undefined;
  try {
    if (item.kind === 'skill') {
      const written = await writeSkill(ports, item, prepared.files, installed);
      if (!written.ok) return written;
      overridesBundled = written.overridesBundled;
    } else if (item.kind === 'expert') {
      const written = writeExpert(ports, item, prepared.files, installed);
      if (!written.ok) return written;
    } else {
      // stdio 永远走不到静默更新（decideUpdate 一律判重新确认），所以这里不需要区分
      const written = await writeConnector(ports, item, prepared.files, installed);
      if (!written.ok) return written;
    }
  } catch (error: unknown) {
    return {
      ok: false,
      refused: `没能装上：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const record: HubInstalled = {
    sourceId: ports.source?.id ?? '',
    kind: item.kind,
    id: item.id,
    version: item.version,
    level: prepared.level,
    network: prepared.capabilities.network,
    commands: prepared.capabilities.commands,
    hooks: prepared.capabilities.hooks,
    promptVisible: item.promptVisible,
    installedAt: ports.now(),
    ...(item.connector !== undefined ? { transport: item.connector.transport } : {}),
    ...(installed !== undefined
      ? {
          previous: {
            version: installed.version,
            level: installed.level,
            network: installed.network,
            commands: installed.commands,
            hooks: installed.hooks,
          },
        }
      : {}),
    ...(overridesBundled === true || installed?.overridesBundled === true
      ? { overridesBundled: true }
      : {}),
  };
  writeHubState(ports, upsertInstalled(readHubState(ports), record));
  return { ok: true };
}

/* ── 三种条目怎么落盘 ───────────────────────────────────────────────────── */

function rollbackDir(ports: HubHostPorts, kind: HubItemKind, id: string): string {
  return join(hubDir(ports), 'rollback', kind, id);
}

async function writeSkill(
  ports: HubHostPorts,
  item: HubItem,
  files: readonly TarFile[],
  installed: HubInstalled | undefined,
): Promise<
  | { readonly ok: true; readonly overridesBundled: boolean }
  | { readonly ok: false; readonly refused: string }
> {
  const skillMd = files.find((f) => f.path === 'SKILL.md');
  if (skillMd === undefined) return { ok: false, refused: '内容包里没有 SKILL.md。' };
  const fm = parseFrontmatter(Buffer.from(skillMd.bytes).toString('utf8'));
  // HF9：name ≤ 64、description ≤ 1024；而且 name 必须就是条目 id，否则内核里认的是另一个名字
  if (fm.name !== item.id || fm.description.length > 1024) {
    return { ok: false, refused: '内容包里的技能名与目录登记的不一致。' };
  }
  const c = ports.catalog;
  const userRoot = join(c.userRoot, 'skills');
  const dest = join(userRoot, item.id);
  const existing = listSkills(
    { official: join(c.pluginsDir, 'skills'), user: userRoot },
    c.io,
  ).find((s) => s.id === item.id);
  let overridesBundled = false;
  if (existing !== undefined && existing.source !== 'hub') {
    if (existing.source !== 'official') {
      return {
        ok: false,
        refused: `已经有一个同名技能（来源：${existing.source === 'git' ? 'Git' : '本地目录'}），请先卸载它。`,
      };
    }
    // 5.5：版本高的生效
    const bundledVersion = bundledSkillVersion(c, item.id);
    if (isVersion(bundledVersion) && compareVersions(item.version, bundledVersion) <= 0) {
      return { ok: false, refused: '随包版本不比它旧，不需要安装。' };
    }
    overridesBundled = true;
  }
  if (installed !== undefined && c.exists(dest)) {
    const keep = rollbackDir(ports, 'skill', item.id);
    if (c.exists(keep)) c.removePath(keep);
    c.mkdirp(join(hubDir(ports), 'rollback', 'skill'));
    c.copyDir(dest, keep);
  }
  if (c.exists(dest)) c.removePath(dest);
  writeFiles(c, dest, files);
  c.writeText(join(dest, SOURCE_MARKER_FILE), 'hub\n');
  // HF7：按需层 = 启用但不进 prompt 目录
  if (!item.promptVisible) {
    c.mkdirp(join(dest, 'agents'));
    c.writeText(
      join(dest, 'agents', 'openai.yaml'),
      'policy:\n  allow_implicit_invocation: false\n',
    );
  }
  const kernelDest = join(c.kernelHome, 'skills', item.id);
  c.mkdirp(join(c.kernelHome, 'skills'));
  if (c.exists(kernelDest)) c.removePath(kernelDest);
  c.copyDir(dest, kernelDest);
  if (overridesBundled) {
    await ports.setSkillEnabledByPath?.(join(c.pluginsDir, 'skills', item.id, 'SKILL.md'), false);
  }
  return { ok: true, overridesBundled };
}

/** 随包技能的版本写在它的 `interface.json` 的 `version` 里；没写 = 0.0.0（任何 Hub 版本都比它新）。 */
function bundledSkillVersion(c: CatalogPorts, id: string): string {
  const raw = c.io.readText(join(c.pluginsDir, 'skills', id, 'interface.json'));
  try {
    const v = raw !== undefined ? (JSON.parse(raw) as { version?: unknown }).version : undefined;
    return typeof v === 'string' && isVersion(v) ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function writeExpert(
  ports: HubHostPorts,
  item: HubItem,
  files: readonly TarFile[],
  installed: HubInstalled | undefined,
): HubMutation {
  const tomls = files.filter((f) => f.path.endsWith('.toml') && !f.path.includes('/'));
  if (tomls.length !== 1 || tomls[0] === undefined) {
    return { ok: false, refused: '专家内容包里应该正好有一份 TOML。' };
  }
  const text = Buffer.from(tomls[0].bytes).toString('utf8');
  const c = ports.catalog;
  const dir = join(c.userRoot, 'agents');
  const dest = join(dir, `${item.id}.toml`);
  if (parseAgentToml(text, dest, 'local') === undefined) {
    return { ok: false, refused: '专家内容包的格式不对。' };
  }
  if (installed === undefined && c.exists(dest)) {
    return { ok: false, refused: '已经有一个同名专家，请先删除它。' };
  }
  if (installed !== undefined && c.exists(dest)) {
    const keep = rollbackDir(ports, 'expert', item.id);
    c.mkdirp(keep);
    c.writeText(join(keep, `${item.id}.toml`), c.io.readText(dest) ?? '');
  }
  c.mkdirp(dir);
  c.writeText(dest, text);
  return { ok: true };
}

interface ConnectorSpec {
  readonly transport: 'stdio' | 'http' | 'sse';
  readonly url?: string | undefined;
  readonly runtime?: 'node' | 'python' | undefined;
  readonly entry?: string | undefined;
  readonly args?: readonly string[] | undefined;
}

function parseConnectorSpec(files: readonly TarFile[]): ConnectorSpec | undefined {
  const file = files.find((f) => f.path === 'connector.json');
  if (file === undefined) return undefined;
  try {
    const raw = JSON.parse(Buffer.from(file.bytes).toString('utf8')) as Record<string, unknown>;
    const transport =
      raw.transport === 'stdio' || raw.transport === 'http' || raw.transport === 'sse'
        ? raw.transport
        : undefined;
    if (transport === undefined) return undefined;
    if (transport !== 'stdio') {
      const url =
        typeof raw.url === 'string' && raw.url.startsWith('https://') ? raw.url : undefined;
      return url !== undefined ? { transport, url } : undefined;
    }
    const runtime = raw.runtime === 'node' || raw.runtime === 'python' ? raw.runtime : undefined;
    const entry =
      typeof raw.entry === 'string' &&
      !raw.entry.startsWith('/') &&
      !raw.entry.split('/').includes('..')
        ? raw.entry
        : undefined;
    const args =
      Array.isArray(raw.args) && raw.args.every((a) => typeof a === 'string')
        ? (raw.args as string[])
        : [];
    if (runtime === undefined || entry === undefined) return undefined;
    if (!files.some((f) => f.path === entry)) return undefined;
    return { transport, runtime, entry, args };
  } catch {
    return undefined;
  }
}

async function writeConnector(
  ports: HubHostPorts,
  item: HubItem,
  files: readonly TarFile[],
  installed: HubInstalled | undefined,
): Promise<HubMutation> {
  const spec = parseConnectorSpec(files);
  if (spec === undefined || spec.transport !== item.connector?.transport) {
    return { ok: false, refused: '连接器内容包的格式不对。' };
  }
  const c = ports.catalog;
  const storePath = join(c.userRoot, 'connectors.json');
  let store = parseConnectorStore(c.io.readText(storePath));
  const existing = store.connectors.find((x) => x.id === item.id);
  if (existing !== undefined && existing.kind !== 'hub') {
    return { ok: false, refused: '已经有一个同名的自建连接器，请先删除它。' };
  }
  if (installed !== undefined && existing !== undefined) {
    const keep = rollbackDir(ports, 'connector', item.id);
    c.mkdirp(keep);
    c.writeText(join(keep, 'connector.json'), `${JSON.stringify(existing)}\n`);
  }
  let next: StoredConnector;
  if (spec.transport === 'stdio') {
    const dir = join(hubDir(ports), 'connectors', item.id, item.version);
    if (c.exists(dir)) c.removePath(dir);
    writeFiles(c, dir, files);
    const entry = join(dir, spec.entry ?? '');
    let command: string;
    let env: Readonly<Record<string, string>> = {};
    if (spec.runtime === 'node') {
      command = ports.nodeRuntime.command;
      env = ports.nodeRuntime.env;
    } else {
      const python = ports.pythonCommand();
      if (python === undefined)
        return { ok: false, refused: '这个连接器需要先安装办公扩展（Python 运行时）。' };
      command = python;
    }
    next = {
      id: item.id,
      name: item.interface.displayName,
      kind: 'hub',
      transport: 'stdio',
      command,
      args: [entry, ...(spec.args ?? [])],
      ...(Object.keys(env).length > 0 ? { env } : {}),
      // HUB-Q6=B：输入名称确认这一步同时算作信任，不再要求第二次点「信任」
      trusted: true,
      toolPolicy: existing?.toolPolicy ?? {},
    };
  } else {
    next = {
      id: item.id,
      name: item.interface.displayName,
      kind: 'hub',
      transport: spec.transport,
      url: spec.url,
      // 远程 MCP：**永远不自动信任**（K6 的显式授权点）。更新沿用用户已有的选择
      trusted: existing?.trusted === true,
      toolPolicy: existing?.toolPolicy ?? {},
    };
  }
  store = upsertConnector(store, next);
  c.mkdirp(c.userRoot);
  c.writeText(storePath, serializeConnectorStore(store));
  await syncMcp(ports, store);
  return { ok: true };
}

async function syncMcp(
  ports: HubHostPorts,
  store: ReturnType<typeof parseConnectorStore>,
): Promise<void> {
  const c = ports.catalog;
  const configPath = join(c.kernelHome, 'config.toml');
  const current = c.io.readText(configPath) ?? '';
  // 别把 connectors.json 里存的旧启动方式（如 `node`）写回去：官方连接器永远用这次安装的
  const fresh = withOfficialLaunch(store, officialBrowser(c));
  c.mkdirp(c.kernelHome);
  c.writeText(
    configPath,
    patchMcpServersToml(
      current,
      fresh.connectors.filter((x) => x.trusted),
    ),
  );
  await ports.reloadMcp?.().catch(() => undefined);
}

/* ── 吊销 · 卸载 · 回滚 ─────────────────────────────────────────────────── */

/**
 * 5.4：吊销 = **停用并写明原因，不删**。技能从内核目录撤下（用户那份留着），
 * 专家挪出专家目录，连接器从 `config.toml` 移除并标上原因。
 */
async function revoke(
  ports: HubHostPorts,
  installed: HubInstalled,
  reason: string,
  by: 'revocation' | 'organization',
): Promise<void> {
  const c = ports.catalog;
  if (installed.kind === 'skill') {
    const kernelDest = join(c.kernelHome, 'skills', installed.id);
    if (c.exists(kernelDest)) c.removePath(kernelDest);
    const userDir = join(c.userRoot, 'skills', installed.id);
    if (c.exists(userDir))
      c.writeText(join(userDir, SOURCE_MARKER_FILE), `${HUB_REVOKED_MARKER}\n`);
    if (installed.overridesBundled === true) {
      await ports.setSkillEnabledByPath?.(
        join(c.pluginsDir, 'skills', installed.id, 'SKILL.md'),
        true,
      );
    }
  } else if (installed.kind === 'expert') {
    const src = join(c.userRoot, 'agents', `${installed.id}.toml`);
    const text = c.io.readText(src);
    if (text !== undefined) {
      const dir = join(hubDir(ports), 'revoked');
      c.mkdirp(dir);
      c.writeText(join(dir, `${installed.id}.toml`), text);
      c.removePath(src);
    }
  } else {
    const storePath = join(c.userRoot, 'connectors.json');
    let store = parseConnectorStore(c.io.readText(storePath));
    const existing = store.connectors.find((x) => x.id === installed.id);
    if (existing !== undefined) {
      store = upsertConnector(store, {
        ...existing,
        trusted: false,
        disabledReason: `已吊销：${reason}`,
      });
      c.writeText(storePath, serializeConnectorStore(store));
      await syncMcp(ports, store);
    }
  }
  writeHubState(
    ports,
    upsertInstalled(readHubState(ports), { ...installed, revokedReason: reason, revokedBy: by }),
  );
}

export async function uninstallHubItem(ports: HubHostPorts, ref: HubItemRef): Promise<HubMutation> {
  const installed = findInstalled(readHubState(ports), ref.kind, ref.id);
  if (installed === undefined) return { ok: false, refused: '没有装这一项。' };
  const c = ports.catalog;
  try {
    if (ref.kind === 'skill') {
      const dest = join(c.userRoot, 'skills', ref.id);
      const kernelDest = join(c.kernelHome, 'skills', ref.id);
      if (c.exists(dest)) c.removePath(dest);
      if (c.exists(kernelDest)) c.removePath(kernelDest);
      // 5.5：卸载 Hub 版本后回落到随包版本
      if (installed.overridesBundled === true) {
        await ports.setSkillEnabledByPath?.(join(c.pluginsDir, 'skills', ref.id, 'SKILL.md'), true);
      }
    } else if (ref.kind === 'expert') {
      for (const p of [
        join(c.userRoot, 'agents', `${ref.id}.toml`),
        join(hubDir(ports), 'revoked', `${ref.id}.toml`),
      ]) {
        if (c.exists(p)) c.removePath(p);
      }
    } else {
      const storePath = join(c.userRoot, 'connectors.json');
      const store = parseConnectorStore(c.io.readText(storePath));
      const next = { connectors: store.connectors.filter((x) => x.id !== ref.id) };
      c.writeText(storePath, serializeConnectorStore(next));
      await syncMcp(ports, next);
      const code = join(hubDir(ports), 'connectors', ref.id);
      if (c.exists(code)) c.removePath(code);
    }
    const keep = rollbackDir(ports, ref.kind, ref.id);
    if (c.exists(keep)) c.removePath(keep);
  } catch (error: unknown) {
    return {
      ok: false,
      refused: `没能卸载：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  writeHubState(ports, removeInstalled(readHubState(ports), ref.kind, ref.id));
  return { ok: true };
}

/** 5.4「保留上一版，可以回滚」。只回滚一步：回滚后没有「上一版」了。 */
export async function rollbackHubItem(ports: HubHostPorts, ref: HubItemRef): Promise<HubMutation> {
  const state = readHubState(ports);
  const installed = findInstalled(state, ref.kind, ref.id);
  if (installed?.previous === undefined) return { ok: false, refused: '没有可以回滚的上一版。' };
  const c = ports.catalog;
  const keep = rollbackDir(ports, ref.kind, ref.id);
  if (!c.exists(keep)) return { ok: false, refused: '上一版的文件不在了，没法回滚。' };
  try {
    if (ref.kind === 'skill') {
      const dest = join(c.userRoot, 'skills', ref.id);
      const kernelDest = join(c.kernelHome, 'skills', ref.id);
      if (c.exists(dest)) c.removePath(dest);
      c.copyDir(keep, dest);
      if (c.exists(kernelDest)) c.removePath(kernelDest);
      c.copyDir(dest, kernelDest);
    } else if (ref.kind === 'expert') {
      c.writeText(
        join(c.userRoot, 'agents', `${ref.id}.toml`),
        c.io.readText(join(keep, `${ref.id}.toml`)) ?? '',
      );
    } else {
      const prev = parseConnectorStore(
        `{"connectors":[${c.io.readText(join(keep, 'connector.json')) ?? ''}]}`,
      ).connectors[0];
      if (prev === undefined) return { ok: false, refused: '上一版的记录读不出来，没法回滚。' };
      const storePath = join(c.userRoot, 'connectors.json');
      const store = upsertConnector(parseConnectorStore(c.io.readText(storePath)), prev);
      c.writeText(storePath, serializeConnectorStore(store));
      await syncMcp(ports, store);
    }
    c.removePath(keep);
  } catch (error: unknown) {
    return {
      ok: false,
      refused: `没能回滚：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const { previous, ...rest } = installed;
  writeHubState(
    ports,
    upsertInstalled(state, {
      ...rest,
      version: previous.version,
      level: previous.level,
      network: previous.network,
      commands: previous.commands,
      hooks: previous.hooks,
      // 回滚到的那一版之后的新版，下次刷新还会被判成「静默更新」—— 记下来挡住它
      heldVersion: installed.version,
      heldReason: '你回滚过这个版本',
    }),
  );
  return { ok: true };
}

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

const TEXT_EXT = /\.(md|json|py|mjs|cjs|js|ts|toml|txt|yml|yaml|sh|ps1|bat|html|css|csv)$/i;

function toAuditFiles(files: readonly TarFile[]): readonly AuditFile[] {
  return files.map((f) =>
    TEXT_EXT.test(f.path)
      ? { relativePath: f.path, text: Buffer.from(f.bytes).toString('utf8') }
      : { relativePath: f.path },
  );
}

function writeFiles(c: CatalogPorts, dir: string, files: readonly TarFile[]): void {
  for (const f of files) {
    const full = join(dir, ...f.path.split('/'));
    c.mkdirp(join(full, '..'));
    c.writeBytes(full, f.bytes);
  }
}

function formatTime(sec: number): string {
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
