/**
 * 更新清单的验签（在线升级提案 §4 B3；总纲 Q46 与 D9 的 K6 登记「完整性」一行）。
 *
 * ## 为什么要自己签
 *
 * `latest-mac.yml` 里的 sha512 和安装包放在同一台服务器上：它只证明文件没传坏，
 * 证明不了文件是我们发的。没有 Developer ID 之前，系统签名也帮不上忙；而应用内下载的
 * 文件不带 quarantine 标记，Gatekeeper 根本不会去看它（提案 §7 实测）。
 * 所以**这里是唯一的真实性校验**，不是锦上添花：验不过就不往下走，没有「仍然下载」。
 *
 * ## 格式（与 `scripts/update-signing.mjs` 的 `signManifest` 逐字节对齐）
 *
 * 签名放在清单同目录的 `signatures/<清单原始字节的 sha256>.sig`（`signatureNameFor`）。
 * 按内容命名是为了上传顺序：同名覆盖时，两次上传之间拉到「新清单 + 旧签名」的客户端会验签失败，
 * CDN 缓存还会把这个窗口拉长；按内容命名后拿到哪份清单就取哪份签名，旧签名从不删除。内容是：
 *
 * ```json
 * { "alg": "ES256", "kid": "evowork-update-1", "signature": "<base64url，P1363 的 r||s，64 字节>" }
 * ```
 *
 * 签的是清单文件的**原始字节**，不是解析后再序列化的东西（同 `packages/account` 的策略包：
 * 两边各序列化一次会在键序或空格上分叉，表现是「刚签的清单自己验不过」）。
 * 两边对不对得上由 `scripts/test/update-signing.test.mjs` 守着 —— 它用真的签名脚本签、
 * 用这里的函数验。
 *
 * 只做验签，不出网、不解析 yml：先验过，再相信清单里的任何一个字。
 */
import { createHash, createPublicKey, verify, type JsonWebKey } from 'node:crypto';

/** 客户端信任的一把公钥。`role` 区分日常与离线备用（B3：2026-10-02 定为两把） */
export interface UpdatePublicKey {
  readonly kid: string;
  readonly role: 'daily' | 'backup';
  readonly jwk: JsonWebKey;
}

export type UpdateManifestVerifyFailure =
  /** 客户端一把公钥都没有 —— 打包时漏了，不是网络问题 */
  | 'no-keys'
  /** `.sig` 不是我们认识的格式（不是 JSON、算法不对、长度不对） */
  | 'malformed-signature'
  /** 签名用的那把 key 我们不认识 */
  | 'unknown-key'
  /** 认识那把 key，但签名对不上：清单被改过，或者不是我们签的 */
  | 'bad-signature';

export type UpdateManifestVerifyResult =
  | { readonly ok: true; readonly kid: string; readonly role: UpdatePublicKey['role'] }
  | { readonly ok: false; readonly reason: UpdateManifestVerifyFailure };

/** 这份清单的签名文件名（相对清单所在目录的 `signatures/`）。与发版脚本的同名函数必须算出同一个 */
export function signatureNameFor(manifest: Uint8Array | string): string {
  const bytes = typeof manifest === 'string' ? Buffer.from(manifest, 'utf8') : manifest;
  return `${createHash('sha256').update(bytes).digest('hex')}.sig`;
}

/** ES256 的 P1363 签名固定 64 字节，base64url 不带填充是 86 个字符 */
const P1363_BASE64URL_LENGTH = 86;

export function verifyUpdateManifest(
  manifest: Uint8Array | string,
  signatureFile: string,
  keys: readonly UpdatePublicKey[],
): UpdateManifestVerifyResult {
  if (keys.length === 0) return { ok: false, reason: 'no-keys' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(signatureFile);
  } catch {
    return { ok: false, reason: 'malformed-signature' };
  }
  const envelope = parsed as { alg?: unknown; kid?: unknown; signature?: unknown };
  if (
    envelope.alg !== 'ES256' ||
    typeof envelope.kid !== 'string' ||
    typeof envelope.signature !== 'string' ||
    envelope.signature.length !== P1363_BASE64URL_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(envelope.signature)
  ) {
    return { ok: false, reason: 'malformed-signature' };
  }

  const key = keys.find((candidate) => candidate.kid === envelope.kid);
  if (!key) return { ok: false, reason: 'unknown-key' };

  let valid = false;
  try {
    valid = verify(
      'sha256',
      typeof manifest === 'string' ? Buffer.from(manifest, 'utf8') : manifest,
      { key: createPublicKey({ key: key.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(envelope.signature, 'base64url'),
    );
  } catch {
    valid = false;
  }
  return valid
    ? { ok: true, kid: key.kid, role: key.role }
    : { ok: false, reason: 'bad-signature' };
}
