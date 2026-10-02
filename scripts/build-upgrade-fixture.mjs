#!/usr/bin/env node
/**
 * 生成一份升级兼容夹具：**某个版本的 EvoWork 留在用户机器上的数据**（在线升级提案 §4 A2）。
 *
 *   node scripts/build-upgrade-fixture.mjs <git-ref> <name>
 *   node scripts/build-upgrade-fixture.mjs v0.0.1 v0.0.1
 *   node scripts/build-upgrade-fixture.mjs WORKTREE next     # 用工作树里的代码（加新迁移时用）
 *
 * 产物在 `apps/desktop/test/fixtures/upgrade/<name>/`：
 *   · `evowork.db`   —— **用那个版本自己的 `openStore` 建出来的库**，每张表一行样例数据
 *   · `config.toml`  —— 那个版本的内核配置模板（全新安装时 `ensureKernelConfig` 拷过去的就是它）
 *   · `FIXTURE.json` —— 来源（ref / 提交 / App 版本）与写进去的样例行，测试按它逐列核对
 *
 * ## 为什么必须用旧版本自己的代码建库
 *
 * 迁移第 1 版 `createTables` 用的是**当前**的建表语句：全新的库永远是最新形状，
 * 所以「全新库 + 现在的代码」这条路径测不出升级问题。真正的升级路径是
 * 「旧建表语句建的库 + 一串迁移」—— 只要有人直接改了 `schema.ts` 里的 DDL 而没加迁移，
 * 新用户没事、老用户的库就缺一列。只有拿旧代码建出来的库才看得见这件事。
 *
 * 做法：`git archive` 取出那个 ref 的 `services/store` 与它依赖的两个包，用 esbuild 打成一个
 * 生成器跑一次。不 checkout、不动工作树（多个会话共用这一棵工作树）。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const [ref, name] = process.argv.slice(2);
if (!ref || !name) {
  console.error('用法：node scripts/build-upgrade-fixture.mjs <git-ref|WORKTREE> <name>');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const work = mkdtempSync(join(tmpdir(), 'evowork-fixture-'));
const out = join(repo, 'apps/desktop/test/fixtures/upgrade', name);

/*
 * 在旧代码上跑的那一段。**只用 `openStore` 与裸 SQL**：旧版本的 repo API 各不相同，
 * 而建表与迁移都在 `openStore` 里，这就是那个版本的用户第一次打开 App 时发生的事。
 *
 * 样例行按列自省填值（没有 CHECK、没有外键，2026-10-02 核对过 schema.ts）。
 * 值都固定，重跑出来的样例相同。
 */
const GENERATOR = String.raw`
import { openStore } from 'evowork-fixture-store';

const path = process.argv[2];
const store = openStore({ path, deviceId: 'fixture-device' });
const db = store.db;

const WORKSPACE = '/Users/demo/工作';
const KNOWN = {
  device_id: 'fixture-device',
  timezone: 'Asia/Shanghai',
  schedule: '0 9 * * 1',
  workspaces: JSON.stringify([WORKSPACE]),
  path: WORKSPACE,
  title: '用户改过的标题',
  name: '周报',
  prompt: '生成上周的周报',
};

const tables = db
  .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name")
  .all()
  .filter((t) => t.name !== 'meta' && !t.name.startsWith('sqlite_'))
  // FTS5 的影子表由虚拟表自己维护，往里直接写会把索引写坏
  .filter((t, _i, all) => !all.some((v) => /VIRTUAL TABLE/i.test(v.sql ?? '') && t.name.startsWith(v.name + '_')));

function valueFor(table, column, index) {
  const lower = column.name.toLowerCase();
  if (lower in KNOWN) return KNOWN[lower];
  if (lower === 'id') return 'fx-' + table;
  if (lower.endsWith('_id')) return 'fx-' + lower.slice(0, -3);
  if (lower.endsWith('_at') || lower === 'first_seen' || lower === 'last_seen') return 1759000000000 + index;
  const type = (column.type ?? '').toUpperCase();
  if (type.includes('INT')) return index + 1;
  if (type.includes('REAL') || type.includes('FLOA') || type.includes('DOUB')) return index + 0.5;
  return 'fx-' + table + '-' + column.name;
}

const samples = {};
for (const table of tables) {
  const columns = db.prepare('PRAGMA table_info(' + table.name + ')').all();
  const virtual = /VIRTUAL TABLE/i.test(table.sql ?? '');
  // 自增主键让 sqlite 自己给；其余每一列都写，这样升级后能逐列核对
  const written = columns.filter((c) => !(c.pk === 1 && /INTEGER/i.test(c.type) && !virtual));
  const row = {};
  written.forEach((c, i) => (row[c.name] = valueFor(table.name, c, i)));
  const names = Object.keys(row);
  db.prepare(
    'INSERT INTO ' + table.name + ' (' + names.join(', ') + ') VALUES (' + names.map(() => '?').join(', ') + ')',
  ).run(...names.map((n) => row[n]));
  samples[table.name] = row;
}

// 那个版本还没有 project_local 时，工作空间存在 meta 里（迁移 v2 会把它搬进新表）
const hasProjects = tables.some((t) => t.name === 'project_local');
const legacyWorkspaces = hasProjects ? null : [WORKSPACE];
if (legacyWorkspaces) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('evowork.workspaces', JSON.stringify(legacyWorkspaces));
}

const meta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
const schema = {
  authoritative: Number(meta('schema_version_authoritative')),
  projection: Number(meta('schema_version_projection')),
};

// 夹具要是一个自包含的文件：把 WAL 落回主文件，再切回 DELETE 模式
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.exec('PRAGMA journal_mode = DELETE');
store.close();

process.stdout.write(JSON.stringify({ schema, legacyWorkspaces, samples }));
`;

// 放在最后：上面的 GENERATOR 是 const，提前用会撞上暂时性死区
try {
  let root;
  let commit;
  let appVersion;
  if (ref === 'WORKTREE') {
    root = repo;
    commit = `${git('rev-parse', 'HEAD')}${git('status', '--porcelain') ? '+dirty' : ''}`;
    appVersion = JSON.parse(git('show', 'HEAD:apps/desktop/package.json')).version;
  } else {
    root = join(work, 'src');
    mkdirSync(root);
    const tar = execFileSync(
      'git',
      [
        'archive',
        '--format=tar',
        ref,
        'services/store',
        'packages/logging',
        'packages/protocol',
        'config/config.toml.template',
        // 两个包的 tsconfig 都 extends 它；少了 esbuild 只是告警，但告警多了真问题就看不见
        'tsconfig.base.json',
      ],
      { cwd: repo },
    );
    execFileSync('tar', ['-x', '-C', root], { input: tar });
    commit = git('rev-parse', `${ref}^{commit}`);
    appVersion = JSON.parse(git('show', `${ref}:apps/desktop/package.json`)).version;
  }

  const entry = join(work, 'generate.mjs');
  writeFileSync(entry, GENERATOR);
  const bundle = join(work, 'generate.bundle.mjs');
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundle,
    logLevel: 'warning',
    alias: {
      'evowork-fixture-store': join(root, 'services/store/src/index.ts'),
      '@evowork/logging': join(root, 'packages/logging/src/index.ts'),
      '@evowork/protocol': join(root, 'packages/protocol/src/index.ts'),
    },
  });

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const report = JSON.parse(
    execFileSync(process.execPath, ['--no-warnings', bundle, join(out, 'evowork.db')], {
      encoding: 'utf8',
    }),
  );
  copyFileSync(join(root, 'config/config.toml.template'), join(out, 'config.toml'));
  writeFileSync(
    join(out, 'FIXTURE.json'),
    `${JSON.stringify(
      {
        name,
        ref,
        commit,
        appVersion,
        generatedBy: 'scripts/build-upgrade-fixture.mjs',
        schema: report.schema,
        legacyWorkspaces: report.legacyWorkspaces,
        samples: report.samples,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `✅ ${name}：EvoWork ${appVersion}（${commit.slice(0, 10)}），` +
      `权威表 v${report.schema.authoritative} · 投影表 v${report.schema.projection} · ` +
      `${Object.keys(report.samples).length} 张表各一行样例 → ${out}`,
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
