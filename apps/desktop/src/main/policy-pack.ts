/**
 * 本机策略包通道（M10c / 11 §7 / R11）。
 *
 * identity 签名 → 本机验签 + 有效期 → 写 `requirements.toml`。
 * **不另开下发通道**：模型锁定仍走网关已经在读的那一段。
 *
 * 未登录不向 identity 发任何请求（11 §12 第 14 条）。离线用上次缓存的
 * JWKS 验本地信封。验不过就不写 `requirements.toml`。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  evaluatePolicyPack,
  parsePolicyPackEnvelope,
  POLICY_EXPIRED_COPY,
  POLICY_EXPIRING_COPY,
  policyPackToRequirementsToml,
  verifyPolicyPack,
  type PolicyPackEnvelope,
  type PolicyPackPayload,
  type PublicJwk,
} from '@evowork/account';
import type { Logger } from '@evowork/logging';

export interface PolicyPackView {
  readonly status: 'none' | 'valid' | 'expiring' | 'expired';
  readonly expiresAt?: number | undefined;
  readonly message?: string | undefined;
  readonly disableShare: boolean;
  readonly disableSlots: boolean;
  readonly forceAudit: boolean;
  readonly allowManagedHooksOnly: boolean;
  readonly disabledProfiles: readonly string[];
  readonly allowCustomModels: boolean;
}

export const EMPTY_POLICY_VIEW: PolicyPackView = {
  status: 'none',
  disableShare: false,
  disableSlots: false,
  forceAudit: false,
  allowManagedHooksOnly: false,
  disabledProfiles: [],
  allowCustomModels: true,
};

export interface SyncPolicyDeps {
  readonly home: string;
  readonly requirementsPath: string;
  readonly identityOrigin?: string | undefined;
  readonly accessJwt?: string | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly nowSec?: number | undefined;
  readonly logger?: Logger | undefined;
}

export function policyPackCachePaths(home: string): {
  readonly envelope: string;
  readonly jwks: string;
} {
  return {
    envelope: join(home, 'policy-pack.json'),
    jwks: join(home, 'jwks.json'),
  };
}

export async function syncEnterprisePolicy(deps: SyncPolicyDeps): Promise<PolicyPackView> {
  const paths = policyPackCachePaths(deps.home);
  const fetchFn = deps.fetchFn ?? fetch;
  let envelope = readEnvelope(paths.envelope);
  let jwks = readJwks(paths.jwks);

  const signedIn = Boolean(deps.accessJwt && deps.identityOrigin);
  if (signedIn && deps.identityOrigin && deps.accessJwt) {
    const origin = deps.identityOrigin;
    const auth = { authorization: `Bearer ${deps.accessJwt}` };
    try {
      const jwksRes = await fetchFn(`${origin}/v1/jwks`);
      if (jwksRes.ok) {
        const body = (await jwksRes.json()) as { keys?: PublicJwk[] };
        if (Array.isArray(body.keys) && body.keys[0]) {
          jwks = body.keys;
          writeJson(paths.jwks, { keys: jwks });
        }
      }
    } catch {
      /* 离线：用缓存 */
    }
    try {
      const packRes = await fetchFn(`${origin}/v1/policy-pack`, { headers: auth });
      if (packRes.ok) {
        const body = (await packRes.json()) as { pack?: unknown };
        const parsed = parsePolicyPackEnvelope(body.pack);
        if (parsed) {
          envelope = parsed;
        }
      }
    } catch {
      /* 离线：用本地信封 */
    }
  }

  if (!envelope) return EMPTY_POLICY_VIEW;
  const jwk = (jwks ?? []).find((key) => key.kid === envelope.kid) ?? jwks?.[0];
  if (!jwk) {
    deps.logger?.warn('desktop.policy_pack.no_jwks', { reason: 'NO_JWKS' });
    return EMPTY_POLICY_VIEW;
  }
  const verified = verifyPolicyPack(envelope, { jwk });
  if (!verified.ok) {
    deps.logger?.warn('desktop.policy_pack.bad_sig', { reason: verified.reason });
    return EMPTY_POLICY_VIEW;
  }
  writeJson(paths.envelope, envelope);
  const nowSec = deps.nowSec ?? Math.floor(Date.now() / 1000);
  const kind = evaluatePolicyPack(verified.payload, nowSec);
  if (kind === 'valid' || kind === 'expiring') {
    writeFileSync(deps.requirementsPath, policyPackToRequirementsToml(verified.payload), 'utf8');
  }
  return viewFromPayload(verified.payload, kind);
}

export function viewFromPayload(
  payload: PolicyPackPayload,
  kind: 'valid' | 'expiring' | 'expired',
): PolicyPackView {
  return {
    status: kind,
    expiresAt: payload.expiresAt,
    ...(kind === 'expired'
      ? { message: POLICY_EXPIRED_COPY }
      : kind === 'expiring'
        ? { message: POLICY_EXPIRING_COPY }
        : {}),
    disableShare: payload.disableShare,
    disableSlots: payload.disableSlots,
    forceAudit: payload.forceAudit,
    allowManagedHooksOnly: payload.allowManagedHooksOnly,
    disabledProfiles: payload.disabledProfiles,
    allowCustomModels: payload.models.allowCustom,
  };
}

function readEnvelope(path: string): PolicyPackEnvelope | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parsePolicyPackEnvelope(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  } catch {
    return undefined;
  }
}

function readJwks(path: string): PublicJwk[] | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { keys?: PublicJwk[] };
    return Array.isArray(parsed.keys) ? [...parsed.keys] : undefined;
  } catch {
    return undefined;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}
