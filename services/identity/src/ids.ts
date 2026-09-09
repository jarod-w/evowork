import { createHash, randomBytes } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** refresh / email token 只存哈希。原文只走一次响应或邮件。 */
export function randomSecret(): string {
  return randomBytes(24).toString('base64url');
}
