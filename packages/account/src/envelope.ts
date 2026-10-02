/**
 * 签名信封：`{ payloadJson, signature, kid }`，ES256，签 `payloadJson` 的**原文**。
 *
 * 策略包（11 §7）和插件 Hub 的索引（13 §4.1，HF11「外层直接用策略包的信封，不另造一套」）共用它。
 * 验签方必须对同一段字符串验，再 `JSON.parse` —— 两边各 stringify 一次会在键序或空格上分叉，
 * 表现是「刚签的包自己验不过」。
 *
 * **无网络、无存储。** 这里只管「这段原文是不是这把钥匙签的」，不管 payload 长什么样。
 */
import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

import type { PublicJwk } from './jwt.js';

export interface SignedEnvelope {
  readonly payloadJson: string;
  readonly signature: string;
  readonly kid: string;
}

export type EnvelopeFailure = 'malformed' | 'bad-sig' | 'bad-kid';

export function signEnvelope(privatePem: string, payloadJson: string, kid: string): SignedEnvelope {
  const signature = sign('sha256', Buffer.from(payloadJson, 'utf8'), {
    key: createPrivateKey(privatePem),
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return { payloadJson, signature, kid };
}

/**
 * 只验签。`jwk.kid` 有值时必须与信封的 `kid` 相同。
 * 返回 `true` 只说明「这段原文是这把钥匙签的」，payload 的形状由调用方再判。
 */
export function verifyEnvelopeSignature(
  envelope: SignedEnvelope,
  options: { readonly publicPem?: string | undefined; readonly jwk?: PublicJwk | undefined },
): { readonly ok: true } | { readonly ok: false; readonly reason: EnvelopeFailure } {
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
  let key: KeyObject | undefined;
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
  try {
    const ok = verify(
      'sha256',
      Buffer.from(envelope.payloadJson, 'utf8'),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(envelope.signature, 'base64url'),
    );
    return ok ? { ok: true } : { ok: false, reason: 'bad-sig' };
  } catch {
    return { ok: false, reason: 'bad-sig' };
  }
}

export function parseSignedEnvelope(input: unknown): SignedEnvelope | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  const payloadJson = typeof rec.payloadJson === 'string' ? rec.payloadJson : undefined;
  const signature = typeof rec.signature === 'string' ? rec.signature : undefined;
  const kid = typeof rec.kid === 'string' ? rec.kid : undefined;
  if (!payloadJson || !signature || !kid) return undefined;
  return { payloadJson, signature, kid };
}
