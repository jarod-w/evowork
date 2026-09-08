/**
 * D10 的机制化第②条：**本机表里不许有 `user_id` / `tenant_id`**（Q31=A，11 §12 第 11 条）。
 *
 * ## 为什么是扫整份 schema，而不是检查某几张表
 *
 * 与 K6 在 `services/ingest` 的整目录扫描是同一条：一份"手工列的表名单"只在
 * 写它的那天是完整的。新增一张表时没人会想起来把它加进名单里，
 * 而那张表恰恰是最可能带上 `user_id` 的（"反正是新表，顺手留个位"）。
 *
 * ## 改坏了的表现
 *
 * 数据归属从"这台机器"漂成"这个账号"。这个方向**去掉比加上难**：
 * 一旦有了 `user_id`，"云端存一份方便跨设备"就成了顺理成章的下一步，
 * 而那会依次推翻 Q17（不做个人云盘）、Q19（团队空间只读）、K6 与 D9 本身（R12）。
 *
 * 2026-09-08 第一次跑这条就抓到了 `automation` 表上两个从没有人读写的列
 * （`tenant_id` / `owner_id`，建表时为"以后有账号"留的位）—— 迁移第 3 版删掉了它们。
 */
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  AUTHORITATIVE_MIGRATIONS,
  ensureMeta,
  PROJECTION_MIGRATIONS,
  type SqliteLike,
} from '../src/migrate.js';
import { AUTHORITATIVE_TABLES, PROJECTION_TABLES } from '../src/schema.js';
import { openStore } from '../src/store.js';

/** 归属类列名。`owner_id` 也在里面：它是 `user_id` 的另一个名字 */
const TENANCY_COLUMNS = ['user_id', 'tenant_id', 'owner_id', 'account_id'];

describe('D10：账号是凭据，不是数据归属主体', () => {
  it('两组 DDL 里一条归属类列都没有', () => {
    const offenders: string[] = [];
    for (const table of [...AUTHORITATIVE_TABLES, ...PROJECTION_TABLES]) {
      for (const ddl of table.ddl) {
        for (const column of TENANCY_COLUMNS) {
          // 词边界：`automation_id` 不该被 `owner_id` 之外的规则误判
          if (new RegExp(`(^|[\\s(,])${column}\\b`).test(ddl)) {
            offenders.push(`${table.name}.${column}`);
          }
        }
      }
    }
    expect(
      offenders,
      `这些表带了归属类列：${offenders.join(', ')}。` +
        '本机数据属于这台机器（automation 的归属靠 device_id），不属于账号 —— ' +
        '见 D10 与 11 §12 第 11 条。要加它必须先回到 D9 / D10 重新决策。',
    ).toEqual([]);
  });

  it('每一个迁移的 up() 也扫一遍 —— 后来加的表同样不许有', () => {
    /*
     * 只扫 `AUTHORITATIVE_TABLES` 会漏掉迁移里现场建的表
     * （第 2 版就是这样自己建了 `project_local` / `project_root`：第 1 版不对老库跑）。
     * 所以这里跑一遍真迁移，然后**问 sqlite 自己**每张表有哪些列 ——
     * 这比读源码可靠：它看到的是真实结果。
     */
    const db = new DatabaseSync(':memory:') as unknown as SqliteLike;
    // 第 2 版要读 `meta`（老键搬迁），真启动时 `openStore` 已经建好了它
    ensureMeta(db);
    for (const migration of [...AUTHORITATIVE_MIGRATIONS, ...PROJECTION_MIGRATIONS]) {
      migration.up(db);
    }
    const tables = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(tables.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const table of tables) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
        (row) => row.name,
      );
      for (const column of columns) {
        if (TENANCY_COLUMNS.includes(column)) offenders.push(`${table}.${column}`);
      }
    }
    expect(offenders, `真实建出来的表带了归属类列：${offenders.join(', ')}`).toEqual([]);
  });

  it('迁移第 3 版把老库里那两列删掉（只改 DDL 不会动已装机器的库）', () => {
    const db = new DatabaseSync(':memory:') as unknown as SqliteLike;
    // 造一个"第 1 版建的老库"：带着那两列
    db.exec(`CREATE TABLE automation (
       id TEXT PRIMARY KEY, tenant_id TEXT, owner_id TEXT, name TEXT NOT NULL,
       device_id TEXT NOT NULL, prompt TEXT NOT NULL, workspaces TEXT NOT NULL,
       schedule TEXT NOT NULL, timezone TEXT NOT NULL, budget_limit INTEGER NOT NULL,
       created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    db.prepare(
      `INSERT INTO automation(id,tenant_id,owner_id,name,device_id,prompt,workspaces,schedule,timezone,budget_limit,created_at,updated_at)
       VALUES('a1','t1','u1','周报','dev1','p','["/w"]','0 9 * * 1','Asia/Shanghai',1,1,1)`,
    ).run();

    const third = AUTHORITATIVE_MIGRATIONS.find((m) => m.version === 3);
    expect(third, '第 3 版迁移不见了 —— 老库里那两列会一直留着').toBeDefined();
    third?.up(db);

    const columns = (db.prepare(`PRAGMA table_info(automation)`).all() as { name: string }[]).map(
      (row) => row.name,
    );
    expect(columns).not.toContain('tenant_id');
    expect(columns).not.toContain('owner_id');
    // **那条定时任务还在**：删列不能顺手删数据（丢了就是丢了定时任务定义）
    expect(db.prepare('SELECT id FROM automation').all()).toEqual([{ id: 'a1' }]);
  });

  it('全新库开出来就没有那两列（走的是新 DDL，不靠迁移补救）', () => {
    const store = openStore({ path: ':memory:' });
    const columns = (
      store.db.prepare(`PRAGMA table_info(automation)`).all() as { name: string }[]
    ).map((row) => row.name);
    expect(columns).not.toContain('tenant_id');
    expect(columns).toContain('device_id');
    store.close();
  });
});
