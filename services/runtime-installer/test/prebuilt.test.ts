import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installOfficeRuntime,
  officeRoot,
  RUNTIME_BUNDLE_FILE,
  RUNTIME_STAMP_FILE,
  runtimeBundleMetadata,
  runtimeStampStatus,
  stagingRoot,
} from '../src/install.js';
import { FONT_FILE_NAME, RUNTIME_MANIFEST_DIGEST } from '../src/manifest.js';

let home: string;
let source: string;
const windows = process.platform === 'win32';
const platformKey = windows ? 'x64-win32' : 'arm64-darwin';
const interpreter = windows ? 'python.exe' : 'bin/python3';
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'evowork-prebuilt-'));
  source = join(home, 'app resources', 'office');
  mkdirSync(join(source, 'bin'), { recursive: true });
  mkdirSync(join(source, 'fonts'));
  if (windows) writeFileSync(join(source, interpreter), 'interpreter');
  else {
    writeFileSync(join(source, 'bin/python3.12'), 'interpreter');
    symlinkSync('python3.12', join(source, interpreter));
  }
  writeFileSync(join(source, 'fonts', FONT_FILE_NAME), 'font');
  writeFileSync(join(source, RUNTIME_BUNDLE_FILE), runtimeBundleMetadata(platformKey));
  writeFileSync(
    join(source, RUNTIME_STAMP_FILE),
    JSON.stringify({ manifestDigest: RUNTIME_MANIFEST_DIGEST }),
  );
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const noDownload = vi.fn(async () => {
  throw new Error('用户部署不能下载');
});
const verifyOnly = vi.fn(async (_file: string, args: readonly string[]) => {
  if (!args.includes('-c')) throw new Error('用户部署不能运行 pip/字体处理');
  return { code: 0, stdout: '{"font": true}', stderr: '' };
});
const options = () => ({
  home,
  platformKey,
  prebuiltRuntimeDir: source,
  downloadFn: noDownload,
  runFn: verifyOnly,
});

describe('部署随包完整成品', () => {
  it('干净机器只复制和验收，保留平台解释器布局，零下载、零 pip', async () => {
    noDownload.mockClear();
    verifyOnly.mockClear();
    const phases: number[] = [];
    const result = await installOfficeRuntime({
      ...options(),
      onProgress: (p) => phases.push(p.percent),
    });
    expect(result).toMatchObject({ ok: true, offline: true });
    expect(readFileSync(join(officeRoot(home), interpreter), 'utf8')).toBe('interpreter');
    expect(readFileSync(join(source, interpreter), 'utf8')).toBe('interpreter');
    if (!windows) expect(readlinkSync(join(officeRoot(home), interpreter))).toBe('python3.12');
    expect(existsSync(stagingRoot(home))).toBe(false);
    expect(phases).toEqual([0, 90, 100]);
    expect(noDownload).not.toHaveBeenCalled();
    expect(verifyOnly).toHaveBeenCalledTimes(1);
  });

  it('自动部署使用应用数据目录，不写入系统默认运行时位置', async () => {
    const target = join(home, 'custom-app-data', 'runtime', 'office');
    const result = await installOfficeRuntime({ ...options(), runtimeRoot: target });
    expect(result).toMatchObject({ ok: true, interpreter: join(target, interpreter) });
    expect(existsSync(officeRoot(home))).toBe(false);
    expect(existsSync(`${target}.staging`)).toBe(false);
    expect(runtimeStampStatus(undefined, target)).toBe('current');
  });

  it.each(['missing', 'platform', 'digest', 'external-link', 'absolute-link'])(
    '成品 %s 时拒绝部署，不尝试网络或覆盖旧环境',
    async (reason) => {
      mkdirSync(officeRoot(home), { recursive: true });
      writeFileSync(join(officeRoot(home), 'old'), 'keep');
      if (reason === 'missing') await rm(source, { recursive: true });
      if (reason === 'platform')
        writeFileSync(join(source, RUNTIME_BUNDLE_FILE), runtimeBundleMetadata('x64-darwin'));
      if (reason === 'digest') writeFileSync(join(source, RUNTIME_STAMP_FILE), '{}');
      if (reason === 'external-link') {
        const outside = join(home, 'outside');
        mkdirSync(outside);
        symlinkSync(outside, join(source, 'outside'), windows ? 'junction' : 'dir');
      }
      if (reason === 'absolute-link')
        symlinkSync(join(source, 'fonts'), join(source, 'absolute'), windows ? 'junction' : 'dir');
      const result = await installOfficeRuntime(options());
      expect(result).toMatchObject({ ok: false, failure: 'VERIFY' });
      expect(readFileSync(join(officeRoot(home), 'old'), 'utf8')).toBe('keep');
      expect(existsSync(stagingRoot(home))).toBe(false);
    },
  );

  it('验收失败保留旧环境，并清理本次 staging', async () => {
    mkdirSync(officeRoot(home), { recursive: true });
    writeFileSync(join(officeRoot(home), 'old'), 'keep');
    const result = await installOfficeRuntime({
      ...options(),
      runFn: async () => ({ code: 1, stdout: '', stderr: 'bad module' }),
    });
    expect(result).toMatchObject({ ok: false, failure: 'VERIFY' });
    expect(existsSync(join(officeRoot(home), 'old'))).toBe(true);
    expect(existsSync(stagingRoot(home))).toBe(false);
  });

  it('验收完成时取消也不换入', async () => {
    const abort = new AbortController();
    const result = await installOfficeRuntime({
      ...options(),
      signal: abort.signal,
      runFn: async () => {
        abort.abort();
        return { code: 1, stdout: '', stderr: 'AbortError' };
      },
    });
    expect(result).toMatchObject({ ok: false, failure: 'ABORTED' });
    expect(existsSync(officeRoot(home))).toBe(false);
  });
});
