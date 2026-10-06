import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createOcrProcessor, verifyOcrRuntime } from '../src/ocr.js';
let root: string;
let runtime: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evowork-ocr-contract-'));
  runtime = join(root, 'runtime');
  mkdirSync(join(runtime, 'bin'), { recursive: true });
  mkdirSync(join(runtime, 'tessdata'), { recursive: true });
  const files: Record<string, string> = {};
  // A manifest fixture never claims to recognize text; real recognition is verify-ocr.mjs.
  for (const name of [
    'bin/tesseract',
    'bin/image-decoder',
    'tessdata/eng.traineddata',
    'tessdata/chi_sim.traineddata',
    'tessdata/osd.traineddata',
  ]) {
    writeFileSync(join(runtime, name), 'fixture-asset');
    files[name] = createHash('sha256').update('fixture-asset').digest('hex');
  }
  writeFileSync(
    join(runtime, 'ocr-runtime.json'),
    JSON.stringify({ version: '5.5.1', platform: `${process.arch}-${process.platform}`, files }),
  );
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('a Python wrapper import cannot substitute for the engine and language data integrity', () => {
  expect(verifyOcrRuntime(runtime).version).toBe('5.5.1');
  writeFileSync(join(runtime, 'tessdata/chi_sim.traineddata'), 'corrupt');
  expect(() => verifyOcrRuntime(runtime)).toThrow('OCR_RUNTIME_CHECKSUM');
  expect(() => verifyOcrRuntime(join(root, 'missing'))).toThrow();
});
it('rejects unsupported platform manifests and missing direction data', () => {
  const manifest = JSON.parse(readFileSync(join(runtime, 'ocr-runtime.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  writeFileSync(
    join(runtime, 'ocr-runtime.json'),
    JSON.stringify({ ...manifest, platform: 'not-this-platform' }),
  );
  expect(() => verifyOcrRuntime(runtime)).toThrow('OCR_RUNTIME_PLATFORM');
  writeFileSync(join(runtime, 'ocr-runtime.json'), JSON.stringify(manifest));
  rmSync(join(runtime, 'tessdata/osd.traineddata'));
  expect(() => verifyOcrRuntime(runtime)).toThrow();
});
it('pre-cancelled jobs and invalid page batches do not launch the decoder', async () => {
  const processor = createOcrProcessor({ runtimeRoot: runtime, cacheRoot: join(root, 'cache') });
  const abort = new AbortController();
  abort.abort();
  await expect(
    processor.recognize({ path: join(root, 'unread-file'), signal: abort.signal }),
  ).rejects.toMatchObject({ code: 'CANCELLED' });
  await expect(
    processor.recognize({ path: join(root, 'unread-file'), pageCount: 101 }),
  ).rejects.toThrow('OCR_PAGE_RANGE');
});
it('only one OCR job can enter source hashing/decoding, even across separate processors', async () => {
  const source = join(root, 'original.png');
  writeFileSync(source, 'source');
  const processor = createOcrProcessor({
    runtimeRoot: runtime,
    cacheRoot: join(root, 'cache'),
    interpreter: '/usr/bin/perl',
    scriptPath: join(root, 'missing-script'),
  });
  const first = processor.recognize({ path: source });
  const another = createOcrProcessor({ runtimeRoot: runtime, cacheRoot: join(root, 'cache') });
  await expect(another.recognize({ path: source })).rejects.toThrow('OCR_BUSY');
  await expect(first).rejects.toThrow();
  await expect(another.recognize({ path: source, pageCount: 101 })).rejects.toThrow(
    'OCR_PAGE_RANGE',
  );
});

it('a foreground attachment cancels background work before taking the single OCR slot', async () => {
  const source = join(root, 'original.png');
  writeFileSync(source, 'source');
  const background = createOcrProcessor({
    runtimeRoot: runtime,
    cacheRoot: join(root, 'cache'),
    interpreter: '/usr/bin/perl',
    scriptPath: join(root, 'missing-script'),
  });
  const pending = background.recognize({ path: source, priority: 'background' });
  // Observe failure concurrently so cancellation cannot become an unhandled rejection.
  const cancelled = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
  const foreground = createOcrProcessor({ runtimeRoot: runtime, cacheRoot: join(root, 'cache') });
  await expect(foreground.recognize({ path: source, pageCount: 101 })).rejects.toThrow(
    'OCR_PAGE_RANGE',
  );
  await cancelled;
});
