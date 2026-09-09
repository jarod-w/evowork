/**
 * 网关 `authenticate` 钩子的 JWT 实现（11 §5.2）。
 *
 * `staticTokenAuth` 必须保留：企业私有部署包是客户自持密钥，不能被强制要求先有我们的账号。
 * 本文件只提供 `hosted` 那一档。`local` / `private` 继续用网关自己的静态比对。
 */
import { verifyAccessToken, type VerifyOptions } from './jwt.js';
import type { AccessClaims } from './claims.js';

export type Authenticate = (authorization: string | undefined) => Promise<boolean> | boolean;

export interface JwtAuthOptions extends VerifyOptions {
  /** 验过之后把 claims 交给调用方（转发、计量）。失败不调用 */
  readonly onClaims?: (claims: AccessClaims) => void;
}

/**
 * `Authorization: Bearer <jwt>` → 验签。缺头 / 前缀不对 / 验不过都是 false，
 * **不区分原因**：区分等于给攻击者一条用户枚举通道。
 */
export function jwtAuth(options: JwtAuthOptions): Authenticate {
  return (authorization) => {
    const token = bearer(authorization);
    if (!token) return false;
    const result = verifyAccessToken(token, options);
    if (!result.ok) return false;
    options.onClaims?.(result.claims);
    return true;
  };
}

export function bearer(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const prefix = 'Bearer ';
  if (!authorization.startsWith(prefix)) return undefined;
  const token = authorization.slice(prefix.length).trim();
  return token.length > 0 ? token : undefined;
}
