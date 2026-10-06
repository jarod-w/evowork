import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The offline bundle is explicit, host-selected input. This verifies corruption, not publisher trust. */
export function verifyOcrRuntime(root: string): {
  readonly digest: string;
  readonly version: string;
} {
  const file = join(root, 'ocr-runtime.json');
  if (statSync(file).size > 64 * 1024) throw new Error('OCR_RUNTIME_INVALID');
  const bytes = readFileSync(file);
  const manifest = JSON.parse(bytes.toString('utf8')) as {
    version?: unknown;
    platform?: unknown;
    files?: Record<string, unknown>;
  };
  if (
    manifest.platform !== `${process.arch}-${process.platform}` ||
    typeof manifest.version !== 'string' ||
    !manifest.version.startsWith('5.')
  ) {
    throw new Error('OCR_RUNTIME_PLATFORM');
  }
  for (const name of [
    'bin/tesseract',
    'bin/image-decoder',
    'tessdata/chi_sim.traineddata',
    'tessdata/eng.traineddata',
    'tessdata/osd.traineddata',
  ]) {
    const path = join(root, name);
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile())
      throw new Error('OCR_RUNTIME_INVALID');
    if (statSync(path).size > 64 * 1024 * 1024) throw new Error('OCR_RUNTIME_INVALID');
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (manifest.files?.[name] !== hash) throw new Error('OCR_RUNTIME_CHECKSUM');
  }
  return { digest: createHash('sha256').update(bytes).digest('hex'), version: manifest.version };
}
