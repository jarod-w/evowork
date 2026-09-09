/**
 * PKCE（RFC 7636）。桌面应用是 public client，没有 client_secret 可藏（11 §5.1）。
 *
 * 只有 S256：`plain` 等于没做。challenge 与 verifier 都是 unpadded base64url。
 */
import { createHash, randomBytes } from 'node:crypto';

const VERIFIER_BYTES = 32;

export function generateCodeVerifier(): string {
  return randomBytes(VERIFIER_BYTES).toString('base64url');
}

export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** verifier 算出的 challenge 是否与登录时提交的那份一致。长度不同也走常量时间比较。 */
export function verifyCodeChallenge(verifier: string, challenge: string): boolean {
  return timingSafeEqual(codeChallengeS256(verifier), challenge);
}
