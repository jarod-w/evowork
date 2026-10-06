#!/usr/bin/env node
/** Release tooling, never a user-machine compiler. Fixed upstream assets; no document input. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(process.arch)) {
  throw new Error('OCR release builds currently support native macOS arm64/x64 only.');
}
const work = resolve(option('--work', join(ROOT, 'dist/ocr-build')));
const cmake = option('--cmake', 'cmake');
const sources = JSON.parse(
  readFileSync(join(ROOT, 'services/runtime-installer/src/ocr-sources.json'), 'utf8'),
);
const offline = args.includes('--offline');
mkdirSync(work, { recursive: true });
for (const [name, asset] of Object.entries(sources)) {
  const file = join(work, name);
  if (!existsSync(file)) {
    if (offline) throw new Error(`Missing offline build asset: ${name}`);
    const response = await fetch(asset.url, {
      signal: AbortSignal.timeout(60_000),
      credentials: 'omit',
    });
    if (!response.ok) throw new Error(`Asset download status ${response.status}`);
    const data = Buffer.from(await response.arrayBuffer());
    if (
      data.length !== asset.bytes ||
      createHash('sha256').update(data).digest('hex') !== asset.sha256
    )
      throw new Error(`Asset checksum: ${name}`);
    writeFileSync(file, data);
  }
  const data = readFileSync(file);
  if (
    data.length !== asset.bytes ||
    createHash('sha256').update(data).digest('hex') !== asset.sha256
  )
    throw new Error(`Asset checksum: ${name}`);
}
const runtime = join(work, 'runtime');
const run = (command, parameters) =>
  execFileSync(command, parameters, { stdio: 'inherit', cwd: work });
for (const source of ['leptonica', 'tesseract'])
  run('/usr/bin/tar', ['-xzf', join(work, `${source}.tar.gz`)]);
const configure = (name, version, switches) =>
  run(cmake, [
    '-S',
    join(work, `${name}-${version}`),
    '-B',
    join(work, `${name}-build`),
    `-DCMAKE_INSTALL_PREFIX=${runtime}`,
    `-DCMAKE_PREFIX_PATH=${runtime}`,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DCMAKE_OSX_DEPLOYMENT_TARGET=14.4',
    '-DBUILD_SHARED_LIBS=OFF',
    ...switches,
  ]);
configure('leptonica', '1.85.0', [
  '-DBUILD_PROG=OFF',
  ...['PNG', 'JPEG', 'TIFF', 'GIF', 'WEBP', 'OPENJPEG', 'ZLIB'].map(
    (name) => `-DENABLE_${name}=OFF`,
  ),
]);
run(cmake, ['--build', join(work, 'leptonica-build'), '--parallel', '4']);
run(cmake, ['--install', join(work, 'leptonica-build')]);
const sdk = execFileSync('/usr/bin/xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
configure('tesseract', '5.5.1', [
  '-DBUILD_TRAINING_TOOLS=OFF',
  '-DBUILD_TESTS=OFF',
  '-DOPENMP_BUILD=OFF',
  '-DDISABLE_CURL=ON',
  '-DDISABLE_ARCHIVE=ON',
  '-DDISABLE_TIFF=ON',
  '-DGRAPHICS_DISABLED=ON',
  '-DENABLE_NATIVE=OFF',
  `-DCMAKE_CXX_FLAGS=-I${sdk}/usr/include/c++/v1`,
]);
run(cmake, ['--build', join(work, 'tesseract-build'), '--parallel', '4']);
run(cmake, ['--install', join(work, 'tesseract-build')]);
const bundle = join(work, `ocr-${process.arch}-darwin`);
rmSync(bundle, { recursive: true, force: true });
mkdirSync(join(bundle, 'bin'), { recursive: true });
mkdirSync(join(bundle, 'tessdata'), { recursive: true });
mkdirSync(join(bundle, 'licenses'), { recursive: true });
copyFileSync(join(runtime, 'bin/tesseract'), join(bundle, 'bin/tesseract'));
chmodSync(join(bundle, 'bin/tesseract'), 0o755);
run('/usr/bin/xcrun', [
  'swiftc',
  '-O',
  '-target',
  `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.4`,
  '-module-cache-path',
  join(work, 'swift-cache'),
  join(ROOT, 'services/ingest/src/native/image-decoder.swift'),
  '-o',
  join(bundle, 'bin/image-decoder'),
]);
for (const name of ['eng', 'chi_sim', 'osd'])
  copyFileSync(join(work, `${name}.traineddata`), join(bundle, `tessdata/${name}.traineddata`));
copyFileSync(
  join(work, 'tesseract-5.5.1/LICENSE'),
  join(bundle, 'licenses/Tesseract-Apache-2.0.txt'),
);
copyFileSync(
  join(work, 'leptonica-1.85.0/leptonica-license.txt'),
  join(bundle, 'licenses/Leptonica-BSD.txt'),
);
// tessdata_fast uses the same Apache-2.0 license, with upstream identity retained here.
writeFileSync(
  join(bundle, 'NOTICE'),
  'Tesseract 5.5.1 (tesseract-ocr), Leptonica 1.85.0 (Dan Bloomberg), tessdata_fast 87416418657359cb625c412a48b6e1d6d41c29bd.\nNative CLI reads PNM; images use the native decoder; PDF rendering uses the explicitly installed office Python/PDFium.\n',
);
// A release-owned PGM smoke sample exercises the engine and the two language packs offline.
const glyphs = {
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
};
const probe = Buffer.alloc(440 * 164, 255);
for (const [letterIndex, letter] of Array.from('HELLO').entries())
  for (let y = 0; y < 7; y++)
    for (let x = 0; x < 5; x++)
      if (glyphs[letter][y][x] === '1')
        for (let dy = 0; dy < 12; dy++)
          for (let dx = 0; dx < 12; dx++)
            probe[(40 + y * 12 + dy) * 440 + 40 + letterIndex * 72 + x * 12 + dx] = 0;
writeFileSync(join(bundle, 'probe.pgm'), Buffer.concat([Buffer.from('P5\n440 164\n255\n'), probe]));
const files = {};
let bytes = 0;
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
  const data = readFileSync(join(bundle, name));
  files[name] = createHash('sha256').update(data).digest('hex');
  bytes += data.length;
}
const version = execFileSync(join(bundle, 'bin/tesseract'), ['--version'], { encoding: 'utf8' });
if (!version.startsWith('tesseract 5.5.1')) throw new Error('Unexpected engine version');
const dependencies = execFileSync('/usr/bin/otool', ['-L', join(bundle, 'bin/tesseract')], {
  encoding: 'utf8',
});
if (
  dependencies
    .split('\n')
    .slice(1)
    .some((line) => line.trim() && !line.trim().startsWith('/usr/lib/'))
)
  throw new Error('OCR binary contains a non-system dylib dependency');
writeFileSync(
  join(bundle, 'ocr-runtime.json'),
  JSON.stringify(
    { version: '5.5.1', platform: `${process.arch}-darwin`, files, bytes, sources },
    null,
    2,
  ) + '\n',
);
console.log(
  JSON.stringify({ bundle, bytes, platform: `${process.arch}-darwin`, releaseVerified: false }),
);
