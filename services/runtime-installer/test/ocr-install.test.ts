import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { inspectOcrBundle, installOcrBundle } from '../src/ocr-install.js';
let root: string, bundle: string, digest: string;
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'evowork-ocr-install-')));
  bundle = join(root, 'bundle');
  const files: Record<string, string> = {};
  for (const name of [
    'bin/tesseract',
    'bin/image-decoder',
    'tessdata/eng.traineddata',
    'tessdata/chi_sim.traineddata',
    'tessdata/osd.traineddata',
    'NOTICE',
    'probe.pgm',
    'licenses/Tesseract-Apache-2.0.txt',
    'licenses/Leptonica-BSD.txt',
  ]) {
    const path = join(bundle, name);
    mkdirSync(dirname(path), { recursive: true });
    // A fake engine here tests installer rollback only; verify-ocr.mjs tests real recognition.
    const bytes =
      name === 'bin/tesseract'
        ? '#!/usr/bin/perl\nprint $ARGV[0] eq "--version" ? "tesseract 5.5.1\\n" : "HELLO\\n";\n'
        : 'fixture';
    writeFileSync(path, bytes, { mode: 0o755 });
    files[name] = hash(bytes);
  }
  const manifest = JSON.stringify({
    platform: `${process.arch}-${process.platform}`,
    version: '5.5.1',
    files,
  });
  writeFileSync(join(bundle, 'ocr-runtime.json'), manifest);
  digest = hash(manifest);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
it('requires a separately pinned manifest and rejects a modified file before executing it', async () => {
  await expect(inspectOcrBundle(bundle, digest)).resolves.toHaveProperty('bytes');
  await expect(inspectOcrBundle(bundle, '0'.repeat(64))).rejects.toThrow('CHECKSUM');
  writeFileSync(join(bundle, 'tessdata/chi_sim.traineddata'), 'modified');
  await expect(
    installOcrBundle({ bundle, digest, destination: join(root, 'installed') }),
  ).rejects.toThrow('CHECKSUM');
  expect(existsSync(join(root, 'installed'))).toBe(false);
});
it('validates in staging and preserves an existing runtime on a failed probe', async () => {
  const target = join(root, 'installed');
  mkdirSync(target);
  writeFileSync(join(target, 'existing'), 'keep');
  const engine = join(bundle, 'bin/tesseract');
  writeFileSync(engine, '#!/usr/bin/perl\nprint "wrong version\\n";\n', { mode: 0o755 });
  const manifest = JSON.parse(readFileSync(join(bundle, 'ocr-runtime.json'), 'utf8')) as {
    files: Record<string, string>;
  };
  manifest.files['bin/tesseract'] = hash(readFileSync(engine));
  const data = JSON.stringify(manifest);
  writeFileSync(join(bundle, 'ocr-runtime.json'), data);
  await expect(
    installOcrBundle({ bundle, digest: hash(data), destination: target }),
  ).rejects.toThrow(
    process.platform === 'darwin' ? 'OCR_ENGINE_PROBE_FAILED' : 'SANDBOX_UNAVAILABLE',
  );
  expect(readFileSync(join(target, 'existing'), 'utf8')).toBe('keep');
});
