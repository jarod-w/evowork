/**
 * ES256 JWT 的签发与验签。只用 `node:crypto`，不引 jose ——
 * 账号包要进企业私有部署的最小依赖面（与网关同一条理由）。
 *
 * JWT 要 IEEE P1363 签名（r||s），不是 node 默认的 DER。漏掉 `dsaEncoding`
 * 的表现是「我们签的 token 自己验不过」，而错误体看起来像密钥不匹配。
 */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

import { CLOCK_SKEW_SEC, parseAccessClaims, type AccessClaims } from './claims.js';

export const JWT_ALG = 'ES256';
export const JWT_TYP = 'JWT';
export const DEFAULT_KID = 'evowork-1';

/** JWK 公钥。不用 DOM 的 `JsonWebKey`，这个包的 tsconfig 只有 node types。 */
export interface PublicJwk {
  readonly kty?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
}

export interface Es256KeyPair {
  readonly privatePem: string;
  readonly publicPem: string;
  readonly jwk: PublicJwk;
  readonly kid: string;
}

export interface JwtHeader {
  readonly alg: typeof JWT_ALG;
  readonly typ: typeof JWT_TYP;
  readonly kid: string;
}

export function generateEs256KeyPair(kid: string = DEFAULT_KID): Es256KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as PublicJwk;
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    jwk: { ...jwk, kid, alg: JWT_ALG, use: 'sig' },
    kid,
  };
}

export function signAccessToken(
  privatePem: string,
  claims: AccessClaims,
  kid: string = DEFAULT_KID,
): string {
  const header: JwtHeader = { alg: JWT_ALG, typ: JWT_TYP, kid };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  const sig = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(privatePem),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${sig.toString('base64url')}`;
}

export interface VerifyOptions {
  readonly publicPem?: string | undefined;
  readonly jwk?: PublicJwk | undefined;
  readonly nowSec?: number | undefined;
  readonly clockSkewSec?: number | undefined;
  readonly expectedKid?: string | undefined;
}

export type VerifyResult =
  | { readonly ok: true; readonly claims: AccessClaims }
  | { readonly ok: false; readonly reason: VerifyFailure };

export type VerifyFailure =
  'malformed' | 'bad-alg' | 'bad-kid' | 'bad-sig' | 'expired' | 'not-yet' | 'bad-claims';

export function verifyAccessToken(token: string, options: VerifyOptions): VerifyResult {
  const parts = token.split('.');
  if (
    parts.length !== 3 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    parts[2] === undefined
  ) {
    return { ok: false, reason: 'malformed' };
  }
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    header === null ||
    typeof header !== 'object' ||
    Array.isArray(header) ||
    (header as { alg?: unknown }).alg !== JWT_ALG
  ) {
    return { ok: false, reason: 'bad-alg' };
  }
  const kid = (header as { kid?: unknown }).kid;
  if (options.expectedKid !== undefined && kid !== options.expectedKid) {
    return { ok: false, reason: 'bad-kid' };
  }

  const key = publicKeyFrom(options);
  if (!key) return { ok: false, reason: 'malformed' };
  const signingInput = `${parts[0]}.${parts[1]}`;
  let okSig = false;
  try {
    okSig = verify(
      'sha256',
      Buffer.from(signingInput),
      { key, dsaEncoding: 'ieee-p1363' },
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    return { ok: false, reason: 'bad-sig' };
  }
  if (!okSig) return { ok: false, reason: 'bad-sig' };

  const claims = parseAccessClaims(payload);
  if (!claims) return { ok: false, reason: 'bad-claims' };

  const now = options.nowSec ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSec ?? CLOCK_SKEW_SEC;
  if (claims.exp + skew < now) return { ok: false, reason: 'expired' };
  if (claims.iat - skew > now) return { ok: false, reason: 'not-yet' };
  return { ok: true, claims };
}

function publicKeyFrom(options: VerifyOptions): KeyObject | undefined {
  try {
    if (options.publicPem) return createPublicKey(options.publicPem);
    if (options.jwk) {
      return createPublicKey({
        key: options.jwk,
        format: 'jwk',
      } as Parameters<typeof createPublicKey>[0]);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export type Es256PemProblem = 'missing' | 'private-key' | 'unparseable' | 'not-es256';

export type Es256PemCheck =
  | { readonly ok: true; readonly pem: string }
  | { readonly ok: false; readonly problem: Es256PemProblem };

/**
 * 验签方**启动时**对公钥的体检：它能不能拿来验我们签的令牌。
 *
 * 为什么要单独有这一步：`verifyAccessToken` 把公钥解析失败也当成一次普通的验签失败
 * （上面 `publicKeyFrom` 吞掉异常 → `malformed`），调用方再一律回 401。于是公钥坏了的服务
 * **照常启动、端口在听，每一个合法令牌都被拒**，在外面与"令牌不对"分不开。
 * 2026-09-27 部署分享托管时真发生过：systemd 的 EnvironmentFile 把不带引号的值里的
 * `\n` 吃成了 `n`，所有上传静默 401，而服务看起来一切正常。
 *
 * 所以这里判的是**那一类**"验不了"，不只是"解析不了"：
 *   · `private-key` —— `createPublicKey` 会从私钥里导出公钥，于是它"能用"；
 *     但那等于把签发密钥放到了只该验签的机器上，拿下那台机器就能签任意令牌
 *   · `not-es256` —— 能解析但不是 P-256 的 EC 公钥（RSA、P-384…），每次验签都失败，
 *     与坏公钥是同一个后果
 */
export function checkEs256PublicPem(pem: string | undefined): Es256PemCheck {
  if (pem === undefined || pem.trim() === '') return { ok: false, problem: 'missing' };
  try {
    createPrivateKey(pem);
    return { ok: false, problem: 'private-key' };
  } catch {
    // 不是私钥 —— 正是期望的
  }
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    return { ok: false, problem: 'unparseable' };
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    return { ok: false, problem: 'not-es256' };
  }
  return { ok: true, pem };
}

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export interface Jwks {
  readonly keys: readonly PublicJwk[];
}

export function toJwks(pair: Es256KeyPair): Jwks {
  return { keys: [pair.jwk] };
}
