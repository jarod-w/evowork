/**
 * @evowork/account —— 账号协议（11 §5.3）。
 *
 * **无网络、无存储、无 Electron。** 签发在 identity，验签在 gateway，PKCE 在桌面主进程。
 */
export {
  ACCESS_CLAIM_KEYS,
  ACCESS_TTL_SEC,
  CLOCK_SKEW_SEC,
  isRole,
  parseAccessClaims,
  QUOTA_CLASSES,
  REFRESH_TTL_SEC,
  ROLES,
  type AccessClaimKey,
  type AccessClaims,
  type QuotaClass,
  type Role,
} from './claims.js';
export {
  DEFAULT_KID,
  generateEs256KeyPair,
  JWT_ALG,
  JWT_TYP,
  signAccessToken,
  toJwks,
  verifyAccessToken,
  type Es256KeyPair,
  type Jwks,
  type JwtHeader,
  type VerifyFailure,
  type VerifyOptions,
  type VerifyResult,
} from './jwt.js';
export {
  codeChallengeS256,
  generateCodeVerifier,
  timingSafeEqual,
  verifyCodeChallenge,
} from './pkce.js';
export {
  METERING_KEYS,
  meteringDayUtc,
  parseMeteringDay,
  type MeteringDay,
  type MeteringKey,
} from './metering.js';
export { bearer, jwtAuth, type Authenticate, type JwtAuthOptions } from './auth.js';
