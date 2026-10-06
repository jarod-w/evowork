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
