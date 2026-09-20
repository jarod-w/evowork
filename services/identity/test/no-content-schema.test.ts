/**
 * 管理端 / 目录返回类型没有任务 · 产物 · prompt（11 §12 第 15 条）。
 * 云端库可以有 tenant_id —— 那是身份面。禁止的是内容面列。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { IDENTITY_DDL } from '../src/schema.js';

const FORBIDDEN = ['thread_id', 'threadId', 'prompt', 'artifact', 'workspace', 'title', 'cwd'];

describe('identity schema 没有内容面', () => {
  it('DDL 里没有任务 / 产物 / prompt 列', () => {
    const lower = IDENTITY_DDL.toLowerCase();
    const hits = FORBIDDEN.filter((word) => lower.includes(word.toLowerCase().trim()));
    expect(hits, `identity DDL 出现了内容面列：${hits.join(', ')}`).toEqual([]);
  });

  it('service.ts 的管理端类型没有任务 / 产物 / prompt，用量类型没有按天字段', () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/service.ts'),
      'utf8',
    );
    expect(/readonly prompt/.test(src)).toBe(false);
    expect(/readonly threadId/.test(src)).toBe(false);
    expect(/readonly artifact/.test(src)).toBe(false);
    const usageStart = src.indexOf('export interface AdminUsage {');
    expect(usageStart).toBeGreaterThan(0);
    const usageBlock = src.slice(usageStart, src.indexOf('}', usageStart) + 1);
    expect(usageBlock).toMatch(/tenantUsed/);
    expect(usageBlock).not.toMatch(/\bdays\?:/);
    expect(usageBlock).not.toMatch(/\bseries\?:/);
    expect(usageBlock).not.toMatch(/\bbyDay\?:/);
    expect(src).not.toMatch(/GROUP BY\s+([A-Za-z_]+\.)?day\b/i);
  });

  it('邮件通道没有短信发送路径（11 §12 第 19 条）', () => {
    const mailer = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/mailer.ts'),
      'utf8',
    );
    expect(mailer).not.toMatch(/twilio|sendSms|sms\.send/i);
    expect(mailer).toContain('不发送短信');
  });
});
