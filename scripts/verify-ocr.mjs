#!/usr/bin/env node
/** Explicit real-runtime acceptance, not a test that silently skips a missing installation. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = process.env.EVOWORK_OCR_TEST_RUNTIME;
const interpreter = process.env.EVOWORK_OFFICE_PYTHON;
const work = resolve(process.env.EVOWORK_OCR_TEST_OUTPUT ?? join(ROOT, 'dist/ocr-verification'));
if (!runtimeRoot || !interpreter)
  throw new Error('Set explicit OCR runtime and office interpreter for real-runtime verification.');
mkdirSync(work, { recursive: true });
const font =
  process.env.EVOWORK_OCR_TEST_FONT ??
  join(dirname(dirname(interpreter)), 'fonts/NotoSansSC-Regular.ttf');
const entry = join(work, 'ingest.mjs');
execFileSync(
  join(ROOT, 'node_modules/.bin/esbuild'),
  [
    join(ROOT, 'services/ingest/src/index.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${entry}`,
    '--log-level=warning',
  ],
  { stdio: 'inherit' },
);
execFileSync(
  interpreter,
  [join(ROOT, 'scripts/ocr-samples.py'), '--output', work, '--font', font],
  { stdio: 'inherit' },
);
const { createOcrProcessor, verifyOcrRuntime } = await import(pathToFileURL(entry).href);
const engine = verifyOcrRuntime(runtimeRoot);
const parser = createOcrProcessor({
  runtimeRoot,
  interpreter,
  cacheRoot: join(work, 'cache'),
  scriptPath: join(ROOT, 'services/ingest/src/parsers/ocr.py'),
});
const truth = JSON.parse(readFileSync(join(work, 'truth.json'), 'utf8'));
const normalize = (text) => Array.from(text.normalize('NFKC').replace(/\s/gu, ''));
const distance = (a, b) => {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1)
      next[j] = Math.min(
        next[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = next;
  }
  return previous[b.length];
};
const started = performance.now();
let result;
for (let startPage = 1; startPage <= 30; startPage += 10)
  result = await parser.recognize({
    path: join(work, 'clear-print.pdf'),
    rotation: 0,
    startPage,
    pageCount: 10,
  });
if (!result.complete || result.pages.length !== 30) throw new Error('Clear-print coverage failed');
const pages = truth.pages.map((expected) => {
  const actual = result.pages.find((page) => page.page === expected.page);
  const expectedChars = normalize(expected.text);
  return {
    page: expected.page,
    cer: distance(expectedChars, normalize(actual.text)) / expectedChars.length,
    amountCorrect: actual.text.includes(expected.amount),
    numberCorrect: actual.text.includes(expected.number),
    source: actual.source,
  };
});
const averageCer = pages.reduce((sum, page) => sum + page.cer, 0) / pages.length;
const native = await parser.recognize({ path: join(work, 'native-and-blank.pdf') });
if (!native.complete || native.pages[0].source !== 'textLayer' || native.pages[1].state !== 'blank')
  throw new Error('Native/blank classification failed');
const before = readFileSync(join(result.cacheDirectory, 'pages.json'));
await parser.recognize({ path: join(work, 'clear-print.pdf'), rotation: 0, pageCount: 10 });
if (!before.equals(readFileSync(join(result.cacheDirectory, 'pages.json'))))
  throw new Error('Completed pages were rewritten on resume');
const rotated = await parser.recognize({ path: join(work, 'rotated.png'), rotation: 90 });
if (!rotated.complete || !rotated.pages[0].text.includes('12301.67'))
  throw new Error('Explicit rotation failed');
const automaticRotation = await parser.recognize({ path: join(work, 'rotated.png') });
if (!automaticRotation.complete || !automaticRotation.pages[0].text.includes('12301.67'))
  throw new Error('Automatic direction detection failed');
const report = {
  engine,
  corpus: truth.corpus,
  sourceSha256: truth.sourceSha256,
  fontSha256: truth.fontSha256,
  pages,
  averageCer,
  elapsedMs: Math.round(performance.now() - started),
  nativeAndBlank: true,
  resumeReuse: true,
  explicitRotation: true,
  automaticRotation: true,
  gatePassed: averageCer <= 0.05 && pages.every((page) => page.amountCorrect && page.numberCorrect),
};
writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(
  JSON.stringify({
    pages: pages.length,
    averageCer,
    elapsedMs: report.elapsedMs,
    gatePassed: report.gatePassed,
    report: join(work, 'report.json'),
  }),
);
if (!report.gatePassed) process.exitCode = 1;
if (!existsSync(join(result.cacheDirectory, 'manifest.json')))
  throw new Error('Missing completion manifest');
