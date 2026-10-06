import { TextDecoder } from 'node:util';
import { createReadStream, existsSync } from 'node:fs';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolatedProcess } from './isolated-process.js';
import { resolveOfficeInterpreter } from './probe.js';
import { sniffEncoding } from './detect.js';

export interface ExtractedBlock {
  readonly text: string;
  readonly location: string;
  readonly page?: number;
  readonly source: 'text' | 'textLayer' | 'ocr';
  readonly needsReview?: boolean;
}
export interface LibraryExtraction {
  readonly blocks: readonly ExtractedBlock[];
  readonly partial: boolean;
  readonly ocrCandidates: number;
  readonly characters?: number;
}
export async function extractLibraryBody(input: {
  readonly path: string;
  readonly signal?: AbortSignal;
  readonly interpreter?: string;
}): Promise<LibraryExtraction> {
  const info = await lstat(input.path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 200 * 1024 * 1024)
    throw new Error('LIBRARY_FILE_LIMIT');
  const ext = extname(input.path).toLowerCase();
  if (['.txt', '.md', '.csv', '.tsv', '.json'].includes(ext)) {
    const stream = createReadStream(input.path, {
      ...(input.signal ? { signal: input.signal } : {}),
    });
    let decoder: TextDecoder | undefined,
      text = '',
      count = 0,
      partial = false;
    try {
      for await (const chunk of stream) {
        const bytes = chunk as Buffer;
        decoder ??= new TextDecoder(
          sniffEncoding(bytes.subarray(0, 512)) === 'gbk' ? 'gbk' : 'utf-8',
        );
        const decoded = Array.from(decoder.decode(bytes, { stream: true }));
        const remaining = 2_000_000 - count;
        text += decoded.slice(0, remaining).join('');
        count += Math.min(remaining, decoded.length);
        if (decoded.length > remaining) {
          partial = true;
          break;
        }
      }
      if (!partial && decoder) {
        const tail = Array.from(decoder.decode()),
          remaining = 2_000_000 - count;
        text += tail.slice(0, remaining).join('');
        partial = tail.length > remaining;
      }
    } finally {
      stream.destroy();
    }
    const blocks: ExtractedBlock[] = [],
      chars = Array.from(text);
    let line = 1;
    for (let offset = 0; offset < chars.length; offset += 3800) {
      blocks.push({
        text: chars.slice(offset, offset + 4000).join(''),
        location: `行 ${line} · 字符 ${offset + 1}`,
        source: 'text',
      });
      line += chars.slice(offset, offset + 3800).filter((c) => c === '\n').length;
    }
    return { blocks, partial, ocrCandidates: 0, characters: Array.from(text).length };
  }
  if (!['.pdf', '.docx', '.xlsx', '.pptx'].includes(ext)) throw new Error('LIBRARY_UNSUPPORTED');
  const interpreter = input.interpreter ?? resolveOfficeInterpreter();
  if (!interpreter) throw new Error('LIBRARY_RUNTIME_MISSING');
  const base = dirname(fileURLToPath(import.meta.url));
  const script = [join(base, 'parsers/library.py'), join(base, 'library.py')].find(existsSync);
  if (!script) throw new Error('LIBRARY_PARSER_MISSING');
  const work = await mkdtemp(join(tmpdir(), 'evowork-library-'));
  try {
    const executableScript = join(work, 'parser.py'),
      result = join(work, 'result.json');
    await writeFile(executableScript, await readFile(script));
    await runIsolatedProcess({
      executable: interpreter,
      args: [executableScript, '--input', input.path, '--result', result],
      readPaths: [input.path, dirname(dirname(interpreter))],
      writeDirectory: work,
      timeoutMs: 30_000,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if ((await lstat(result)).size > 32 * 1024 * 1024) throw new Error('LIBRARY_OUTPUT_LIMIT');
    const value = JSON.parse(await readFile(result, 'utf8')) as LibraryExtraction;
    if (
      !Array.isArray(value.blocks) ||
      value.blocks.some((b) => typeof b.text !== 'string' || typeof b.location !== 'string')
    )
      throw new Error('LIBRARY_RESULT_INVALID');
    if (value.blocks.reduce((sum, b) => sum + Array.from(b.text).length, 0) > 2_000_000)
      throw new Error('LIBRARY_OUTPUT_LIMIT');
    return value;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
