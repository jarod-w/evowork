import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NextActionStore,
  openStore,
  dropProjectionTables,
  migrateProjection,
} from '../src/index.js';
describe('本机建议权威存储', () => {
  it('旧 v6 库升级后可保存；重启与重建投影不丢关闭状态，也不变成待执行输入', () => {
    const home = mkdtempSync(join(tmpdir(), 'evowork-next-actions-'));
    const path = join(home, 'state.db');
    let store = openStore({ path });
    try {
      store.db.exec(
        "DROP TABLE next_action; UPDATE meta SET value='6' WHERE key='schema_version_authoritative'",
      );
      store.close();
      store = openStore({ path });
      let repo = new NextActionStore(store);
      const actions = [
        {
          id: 'one',
          threadId: 'task',
          sourceTurnId: 'turn',
          title: '验收',
          prompt: '检查交付结果',
        },
      ];
      repo.propose('task', 'turn', actions);
      repo.transition('task', 'turn', 'proposed', 'available');
      repo.transition('task', 'turn', 'available', 'dismissed');
      store.close();
      store = openStore({ path });
      dropProjectionTables(store.db);
      migrateProjection(store.db);
      repo = new NextActionStore(store);
      expect(repo.get('task')).toEqual({ turnId: 'turn', state: 'dismissed', actions });
      expect(store.db.prepare('SELECT * FROM follow_up_queue').all()).toEqual([]);
      repo.remove('task');
      expect(repo.get('task')).toBeUndefined();
    } finally {
      store.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
