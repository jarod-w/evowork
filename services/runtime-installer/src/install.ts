/**
 * 办公扩展的安装编排（08 §4「按需下载」的实现处）。
 *
 * ```
 * ① 下 python 发行版 → ② 解包 → ③ pip 装六个包 → ④ 下字体并切静态实例 → ⑤ 验收 → ⑥ 原子换入
 * ```
 *
 * ## 在此之前这里是空的
 *
 * 08 §4 决定"按需下载"是 2026-09-03 的事，但下载器一直没写。表现是：引导页第 ⑤ 步的
 * `runtimeInstalled` 硬编码成 `false`，Word / Excel / PPT / PDF 在**任何一台干净机器上
 * 都不可用**，而用户没有任何出路 —— 唯一的装法写在 `docs/build-and-deploy.md` 里，
 * 需要用户自己装 uv 再敲两条命令。这个文件是把那两条命令变成一个按钮。
 *
 * ## 四条把"能装上"变成"装得对"的规则
 *
 * 1. **原子换入。** 全程装在 `office.staging/`，只有验收通过才 rename 成 `office/`。
 *    半截的目录比没有更糟：`resolveOfficeInterpreter` 只看解释器文件在不在，
 *    一个装了一半的目录会被判成"装好了"，然后每次生成产物都以奇怪的方式失败。
 * 2. **验收是真的跑一遍。** 不是"文件都在"，是用装出来的解释器 import 那六个模块、
 *    并且让 matplotlib 真的把字体登记出 `Noto Sans SC` 这个家族名 ——
 *    `plugins/skills/charts` 在用户机器上就是这么找字体的，验收要走同一条路。
 * 3. **失败有类型，且都能说人话。** 网络断了、代理改写了内容、磁盘满了、平台不支持，
 *    这四件事用户要做的动作完全不同，合并成一句"安装失败"等于让他们去猜。
 * 4. **离线包一个字节都不出网**（§3 / K6）。`EVOWORK_OFFICE_BUNDLE` 指向一个事先打好的目录时，
 *    python 从那里解包、pip 用 `--no-index --find-links` 装本地 wheel、字体也从那里拿。
 *    这条路径在断网的机器上必须能走完 —— 企业部署的验收标准就是"拔网线还能装上"。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { OFFICE_RUNTIME_DIR } from '@evowork/ingest/runtime.js';
import { errorFields, type Logger } from '@evowork/logging';

import { downloadAsset, DownloadError } from './download.js';
import {
  FONT_ASSET,
  FONT_FAMILY,
  FONT_FILE_NAME,
  FONT_WEIGHT_AXIS,
  PYTHON_ASSETS,
  REQUIREMENTS,
  totalDownloadBytes,
  TRIPLE_BY_PLATFORM,
} from './manifest.js';

/* ───────────────────────────── 对外契约 ───────────────────────────── */

/**
 * 安装阶段。**给用户看的是它，不是百分比** —— 一个卡在 62% 的进度条什么也没说明，
 * 而"正在安装 Python 包"至少让人知道现在在等什么、大概还要多久。
 */
export type InstallPhase =
  | 'download-python'
  | 'extract-python'
  | 'install-packages'
  | 'download-font'
  | 'build-font'
  | 'verify'
  | 'done';

export const PHASE_LABEL: Readonly<Record<InstallPhase, string>> = Object.freeze({
  'download-python': '正在下载运行时',
  'extract-python': '正在解包',
  'install-packages': '正在安装文档处理组件',
  'download-font': '正在下载中文字体',
  'build-font': '正在处理字体',
  verify: '正在验证',
  done: '完成',
});

/**
 * 每个阶段占总进度的权重。加起来是 1。
 *
 * 只有 `download-python` 与 `download-font` 能给出真实的字节进度，其余三个是
 * "开始了/结束了"两个点。所以进度条在那三段里是**匀速假动作** —— 这是可以接受的，
 * 因为阶段名同时在变；不可接受的是让它停在某个数字上一动不动。
 */
const PHASE_WEIGHT: Readonly<Record<InstallPhase, number>> = Object.freeze({
  'download-python': 0.4,
  'extract-python': 0.1,
  'install-packages': 0.25,
  'download-font': 0.12,
  'build-font': 0.08,
  verify: 0.05,
  done: 0,
});

export interface InstallProgress {
  readonly phase: InstallPhase;
  /** 0–100，整体进度 */
  readonly percent: number;
  /** 这一阶段的补充说明（如 "18.2 / 25.1 MB"）。没有就不填 */
  readonly detail?: string | undefined;
}

/**
 * 失败原因。**每一种对应一个不同的用户动作**，所以不合并：
 *
 *   · `UNSUPPORTED_PLATFORM` —— 换机器（或等我们支持）
 *   · `DOWNLOAD` / `CHECKSUM` —— 换网络重试 / 用离线包
 *   · `EXTRACT` / `DISK` —— 清磁盘
 *   · `PACKAGES` —— 多半是公司代理挡了 PyPI
 *   · `VERIFY` —— 装完了但不能用，这是 bug，要看日志
 *   · `BUSY` —— 已经在装了，别点第二次
 */
export type InstallFailure =
  | 'UNSUPPORTED_PLATFORM'
  | 'DOWNLOAD'
  | 'CHECKSUM'
  | 'EXTRACT'
  | 'PACKAGES'
  | 'FONT'
  | 'VERIFY'
  | 'ABORTED'
  | 'BUSY';

export type InstallResult =
  | {
      readonly ok: true;
      /** 装好的解释器绝对路径。宿主拿它去 `probe.invalidate()` 之后重新探测 */
      readonly interpreter: string;
      /** 走的是离线包还是下载 —— 记一条，省得事后分不清用户是怎么装上的 */
      readonly offline: boolean;
    }
  | {
      readonly ok: false;
      readonly failure: InstallFailure;
      /** 直接可以显示给用户的一句话。**不含技术堆栈** */
      readonly message: string;
    };

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type RunFn = (
  file: string,
  args: readonly string[],
  options?: { readonly cwd?: string | undefined; readonly signal?: AbortSignal | undefined },
) => Promise<RunResult>;

export interface InstallOptions {
  readonly home?: string | undefined;
  readonly platformKey?: string | undefined;
  readonly onProgress?: ((progress: InstallProgress) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly logger?: Logger | undefined;
  /**
   * 离线包目录（企业部署，§3）。给了就**完全不出网**。
   *
   * 目录结构由 `scripts/build-office-bundle.mjs` 产出：
   * ```
   * <bundle>/python-<triple>.tar.gz
   * <bundle>/wheels/*.whl
   * <bundle>/NotoSansSC.ttf
   * ```
   */
  readonly bundleDir?: string | undefined;
  /** 注入以便测试。**默认是真的下载 / 真的起进程** */
  readonly downloadFn?: typeof downloadAsset | undefined;
  readonly runFn?: RunFn | undefined;
}

/* ───────────────────────────── 路径 ───────────────────────────── */

export function officeRoot(home: string = homedir()): string {
  return join(home, OFFICE_RUNTIME_DIR);
}

/** 装到一半的目录。**与最终目录同级同父**，这样 rename 是同一文件系统内的原子操作 */
export function stagingRoot(home: string = homedir()): string {
  return `${officeRoot(home)}.staging`;
}

export function fontsDir(root: string): string {
  return join(root, 'fonts');
}

/**
 * 解包后解释器在哪。
 *
 * python-build-standalone 的 `install_only` 解出来是一个 `python/` 目录，我们把它
 * **摊平**到扩展根下，于是 unix 是 `bin/python3`、windows 是 `python.exe`（在根上，
 * 不在 `Scripts/` 里 —— `Scripts/` 放的是 pip.exe 那些）。
 */
function interpreterIn(root: string, platformKey: string): string {
  return platformKey.endsWith('-win32') ? join(root, 'python.exe') : join(root, 'bin', 'python3');
}

/* ───────────────────────────── 主流程 ───────────────────────────── */

export async function installOfficeRuntime(options: InstallOptions = {}): Promise<InstallResult> {
  const home = options.home ?? homedir();
  const platformKey = options.platformKey ?? `${process.arch}-${process.platform}`;
  const triple = TRIPLE_BY_PLATFORM[platformKey];
  const run = options.runFn ?? defaultRun;
  const download = options.downloadFn ?? downloadAsset;
  const offline = options.bundleDir !== undefined;
  const log = options.logger;

  if (triple === undefined) {
    // 不静默降级成"试试看"：不支持的平台上装出来的东西没人验证过
    return {
      ok: false,
      failure: 'UNSUPPORTED_PLATFORM',
      message: `这台设备的系统架构（${platformKey}）暂时没有可用的办公扩展。`,
    };
  }

  const target = officeRoot(home);
  const staging = stagingRoot(home);

  const claimed = await claimStaging(staging);
  if (!claimed) {
    return {
      ok: false,
      failure: 'BUSY',
      message: '已经在安装了，等这次装完再试。',
    };
  }

  const report = makeReporter(options.onProgress);

  try {
    /* ① python 发行版 —— 下载或从离线包取 */
    const archive = join(staging, 'python.tar.gz');
    const totalBytes = totalDownloadBytes(triple);
    if (options.bundleDir !== undefined) {
      const local = join(options.bundleDir, `python-${triple}.tar.gz`);
      if (!existsSync(local)) {
        return fail('DOWNLOAD', `离线包里没有这个平台的运行时（缺 python-${triple}.tar.gz）。`);
      }
      report('download-python', 1, '使用离线包');
      await copyLocal(local, archive);
    } else {
      const asset = PYTHON_ASSETS[triple];
      if (asset === undefined) {
        return fail('UNSUPPORTED_PLATFORM', `清单里没有 ${triple} 的运行时。`);
      }
      try {
        await download(asset, archive, {
          ...(options.signal ? { signal: options.signal } : {}),
          onBytes: (received) =>
            report(
              'download-python',
              received / asset.bytes,
              `${mb(received)} / ${mb(asset.bytes)} MB（共约 ${mb(totalBytes)} MB）`,
            ),
        });
      } catch (err: unknown) {
        return fromDownloadError(err, log);
      }
    }
    if (options.signal?.aborted) return fail('ABORTED', '安装已取消。');

    /* ② 解包并摊平 */
    report('extract-python', 0);
    const extracted = await extractPython(archive, staging, run, options.signal);
    if (!extracted.ok) return fail('EXTRACT', extracted.message);
    await rm(archive, { force: true });
    report('extract-python', 1);

    const python = interpreterIn(staging, platformKey);
    if (!existsSync(python)) {
      return fail(
        'EXTRACT',
        '解包出来的运行时里找不到解释器。这个安装包可能不完整，重试一次；还不行就换离线安装。',
      );
    }

    /* ③ pip 装六个包 */
    report('install-packages', 0, offline ? '从离线包安装' : '从 PyPI 安装');
    const pip = await run(
      python,
      [
        '-m',
        'pip',
        'install',
        '--no-input',
        '--disable-pip-version-check',
        '--no-warn-script-location',
        ...(options.bundleDir !== undefined
          ? ['--no-index', '--find-links', join(options.bundleDir, 'wheels')]
          : []),
        ...REQUIREMENTS,
      ],
      { ...(options.signal ? { signal: options.signal } : {}) },
    );
    if (pip.code !== 0) {
      log?.warn('office.install.pip_failed', { exitCode: pip.code });
      return fail('PACKAGES', pipMessage(pip, offline));
    }
    report('install-packages', 1);

    /* ④ 字体：下载可变字体 → 切成 wght=400 的静态实例 */
    const fonts = fontsDir(staging);
    await mkdir(fonts, { recursive: true });
    const variable = join(fonts, 'NotoSansSC-Variable.ttf');
    if (options.bundleDir !== undefined) {
      const local = join(options.bundleDir, 'NotoSansSC.ttf');
      if (!existsSync(local)) return fail('FONT', '离线包里没有中文字体（缺 NotoSansSC.ttf）。');
      report('download-font', 1, '使用离线包');
      await copyLocal(local, variable);
    } else {
      try {
        await download(FONT_ASSET, variable, {
          ...(options.signal ? { signal: options.signal } : {}),
          onBytes: (received) =>
            report(
              'download-font',
              received / FONT_ASSET.bytes,
              `${mb(received)} / ${mb(FONT_ASSET.bytes)} MB`,
            ),
        });
      } catch (err: unknown) {
        return fromDownloadError(err, log);
      }
    }
    if (options.signal?.aborted) return fail('ABORTED', '安装已取消。');

    report('build-font', 0);
    const instanced = await run(
      python,
      [
        '-m',
        'fontTools.varLib.instancer',
        variable,
        FONT_WEIGHT_AXIS,
        '-o',
        join(fonts, FONT_FILE_NAME),
      ],
      { ...(options.signal ? { signal: options.signal } : {}) },
    );
    if (instanced.code !== 0) {
      log?.warn('office.install.font_failed', { exitCode: instanced.code });
      return fail('FONT', '中文字体处理失败，图表里的中文会显示不正常。重试一次安装。');
    }
    // 可变字体留着没用，而且会被 matplotlib 登记成一个偏细的同名家族 —— 删掉，
    // 否则"按家族名找到的到底是哪一份"取决于扫描顺序
    await rm(variable, { force: true });
    report('build-font', 1);

    /* ⑤ 验收：真的 import，真的登记字体 */
    report('verify', 0);
    const verified = await verify(python, join(fonts, FONT_FILE_NAME), run, options.signal);
    if (!verified.ok) {
      log?.warn('office.install.verify_failed', { reason: verified.reason });
      return fail('VERIFY', verified.message);
    }
    report('verify', 1);

    /* ⑥ 原子换入 */
    await swapIn(staging, target);
    report('done', 1);
    log?.info('office.install.done', { itemCount: REQUIREMENTS.length });
    return { ok: true, interpreter: interpreterIn(target, platformKey), offline };
  } catch (err: unknown) {
    log?.warn('office.install.failed', errorFields(err));
    return {
      ok: false,
      failure: 'EXTRACT',
      message: `安装没能完成：${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }

  function fail(failure: InstallFailure, message: string): InstallResult {
    return { ok: false, failure, message };
  }
}

/* ───────────────────────────── 各步的实现 ───────────────────────────── */

/**
 * 占住 staging 目录 —— 同时也是"别装两遍"的锁。
 *
 * `mkdir` 不带 recursive 时目录已存在会抛 EEXIST，这就是一个免费的原子锁。
 * 但**崩溃留下的目录会把锁永远焊死**，所以超过一小时没动过的 staging 视为残骸清掉：
 * 一小时远长于任何一次正常安装（实测整个流程分钟级）。
 */
async function claimStaging(staging: string): Promise<boolean> {
  /*
   * 父目录要先建出来。**这一行是被测试抓出来的**：不带 recursive 的 mkdir 在父目录
   * 不存在时抛的是 ENOENT，而下面的 catch 把任何异常都当成"已经有人在装了"，
   * 于是**每一台干净机器上的第一次安装**都会返回 BUSY —— 一个从没装过的用户
   * 被告知"已经在安装了"。干净机器恰恰是这个功能唯一要服务的场景。
   */
  await mkdir(dirname(staging), { recursive: true });
  try {
    await mkdir(staging, { recursive: false });
    return true;
  } catch {
    try {
      const info = await stat(staging);
      if (Date.now() - info.mtimeMs < 60 * 60 * 1000) return false;
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: false });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 解包并把 `python/` 摊平到扩展根下。
 *
 * 用 `tar` 而不是 node 的解压库：macOS / Linux 自带，Windows 10 1803 起自带 bsdtar，
 * 而多带一个原生依赖会让 electron 打包与公证都变复杂。代价是它是外部进程 ——
 * 所以退出码要看，`stderr` 要带进错误信息，否则"解包失败"没有任何线索。
 */
async function extractPython(
  archive: string,
  staging: string,
  run: RunFn,
  signal: AbortSignal | undefined,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await run('tar', ['-xzf', archive, '-C', staging], {
    ...(signal ? { signal } : {}),
  });
  if (result.code !== 0) {
    return {
      ok: false,
      message: `解包失败（${result.stderr.trim().slice(0, 160) || `退出码 ${result.code}`}）。磁盘空间不够时也会这样。`,
    };
  }

  // install_only 解出来固定是一个 `python/` 顶层目录；摊平之后
  // `bin/python3` 与 `python.exe` 就落在扩展根上，与 `officeInterpreterPaths` 对齐
  const inner = join(staging, 'python');
  if (!existsSync(inner)) return { ok: true }; // 上游改了布局就照原样留着，让后面的解释器检查去报
  for (const entry of await readdir(inner)) {
    await rename(join(inner, entry), join(staging, entry));
  }
  await rm(inner, { recursive: true, force: true });
  return { ok: true };
}

/**
 * 验收。**两件事都要真的做，不是查文件在不在**：
 *
 * 1. 六个模块 import 得动 —— 这是 `RUNTIME_TIERS.office.probeModules` 加 `jsonschema`，
 *    也就是探针与四个技能各自会去 import 的那一组；
 * 2. matplotlib 能把字体登记成 `Noto Sans SC` —— `plugins/skills/charts` 就是按这个
 *    家族名找字体的。只查 ttf 文件在不在的话，"下到一份家族名不一样的字体"这种情况
 *    要等用户第一次画图才暴露。
 */
async function verify(
  python: string,
  fontPath: string,
  run: RunFn,
  signal: AbortSignal | undefined,
): Promise<{ ok: true } | { ok: false; reason: string; message: string }> {
  const script = [
    'import json',
    'import docx, openpyxl, pptx, pdfplumber, matplotlib, jsonschema',
    'matplotlib.use("Agg")',
    'from matplotlib import font_manager',
    `font_manager.fontManager.addfont(${JSON.stringify(fontPath)})`,
    `names = {f.name for f in font_manager.fontManager.ttflist if f.fname == ${JSON.stringify(fontPath)}}`,
    `print(json.dumps({"font": ${JSON.stringify(FONT_FAMILY)} in names}))`,
  ].join('\n');

  const result = await run(python, ['-c', script], { ...(signal ? { signal } : {}) });
  if (result.code !== 0) {
    return {
      ok: false,
      reason: 'IMPORT',
      message:
        '装完了，但组件没能加载起来。这台机器上的安全软件有时会拦截新装的程序；' +
        '重试一次安装，还不行就把日志发给我们。',
    };
  }
  if (!/"font"\s*:\s*true/.test(result.stdout)) {
    return {
      ok: false,
      reason: 'FONT_FAMILY',
      message: `中文字体装进去了但没能被识别成「${FONT_FAMILY}」，图表里的中文会有问题。重试一次安装。`,
    };
  }
  return { ok: true };
}

/**
 * 原子换入。
 *
 * 先把旧的挪开再 rename 新的，最后才删旧的 —— 顺序反过来的话，"删掉旧的"与
 * "换上新的"之间存在一个**扩展不存在**的时间窗，此时正在跑的技能会以"没装扩展"失败。
 */
async function swapIn(staging: string, target: string): Promise<void> {
  const retired = `${target}.old-${Date.now()}`;
  if (existsSync(target)) await rename(target, retired);
  await rename(staging, target);
  await rm(retired, { recursive: true, force: true });
}

/** 离线包里的文件拷进 staging。不起 `cp`/`copy` 子进程：node 自己来，跨平台没有歧义。 */
async function copyLocal(from: string, to: string): Promise<void> {
  await copyFile(from, to);
}

/* ───────────────────────────── 小工具 ───────────────────────────── */

function makeReporter(
  onProgress: ((progress: InstallProgress) => void) | undefined,
): (phase: InstallPhase, fraction: number, detail?: string) => void {
  const order: readonly InstallPhase[] = [
    'download-python',
    'extract-python',
    'install-packages',
    'download-font',
    'build-font',
    'verify',
    'done',
  ];
  return (phase, fraction, detail) => {
    if (!onProgress) return;
    const before = order
      .slice(0, order.indexOf(phase))
      .reduce((sum, p) => sum + PHASE_WEIGHT[p], 0);
    const percent = Math.min(
      100,
      Math.round((before + PHASE_WEIGHT[phase] * Math.min(1, Math.max(0, fraction))) * 100),
    );
    onProgress({ phase, percent, ...(detail !== undefined ? { detail } : {}) });
  };
}

function mb(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1);
}

function fromDownloadError(err: unknown, log: Logger | undefined): InstallResult {
  if (err instanceof DownloadError) {
    log?.warn('office.install.download_failed', { reason: err.failure });
    /*
     * `STALLED` 归到 `DOWNLOAD`（用户的动作一样：换网络或用离线包），
     * 但 `err.message` 会说清是"停住了"而不是"连不上" —— 这两者查的地方不同。
     */
    return {
      ok: false,
      failure:
        err.failure === 'CHECKSUM'
          ? 'CHECKSUM'
          : err.failure === 'ABORTED'
            ? 'ABORTED'
            : 'DOWNLOAD',
      message: err.message,
    };
  }
  log?.warn('office.install.download_failed', errorFields(err));
  return {
    ok: false,
    failure: 'DOWNLOAD',
    message: `下载失败：${err instanceof Error ? err.message : String(err)}`,
  };
}

/**
 * pip 失败时说人话。
 *
 * 最常见的两种是**公司代理挡了 PyPI**和**磁盘满了**，它们在 stderr 里有明显特征。
 * 认不出来时**如实给退出码**，不编一个原因 —— 编错方向会让人往完全不相干的地方查。
 */
function pipMessage(result: RunResult, offline: boolean): string {
  const stderr = result.stderr.toLowerCase();
  if (offline) {
    return '离线包里的组件不完整，装不上。请让管理员重新打一份离线包。';
  }
  if (/proxy|ssl|certificate|tlsv1|connection|timed out|network/.test(stderr)) {
    return '连不上 Python 包镜像（PyPI）。公司网络常会拦截它 —— 换个网络重试，或者用离线安装包。';
  }
  if (/no space left|disk full/.test(stderr)) {
    return '磁盘空间不够，装不下办公扩展（需要约 400MB）。清理一些空间再试。';
  }
  return `安装组件失败（退出码 ${result.code}）。换个网络重试，或者用离线安装包。`;
}

/** 默认的起进程实现。**输出要收上来**：失败原因全在 stderr 里。 */
const defaultRun: RunFn = (file, args, options) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      {
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options?.signal ? { signal: options.signal } : {}),
        maxBuffer: 16 * 1024 * 1024,
        // pip 会读一堆 PIP_* 环境变量；照搬父进程的环境是对的（企业镜像源就配在那里）
      },
      (err, stdout, stderr) => {
        /*
         * `err.code` 有两种含义：数字是子进程的退出码，字符串是**根本没起来**
         * （`ENOENT` = 找不到可执行文件，比如这台机器没有 tar）。
         * 后者的 stderr 是空的，所以要把 err.message 补进去 ——
         * 不补的话失败信息是一句"退出码 1"，查不出是"没装 tar"。
         */
        const raw: unknown = err === null ? undefined : (err as { code?: unknown }).code;
        const code = typeof raw === 'number' ? raw : err ? 1 : 0;
        const detail = err && typeof raw !== 'number' ? `${err.message}\n` : '';
        resolve({ code, stdout: String(stdout), stderr: detail + String(stderr) });
      },
    );
  });
