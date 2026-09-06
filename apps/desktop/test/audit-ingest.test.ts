/**
 * hook 的审计 JSONL → `audit_log` 表（10 §6）。
 *
 * 这条链路 2026-09-06 之前**整个不存在**：hook 在产出记录并写向
 * `EVOWORK_AUDIT_LOG`，而没有任何一处设置那个环境变量，`audit_log` 也没有读写方。
 * 10 §6 的原则 6「审计对用户可见，不只对管理员」当时是"既不写也不读"。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { ensureAuditLog, ingestAuditLog, parseRecord } from '../src/main/audit-ingest.js';

function logFile(lines: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'evowork-audit-')), 'audit.jsonl');
  writeFileSync(path, lines.join('\n'));
  return path;
}

describe('搬运', () => {
  it('每行一条搬进去，然后**清空文件**', () => {
    const path = logFile([
      JSON.stringify({ occurredAt: 1, action: 'tool.pre', toolName: 'shell' }),
      JSON.stringify({ occurredAt: 2, action: 'permission.decided', approvalResult: 'accept' }),
    ]);
    const insert = vi.fn(() => 2);

    expect(ingestAuditLog({ path, insert })).toBe(2);
    expect(insert).toHaveBeenCalledWith([
      { occurredAt: 1, action: 'tool.pre', toolName: 'shell' },
      { occurredAt: 2, action: 'permission.decided', approvalResult: 'accept' },
    ]);
    // 不清空的话，同一条记录会随每次读入库一次
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  /*
   * **插入失败时不能截断。** 反过来的话一次插入失败就永久丢掉这一批 ——
   * 而审计是那种"丢了没人会立刻发现、需要时才发现没有"的数据。
   */
  it('插入失败时保留文件，下次还能再搬一次', () => {
    const line = JSON.stringify({ occurredAt: 1, action: 'tool.pre' });
    const path = logFile([line]);
    const insert = vi.fn(() => {
      throw new Error('db locked');
    });

    expect(ingestAuditLog({ path, insert })).toBe(0);
    expect(readFileSync(path, 'utf8')).toContain('tool.pre');
  });

  it('文件不存在 / 是空的都返回 0，不报错', () => {
    expect(ingestAuditLog({ path: '/nope/audit.jsonl', insert: () => 0 })).toBe(0);
    expect(ingestAuditLog({ path: logFile([]), insert: () => 0 })).toBe(0);
  });

  it('认不出来的行跳过，但**记一条计数**（不记那行的内容）', () => {
    const warn = vi.fn();
    const path = logFile([
      '{ 半行 JSON',
      JSON.stringify({ occurredAt: 1, action: 'tool.pre' }),
      JSON.stringify({ action: '没有时间戳' }),
    ]);
    const inserted: unknown[][] = [];
    ingestAuditLog({
      path,
      insert: (r) => {
        inserted.push([...r]);
        return r.length;
      },
      logger: { warn, info: vi.fn() } as never,
    });

    expect(inserted[0]).toHaveLength(1);
    const skipped = warn.mock.calls.find((c) => c[0] === 'audit.ingest.skipped_lines');
    expect(skipped?.[1]).toEqual({ count: 2 });
    // Q14：半行 JSON 里可能有任何东西，**不许把它记进日志**
    expect(JSON.stringify(warn.mock.calls)).not.toContain('半行');
  });

  it('ensureAuditLog 建出文件 —— hook 用 appendFileSync，父目录必须在', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'evowork-audit-')), 'audit.jsonl');
    ensureAuditLog(path);
    expect(readFileSync(path, 'utf8')).toBe('');
  });
});

describe('一行 JSON → 一条记录', () => {
  /*
   * **逐字段挑，不 `{...parsed}`。** hook 那侧随时可能加字段，而 Q14 的红线
   * 正是"别让没登记过的东西进到落盘路径上"。
   */
  it('未登记的字段不会被带进库里', () => {
    const record = parseRecord(
      JSON.stringify({
        occurredAt: 1,
        action: 'tool.pre',
        promptText: '用户的原话',
        futureField: 'x',
      }),
    );
    expect(record).toEqual({ occurredAt: 1, action: 'tool.pre' });
    expect(JSON.stringify(record)).not.toContain('用户的原话');
  });

  it('缺时间或缺分类的行认不出来 —— 排不了序、也不知道它是什么', () => {
    expect(parseRecord(JSON.stringify({ action: 'tool.pre' }))).toBeUndefined();
    expect(parseRecord(JSON.stringify({ occurredAt: 1 }))).toBeUndefined();
    expect(parseRecord('不是 JSON')).toBeUndefined();
  });

  it('类型不对的字段当作没有，而不是强转', () => {
    // exitCode 是字符串 "0" 时不能变成数字 0：那会让"没有退出码"和"退出码 0"混为一谈
    const record = parseRecord(
      JSON.stringify({ occurredAt: 1, action: 'tool.post', exitCode: '0' }),
    );
    expect(record?.exitCode).toBeUndefined();
  });
});
