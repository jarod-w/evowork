/**
 * Hub 索引（13 §4.1）。外层是策略包同一个信封（HF11），这里定义 `payloadJson` 的形状。
 *
 * **解析是白名单式的**：多一个认不出的 `schemaVer`、少一个必填字段、路径里带 `..`，
 * 整份索引都不认（4.5：丢弃这份新索引，继续用缓存）。宁可一次更新不生效，也不能把
 * 一份半懂的索引当真。
 *
 * 结构上守住的两条（不靠管道自觉）：
 * - **没写许可（`NOASSERTION`）的条目只能指向上游的固定提交**，不能指向我们的 CDN（HUB-Q5a=A）。
 * - 内容包路径只能是相对路径、不能出现 `..`。
 */
import {
  signEnvelope,
  verifyEnvelopeSignature,
  type PublicJwk,
  type SignedEnvelope,
} from '@evowork/account';

import { isValidRange, isVersion } from './version.js';

export const HUB_SCHEMA_VER = 1 as const;

export type HubItemKind = 'skill' | 'expert' | 'connector';
export type HubRiskLevel = 'p0' | 'p1' | 'p2';

/** 我们 CDN 上的内容包：`<base>/<sourceId>/<path>`，sha256 是**归档文件**的。 */
export interface HostedPackage {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

/**
 * 上游固定提交（HUB-Q5a=A，没写许可的条目）：用户点安装时客户端直接去上游取。
 * 上游归档的字节不保证稳定（代码托管站重新压缩过），所以校验的是解出来的
 * `subdir` 的**文件树哈希**（`treeSha256`），不是归档的哈希。
 */
export interface UpstreamPackage {
  readonly url: string;
  readonly subdir: string;
  readonly treeSha256: string;
}

export type HubPackage = HostedPackage | UpstreamPackage;

export function isUpstreamPackage(pkg: HubPackage): pkg is UpstreamPackage {
  return 'url' in pkg;
}

export interface HubInterface {
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly defaultPrompt?: string | undefined;
  /** 专家卡片上的示例任务。 */
  readonly sampleTasks?: readonly string[] | undefined;
}

/**
 * 云端的审计结论（13 §4.1 `audit`）。客户端会本地再审一遍（5.3）：
 * `rulesVersion` 相同时结论必须一致，不同时取更严的那个。
 */
export interface HubAudit {
  readonly level: HubRiskLevel;
  readonly rulesVersion: string;
  /** 要访问的域名。 */
  readonly network: readonly string[];
  /** 会执行的命令 / 脚本（相对路径或命令名）。 */
  readonly commands: readonly string[];
  readonly hooks: boolean;
}

export interface HubLicense {
  /** SPDX 表达式；没写许可的是 `NOASSERTION`。 */
  readonly spdx: string;
  readonly upstream?: string | undefined;
  readonly commit?: string | undefined;
  readonly modified?: boolean | undefined;
}

export interface HubItem {
  readonly id: string;
  readonly kind: HubItemKind;
  readonly version: string;
  readonly package: HubPackage;
  readonly minAppVersion?: string | undefined;
  readonly defaultEnabled: boolean;
  /** 进核心层（进 prompt 目录）还是按需层（13 §6）。 */
  readonly promptVisible: boolean;
  readonly interface: HubInterface;
  readonly audit: HubAudit;
  readonly license: HubLicense;
  /** 连接器才有：传输方式。stdio 的任何更新都要重新确认（5.4）。 */
  readonly connector?: { readonly transport: 'stdio' | 'http' | 'sse' } | undefined;
  /** 「新上架」标注用（5.6，只在插件页里）。 */
  readonly publishedAt?: number | undefined;
}

export interface HubRevocation {
  readonly id: string;
  readonly kind?: HubItemKind | undefined;
  /** 范围列表，命中任一即吊销（`matchesRange`）。 */
  readonly versions: readonly string[];
  readonly reason: string;
}

export interface HubIndexPayload {
  readonly schemaVer: typeof HUB_SCHEMA_VER;
  readonly source: { readonly id: string; readonly displayName: string };
  readonly sequence: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly items: readonly HubItem[];
  readonly revoked: readonly HubRevocation[];
}

export type HubIndexEnvelope = SignedEnvelope;

export interface TrustedHubKey {
  readonly kid: string;
  readonly publicPem?: string | undefined;
  readonly jwk?: PublicJwk | undefined;
}

export type VerifyHubIndexResult =
  | { readonly ok: true; readonly payload: HubIndexPayload }
  | { readonly ok: false; readonly reason: 'malformed' | 'bad-sig' | 'bad-kid' | 'bad-payload' };

/* ── 签与验 ─────────────────────────────────────────────────────────────── */

/** 待签字符串：键按字典序，数组保持顺序。签名方只用它；验签方**不**重新编码。 */
export function encodeHubIndexPayload(payload: HubIndexPayload): string {
  return canonicalJson(payload);
}

export function signHubIndex(
  privatePem: string,
  payload: HubIndexPayload,
  kid: string,
): HubIndexEnvelope {
  return signEnvelope(privatePem, encodeHubIndexPayload(payload), kid);
}

/**
 * 按 `kid` 在钉死的公钥列表里找钥匙（4.3：官方源的公钥随 App 分发并钉死）。
 * 列表里没有这个 `kid` = `bad-kid`，不会退而求其次去试别的钥匙。
 */
export function verifyHubIndex(
  envelope: HubIndexEnvelope,
  trusted: readonly TrustedHubKey[],
): VerifyHubIndexResult {
  const key = trusted.find((k) => k.kid === envelope.kid);
  if (key === undefined) return { ok: false, reason: 'bad-kid' };
  const sig = verifyEnvelopeSignature(envelope, {
    ...(key.publicPem !== undefined ? { publicPem: key.publicPem } : {}),
    ...(key.jwk !== undefined ? { jwk: key.jwk } : {}),
  });
  if (!sig.ok) return { ok: false, reason: sig.reason };
  const payload = parseHubIndexPayload(envelope.payloadJson);
  if (payload === undefined) return { ok: false, reason: 'bad-payload' };
  return { ok: true, payload };
}

/* ── 解析 ───────────────────────────────────────────────────────────────── */

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const REL_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const HOST_RE = /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/;
const KINDS: readonly HubItemKind[] = ['skill', 'expert', 'connector'];
const LEVELS: readonly HubRiskLevel[] = ['p0', 'p1', 'p2'];
/** 单个内容包的上限。技能包大多是纯 Markdown，几十 KB；stdio 连接器带依赖也该在这之内。 */
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;

export function parseHubIndexPayload(json: string): HubIndexPayload | undefined {
  const rec = parseObject(json);
  if (rec === undefined || rec.schemaVer !== HUB_SCHEMA_VER) return undefined;
  const source = obj(rec.source);
  const sourceId = source !== undefined ? token(source.id) : undefined;
  const sourceName = source !== undefined ? text(source.displayName, 64) : undefined;
  const sequence = nonNegInt(rec.sequence);
  const issuedAt = unix(rec.issuedAt);
  const expiresAt = unix(rec.expiresAt);
  if (
    sourceId === undefined ||
    sourceName === undefined ||
    sequence === undefined ||
    issuedAt === undefined ||
    expiresAt === undefined ||
    expiresAt <= issuedAt ||
    !Array.isArray(rec.items) ||
    !Array.isArray(rec.revoked)
  ) {
    return undefined;
  }
  const items: HubItem[] = [];
  const seen = new Set<string>();
  for (const raw of rec.items) {
    const item = parseItem(raw);
    if (item === undefined) return undefined;
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    items.push(item);
  }
  const revoked: HubRevocation[] = [];
  for (const raw of rec.revoked) {
    const r = parseRevocation(raw);
    if (r === undefined) return undefined;
    revoked.push(r);
  }
  return {
    schemaVer: HUB_SCHEMA_VER,
    source: { id: sourceId, displayName: sourceName },
    sequence,
    issuedAt,
    expiresAt,
    items,
    revoked,
  };
}

function parseItem(raw: unknown): HubItem | undefined {
  const rec = obj(raw);
  if (rec === undefined) return undefined;
  const id = typeof rec.id === 'string' && ID_RE.test(rec.id) ? rec.id : undefined;
  const kind = KINDS.find((k) => k === rec.kind);
  const version =
    typeof rec.version === 'string' && isVersion(rec.version) ? rec.version : undefined;
  const pkg = parsePackage(rec.package);
  const iface = parseInterface(rec.interface);
  const audit = parseAudit(rec.audit);
  const license = parseLicense(rec.license);
  const defaultEnabled = bool(rec.defaultEnabled);
  const promptVisible = bool(rec.promptVisible);
  if (
    id === undefined ||
    kind === undefined ||
    version === undefined ||
    pkg === undefined ||
    iface === undefined ||
    audit === undefined ||
    license === undefined ||
    defaultEnabled === undefined ||
    promptVisible === undefined
  ) {
    return undefined;
  }
  // HUB-Q5a=A：没写许可的条目只做索引，内容永远不经过我们的 CDN
  if (license.spdx === 'NOASSERTION' && !isUpstreamPackage(pkg)) return undefined;
  let minAppVersion: string | undefined;
  if (rec.minAppVersion !== undefined) {
    if (typeof rec.minAppVersion !== 'string' || !isVersion(rec.minAppVersion)) return undefined;
    minAppVersion = rec.minAppVersion;
  }
  let connector: HubItem['connector'];
  if (kind === 'connector') {
    const c = obj(rec.connector);
    const transport = c?.transport;
    if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') return undefined;
    connector = { transport };
  } else if (rec.connector !== undefined) {
    return undefined;
  }
  let publishedAt: number | undefined;
  if (rec.publishedAt !== undefined) {
    publishedAt = unix(rec.publishedAt);
    if (publishedAt === undefined) return undefined;
  }
  return {
    id,
    kind,
    version,
    package: pkg,
    ...(minAppVersion !== undefined ? { minAppVersion } : {}),
    defaultEnabled,
    promptVisible,
    interface: iface,
    audit,
    license,
    ...(connector !== undefined ? { connector } : {}),
    ...(publishedAt !== undefined ? { publishedAt } : {}),
  };
}

function parsePackage(raw: unknown): HubPackage | undefined {
  const rec = obj(raw);
  if (rec === undefined) return undefined;
  if (rec.url !== undefined) {
    if (rec.path !== undefined || rec.sha256 !== undefined) return undefined;
    const url = typeof rec.url === 'string' ? httpsUrl(rec.url) : undefined;
    const subdir =
      rec.subdir === '' ? '' : typeof rec.subdir === 'string' ? relPath(rec.subdir) : undefined;
    const treeSha256 =
      typeof rec.treeSha256 === 'string' && SHA256_RE.test(rec.treeSha256)
        ? rec.treeSha256
        : undefined;
    if (url === undefined || subdir === undefined || treeSha256 === undefined) return undefined;
    return { url, subdir, treeSha256 };
  }
  const path = typeof rec.path === 'string' ? relPath(rec.path) : undefined;
  const sha256 =
    typeof rec.sha256 === 'string' && SHA256_RE.test(rec.sha256) ? rec.sha256 : undefined;
  const size = nonNegInt(rec.size);
  if (path === undefined || sha256 === undefined || size === undefined) return undefined;
  if (size > MAX_PACKAGE_BYTES || !path.endsWith('.tar.gz')) return undefined;
  return { path, sha256, size };
}

function parseInterface(raw: unknown): HubInterface | undefined {
  const rec = obj(raw);
  if (rec === undefined) return undefined;
  const displayName = text(rec.displayName, 64);
  const description =
    typeof rec.description === 'string' && rec.description.length <= 1024
      ? rec.description
      : undefined;
  const category = text(rec.category, 32);
  if (displayName === undefined || description === undefined || category === undefined) {
    return undefined;
  }
  let defaultPrompt: string | undefined;
  if (rec.defaultPrompt !== undefined) {
    if (typeof rec.defaultPrompt !== 'string' || rec.defaultPrompt.length > 500) return undefined;
    defaultPrompt = rec.defaultPrompt;
  }
  let sampleTasks: string[] | undefined;
  if (rec.sampleTasks !== undefined) {
    if (!Array.isArray(rec.sampleTasks) || rec.sampleTasks.length > 8) return undefined;
    sampleTasks = [];
    for (const t of rec.sampleTasks) {
      const s = text(t, 120);
      if (s === undefined) return undefined;
      sampleTasks.push(s);
    }
  }
  return {
    displayName,
    description,
    category,
    ...(defaultPrompt !== undefined ? { defaultPrompt } : {}),
    ...(sampleTasks !== undefined ? { sampleTasks } : {}),
  };
}

function parseAudit(raw: unknown): HubAudit | undefined {
  const rec = obj(raw);
  if (rec === undefined) return undefined;
  const level = LEVELS.find((l) => l === rec.level);
  const rulesVersion = token(rec.rulesVersion);
  const network = stringList(rec.network, (s) => HOST_RE.test(s));
  const commands = stringList(rec.commands, (s) => s.length <= 200 && !/[\n\r]/.test(s));
  const hooks = bool(rec.hooks);
  if (
    level === undefined ||
    rulesVersion === undefined ||
    network === undefined ||
    commands === undefined ||
    hooks === undefined
  ) {
    return undefined;
  }
  return { level, rulesVersion, network, commands, hooks };
}

function parseLicense(raw: unknown): HubLicense | undefined {
  const rec = obj(raw);
  if (rec === undefined) return undefined;
  const spdx =
    typeof rec.spdx === 'string' && /^[A-Za-z0-9.+() -]{1,128}$/.test(rec.spdx)
      ? rec.spdx
      : undefined;
  if (spdx === undefined) return undefined;
  const upstream = rec.upstream === undefined ? undefined : text(rec.upstream, 300);
  const commit = rec.commit === undefined ? undefined : token(rec.commit);
  const modified = rec.modified === undefined ? undefined : bool(rec.modified);
  if (
    (rec.upstream !== undefined && upstream === undefined) ||
    (rec.commit !== undefined && commit === undefined) ||
    (rec.modified !== undefined && modified === undefined)
  ) {
    return undefined;
  }
  return {
    spdx,
    ...(upstream !== undefined ? { upstream } : {}),
    ...(commit !== undefined ? { commit } : {}),
    ...(modified !== undefined ? { modified } : {}),
  };
}

function parseRevocation(raw: unknown): HubRevocation | undefined {
  const rec = obj(raw);
  if (rec === undefined) return undefined;
  const id = typeof rec.id === 'string' && ID_RE.test(rec.id) ? rec.id : undefined;
  const versions = stringList(rec.versions, isValidRange);
  const reason = text(rec.reason, 200);
  if (id === undefined || versions === undefined || versions.length === 0 || reason === undefined) {
    return undefined;
  }
  let kind: HubItemKind | undefined;
  if (rec.kind !== undefined) {
    kind = KINDS.find((k) => k === rec.kind);
    if (kind === undefined) return undefined;
  }
  return { id, ...(kind !== undefined ? { kind } : {}), versions, reason };
}

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

function parseObject(json: string): Record<string, unknown> | undefined {
  try {
    return obj(JSON.parse(json) as unknown);
  } catch {
    return undefined;
  }
}

function obj(raw: unknown): Record<string, unknown> | undefined {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : undefined;
}

function token(raw: unknown): string | undefined {
  return typeof raw === 'string' && TOKEN_RE.test(raw) ? raw : undefined;
}

function text(raw: unknown, max: number): string | undefined {
  return typeof raw === 'string' && raw.trim() !== '' && raw.length <= max && !/[\n\r]/.test(raw)
    ? raw
    : undefined;
}

function bool(raw: unknown): boolean | undefined {
  return typeof raw === 'boolean' ? raw : undefined;
}

function unix(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

function nonNegInt(raw: unknown): number | undefined {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
}

function stringList(raw: unknown, ok: (s: string) => boolean): readonly string[] | undefined {
  if (!Array.isArray(raw) || raw.length > 200) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item === '' || !ok(item)) return undefined;
    out.push(item);
  }
  return out;
}

function relPath(raw: string): string | undefined {
  if (!REL_PATH_RE.test(raw) || raw.length > 300) return undefined;
  return raw.split('/').some((seg) => seg === '..' || seg === '.') ? undefined : raw;
}

function httpsUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? raw
      : undefined;
  } catch {
    return undefined;
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
