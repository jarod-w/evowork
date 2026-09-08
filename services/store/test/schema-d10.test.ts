/**
 * 本机 14 张表不许长出 user_id（Q31=A / D10）。
 *
 * 扫 schema 定义，不是扫某几张表。`automation.tenant_id` 是既有列，单独放过。
 * 往别的表加 tenant_id / 任何表加 user_id，这条就会红。
 */
import { describe, expect, it } from 'vitest';

import { TABLES } from '../src/schema.js';

describe('D10：账号不是数据归属主体', () => {
  it('任何表都不出现 user_id 列', () => {
    for (const table of TABLES) {
      const ddl = table.ddl.join('\n');
      expect(ddl, `${table.name} 出现了 user_id`).not.toMatch(/\buser_id\b/i);
    }
  });

  it('tenant_id 只出现在 automation（既有列），别的表不许再加', () => {
    const withTenant = TABLES.filter((table) => table.ddl.join('\n').match(/\btenant_id\b/i)).map(
      (t) => t.name,
    );
    expect(withTenant).toEqual(['automation']);
  });
});
