import { verifyOcrRuntime } from './ocr-runtime.js';
export { verifyOcrRuntime } from './ocr-runtime.js';
import { recognizeNativeImage } from './native-image-ocr.js';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ParserProcessError, runIsolatedProcess } from './isolated-process.js';
import { resolveOfficeInterpreter } from './probe.js';

export interface OcrPage {
  readonly page: number;
  readonly state: 'complete' | 'blank' | 'failed';
  readonly source: 'ocr' | 'textLayer' | 'blank';
  readonly text: string;
  readonly classification?: 'textLayer' | 'ocrCandidate' | 'blank' | 'suspectText';
  readonly confidence?: number;
  readonly needsReview?: boolean;
  readonly truncated?: boolean;
  readonly error?: string;
  readonly rotation?: number;
  readonly dpi?: number;
  readonly size?: readonly [number, number];
  readonly directionFailed?: boolean;
  /** Original-page top-left normalized coordinates; score is not a probability. */
  readonly words?: readonly {
    readonly text: string;
    readonly confidence: number;
    readonly box: readonly [number, number, number, number];
  }[];
  readonly textLayerText?: string;
}

export interface OcrResult {
  readonly key: string;
  readonly sourceHash: string;
  readonly total: number;
  readonly complete: boolean;
  readonly stopped: boolean;
  readonly pages: readonly OcrPage[];
  readonly markdown: string;
  readonly cacheDirectory: string;
}

export interface OcrInput {
  readonly priority?: 'foreground' | 'background';
  readonly path: string;
  readonly rotation?: 0 | 90 | 180 | 270;
  readonly startPage?: number;
  readonly pageCount?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: {
    readonly completed: number;
    readonly total: number;
    readonly failed: number;
  }) => void;
}

export async function sourceDigest(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const buffer of createReadStream(path, { ...(signal ? { signal } : {}) }))
    hash.update(buffer as Buffer);
  return hash.digest('hex');
}

export function resolveOcrScript(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return [
    join(here, 'parsers/ocr.py'),
    join(here, 'ocr.py'),
    ...(resources ? [join(resources, 'ingest/ocr.py')] : []),
  ].find((path) => existsSync(path));
}

let activeOcrJob = false;
let activePriority: 'foreground' | 'background' = 'foreground';
let activeAbort: AbortController | undefined;
let activeFinished: Promise<void> = Promise.resolve();

export function createOcrProcessor(options: {
  readonly runtimeRoot: string;
  readonly cacheRoot: string;
  readonly interpreter?: string;
  readonly scriptPath?: string;
}) {
  const processor = {
    async run(input: OcrInput): Promise<OcrResult> {
      if (input.signal?.aborted) throw new ParserProcessError('CANCELLED');
      if (
        input.startPage !== undefined &&
        (!Number.isSafeInteger(input.startPage) || input.startPage < 1)
      )
        throw new Error('OCR_PAGE_RANGE');
      if (
        input.pageCount !== undefined &&
        (!Number.isSafeInteger(input.pageCount) || input.pageCount < 1 || input.pageCount > 100)
      )
        throw new Error('OCR_PAGE_RANGE');
      if (input.rotation !== undefined && ![0, 90, 180, 270].includes(input.rotation))
        throw new Error('OCR_ROTATION');
      const extension = extname(input.path).toLowerCase();
      if (!['.pdf', '.png', '.jpg', '.jpeg', '.webp'].includes(extension))
        throw new Error('OCR_INPUT');
      const info = lstatSync(input.path);
      const sizeLimit = extension === '.pdf' ? 200 * 1024 * 1024 : 20 * 1024 * 1024;
      if (!info.isFile() || info.isSymbolicLink() || info.size > sizeLimit)
        throw new Error('OCR_INPUT');
      const runtime = verifyOcrRuntime(options.runtimeRoot);
      if (extension !== '.pdf' && options.scriptPath === undefined) {
        return recognizeNativeImage(input, {
          runtimeRoot: options.runtimeRoot,
          cacheRoot: options.cacheRoot,
          runtimeDigest: runtime.digest,
        });
      }
      const interpreter = options.interpreter ?? resolveOfficeInterpreter();
      const script = options.scriptPath ?? resolveOcrScript();
      if (!interpreter || !script) throw new Error('OCR_BRIDGE_MISSING');
      const source = realpathSync(input.path);
      const sourceHash = await sourceDigest(source, input.signal);
      const scriptDigest = await sourceDigest(script, input.signal);
      const key = createHash('sha256')
        .update(
          JSON.stringify({
            sourceHash,
            runtime: runtime.digest,
            scriptDigest,
            languages: ['chi_sim', 'eng'],
            rotation: input.rotation ?? 'auto',
          }),
        )
        .digest('hex');
      const directory = join(options.cacheRoot, key);
      await mkdir(directory, { recursive: true });
      const executableScript = join(directory, 'ocr-parser.py');
      await writeFile(executableScript, readFileSync(script));
      let stopped = false;
      let progressBuffer = '';
      try {
        const executable = realpathSync(interpreter);
        await runIsolatedProcess({
          executable,
          args: [
            realpathSync(executableScript),
            '--input',
            source,
            '--runtime',
            realpathSync(options.runtimeRoot),
            '--out-dir',
            realpathSync(directory),
            '--key',
            key,
            '--start-page',
            String(input.startPage ?? 1),
            '--page-count',
            String(input.pageCount ?? 100),
            ...(input.rotation !== undefined ? ['--rotation', String(input.rotation)] : []),
          ],
          readPaths: [dirname(dirname(executable)), source, realpathSync(options.runtimeRoot)],
          writeDirectory: directory,
          timeoutMs: 120_000,
          onStdout: (chunk) => {
            progressBuffer += chunk;
            let newline;
            while ((newline = progressBuffer.indexOf('\n')) >= 0) {
              const line = progressBuffer.slice(0, newline);
              progressBuffer = progressBuffer.slice(newline + 1);
              try {
                const row = JSON.parse(line) as {
                  completed: number;
                  total: number;
                  failed: number;
                };
                if (
                  [row.completed, row.total, row.failed].every(Number.isSafeInteger) &&
                  row.completed >= 0 &&
                  row.completed <= row.total
                )
                  input.onProgress?.(row);
              } catch {
                /* Progress is advisory; committed pages are validated separately. */
              }
            }
          },
          signal: input.signal,
        });
      } catch (error) {
        if (
          error instanceof ParserProcessError &&
          (error.code === 'CANCELLED' || error.code === 'TIMEOUT')
        )
          stopped = true;
        else throw error;
      } finally {
        await rm(join(directory, 'temporary'), { recursive: true, force: true });
      }
      if ((await sourceDigest(source)) !== sourceHash) throw new Error('OCR_SOURCE_CHANGED');
      const pagesFile = join(directory, 'pages.json');
      if (!existsSync(pagesFile))
        throw new Error(stopped ? 'OCR_STOPPED_WITHOUT_PAGES' : 'OCR_NO_RESULT');
      if (statSync(pagesFile).size > 32 * 1024 * 1024) throw new Error('OCR_OUTPUT_LIMIT');
      const parsed = JSON.parse(await readFile(pagesFile, 'utf8')) as {
        key: string;
        sourceHash: string;
        total: number;
        pages: OcrPage[];
      };
      if (
        parsed.key !== key ||
        parsed.sourceHash !== sourceHash ||
        !Number.isSafeInteger(parsed.total) ||
        parsed.total < 1 ||
        !Array.isArray(parsed.pages)
      )
        throw new Error('OCR_INVALID_RESULT');
      let chars = 0;
      const seen = new Set<number>();
      for (const page of parsed.pages) {
        if (
          !Number.isSafeInteger(page.page) ||
          page.page < 1 ||
          page.page > parsed.total ||
          seen.has(page.page) ||
          !['complete', 'blank', 'failed'].includes(page.state) ||
          !['ocr', 'textLayer', 'blank'].includes(page.source) ||
          typeof page.text !== 'string'
        )
          throw new Error('OCR_INVALID_RESULT');
        seen.add(page.page);
        chars += Array.from(page.text).length;
      }
      if (chars > 2_000_000) throw new Error('OCR_OUTPUT_LIMIT');
      return {
        key,
        sourceHash,
        total: parsed.total,
        stopped,
        complete:
          parsed.pages.length === parsed.total &&
          parsed.pages.every((p) => p.state !== 'failed' && !p.truncated),
        pages: parsed.pages,
        markdown: parsed.pages
          .filter((p) => p.state === 'complete')
          .map((p) => `## 第 ${p.page} 页\n\n${p.text}`)
          .join('\n\n'),
        cacheDirectory: directory,
      };
    },
  };
  return {
    async recognize(input: OcrInput): Promise<OcrResult> {
      if (input.signal?.aborted) throw new ParserProcessError('CANCELLED');
      const priority = input.priority ?? 'foreground';
      if (activeOcrJob && priority === 'foreground' && activePriority === 'background') {
        activeAbort?.abort();
        await activeFinished;
      }
      if (activeOcrJob) throw new Error('OCR_BUSY');
      if (input.signal?.aborted) throw new ParserProcessError('CANCELLED');
      const abort = new AbortController();
      activeOcrJob = true;
      activePriority = priority;
      activeAbort = abort;
      let release!: () => void;
      activeFinished = new Promise<void>((resolve) => {
        release = resolve;
      });
      const signal = input.signal ? AbortSignal.any([input.signal, abort.signal]) : abort.signal;
      try {
        return await processor.run({ ...input, signal });
      } catch (error) {
        if (signal.aborted) throw new ParserProcessError('CANCELLED');
        throw error;
      } finally {
        activeOcrJob = false;
        activeAbort = undefined;
        release();
      }
    },
  };
}
