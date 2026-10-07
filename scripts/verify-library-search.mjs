/** Real 10k/100k search acceptance; includes process startup, SQLite and snippets. */
import { createHash } from 'node:crypto';
import { cpus, release } from 'node:os';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const work = process.env.EVOWORK_LIBRARY_SEARCH_OUTPUT;
if (!work) throw new Error('An explicit temporary output directory is required.');
mkdirSync(work, { recursive: true });
await build({
  entryPoints: [join(root, 'services/store/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(work, 'store.mjs'),
  logLevel: 'warning',
});
const current = await import(pathToFileURL(join(work, 'store.mjs')).href);
const databasePath = process.env.EVOWORK_LIBRARY_SEARCH_DATABASE ?? join(work, 'library.db');
const store = current.openStore({ path: databasePath });
try {
  const count = store.db.prepare('SELECT count(*) AS n FROM library_document').get().n;
  if (count === 0 && !process.env.EVOWORK_LIBRARY_SEARCH_DATABASE) {
    const projection = current.createLibraryProjection(store.db);
    store.db.exec('BEGIN');
    for (let i = 0; i < 10000; i++)
      projection.publish({
        id: `doc-${String(i).padStart(5, '0')}`,
        title: `report ${i}`,
        hash: 'fixed-corpus',
        state: 'searchable',
        blocks: Array.from({ length: 10 }, (_, block) => ({
          text:
            'clear bounded ordinary document ' +
            'ordinary text '.repeat(10) +
            ' 合同 ZXCVUNIQUE\n付款说明',
          location: `段落 ${block + 1}`,
          source: 'text',
        })),
      });
    store.db.exec('COMMIT');
  }
  if (
    store.db.prepare('SELECT count(*) AS n FROM library_document').get().n !== 10000 ||
    store.db.prepare('SELECT count(*) AS n FROM library_chunk').get().n !== 100000
  )
    throw new Error(
      'The acceptance corpus must contain exactly 10,000 documents and 100,000 chunks.',
    );
} finally {
  store.close();
}
if (statSync(databasePath).size >= 1024 ** 3)
  throw new Error('The benchmark database exceeds 1 GiB.');
const digest = () => createHash('sha256').update(readFileSync(databasePath)).digest('hex');
const databaseSha256 = digest();
const reader = current.createLibraryQueryRunner({ databasePath });
const baselineModule = process.env.EVOWORK_LIBRARY_SEARCH_BASELINE;
const baseline = baselineModule
  ? (await import(pathToFileURL(resolve(baselineModule)).href)).createLibraryQueryRunner({
      databasePath,
    })
  : undefined;
const documentIds = Array.from({ length: 10000 }, (_, i) => `doc-${String(i).padStart(5, '0')}`);
const visible = new Set(documentIds);
const percentile = (values, fraction) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
const statistics = (observations) => ({
  observations,
  firstProcessMs: observations[0],
  p50Ms: percentile(observations, 0.5),
  p95Ms: percentile(observations, 0.95),
  maxMs: Math.max(...observations),
});
const timings = [];
for (const query of [
  'ZXCVUNIQUE',
  '合同',
  'ZXCVUNIQUE 付款',
  'ZXCVUNIQUE ordinary',
  'ZXCVUNIQUE ordinary 付款',
]) {
  const observations = [],
    baselineObservations = [];
  for (let run = 0; run < 30; run++) {
    const measure = async (runner) => {
      const start = performance.now();
      const hits = await runner.search({ query, documentIds, details: true });
      const elapsed = Math.round(performance.now() - start);
      if (
        hits.length !== 20 ||
        hits.some((hit) => !visible.has(hit.documentId) || !hit.snippets?.length)
      )
        throw new Error('Scoped result page/snippet coverage failed.');
      return { hits, elapsed };
    };
    let before, after;
    // Alternate A/B order; do not hide startup samples or run competing readers in parallel.
    if (baseline && run % 2 === 0) before = await measure(baseline);
    after = await measure(reader);
    if (baseline && run % 2 !== 0) before = await measure(baseline);
    if (before) {
      if (JSON.stringify(before.hits) !== JSON.stringify(after.hits))
        throw new Error('Optimization changed document order, source snippets or highlights.');
      baselineObservations.push(before.elapsed);
    }
    observations.push(after.elapsed);
  }
  const targetMs = query === '合同' ? 2000 : 500;
  const result = {
    query,
    ...statistics(observations),
    targetMs,
    passed: percentile(observations, 0.95) <= targetMs,
    ...(baseline ? { baseline: statistics(baselineObservations), identicalResults: true } : {}),
  };
  timings.push(result);
  console.log(
    JSON.stringify({ query, p95Ms: result.p95Ms, maxMs: result.maxMs, passed: result.passed }),
  );
}
if (digest() !== databaseSha256)
  throw new Error('The benchmark corpus changed during measurement.');
const report = {
  platform: `${process.arch}-${process.platform}`,
  cpu: cpus()[0].model,
  osRelease: release(),
  node: process.version,
  date: new Date().toISOString(),
  queryCorpus: 10000,
  queryBlocks: 100000,
  databaseBytes: statSync(databasePath).size,
  databaseSha256,
  samplesPerQuery: 30,
  cacheState:
    'Fresh reader process/connection each time; filesystem cache not purged; first sample retained.',
  includes: [
    'process startup',
    'bound visible scope',
    'SQLite matching/ranking',
    '20 documents with snippets/highlights',
  ],
  timings,
  passed: timings.every((result) => result.passed),
};
writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n');
if (!report.passed) process.exitCode = 1;
