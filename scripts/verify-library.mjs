/** Real local acceptance: decoder formats, offline installer, body extraction, and a 10k-document query corpus. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';
const root = resolve(import.meta.dirname, '..');
const work = process.env.EVOWORK_LIBRARY_TEST_OUTPUT,
  runtime = process.env.EVOWORK_OCR_TEST_RUNTIME,
  python = process.env.EVOWORK_OFFICE_PYTHON;
if (!work || !runtime || !python)
  throw new Error('Explicit temporary output, local OCR bundle and Office Python are required.');
mkdirSync(work, { recursive: true });
await build({
  entryPoints: [join(root, 'services/ingest/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(work, 'ingest.mjs'),
});
await build({
  entryPoints: [join(root, 'services/store/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(work, 'store.mjs'),
});
await build({
  entryPoints: [join(root, 'services/runtime-installer/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: join(work, 'installer.mjs'),
});
copyFileSync(join(root, 'services/ingest/src/parsers/library.py'), join(work, 'library.py'));
const ingest = await import(join(work, 'ingest.mjs')),
  storeModule = await import(join(work, 'store.mjs')),
  installer = await import(join(work, 'installer.mjs'));
execFileSync(python, [
  join(root, 'scripts/ocr-samples.py'),
  '--output',
  work,
  '--font',
  join(resolve(python, '../..'), 'fonts/NotoSansSC-Regular.ttf'),
]);
execFileSync(python, [
  '-c',
  String.raw`from PIL import Image
import sys,struct,zlib,openpyxl
from pathlib import Path
r=Path(sys.argv[1]);im=Image.open(r/'clear-print.png');im.save(r/'clear-print.jpg',quality=95);im.save(r/'clear-print.webp',lossless=True)
im.save(r/'animated.webp',save_all=True,append_images=[im.rotate(180)],duration=100,loop=0)
def chunk(name,data):return struct.pack('>I',len(data))+name+data+struct.pack('>I',zlib.crc32(name+data)&0xffffffff)
(r/'oversized.png').write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',20000,20000,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\0'))+chunk(b'IEND',b''))
w=openpyxl.Workbook();s=w.active
for i in range(1,242):s.append([i,'ROW201_PRIVATE_NEEDLE' if i==201 else 'ordinary record'])
w.save(r/'rows.xlsx')`,
  work,
]);
const digest = createHash('sha256')
  .update(readFileSync(join(runtime, 'ocr-runtime.json')))
  .digest('hex');
await installer.installOcrBundle({
  bundle: runtime,
  digest,
  destination: join(work, 'installed-ocr'),
});
const processor = ingest.createOcrProcessor({
  runtimeRoot: join(work, 'installed-ocr'),
  cacheRoot: join(work, 'cache'),
});
// Deliberately deny the Office tier for images. Fixture generation above is a test-only operation.
process.env.EVOWORK_OFFICE_PYTHON = join(work, 'missing-office-runtime');
const formats = [];
const truth = JSON.parse(readFileSync(join(work, 'truth.json'), 'utf8')).pages[0];
for (const extension of ['png', 'jpg', 'webp']) {
  const result = await processor.recognize({
    path: join(work, `clear-print.${extension}`),
    rotation: 0,
  });
  const compact = result.pages[0].text.replace(/\s+/gu, '');
  if (!compact.includes(truth.amount) || !compact.includes(truth.number))
    throw new Error(`Critical values failed for ${extension}`);
  formats.push({
    extension,
    amountCorrect: true,
    numberCorrect: true,
    needsReview: result.pages[0].needsReview,
  });
}
const rotations = [];
for (const rotation of [90, undefined]) {
  const result = await processor.recognize({
    path: join(work, 'rotated.png'),
    ...(rotation !== undefined ? { rotation } : {}),
  });
  const page = result.pages[0];
  const compact = page.text.replace(/\s+/gu, '');
  if (
    !compact.includes(truth.amount) ||
    !compact.includes(truth.number) ||
    !page.words.every((w) => w.box.every((n) => n >= 0 && n <= 1))
  )
    throw new Error('Native rotation/coordinate verification failed');
  rotations.push({
    mode: rotation ?? 'auto',
    rotation: page.rotation,
    criticalValuesCorrect: true,
    originalCoordinatesBounded: true,
  });
}
const rejected = [];
for (const name of ['animated.webp', 'oversized.png']) {
  try {
    await processor.recognize({ path: join(work, name), rotation: 0 });
    throw new Error(`Accepted invalid decoder input: ${name}`);
  } catch (error) {
    if (error.message.startsWith('Accepted')) throw error;
    rejected.push(name);
  }
}
process.env.EVOWORK_OFFICE_PYTHON = python;
const body = await ingest.extractLibraryBody({
  path: join(work, 'rows.xlsx'),
  interpreter: python,
});
const row201 = body.blocks.find((b) => b.text.includes('ROW201_PRIVATE_NEEDLE'));
if (!row201 || body.partial) throw new Error('Spreadsheet body coverage failed');
const store = storeModule.openStore({ path: join(work, 'library.db') });
const projection = storeModule.createLibraryProjection(store.db);
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
const reader = storeModule.createLibraryQueryRunner({ databasePath: join(work, 'library.db') });
const ids = Array.from({ length: 10000 }, (_, i) => `doc-${String(i).padStart(5, '0')}`);
const timings = [];
for (const query of ['ZXCVUNIQUE', '合同', 'ZXCVUNIQUE 付款']) {
  const observations = [];
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    const hits = await reader.search({ query, documentIds: ids, details: true });
    if (hits.length !== 20) throw new Error('Search result page failed');
    observations.push(Math.round(performance.now() - start));
  }
  timings.push({ query, observations, p95Ms: Math.max(...observations), documents: 20 });
}
store.close();
const report = {
  platform: `${process.arch}-${process.platform}`,
  offlineInstall: true,
  imagesWithoutOffice: formats,
  nativeRotations: rotations,
  rejected,
  row201Location: row201.location,
  queryCorpus: 10000,
  queryBlocks: 100000,
  timings,
};
writeFileSync(join(work, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
