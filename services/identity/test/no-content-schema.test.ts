/**
 * 管理端 / 目录返回类型没有任务 · 产物 · prompt（11 §12 第 15 条）。
 * 云端库可以有 tenant_id —— 那是身份面。禁止的是内容面列。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { IDENTITY_DDL } from '../src/schema.js';

const FORBIDDEN = [
  'thread_id',
  'threadId',
  'prompt',
  'artifact',
  'workspace',
  'title',
  'cwd',
  'password ',
];

describe('identity schema 没有内容面', () => {
  it('DDL 里没有任务 / 产物 / prompt 列', () => {
    const lower = IDENTITY_DDL.toLowerCase();
    const hits = FORBIDDEN.filter((word) => lower.includes(word.toLowerCase().trim()));
    expect(hits, `identity DDL 出现了内容面列：${hits.join(', ')}`).toEqual([]);
  });

  it('service.ts 的 AdminMember / PublicModel 没有那些字段', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/service.ts'), 'utf8');
    expect(/readonly prompt/.test(src)).toBe(false);
    expect(/readonly threadId/.test(src)).toBe(false);
    expect(/readonly artifact/.test(src)).toBe(false);
  });

  it('邮件通道没有短信发送路径（11 §12 第 19 条）', () => {
    const mailer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../src/mailer.ts'), 'utf8');
    expect(mailer).not.toMatch(/twilio|sendSms|sms\.send/i);
    expect(mailer).toContain('不发送短信');
  });
});
