import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  installOfficeRuntime,
  officeRoot,
  stagingRoot,
  type InstallProgress,
  type RunFn,
} from '../src/install.js';
import { FONT_FILE_NAME } from '../src/manifest.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'evowork-home-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

/** 假下载：把内容写到目标路径，不校验（校验在 download.test.ts 里单独测） */
const fakeDownload = (async (_asset, dest) => {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, 'fake');
}) as unknown as NonNullable<Parameters<typeof installOfficeRuntime>[0]>['downloadFn'];

/**
 * 假子进程。**它必须真的产生副作用**（建出解释器、建出字体文件），
 * 否则测的只是"函数被调用了"，而安装器真正的失败模式是"文件没出现在该在的地方"。
 */
function makeRun(
  overrides: {
    readonly pipCode?: number;
    readonly pipStderr?: string;
    readonly fontCode?: number;
    readonly verifyStdout?: string;
    readonly verifyCode?: number;
    readonly skipInterpreter?: boolean;
  } = {},
): RunFn & { readonly calls: string[][] } {
  const calls: string[][] = [];
  const run: RunFn = async (file, args) => {
    calls.push([file, ...args]);

    if (file === 'tar') {
      // 模拟 install_only 的布局：解出一个 `python/` 顶层目录
      const dest = args[args.indexOf('-C') + 1] as string;
      if (!overrides.skipInterpreter) {
        mkdirSync(join(dest, 'python', 'bin'), { recursive: true });
        writeFileSync(join(dest, 'python', 'bin', 'python3'), '#!/bin/sh\n');
        mkdirSync(join(dest, 'python', 'lib'), { recursive: true });
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args.includes('pip')) {
      return { code: overrides.pipCode ?? 0, stdout: '', stderr: overrides.pipStderr ?? '' };
    }
    if (args.includes('-m') && args.some((a) => a.includes('fontTools'))) {
      const out = args[args.indexOf('-o') + 1] as string;
      if ((overrides.fontCode ?? 0) === 0) writeFileSync(out, 'font');
      return { code: overrides.fontCode ?? 0, stdout: '', stderr: '' };
    }
    // 验收脚本
    return {
      code: overrides.verifyCode ?? 0,
      stdout: overrides.verifyStdout ?? '{"font": true}',
      stderr: '',
    };
  };
  return Object.assign(run, { calls });
}

const base = (run: RunFn) => ({
  home,
  platformKey: 'arm64-darwin',
  downloadFn: fakeDownload,
  runFn: run,
});

describe('安装成功的那条路', () => {
  it('装完之后解释器与字体都在最终目录里，staging 已清掉', async () => {
    const result = await installOfficeRuntime(base(makeRun()));

    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    const root = officeRoot(home);
    expect(existsSync(join(root, 'bin', 'python3')), '解释器要在扩展根下').toBe(true);
    expect(existsSync(join(root, 'fonts', FONT_FILE_NAME)), '字体要跟着扩展走').toBe(true);
    expect(existsSync(stagingRoot(home)), 'staging 必须清掉').toBe(false);
    // `python/` 那一层被摊平了 —— 不摊平的话探针在 `<root>/bin/python3` 找不到解释器
    expect(existsSync(join(root, 'python')), '中间层要被摊平').toBe(false);
  });

  it('可变字体不留在盘上：留着会被登记成同名但偏细的家族，选中哪份取决于扫描顺序', async () => {
    await installOfficeRuntime(base(makeRun()));
    expect(existsSync(join(officeRoot(home), 'fonts', 'NotoSansSC-Variable.ttf'))).toBe(false);
  });

  it('进度单调不减，且以 done/100 收尾', async () => {
    const seen: InstallProgress[] = [];
    await installOfficeRuntime({ ...base(makeRun()), onProgress: (p) => seen.push(p) });

    const percents = seen.map((p) => p.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(seen.at(-1)?.phase).toBe('done');
    expect(seen.at(-1)?.percent).toBe(100);
  });

  /**
   * 原子换入：升级时旧目录不能出现"删了还没换上"的空窗 ——
   * 那个窗口里正在跑的技能会以"没装扩展"失败。
   */
  it('已经装过时是替换，不是先删后装', async () => {
    mkdirSync(join(officeRoot(home), 'bin'), { recursive: true });
    writeFileSync(join(officeRoot(home), 'bin', 'python3'), 'old');
    writeFileSync(join(officeRoot(home), 'MARKER-OLD'), '1');

    const result = await installOfficeRuntime(base(makeRun()));

    expect(result.ok).toBe(true);
    expect(existsSync(join(officeRoot(home), 'MARKER-OLD')), '旧目录该被整体换掉').toBe(false);
    expect(existsSync(join(officeRoot(home), 'bin', 'python3'))).toBe(true);
    // 换下来的旧目录不能留在盘上占空间
    expect(existsSync(`${officeRoot(home)}.old`)).toBe(false);
  });
});

describe('每一种失败都说人话，而且说的是不同的话', () => {
  it('不支持的平台：不试着装一个没人验证过的东西', async () => {
    const result = await installOfficeRuntime({
      ...base(makeRun()),
      platformKey: 'mips-aix',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('UNSUPPORTED_PLATFORM');
    expect(result.message).toContain('mips-aix');
  });

  it('pip 被公司代理挡住：指向"换网络或用离线包"，不说成磁盘问题', async () => {
    const result = await installOfficeRuntime(
      base(makeRun({ pipCode: 1, pipStderr: 'ProxyError: Cannot connect to proxy' })),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('PACKAGES');
    expect(result.message).toContain('离线');
  });

  it('磁盘满了就说磁盘满了 —— 认不出来时给退出码，不编一个原因', async () => {
    const full = await installOfficeRuntime(
      base(makeRun({ pipCode: 1, pipStderr: 'OSError: [Errno 28] No space left on device' })),
    );
    expect(full.ok).toBe(false);
    if (!full.ok) expect(full.message).toContain('磁盘空间');

    const unknown = await installOfficeRuntime(
      base(makeRun({ pipCode: 7, pipStderr: 'something we have never seen' })),
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.message).toContain('7');
  });

  /**
   * 验收失败是"装完了但不能用"，与"没装上"是两回事：
   * 它意味着有 bug 或有安全软件在拦，所以文案要把人引向日志而不是引向重装。
   */
  it('模块 import 不动：报 VERIFY，且最终目录不被污染', async () => {
    const result = await installOfficeRuntime(base(makeRun({ verifyCode: 1 })));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('VERIFY');
    expect(existsSync(officeRoot(home)), '验收没过就不该换入').toBe(false);
  });

  it('字体装进去了但家族名不对：也算验收失败，不放它过去', async () => {
    const result = await installOfficeRuntime(base(makeRun({ verifyStdout: '{"font": false}' })));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('VERIFY');
    expect(result.message).toContain('Noto Sans SC');
  });

  it('解包出来没有解释器：报 EXTRACT，不留半截目录', async () => {
    const result = await installOfficeRuntime(base(makeRun({ skipInterpreter: true })));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toBe('EXTRACT');
    expect(existsSync(stagingRoot(home))).toBe(false);
  });

  it('任何一步失败都不留 staging —— 留着会把下一次安装锁死一小时', async () => {
    await installOfficeRuntime(base(makeRun({ fontCode: 1 })));
    expect(existsSync(stagingRoot(home))).toBe(false);
  });
});

describe('别装两遍', () => {
  it('staging 还在（另一次安装正在跑）时直接返回 BUSY', async () => {
    mkdirSync(stagingRoot(home), { recursive: true });
    const result = await installOfficeRuntime(base(makeRun()));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('BUSY');
  });

  /**
   * 崩溃留下的 staging 不能把锁永远焊死 —— 否则用户点一次安装崩了之后，
   * 剩下的一小时里每次点都只会看到"已经在安装了"。
   */
  it('一小时前留下的残骸视为崩溃残留，清掉继续装', async () => {
    const stale = stagingRoot(home);
    mkdirSync(stale, { recursive: true });
    const { utimes } = await import('node:fs/promises');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    const result = await installOfficeRuntime(base(makeRun()));
    expect(result.ok, result.ok ? '' : result.message).toBe(true);
  });
});

describe('离线安装（企业部署）', () => {
  function makeBundle(): string {
    const bundle = join(home, 'bundle');
    mkdirSync(join(bundle, 'wheels'), { recursive: true });
    writeFileSync(join(bundle, 'python-aarch64-apple-darwin.tar.gz'), 'x');
    writeFileSync(join(bundle, 'NotoSansSC.ttf'), 'x');
    return bundle;
  }

  /**
   * 这条是企业部署的验收标准：**拔了网线也要能装上**。
   * `downloadFn` 故意换成一个"一被调用就失败"的实现 ——
   * 只要离线路径上还有任何一次网络调用，这条就会红。
   */
  it('给了离线包就一个字节都不出网', async () => {
    const exploding = (async () => {
      throw new Error('离线安装路径上不该有任何下载');
    }) as unknown as typeof fakeDownload;

    const result = await installOfficeRuntime({
      ...base(makeRun()),
      downloadFn: exploding,
      bundleDir: makeBundle(),
    });

    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (result.ok) expect(result.offline).toBe(true);
  });

  it('pip 走 --no-index --find-links，不去 PyPI', async () => {
    const run = makeRun();
    await installOfficeRuntime({ ...base(run), bundleDir: makeBundle() });

    const pip = run.calls.find((c) => c.includes('pip'));
    expect(pip).toBeDefined();
    expect(pip).toContain('--no-index');
    expect(pip).toContain('--find-links');
  });

  it('离线包缺东西时说清缺哪个文件，别让管理员去猜', async () => {
    const bundle = join(home, 'empty-bundle');
    mkdirSync(bundle, { recursive: true });
    const result = await installOfficeRuntime({ ...base(makeRun()), bundleDir: bundle });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('python-aarch64-apple-darwin.tar.gz');
  });
});
