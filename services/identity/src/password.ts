/**
 * argon2id（11 §13.8）。参数可注入，测试用更小的内存以免整仓变慢。
 *
 * 编码是 PHC 字符串。写进库的永远是哈希，引导配置里的明文密码只在「0 个 admin」
 * 那一次被读，立刻变成这一串。
 */
import { argon2id } from '@noble/hashes/argon2.js';
import { randomBytes } from '@noble/hashes/utils.js';

export interface ArgonParams {
  readonly t: number;
  readonly m: number;
  readonly p: number;
  readonly dkLen: number;
}

/** 测试默认。生产在 `main.ts` 换成 OWASP 的 19MiB。 */
export const TEST_ARGON: ArgonParams = { t: 1, m: 4096, p: 1, dkLen: 32 };
export const PROD_ARGON: ArgonParams = { t: 2, m: 19456, p: 1, dkLen: 32 };

export function hashPassword(password: string, params: ArgonParams = TEST_ARGON): string {
  const salt = randomBytes(16);
  const hash = argon2id(password, salt, params);
  return [
    '$argon2id$v=19',
    `m=${params.m},t=${params.t},p=${params.p}`,
    Buffer.from(salt).toString('base64url'),
    Buffer.from(hash).toString('base64url'),
  ].join('$');
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split('$');
  // ['', 'argon2id', 'v=19', 'm=..', salt, hash]
  if (parts.length !== 6 || parts[1] !== 'argon2id') return false;
  const paramPart = parts[3] ?? '';
  const m = Number(/m=(\d+)/.exec(paramPart)?.[1]);
  const t = Number(/t=(\d+)/.exec(paramPart)?.[1]);
  const p = Number(/p=(\d+)/.exec(paramPart)?.[1]);
  const saltB64 = parts[4];
  const hashB64 = parts[5];
  if (!Number.isFinite(m) || !Number.isFinite(t) || !Number.isFinite(p) || !saltB64 || !hashB64) {
    return false;
  }
  const salt = Buffer.from(saltB64, 'base64url');
  const expected = Buffer.from(hashB64, 'base64url');
  const actual = Buffer.from(argon2id(password, salt, { t, m, p, dkLen: expected.length }));
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}
