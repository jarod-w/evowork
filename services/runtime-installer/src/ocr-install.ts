/** Offline deployment bundle. Its digest must come from trusted host configuration, not itself. */
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { runIsolatedProcess, verifyOcrRuntime } from '@evowork/ingest';

const FILES = [
  'bin/tesseract',
  'bin/image-decoder',
  'tessdata/eng.traineddata',
  'tessdata/chi_sim.traineddata',
  'tessdata/osd.traineddata',
  'NOTICE',
  'probe.pgm',
  'licenses/Tesseract-Apache-2.0.txt',
  'licenses/Leptonica-BSD.txt',
];
export async function inspectOcrBundle(
  bundle: string,
  pinnedDigest: string,
): Promise<{ bytes: number }> {
  if (!/^[a-f0-9]{64}$/.test(pinnedDigest) || (await realpath(bundle)) !== resolve(bundle))
    throw new Error('OCR_BUNDLE_UNTRUSTED');
  const path = join(bundle, 'ocr-runtime.json');
  if ((await lstat(path)).isSymbolicLink() || (await lstat(path)).size > 64 * 1024)
    throw new Error('OCR_BUNDLE_INVALID');
  const data = await readFile(path);
  if (createHash('sha256').update(data).digest('hex') !== pinnedDigest)
    throw new Error('OCR_BUNDLE_CHECKSUM');
  const manifest = JSON.parse(data.toString('utf8')) as {
    platform: string;
    version: string;
    files: Record<string, string>;
  };
  if (manifest.platform !== `${process.arch}-${process.platform}` || manifest.version !== '5.5.1')
    throw new Error('OCR_BUNDLE_PLATFORM');
  let bytes = 0;
  for (const name of FILES) {
    const file = join(bundle, name),
      info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (await realpath(file)) !== resolve(file) ||
      info.size > 64 * 1024 * 1024
    )
      throw new Error('OCR_BUNDLE_INVALID');
    const content = await readFile(file);
    bytes += content.length;
    if (createHash('sha256').update(content).digest('hex') !== manifest.files[name])
      throw new Error('OCR_BUNDLE_CHECKSUM');
  }
  return { bytes };
}
let installing = false;
export async function installOcrBundle(input: {
  readonly bundle: string;
  readonly digest: string;
  readonly destination: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  if (installing) throw new Error('OCR_INSTALL_BUSY');
  installing = true;
  let stage: string | undefined;
  let backup: string | undefined;
  let replaced = false;
  try {
    await mkdir(dirname(resolve(input.destination)), { recursive: true });
    const destinationRoot = join(
      await realpath(dirname(resolve(input.destination))),
      basename(input.destination),
    );
    stage = `${destinationRoot}.staging-${randomUUID()}`;
    backup = `${destinationRoot}.previous-${randomUUID()}`;
    await inspectOcrBundle(input.bundle, input.digest);
    if (input.signal?.aborted) throw new Error('OCR_INSTALL_CANCELLED');
    await mkdir(stage, { recursive: true });
    for (const name of ['ocr-runtime.json', ...FILES]) {
      const destination = join(stage, name);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(input.bundle, name), destination);
      if (input.signal?.aborted) throw new Error('OCR_INSTALL_CANCELLED');
    }
    // Copy itself can race source changes. Verify against the pinned manifest again before executing.
    await inspectOcrBundle(stage, input.digest);
    verifyOcrRuntime(stage);
    const version = await runIsolatedProcess({
      executable: join(stage, 'bin/tesseract'),
      args: ['--version'],
      readPaths: [stage],
      writeDirectory: stage,
      timeoutMs: 5000,
      signal: input.signal,
    });
    if (!version.includes('tesseract 5.5.1')) throw new Error('OCR_ENGINE_PROBE_FAILED');
    const recognized = await runIsolatedProcess({
      executable: join(stage, 'bin/tesseract'),
      args: [
        join(stage, 'probe.pgm'),
        'stdout',
        '--tessdata-dir',
        join(stage, 'tessdata'),
        '-l',
        'chi_sim+eng',
        '--psm',
        '7',
      ],
      readPaths: [stage],
      writeDirectory: stage,
      timeoutMs: 30_000,
      signal: input.signal,
    });
    if (recognized.trim() !== 'HELLO') throw new Error('OCR_ENGINE_PROBE_FAILED');
    try {
      await rename(destinationRoot, backup);
      replaced = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await rename(stage, destinationRoot);
    } catch (error) {
      if (replaced) await rename(backup, destinationRoot);
      throw error;
    }
    await rm(backup, { recursive: true, force: true });
  } finally {
    installing = false;
    if (stage) await rm(stage, { recursive: true, force: true });
  }
}
