/**
 * Q39：登出与注销都不碰本机表。数据属于这台机器，不属于账号。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, type Store } from '@evowork/store';
import { describe, expect, it } from 'vitest';

import { createAccountSession, REFRESH_SECRET, type AccountVault } from '../src/main/account.js';

function countRows(store: Store): number {
  const tables = store.db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
    .all() as { name: string }[];
  let total = 0;
  for (const table of tables) {
    const row = store.db.prepare(`SELECT COUNT(*) AS n FROM "${table.name}"`).get() as { n: number };
    total += Number(row.n);
  }
  return total;
}

describe('登出不删本机数据（Q39）', () => {
  it('logout 前后 sqlite 行数相同', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ew-logout-'));
    const store = openStore({ path: join(dir, 'evowork.db') });
    store.db
      .prepare(
        `INSERT INTO artifact (id, path, artifact_type, output_format, title, operation_kind,
                               version, source_signal, file_state, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run('art_keep', join(dir, 'out.docx'), 'document', 'docx', '本地产物', 'create', 1, 'SKILL_REPORT', 'PRESENT', 1);
    const before = countRows(store);
    expect(before).toBeGreaterThan(0);

    const map = new Map<string, string>([[REFRESH_SECRET, 'rt_x']]);
    const vault: AccountVault = {
      get: (name) => map.get(name),
      set: (name, value) => {
        map.set(name, value);
        return true;
      },
      remove: (name) => map.delete(name),
    };
    const session = createAccountSession({
      vault,
      readFlag: () => undefined,
      writeFlag: () => undefined,
      openExternal: async () => undefined,
      identityOrigin: 'https://id.example.com',
      webOrigin: 'https://web.example.com',
    });
    await session.logout();
    expect(countRows(store)).toBe(before);
    store.close();
  });
});
