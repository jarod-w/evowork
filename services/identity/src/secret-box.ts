/**
 * 托管模型的上游 key 只存在 identity。用 AES-256-GCM，密钥来自
 * `EVOWORK_IDENTITY_MASTER_KEY`（32 字节 hex）。没有它就起不来 ——
 * 默认同一个硬编码值等于把租户共享的厂商 key 用公开口令加密。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function parseMasterKey(hex: string): Buffer {
  const buf = Buffer.from(hex.trim(), 'hex');
  if (buf.length !== 32) {
    throw new Error('EVOWORK_IDENTITY_MASTER_KEY 必须是 32 字节 hex');
  }
  return buf;
}

export function encryptSecret(master: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', master, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptSecret(master: Buffer, packed: string): string {
  const [ivB, tagB, ctB] = packed.split('.');
  if (!ivB || !tagB || !ctB) throw new Error('密文损坏');
  const decipher = createDecipheriv('aes-256-gcm', master, Buffer.from(ivB, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString(
    'utf8',
  );
}
