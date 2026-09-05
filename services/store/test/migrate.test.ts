import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTHORITATIVE_MIGRATIONS,
  AuthoritativeMigrationFailed,
  PROJECTION_MIGRATIONS,
  dropProjectionTables,
  migrateAuthoritative,
  migrateProjection,
  pruneBackups,
  readMeta,
  restoreFromBackup,
  type Migration,
  type SqliteLike,
} from '../src/migrate.js';
import { AUTHORITATIVE_TABLES, PROJECTION_TABLES } from '../src/schema.js';
import { openStore } from '../src/store.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evowork-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tableNames(db: SqliteLike): string[] {
  return (
    db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name`).all() as {
      name: string;
    }[]
  ).map((r) => r.name);
}

describe('两个迁移器的分工（09 §4.6）', () => {
  it('全新库：两类表都建起来，版本号分别记在 meta 里', () => {
    const store = openStore({ path: join(dir, 'evowork.db') });
    const names = tableNames(store.db);

    for (const t of [...PROJECTION_TABLES, ...AUTHORITATIVE_TABLES]) {
      expect(names).toContain(t.name);
    }
    expect(readMeta(store.db, 'schema_version_projection')).toBe('1');
    expect(readMeta(store.db, 'schema_version_authoritative')).toBe('1');
    store.close();
  });

  it('WAL 已开启（单写者多读者，09 §4）', () => {
    const store = openStore({ path: join(dir, 'evowork.db') });
    const mode = store.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(mode.journal_mode).toBe('wal');
    store.close();
  });

  it('FTS5 可用，且中文能按子串命中（trigram 分词器，06 §3.4）', () => {
    const store = openStore({ path: join(dir, 'evowork.db') });
    store.db
      .prepare(`INSERT INTO library_index(node_id, title, body, meta) VALUES(?,?,?,?)`)
      .run('n1', '季度汇报', '毛利率与欠款风险', '{}');

    const search = (q: string) =>
      (
        store.db
          .prepare(`SELECT node_id FROM library_index WHERE library_index MATCH ?`)
          .all(q) as { node_id: string }[]
      ).map((h) => h.node_id);

    // 中文子串：默认的 unicode61 分词器在这里会返回空（整段是一个 token）
    expect(search('毛利率')).toEqual(['n1']);
    expect(search('欠款风险')).toEqual(['n1']);
    expect(search('季度汇报')).toEqual(['n1']);
    // 不相关的词不命中
    expect(search('现金流量')).toEqual([]);
    store.close();
  });

  it('trigram 的已知限制：**少于 3 个字符查不到** —— 查询层必须回落 LIKE（06 §3.4）', () => {
    const store = openStore({ path: join(dir, 'evowork.db') });
    store.db
      .prepare(`INSERT INTO library_index(node_id, title, body, meta) VALUES(?,?,?,?)`)
      .run('n1', '季度汇报', '毛利率与欠款风险', '{}');

    // 两个字的查询：FTS 侧查不到，这不是 bug，是 trigram 的定义
    const fts = store.db
      .prepare(`SELECT node_id FROM library_index WHERE library_index MATCH ?`)
      .all('毛利') as { node_id: string }[];
    expect(fts).toEqual([]);

    // 回落路径（M8 的搜索实现要走这条）：LIKE 能查到
    const like = store.db
      .prepare(`SELECT node_id FROM library_index WHERE body LIKE ?`)
      .all('%毛利%') as { node_id: string }[];
    expect(like.map((r) => r.node_id)).toEqual(['n1']);
    store.close();
  });

  it('重复打开是幂等的（迁移只跑一次）', () => {
    const path = join(dir, 'evowork.db');
    const first = openStore({ path });
    first.close();
    const second = openStore({ path });
    expect(second.migrations.every((m) => m.applied.length === 0)).toBe(true);
    second.close();
  });

  it('投影表迁移失败 → 丢弃重建、**不阻塞启动**（走真实恢复路径）', () => {
    const store = openStore({ path: join(dir, 'evowork.db') });
    // 投影表里先有点数据，重建应该把它们清掉（它们能从内核重算）
    store.db
      .prepare(`INSERT INTO thread_projection(thread_id, derived_status) VALUES('t1','completed')`)
      .run();

    const failing: Migration = {
      version: 2,
      summary: '故意失败的投影迁移',
      up: () => {
        throw new Error('boom');
      },
    };
    const outcome = migrateProjection(store.db, [...PROJECTION_MIGRATIONS, failing]);

    expect(outcome.rebuilt).toBe(true);
    expect(outcome.warning).toContain('丢弃重建');
    // 表是齐的，App 能继续启动
    const names = tableNames(store.db);
    for (const t of PROJECTION_TABLES) expect(names).toContain(t.name);
    // 数据被清了 —— 这正是"投影类"的定义：真源在内核，下一次对账会补齐
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM thread_projection').get()).toMatchObject({
      n: 0,
    });
    store.close();
  });

  it('投影表重建**不会**碰权威表（09 §4.6 最担心的那件事）', () => {
    const store = openStore({ path: join(dir, 'evowork.db') });
    store.db
      .prepare(
        `INSERT INTO automation(id, name, device_id, prompt, workspaces, schedule, timezone,
           budget_limit, created_at, updated_at)
         VALUES('a1','周报','dev1','生成周报','["/w"]','0 9 * * 1','Asia/Shanghai',200000,1,1)`,
      )
      .run();

    const failing: Migration = {
      version: 2,
      summary: '故意失败',
      up: () => {
        throw new Error('boom');
      },
    };
    migrateProjection(store.db, [...PROJECTION_MIGRATIONS, failing]);

    expect(store.db.prepare('SELECT id FROM automation').all()).toEqual([{ id: 'a1' }]);
    store.close();
  });

  it('dropProjectionTables 只动投影表 —— 绝不碰 automation', () => {
    const store = openStore({ path: join(dir, 'evowork.db') });
    store.db
      .prepare(
        `INSERT INTO automation(id, name, device_id, prompt, workspaces, schedule, timezone,
           budget_limit, created_at, updated_at)
         VALUES('a1','周报','dev1','生成周报','["/w"]','0 9 * * 1','Asia/Shanghai',200000,1,1)`,
      )
      .run();

    dropProjectionTables(store.db);

    const names = tableNames(store.db);
    for (const t of PROJECTION_TABLES) expect(names).not.toContain(t.name);
    for (const t of AUTHORITATIVE_TABLES) expect(names).toContain(t.name);
    const rows = store.db.prepare('SELECT id FROM automation').all() as { id: string }[];
    expect(rows).toEqual([{ id: 'a1' }]);
    store.close();
  });

  it('权威表迁移：迁移失败 → **事务回滚** → 抛错中止启动', () => {
    const path = join(dir, 'evowork.db');
    const store = openStore({ path });
    store.db
      .prepare(
        `INSERT INTO automation(id, name, device_id, prompt, workspaces, schedule, timezone,
           budget_limit, created_at, updated_at)
         VALUES('a1','周报','dev1','生成周报','["/w"]','0 9 * * 1','Asia/Shanghai',200000,1,1)`,
      )
      .run();

    const failing: Migration = {
      version: 2,
      summary: '故意失败的权威迁移',
      up: (db) => {
        // 先做一次破坏性改动，再抛错 —— 这才是回滚真正要救的场景
        db.exec('DELETE FROM automation');
        throw new Error('boom');
      },
    };

    let thrown: unknown;
    try {
      migrateAuthoritative(store.db, {
        dbPath: path,
        checkpoint: (d) => d.exec('PRAGMA wal_checkpoint(TRUNCATE)'),
        migrations: [...AUTHORITATIVE_MIGRATIONS, failing],
      });
    } catch (err) {
      thrown = err;
    }

    // ① 抛错了（启动被刻意中止），且备份文件留下了（"进程被杀"那条路径的凭据）
    expect(thrown).toBeInstanceOf(AuthoritativeMigrationFailed);
    expect((thrown as AuthoritativeMigrationFailed).backupPath).toBe(`${path}.bak.1`);
    expect(existsSync(`${path}.bak.1`)).toBe(true);

    // ② 那条 automation 还在 —— 事务回滚生效。**这是这段代码存在的唯一理由**
    expect(store.db.prepare('SELECT id FROM automation').all()).toEqual([{ id: 'a1' }]);
    expect(readMeta(store.db, 'schema_version_authoritative')).toBe('1');
    store.close();

    // ③ 重开也还在（不是只在内存里看着像回滚了）
    const after = openStore({ path });
    expect(after.db.prepare('SELECT id FROM automation').all()).toEqual([{ id: 'a1' }]);
    after.close();
  });

  it('反例：不走迁移器时那条 automation 真的会没 —— 证明上面的断言不是重言式', () => {
    const path = join(dir, 'evowork.db');
    const store = openStore({ path });
    store.db
      .prepare(
        `INSERT INTO automation(id, name, device_id, prompt, workspaces, schedule, timezone,
           budget_limit, created_at, updated_at)
         VALUES('a1','周报','dev1','生成周报','["/w"]','0 9 * * 1','Asia/Shanghai',200000,1,1)`,
      )
      .run();
    store.db.exec('DELETE FROM automation'); // 没有事务包着
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM automation').get()).toMatchObject({ n: 0 });
    store.close();
  });

  it('restoreFromBackup 用于"上次迁移中途被杀"，且要求连接已关闭', () => {
    const path = join(dir, 'evowork.db');
    const store = openStore({ path });
    store.db
      .prepare(
        `INSERT INTO automation(id, name, device_id, prompt, workspaces, schedule, timezone,
           budget_limit, created_at, updated_at)
         VALUES('a1','周报','dev1','生成周报','["/w"]','0 9 * * 1','Asia/Shanghai',200000,1,1)`,
      )
      .run();
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    copyFileSync(path, `${path}.bak.1`);

    // 模拟"被杀之后留下的坏库"：删掉数据再关闭
    store.db.exec('DELETE FROM automation');
    store.close();

    restoreFromBackup(path, `${path}.bak.1`);

    const after = openStore({ path });
    expect(after.db.prepare('SELECT id FROM automation').all()).toEqual([{ id: 'a1' }]);
    after.close();
  });

  it('新库（from = 0）不备份：没有可丢的东西', () => {
    const path = join(dir, 'evowork.db');
    const store = openStore({ path });
    expect(existsSync(`${path}.bak.0`)).toBe(false);
    expect(store.migrations.find((m) => m.kind === 'authoritative')?.backupPath).toBeUndefined();
    store.close();
  });

  it('pruneBackups 只留最近几个备份', () => {
    const path = join(dir, 'evowork.db');
    for (const v of [1, 2, 3, 4, 5]) writeFileSync(`${path}.bak.${v}`, 'x');
    const removed = pruneBackups(path, [1, 2, 3, 4, 5], 2);
    expect(removed).toHaveLength(3);
    expect(existsSync(`${path}.bak.5`)).toBe(true);
    expect(existsSync(`${path}.bak.4`)).toBe(true);
    expect(existsSync(`${path}.bak.1`)).toBe(false);
  });

  it('AuthoritativeMigrationFailed 的文案说清了发生了什么与为什么中止启动', () => {
    const err = new AuthoritativeMigrationFailed(1, 2, '/tmp/x.bak.1', new Error('boom'));
    expect(err.message).toContain('定时任务定义');
    expect(err.message).toContain('/tmp/x.bak.1');
    // 文案必须与实际行为一致：是事务回滚救的，不是"拷回备份"救的
    expect(err.message).toContain('事务已回滚');
    expect(err.message).not.toContain('已回滚到备份');
  });

  it('内存库不做备份（没有文件可备份），且不因此失败', () => {
    const outcome = migrateAuthoritative(openStore({ path: ':memory:' }).db as SqliteLike, {});
    expect(outcome.backupPath).toBeUndefined();
  });
});

describe('unknown_event —— R2 雷达，且只记形状不记正文', () => {
  it('同一形状聚成一条并累加计数', () => {
    const store = openStore({ path: ':memory:' });
    store.recordUnknownEvent('thread/somethingNew', { threadId: 't1', payload: { a: 1 } }, 1000);
    store.recordUnknownEvent('thread/somethingNew', { threadId: 't2', payload: { a: 2 } }, 2000);

    const rows = store.db
      .prepare('SELECT method, shape, hits, last_seen FROM unknown_event')
      .all() as {
      method: string;
      shape: string;
      hits: number;
      last_seen: number;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hits).toBe(2);
    expect(rows[0]?.last_seen).toBe(2000);
    expect(rows[0]?.shape).toBe('payload:object|threadId:string');
    store.close();
  });

  it('**params 的正文不进库** —— 只有键名与类型', () => {
    const store = openStore({ path: ':memory:' });
    store.recordUnknownEvent('item/newKind', {
      threadId: 't1',
      text: '帮我分析鹏程公司的逾期账款',
    });
    const dump = JSON.stringify(store.db.prepare('SELECT * FROM unknown_event').all());
    expect(dump).not.toContain('鹏程');
    expect(dump).toContain('text:string');
    store.close();
  });
});

describe('item_digest —— 首屏快显缓存（09 §4.2）', () => {
  it('只保留最近 50 条，读回时按 seq 升序', () => {
    const store = openStore({ path: ':memory:' });
    for (let i = 1; i <= 60; i += 1) {
      store.putItemDigest({
        threadId: 't1',
        seq: i,
        itemId: `item-${i}`,
        itemType: 'agentMessage',
        summary: `第 ${i} 条`,
        createdAt: i,
      });
    }
    const rows = store.readItemDigest('t1');
    expect(rows).toHaveLength(50);
    expect(rows[0]?.seq).toBe(11);
    expect(rows.at(-1)?.seq).toBe(60);
    store.close();
  });
});

describe('设备 id（Q15 的绑定依据）', () => {
  it('首次打开生成并持久化，之后保持不变', () => {
    const path = join(dir, 'evowork.db');
    const first = openStore({ path });
    const id = first.deviceId;
    expect(id).toMatch(/^dev_[0-9a-f]{16}$/);
    first.close();

    const second = openStore({ path, deviceId: 'someone-else' });
    expect(second.deviceId).toBe(id); // 已有值不被覆盖
    second.close();
  });
});

describe('transaction', () => {
  it('抛错时回滚', () => {
    const store = openStore({ path: ':memory:' });
    expect(() =>
      store.transaction(() => {
        store.db
          .prepare(
            `INSERT INTO automation(id, name, device_id, prompt, workspaces, schedule, timezone,
               budget_limit, created_at, updated_at)
             VALUES('a1','x','d','p','[]','* * * * *','UTC',1,1,1)`,
          )
          .run();
        throw new Error('nope');
      }),
    ).toThrow('nope');
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM automation').get()).toMatchObject({ n: 0 });
    store.close();
  });
});

describe('文件落地', () => {
  it('close 后收尾 WAL，不留下 -wal 文件让用户以为出错了', () => {
    const path = join(dir, 'evowork.db');
    const store = openStore({ path });
    store.db.prepare(`INSERT INTO meta(key, value) VALUES('x','1')`).run();
    store.close();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path).length).toBeGreaterThan(0);
    expect(existsSync(`${path}-wal`)).toBe(false);
  });
});
