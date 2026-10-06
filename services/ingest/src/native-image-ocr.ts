import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ParserProcessError, runIsolatedProcess } from './isolated-process.js';
import { sourceDigest, type OcrInput, type OcrPage, type OcrResult } from './ocr.js';

/** Native ImageIO decoder means a single image never needs the Office/Python tier. */
export async function recognizeNativeImage(
  input: OcrInput,
  options: {
    readonly runtimeRoot: string;
    readonly cacheRoot: string;
    readonly runtimeDigest: string;
  },
): Promise<OcrResult> {
  if ((input.startPage ?? 1) !== 1) throw new Error('OCR_PAGE_RANGE');
  const deadline = Date.now() + 30_000;
  const remaining = (maximum: number): number =>
    Math.max(1, Math.min(maximum, deadline - Date.now()));
  const decoder = join(options.runtimeRoot, 'bin/image-decoder');
  const manifest = JSON.parse(
    readFileSync(join(options.runtimeRoot, 'ocr-runtime.json'), 'utf8'),
  ) as { files: Record<string, string> };
  if (
    !existsSync(decoder) ||
    lstatSync(decoder).isSymbolicLink() ||
    !lstatSync(decoder).isFile() ||
    lstatSync(decoder).size > 16 * 1024 * 1024 ||
    createHash('sha256').update(readFileSync(decoder)).digest('hex') !==
      manifest.files['bin/image-decoder']
  )
    throw new Error('OCR_IMAGE_DECODER_MISSING');
  const source = resolve(input.path),
    sourceHash = await sourceDigest(source, input.signal);
  const key = createHash('sha256')
    .update(
      JSON.stringify({
        sourceHash,
        runtime: options.runtimeDigest,
        parser: 'native-image-v2',
        rotation: input.rotation ?? 'auto',
        languages: ['chi_sim', 'eng'],
      }),
    )
    .digest('hex');
  const directory = join(options.cacheRoot, key),
    recordFile = join(directory, 'image-result.json');
  await mkdir(directory, { recursive: true });
  try {
    if (
      existsSync(recordFile) &&
      !lstatSync(recordFile).isSymbolicLink() &&
      lstatSync(recordFile).size <= 32 * 1024 * 1024
    ) {
      const record = JSON.parse(await readFile(recordFile, 'utf8')) as {
        checksum: string;
        result: OcrResult;
      };
      const checksum = createHash('sha256').update(JSON.stringify(record.result)).digest('hex');
      if (
        record.checksum === checksum &&
        record.result.sourceHash === sourceHash &&
        record.result.key === key &&
        record.result.complete
      )
        return record.result;
    }
  } catch {
    /* Corrupt derived result can be regenerated. */
  }
  const work = join(directory, 'temporary');
  await mkdir(work, { recursive: true });
  try {
    const image = join(work, 'page.ppm'),
      executable = join(options.runtimeRoot, 'bin/tesseract');
    const decode = async (rotation: number) => {
      const output = await runIsolatedProcess({
        executable: decoder,
        args: [source, image, String(rotation)],
        readPaths: [source, options.runtimeRoot],
        writeDirectory: work,
        timeoutMs: remaining(10_000),
        signal: input.signal,
      });
      const size = JSON.parse(output) as {
        width: number;
        height: number;
        renderWidth: number;
        renderHeight: number;
      };
      if (
        !Number.isSafeInteger(size.width) ||
        !Number.isSafeInteger(size.height) ||
        size.width * size.height > 16_000_000
      )
        throw new Error('OCR_PIXEL_LIMIT');
      return size;
    };
    let rotation: number = input.rotation ?? 0,
      size = await decode(rotation),
      directionFailed = false;
    if (input.rotation === undefined) {
      try {
        const direction = await runIsolatedProcess({
          executable,
          args: [
            image,
            'stdout',
            '--tessdata-dir',
            join(options.runtimeRoot, 'tessdata'),
            '-l',
            'osd',
            '--psm',
            '0',
          ],
          readPaths: [options.runtimeRoot],
          writeDirectory: work,
          timeoutMs: remaining(8000),
          signal: input.signal,
        });
        const proposed = Number(/Rotate:\s*(\d+)/u.exec(direction)?.[1]);
        if (![0, 90, 180, 270].includes(proposed)) directionFailed = true;
        else {
          rotation = proposed;
          if (rotation) size = await decode(rotation);
        }
      } catch (error) {
        if (input.signal?.aborted) throw error;
        directionFailed = true;
      }
    }
    const output = join(work, 'recognized');
    await runIsolatedProcess({
      executable,
      args: [
        image,
        output,
        '--tessdata-dir',
        join(options.runtimeRoot, 'tessdata'),
        '-l',
        'chi_sim+eng',
        '--psm',
        '3',
        '-c',
        'tessedit_create_tsv=1',
      ],
      readPaths: [options.runtimeRoot],
      writeDirectory: work,
      timeoutMs: remaining(30_000),
      signal: input.signal,
    });
    const tsv = `${output}.tsv`;
    if (lstatSync(tsv).size > 16 * 1024 * 1024) throw new Error('OCR_OUTPUT_LIMIT');
    const lines = new Map<string, string[]>(),
      words: NonNullable<OcrPage['words']>[number][] = [];
    for (const row of (await readFile(tsv, 'utf8')).split('\n').slice(1)) {
      const cols = row.split('\t');
      if (cols.length < 12 || cols[0] !== '5') continue;
      const text = cols.slice(11).join('\t').trim(),
        confidence = Number(cols[10]);
      if (!text || !Number.isFinite(confidence) || confidence < 0) continue;
      const x = Number(cols[6]) / size.renderWidth,
        y = Number(cols[7]) / size.renderHeight,
        w = Number(cols[8]) / size.renderWidth,
        h = Number(cols[9]) / size.renderHeight;
      if (![x, y, w, h].every(Number.isFinite)) continue;
      const box: [number, number, number, number] =
        rotation === 90
          ? [y, 1 - x - w, h, w]
          : rotation === 180
            ? [1 - x - w, 1 - y - h, w, h]
            : rotation === 270
              ? [1 - y - h, x, h, w]
              : [x, y, w, h];
      words.push({ text, confidence, box });
      const line = cols.slice(1, 5).join(':');
      const tokens = lines.get(line) ?? [];
      tokens.push(text);
      lines.set(line, tokens);
      if (words.length > 100_000) throw new Error('OCR_OUTPUT_LIMIT');
    }
    const text = Array.from([...lines.values()].map((l) => l.join(' ')).join('\n'))
      .slice(0, 2_000_000)
      .join('');
    if (!text.trim()) throw new Error('OCR_NO_TEXT');
    const confidence = words.length
      ? words.reduce((sum, w) => sum + w.confidence, 0) / words.length
      : 0;
    const page: OcrPage = {
      page: 1,
      state: 'complete',
      source: 'ocr',
      classification: 'ocrCandidate',
      text,
      words,
      confidence,
      needsReview: !text || confidence < 70 || directionFailed,
      directionFailed,
      rotation,
      size: [size.width, size.height],
    };
    if ((await sourceDigest(source, input.signal)) !== sourceHash)
      throw new Error('OCR_SOURCE_CHANGED');
    const result: OcrResult = {
      key,
      sourceHash,
      total: 1,
      complete: true,
      stopped: false,
      pages: [page],
      markdown: `## 第 1 页（OCR${page.needsReview ? '，需核对' : ''}）\n\n${text}`,
      cacheDirectory: directory,
    };
    const temp = `${recordFile}.tmp`;
    await writeFile(
      temp,
      JSON.stringify({
        checksum: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
        result,
      }),
      { mode: 0o600 },
    );
    await rename(temp, recordFile);
    return result;
  } catch (error) {
    if (error instanceof ParserProcessError && input.signal?.aborted)
      throw new ParserProcessError('CANCELLED');
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
