/**
 * 升级兼容：**老版本留在用户机器上的数据 + 现在的代码**（在线升级提案 §4 A2）。
 *
 * 在此之前没有任何测试走过这条路径。迁移测试用的都是「全新库」或「手工拼出来的老库」，
 * 而迁移第 1 版 `createTables` 用的是**当前**的建表语句 —— 全新库永远是最新形状，
 * 于是「有人直接改了 `schema.ts` 的 DDL 却没加迁移」在所有测试里都看不见：
 * 新用户没事，老用户的库缺一列，第一次用到那一列时才报 `no such column`。
 *
 * 夹具是用**那个版本自己的代码**建出来的（`scripts/build-upgrade-fixture.mjs`，
 * 每张表一行样例），所以这里看到的就是那个版本的用户升级时真正会遇到的库。
 *
 * 发版时要加一份：把 `apps/desktop/package.json` 的版本号改上去之后，
 * `node scripts/build-upgrade-fixture.mjs WORKTREE v<新版本>`。最后一组断言会提醒你。
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AUTHORITATIVE_VERSION,
  LEGACY_WORKSPACES_META_KEY,
  PROJECTION_VERSION,
  openStore,
  readMeta,
  type SqliteLike,
} from '@evowork/store';

import { migrateDefaultPermissions, migrateKernelConfigText } from '../src/main/service-host.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures/upgrade');

interface FixtureMeta {
  readonly name: string;
  readonly ref: string;
  readonly commit: string;
  readonly appVersion: string;
  readonly schema: { readonly authoritative: number; readonly projection: number };
  readonly legacyWorkspaces: readonly string[] | null;
  readonly samples: Record<string, Record<string, unknown>>;
}

const fixtures = readdirSync(FIXTURES, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => {
    const dir = join(FIXTURES, d.name);
    return {
      dir,
      meta: JSON.parse(readFileSync(join(dir, 'FIXTURE.json'), 'utf8')) as FixtureMeta,
    };
  })
  .sort((a, b) => a.meta.name.localeCompare(b.meta.name));

interface Column {
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: unknown;
  readonly pk: number;
}

/**
 * 一个库的表结构：每张表的列（按列名排序）+ 每个索引的定义。
 *
 * 比的是列而不是建表 SQL：`ALTER TABLE ADD COLUMN` 得到的 SQL 文本与把那一列直接写进
 * `CREATE TABLE` 的不一样，列的顺序也不一样，但对读写它的代码没有区别。
 */
function schemaOf(db: SqliteLike): Record<string, unknown> {
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
    .all() as { name: string }[];
  const shape: Record<string, unknown> = {};
  for (const { name } of tables) {
    if (name.startsWith('sqlite_')) continue;
    const columns = (db.prepare(`PRAGMA table_info(${name})`).all() as unknown as Column[])
      .map(({ name: column, type, notnull, dflt_value, pk }) => ({
        column,
        type,
        notnull,
        dflt_value,
        pk,
      }))
      .sort((a, b) => a.column.localeCompare(b.column));
    shape[`table ${name}`] = columns;
  }
  const indexes = db
    .prepare(
      `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`,
    )
    .all() as { name: string; tbl_name: string; sql: string }[];
  for (const index of indexes) {
    shape[`index ${index.name}`] = { on: index.tbl_name, sql: index.sql.replace(/\s+/g, ' ') };
  }
  return shape;
}

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'evowork-upgrade-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

/** 夹具本身不能被改：每条用例拷一份再开 */
function openFixture(dir: string) {
  const path = join(work, 'evowork.db');
  copyFileSync(join(dir, 'evowork.db'), path);
  return openStore({ path, appVersion: '0.0.0-upgrade-test' });
}

describe.each(fixtures)('从 EvoWork $meta.appVersion 升级上来（$meta.name）', ({ dir, meta }) => {
  it('现在的代码打得开，而且两个迁移器都走的是正常路径 —— 不是靠「丢弃重建」兜底', () => {
    const store = openFixture(dir);
    // rebuilt=true 意味着投影迁移在真实老库上失败了，只是被兜底接住：用户的任务索引会被清掉
    expect(store.migrations.filter((m) => m.rebuilt)).toEqual([]);
    expect(readMeta(store.db, 'schema_version_authoritative')).toBe(String(AUTHORITATIVE_VERSION));
    expect(readMeta(store.db, 'schema_version_projection')).toBe(String(PROJECTION_VERSION));
    store.close();
  });

  it('升级后的表结构与全新安装逐列相同 —— 否则就是有人改了建表语句却没加迁移，只有老用户的库缺这一列', () => {
    const upgraded = openFixture(dir);
    const fresh = openStore({ path: join(work, 'fresh.db') });
    expect(schemaOf(upgraded.db)).toEqual(schemaOf(fresh.db));
    upgraded.close();
    fresh.close();
  });

  it('那个版本写下的每一行都还在，现在还存在的每一列值都没变', () => {
    const store = openFixture(dir);
    const lost: string[] = [];
    for (const [table, sample] of Object.entries(meta.samples)) {
      const exists = store.db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table);
      if (!exists) {
        lost.push(`${table}（整张表没了）`);
        continue;
      }
      const columns = new Set(
        (store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
          (c) => c.name,
        ),
      );
      // 被迁移刻意删掉的列（如 v3 删的 automation.tenant_id）不在 columns 里，自然不比
      const kept = Object.entries(sample).filter(([column]) => columns.has(column));
      const where = kept.map(([column]) => `${column} IS ?`).join(' AND ');
      const found = store.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
        .get(...kept.map(([, value]) => value)) as { n: number };
      if (found.n !== 1) lost.push(table);
    }
    expect(lost, '这些表里那个版本写下的那一行没了，或者值被改了').toEqual([]);
    store.close();
  });

  it('内核配置：启动迁移跑第二遍什么都不改，企业会改的网关地址原样保留', () => {
    const original = readFileSync(join(dir, 'config.toml'), 'utf8');
    const once = migrateKernelConfigText(original);
    const twice = migrateKernelConfigText(once.text);
    // 不幂等 = 每次启动都改写一遍用户的配置文件
    expect(twice.changed).toEqual({
      retiredModel: false,
      multiAgentV2: false,
      memories: false,
      retries: false,
      defaultPermissions: false,
    });
    expect(twice.text).toBe(once.text);
    const baseUrl = original.split('\n').find((line) => /^\s*base_url\s*=/.test(line));
    expect(baseUrl, '夹具的配置里应当有网关地址').toBeDefined();
    expect(once.text.split('\n')).toContain(baseUrl);
  });
});

describe.each(fixtures.filter((f) => f.meta.legacyWorkspaces !== null))(
  '从 EvoWork $meta.appVersion 升级上来：工作空间（那时还没有项目表）',
  ({ dir, meta }) => {
    it('存在 meta 里的工作空间路径被搬成了项目，旧键不留（两处真源会分叉）', () => {
      const store = openFixture(dir);
      const roots = (
        store.db.prepare(`SELECT path FROM project_root ORDER BY path`).all() as { path: string }[]
      ).map((r) => r.path);
      for (const path of meta.legacyWorkspaces ?? []) expect(roots).toContain(path);
      expect(readMeta(store.db, LEGACY_WORKSPACES_META_KEY)).toBeUndefined();
      store.close();
    });
  },
);

/** TOML 根键：第一个 `[table]` 之前的 `key = value` */
function rootKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1];
    if (key) keys.push(key);
  }
  return keys;
}

describe.each(fixtures)('从 EvoWork $meta.appVersion 升级上来：内核配置的根键', ({ dir }) => {
  /*
   * 判的是「模板的根键 ⊆ 迁移后老配置的根键」这一类，不是 default_permissions 这一个：
   * `ensureKernelConfig` 不覆盖已有文件，模板里新加的根键只有靠迁移才到得了老用户那里，
   * 而根键缺了**不是回退默认值** —— 2026-10-02 实测，0.0.1 / 0.0.2 的配置缺 default_permissions，
   * 现在的内核对 config/read、plugin/list 等四个方法直接回 -32603。
   * 以后往模板加根键却没写迁移，同样会在这里红。
   */
  it('现在模板里的每一个根键，老配置迁移后都有 —— 缺了根键内核会拒绝整份配置', () => {
    const template = readFileSync(join(HERE, '../../../config/config.toml.template'), 'utf8');
    const migrated = migrateKernelConfigText(readFileSync(join(dir, 'config.toml'), 'utf8')).text;
    const have = new Set(rootKeys(migrated));
    expect(rootKeys(template).filter((key) => !have.has(key))).toEqual([]);
  });
});

describe('migrateDefaultPermissions 的边界', () => {
  const OURS = [
    'model = "x"',
    '',
    '[permissions.evowork-workspace]',
    'extends = ":workspace"',
    '',
  ].join('\n');

  it('补在第一个 [table] 之前 —— 写进表里内核同样会拒绝整份配置', () => {
    const { text, changed } = migrateDefaultPermissions(OURS);
    expect(changed).toBe(true);
    expect(rootKeys(text)).toContain('default_permissions');
    expect(text).toContain('default_permissions = "evowork-workspace"');
  });

  it('根上已经有（包括企业设成了别的档位）：一个字都不改', () => {
    const enterprise = `default_permissions = "corp-locked"\n${OURS}`;
    expect(migrateDefaultPermissions(enterprise)).toEqual({ text: enterprise, changed: false });
  });

  it('企业换成了自己的档位、又没设根键：不替他们选 —— 选了就是把默认权限改成一个他们没写的档', () => {
    const custom = '[permissions.corp-locked]\nextends = ":read-only"\n';
    expect(migrateDefaultPermissions(custom)).toEqual({ text: custom, changed: false });
  });
});

describe('夹具的覆盖面', () => {
  const desktop = JSON.parse(readFileSync(join(HERE, '../package.json'), 'utf8')) as {
    version: string;
  };

  it('当前版本号一定有一份夹具 —— 发版时漏生成，下一次升级就没有这一版的老库可验', () => {
    expect(
      fixtures.map((f) => f.meta.appVersion),
      `发版前跑：node scripts/build-upgrade-fixture.mjs WORKTREE v${desktop.version}`,
    ).toContain(desktop.version);
  });

  it('FIXTURE.json 记的 schema 版本就是库里写的那个 —— 夹具没被手工改过', () => {
    for (const { dir, meta } of fixtures) {
      const path = join(work, `${meta.name}.db`);
      copyFileSync(join(dir, 'evowork.db'), path);
      // 只读地看一眼 meta，不能用 openStore（它会迁移）
      const raw = new DatabaseSync(path, { readOnly: true }) as unknown as SqliteLike;
      expect({
        authoritative: Number(readMeta(raw, 'schema_version_authoritative')),
        projection: Number(readMeta(raw, 'schema_version_projection')),
      }).toEqual(meta.schema);
      (raw as unknown as { close(): void }).close();
    }
  });
});
