/**
 * 签名策略包（11 §7 / R11）。**无网络、无存储。**
 *
 * 签的是 `payloadJson` 这一段**原文**（不是再 canonicalize 一遍）。
 * 验签方必须对同一段字符串验，再 `JSON.parse` —— 两边各 stringify 一次
 * 会在键序或空格上分叉，表现是「刚签的包自己验不过」。
 *
 * 类型里没有能装内容的字段：没有 `threadId` / prompt / 产物。
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

import { CLOCK_SKEW_SEC } from './claims.js';
import { JWT_ALG, type PublicJwk } from './jwt.js';

export const POLICY_PACK_SCHEMA_VER = 1 as const;

/** 11 §8 / 10 §8：超期只读时必须给出恢复路径，原句不能改。 */
export const POLICY_EXPIRED_COPY = '安全策略已过期，已切换为只读模式。请连接企业网络以更新。';

export const POLICY_EXPIRING_COPY = '安全策略即将过期。请连接企业网络以续期。';

export interface PolicyPackModels {
  readonly disabled: readonly string[];
  readonly allowCustom: boolean;
  readonly reason?: string | undefined;
}

export interface PolicyPackPayload {
  readonly schemaVer: typeof POLICY_PACK_SCHEMA_VER;
  readonly tenant: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly graceUntil?: number | undefined;
  readonly models: PolicyPackModels;
  readonly allowManagedHooksOnly: boolean;
  readonly disableShare: boolean;
  readonly disableSlots: boolean;
  readonly forceAudit: boolean;
  readonly disabledProfiles: readonly string[];
}

export interface PolicyPackEnvelope {
  readonly payloadJson: string;
  readonly signature: string;
  readonly kid: string;
}

export type PolicyPackStatusKind = 'valid' | 'expiring' | 'expired';

export type VerifyPackFailure = 'malformed' | 'bad-sig' | 'bad-kid' | 'bad-payload';

export type VerifyPackResult =
  | { readonly ok: true; readonly payload: PolicyPackPayload; readonly payloadJson: string }
  | { readonly ok: false; readonly reason: VerifyPackFailure };

/**
 * 把 payload 编成**唯一**的待签字符串。键序固定；optional 缺席就不出现。
 */
export function encodePolicyPackPayload(payload: PolicyPackPayload): string {
  const models: Record<string, unknown> = {
    disabled: [...payload.models.disabled],
    allowCustom: payload.models.allowCustom,
  };
  if (payload.models.reason !== undefined) models.reason = payload.models.reason;
  const rec: Record<string, unknown> = {
    schemaVer: POLICY_PACK_SCHEMA_VER,
    tenant: payload.tenant,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  };
  if (payload.graceUntil !== undefined) rec.graceUntil = payload.graceUntil;
  rec.models = models;
  rec.allowManagedHooksOnly = payload.allowManagedHooksOnly;
  rec.disableShare = payload.disableShare;
  rec.disableSlots = payload.disableSlots;
  rec.forceAudit = payload.forceAudit;
  rec.disabledProfiles = [...payload.disabledProfiles];
  return JSON.stringify(rec);
}

export function parsePolicyPackPayload(json: string): PolicyPackPayload | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  if (rec.schemaVer !== POLICY_PACK_SCHEMA_VER) return undefined;
  const tenant = asToken(rec.tenant);
  const issuedAt = asUnix(rec.issuedAt);
  const expiresAt = asUnix(rec.expiresAt);
  const models = parseModels(rec.models);
  if (!tenant || issuedAt === undefined || expiresAt === undefined || !models) return undefined;
  if (expiresAt < issuedAt) return undefined;
  const graceUntil = rec.graceUntil === undefined ? undefined : asUnix(rec.graceUntil);
  if (rec.graceUntil !== undefined && graceUntil === undefined) return undefined;
  if (graceUntil !== undefined && graceUntil < expiresAt) return undefined;
  const allowManagedHooksOnly = asBool(rec.allowManagedHooksOnly);
  const disableShare = asBool(rec.disableShare);
  const disableSlots = asBool(rec.disableSlots);
  const forceAudit = asBool(rec.forceAudit);
  const disabledProfiles = asStringList(rec.disabledProfiles);
  if (
    allowManagedHooksOnly === undefined ||
    disableShare === undefined ||
    disableSlots === undefined ||
    forceAudit === undefined ||
    disabledProfiles === undefined
  ) {
    return undefined;
  }
  return {
    schemaVer: POLICY_PACK_SCHEMA_VER,
    tenant,
    issuedAt,
    expiresAt,
    ...(graceUntil !== undefined ? { graceUntil } : {}),
    models,
    allowManagedHooksOnly,
    disableShare,
    disableSlots,
    forceAudit,
    disabledProfiles,
  };
}

export function signPolicyPack(
  privatePem: string,
  payload: PolicyPackPayload,
  kid: string,
): PolicyPackEnvelope {
  const payloadJson = encodePolicyPackPayload(payload);
  const signature = sign('sha256', Buffer.from(payloadJson, 'utf8'), {
    key: createPrivateKey(privatePem),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { payloadJson, signature, kid };
}

export function verifyPolicyPack(
  envelope: PolicyPackEnvelope,
  options: { readonly publicPem?: string | undefined; readonly jwk?: PublicJwk | undefined },
): VerifyPackResult {
  if (
    typeof envelope.payloadJson !== 'string' ||
    typeof envelope.signature !== 'string' ||
    typeof envelope.kid !== 'string' ||
    envelope.payloadJson.length === 0 ||
    envelope.signature.length === 0
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (options.jwk?.kid !== undefined && options.jwk.kid !== envelope.kid) {
    return { ok: false, reason: 'bad-kid' };
  }
  let key;
  try {
    key = options.publicPem
      ? createPublicKey(options.publicPem)
      : options.jwk
        ? createPublicKey({ key: options.jwk, format: 'jwk' } as Parameters<
            typeof createPublicKey
          >[0])
        : undefined;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!key) return { ok: false, reason: 'malformed' };
  let okSig = false;
  try {
    okSig = verify(
      'sha256',
      Buffer.from(envelope.payloadJson, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(envelope.signature, 'base64url'),
    );
  } catch {
    return { ok: false, reason: 'bad-sig' };
  }
  if (!okSig) return { ok: false, reason: 'bad-sig' };
  const payload = parsePolicyPackPayload(envelope.payloadJson);
  if (!payload) return { ok: false, reason: 'bad-payload' };
  return { ok: true, payload, payloadJson: envelope.payloadJson };
}

/**
 * 有效 / 即将过期（宽限内仍执行）/ 超期。
 *
 * `graceUntil` 缺席时，`expiresAt` 一过就是超期。宽限只收紧不放宽：
 * 没有宽限不能把超期读成有效。
 */
export function evaluatePolicyPack(
  payload: PolicyPackPayload,
  nowSec: number,
  clockSkewSec: number = CLOCK_SKEW_SEC,
): PolicyPackStatusKind {
  if (nowSec <= payload.expiresAt + clockSkewSec) return 'valid';
  const grace = payload.graceUntil;
  if (grace !== undefined && nowSec <= grace + clockSkewSec) return 'expiring';
  return 'expired';
}

/**
 * 已验签的 payload → `requirements.toml` 正文。
 *
 * 同时写 `[models]`（网关第②层已经在读）和模板里的 hooks / 权限 / 开关，
 * **不另开下发通道**（11 §7）。
 */
export function policyPackToRequirementsToml(payload: PolicyPackPayload): string {
  const disabled = payload.models.disabled.map(tomlString).join(', ');
  const profiles = payload.disabledProfiles.map(tomlString).join(', ');
  const reasonLine =
    payload.models.reason !== undefined ? `reason = ${tomlString(payload.models.reason)}\n` : '';
  return `# Written by a verified policy pack. Do not edit.
allow_managed_hooks_only = ${tomlBool(payload.allowManagedHooksOnly)}

[models]
disabled = [${disabled}]
allow_custom = ${tomlBool(payload.models.allowCustom)}
${reasonLine}
[permissions]
disabled = [${profiles}]

[evowork]
sharing_enabled = ${tomlBool(!payload.disableShare)}
slots_enabled = ${tomlBool(!payload.disableSlots)}
audit_upload = ${tomlBool(payload.forceAudit)}
`;
}

export function parsePolicyPackEnvelope(input: unknown): PolicyPackEnvelope | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  const payloadJson = typeof rec.payloadJson === 'string' ? rec.payloadJson : undefined;
  const signature = typeof rec.signature === 'string' ? rec.signature : undefined;
  const kid = typeof rec.kid === 'string' ? rec.kid : undefined;
  if (!payloadJson || !signature || !kid) return undefined;
  return { payloadJson, signature, kid };
}

export { JWT_ALG as POLICY_PACK_ALG };

function parseModels(value: unknown): PolicyPackModels | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const rec = value as Record<string, unknown>;
  const disabled = asStringList(rec.disabled);
  const allowCustom = asBool(rec.allowCustom);
  if (disabled === undefined || allowCustom === undefined) return undefined;
  const reason = rec.reason === undefined ? undefined : asReason(rec.reason);
  if (rec.reason !== undefined && reason === undefined) return undefined;
  return {
    disabled,
    allowCustom,
    ...(reason !== undefined ? { reason } : {}),
  };
}

function asToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_:.@-]{1,128}$/.test(value) ? value : undefined;
}

function asUnix(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > 128) return undefined;
    if (/[\n\r]/.test(item)) return undefined;
    out.push(item);
  }
  return out;
}

function asReason(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !/[\n\r]/.test(value)
    ? value
    : undefined;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tomlBool(value: boolean): string {
  return value ? 'true' : 'false';
}
