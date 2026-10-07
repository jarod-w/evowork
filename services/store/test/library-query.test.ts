import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createLibraryQueryRunner,
  libraryTerms,
  normalizeLibraryText,
} from '../src/library-query.js';
import { openStore, type Store } from '../src/store.js';
import { createLibraryProjection } from '../src/library-projection.js';
let directory: string;
let store: Store;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'evowork-library-query-'));
  store = openStore({ path: join(directory, 'library.db') });
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
const insert = (id: string, text: string): void => {
  store.db
    .prepare('INSERT INTO library_index(node_id,title,body,meta) VALUES(?,?,?,?)')
    .run(id, 'a file without query keywords', normalizeLibraryText(text), '{}');
};
const reader = () => createLibraryQueryRunner({ databasePath: join(directory, 'library.db') });

it('normalizes width/case and counts Unicode query characters without accepting FTS operators', () => {
  expect(libraryTerms(' 合同 ＡＢＣ 合同 ')).toEqual(['合同', 'abc']);
  expect(() => libraryTerms('😀'.repeat(201))).toThrow('LIBRARY_QUERY_TOO_LONG');
  expect(libraryTerms('😀'.repeat(200))).toHaveLength(1);
});
it('short words and literal quotes/FTS tokens search body, with AND across separate blocks', async () => {
  insert('visible', '毛利率分析 合同');
  insert('visible', '付款说明 ABC AND "quoted"');
  insert('outside', '毛利率分析 合同 付款说明 ABC AND "quoted"');
  const search = (query: string) => reader().search({ query, documentIds: ['visible'] });
  expect((await search('合同')).map((hit) => hit.documentId)).toEqual(['visible']);
  expect((await search('毛利率 付款')).map((hit) => hit.documentId)).toEqual(['visible']);
  expect((await search('ａｂｃ AND')).map((hit) => hit.documentId)).toEqual(['visible']);
  expect((await search('"quoted"')).map((hit) => hit.documentId)).toEqual(['visible']);
  expect(await search('NEAR')).toEqual([]);
});
it('scope applies before pagination and an empty scope never searches globally', async () => {
  for (let index = 0; index < 30; index += 1) insert(`outside-${index}`, '合同');
  insert('zz-visible', '合同');
  expect(
    (await reader().search({ query: '合同', documentIds: ['zz-visible'] })).map(
      (hit) => hit.documentId,
    ),
  ).toEqual(['zz-visible']);
  expect(await reader().search({ query: '合同', documentIds: [] })).toEqual([]);
});

it("projected long/short AND finds different and late chunks without borrowing another document's text", async () => {
  const projection = createLibraryProjection(store.db);
  for (const [id, last] of [
    ['included', '付款说明'],
    ['long-only', '普通说明'],
    ['outside', '付款说明'],
  ]) {
    projection.publish({
      id: id!,
      title: 'report',
      hash: 'fixture',
      state: 'searchable',
      blocks: Array.from({ length: 10 }, (_, index) => ({
        text:
          index === 0
            ? 'needlealpha'
            : index === 8
              ? 'needlebeta'
              : index === 9
                ? last!
                : 'ordinary',
        location: `第 ${index + 1} 页`,
        source: 'text' as const,
      })),
    });
  }
  const scope = ['included', 'long-only'];
  for (const query of ['needlealpha 付款', 'needlealpha needlebeta 付款']) {
    const hits = await reader().search({ query, documentIds: scope, details: true });
    expect(hits.map((hit) => hit.documentId)).toEqual(['included']);
    expect(hits[0]?.snippets?.map((snippet) => snippet.location)).toEqual(
      query.includes('needlebeta') ? ['第 1 页', '第 9 页', '第 10 页'] : ['第 1 页', '第 10 页'],
    );
  }
});

it('projected matches keep title priority, BM25, timestamp/id tie breaks, and pagination within scope', async () => {
  const projection = createLibraryProjection(store.db);
  const publish = (id: string, title: string, text: string, time: number) => {
    projection.publish({
      id,
      title,
      hash: 'fixture',
      state: 'searchable',
      blocks: [{ text, location: '段落 1', source: 'text' }],
    });
    store.db.prepare('UPDATE library_document SET updated_at=? WHERE id=?').run(time, id);
  };
  publish('title-first', 'needlealpha', 'ordinary '.repeat(200), 0);
  publish('body-strong', 'report', 'needlealpha '.repeat(20), 0);
  const scope = ['title-first', 'body-strong'];
  for (let index = 0; index < 25; index++) {
    const id = `peer-${String(index).padStart(2, '0')}`;
    publish(id, 'report', 'needlealpha ' + 'ordinary '.repeat(200), index < 2 ? 999 : 100 - index);
    scope.push(id);
  }
  publish('outside', 'needlealpha', 'needlealpha', 1000);
  const expected = ['title-first', 'body-strong', ...scope.slice(2)];
  const first = await reader().search({ query: 'needlealpha', documentIds: scope });
  const second = await reader().search({ query: 'needlealpha', documentIds: scope, offset: 20 });
  expect([...first, ...second].map((hit) => hit.documentId)).toEqual(expected);
  // No query still uses the same explicit scope and timestamp/id order, without requiring FTS matches.
  expect(
    (await reader().search({ query: '', documentIds: scope }))
      .slice(0, 2)
      .map((hit) => hit.documentId),
  ).toEqual(['peer-00', 'peer-01']);
});

it('bound JSON scope keeps quotes/Unicode literal and title-only short matches searchable', async () => {
  const id = '资料"?) OR 1=1 😀';
  createLibraryProjection(store.db).publish({
    id,
    title: '合同',
    hash: 'fixture',
    state: 'searchable',
    blocks: [],
  });
  insert('outside', '合同');
  expect(
    (await reader().search({ query: '合同', documentIds: [id, id] })).map((hit) => hit.documentId),
  ).toEqual([id]);
  expect(await reader().search({ query: 'absentword', documentIds: [id] })).toEqual([]);
  createLibraryProjection(store.db).publish({
    id: 'literal',
    title: 'report',
    hash: 'fixture',
    state: 'searchable',
    blocks: [{ text: '毛利率分析 ABC AND "quoted"', location: '段落 1', source: 'text' }],
  });
  for (const query of ['毛利率', 'ＡＢＣ AND', '"quoted"'])
    expect(
      (await reader().search({ query, documentIds: ['literal'] })).map((hit) => hit.documentId),
    ).toEqual(['literal']);
  expect(await reader().search({ query: 'NEAR', documentIds: ['literal'] })).toEqual([]);
});
it('deadline and explicit cancellation terminate a native query process, then a later query still works', async () => {
  insert('visible', '合同');
  const abort = new AbortController();
  const pending = reader().search({
    query: '合同',
    documentIds: ['visible'],
    signal: abort.signal,
  });
  abort.abort();
  await expect(pending).rejects.toThrow('LIBRARY_QUERY_CANCELLED');
  await expect(
    createLibraryQueryRunner({ databasePath: join(directory, 'library.db'), timeoutMs: 1 }).search({
      query: '合同',
      documentIds: ['visible'],
    }),
  ).rejects.toThrow('LIBRARY_QUERY_TIMEOUT');
  expect(await reader().search({ query: '合同', documentIds: ['visible'] })).toHaveLength(1);
});

it('a SQLite recursive scan running in native code cannot block the host beyond its deadline', async () => {
  // Deliberately slow read-only fixture: no renderer can supply SQL to the runner.
  store.db.exec(`DROP TABLE library_index;
    CREATE VIEW library_index AS
    WITH RECURSIVE counter(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM counter WHERE n < 1000000000)
    SELECT 'visible' AS node_id, 'native scan' AS title, CAST(sum(n) AS TEXT) AS body, '{}' AS meta FROM counter`);
  const started = performance.now();
  await expect(
    createLibraryQueryRunner({
      databasePath: join(directory, 'library.db'),
      timeoutMs: 300,
    }).search({ query: 'zz', documentIds: ['visible'] }),
  ).rejects.toThrow('LIBRARY_QUERY_TIMEOUT');
  expect(performance.now() - started).toBeLessThan(3000);
  // The killed reader held no writer state; the host can still use its authority tables.
  expect(store.db.prepare('SELECT count(*) AS count FROM meta').get()).toBeTruthy();
});
