/**
 * 下载 + 校验。**这是本仓库里唯一一个为了装扩展而出网的文件**（K6 登记项）。
 *
 * ## 为什么它单独一个包，而不是放进 `services/ingest`
 *
 * `services/ingest` 的身份是"**结构上不出网**"——它的测试会扫源码里的 `fetch(` /
 * `node:http`，扫到就红。那条断言守的是"用户的文件不会被传到云上解析"，是 K6 的核心承诺，
 * 不该为了一个下载器被开一道口子（开了口子之后，下一个人往里加什么就没人拦得住了）。
 *
 * 所以下载这件事被放在**另一个包**里：ingest 那边的扫描因此可以从"手工列的文件名单"
 * 收紧成"整个 src 目录"，承诺反而更强了。
 *
 * ## 这里出网到哪
 *
 *   · `github.com` / `objects.githubusercontent.com` —— python 发行版与字体
 *   · `pypi.org` / `files.pythonhosted.org` —— pip 装那六个包（在 `install.ts` 里由 pip 发起）
 *
 * **它只下载、不上传**：请求里没有用户内容，没有机器标识，没有遥测。企业不许出网时走
 * 离线包（`EVOWORK_OFFICE_BUNDLE`），那条路径一个字节都不出网。
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { RemoteAsset } from './manifest.js';

export interface DownloadOptions {
  /** 收到多少字节了。用于进度条；调用方自己节流 */
  readonly onBytes?: ((received: number) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
  /**
   * **多久没收到字节就判定这条连接死了**（默认 60 秒）。
   *
   * 不是"整个下载的总超时"：慢网上下 110MB 的 linux 运行时花十几分钟是正常的，
   * 给总超时会把慢网用户全部误杀。真正要抓的是**一个字节都不来**的状态。
   *
   * 这一条是 2026-09-07 跑真机 E2E 时撞出来的：连接在 0% 上挂住，测试等满 15 分钟
   * 超时退出，而这期间进度条一直停在 `0.0 / 25.1 MB`。放到用户那里就是
   * "点了安装，然后永远卡在 0%"，而且**没有任何出路** —— 没有报错、没有重试按钮。
   */
  readonly stallTimeoutMs?: number | undefined;
  /** 注入以便测试。**默认是真的 `fetch`** —— 只留注入口不给默认值的话，
   *  生产环境永远走不到真下载那一步（`gateway-process.ts` 踩过这个坑）*/
  readonly fetchFn?: typeof fetch | undefined;
}

/** 下载失败的原因。**分开是因为给用户看的话不一样**：网络问题能重试，校验失败不该重试。 */
export type DownloadFailure = 'NETWORK' | 'HTTP_STATUS' | 'CHECKSUM' | 'ABORTED' | 'STALLED';

export class DownloadError extends Error {
  constructor(
    readonly failure: DownloadFailure,
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

/**
 * 把一个资产下载到 `destPath`，并**边下边算 sha256**。
 *
 * 校验不过就删掉文件再抛 —— 留一个半截的坏文件在盘上，下次安装可能直接用它，
 * 那才是真正难查的故障。这里没有"校验失败但先用着"这条分支。
 */
export async function downloadAsset(
  asset: RemoteAsset,
  destPath: string,
  options: DownloadOptions = {},
): Promise<void> {
  const fetchFn = options.fetchFn ?? fetch;
  const hash = createHash('sha256');
  let received = 0;

  /*
   * 停滞看门狗。把调用方的 signal 与"卡住了"合成一个 —— fetch 与 pipeline 都只认
   * 一个 signal，而我们有两个理由要中止。每收到一块就重置计时器。
   */
  const stallMs = options.stallTimeoutMs ?? 60_000;
  const controller = new AbortController();
  let stalled = false;
  let timer: NodeJS.Timeout | undefined;
  const armStallTimer = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
    // 别让这个计时器把进程吊住：安装失败退出时它可能还在
    timer.unref?.();
  };
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort);
  const cleanup = (): void => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  };

  /** 中止到底是谁引起的 —— 说错了用户就会往错的方向查。 */
  const abortReason = (): DownloadError =>
    stalled
      ? new DownloadError(
          'STALLED',
          `下载停住了（${Math.round(stallMs / 1000)} 秒没有收到数据）。` +
            '网络不通或被中间设备挡住了，换个网络重试，或者用离线安装包。',
        )
      : new DownloadError('ABORTED', '安装已取消。');

  let response: Response;
  try {
    armStallTimer();
    response = await fetchFn(asset.url, { redirect: 'follow', signal: controller.signal });
  } catch (err: unknown) {
    cleanup();
    if (controller.signal.aborted) throw abortReason();
    throw new DownloadError('NETWORK', `连不上下载地址：${describe(err)}`);
  }

  if (!response.ok) {
    cleanup();
    // 带上状态码：403 常常是公司代理挡的，404 是清单过期，两者的处理完全不同
    throw new DownloadError('HTTP_STATUS', `下载失败（HTTP ${response.status}）。`);
  }
  if (!response.body) {
    cleanup();
    throw new DownloadError('NETWORK', '下载失败：响应没有内容。');
  }

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on('data', (chunk: Buffer) => {
    armStallTimer(); // 有数据就续命
    hash.update(chunk);
    received += chunk.byteLength;
    options.onBytes?.(received);
  });

  try {
    await pipeline(source, createWriteStream(destPath), { signal: controller.signal });
  } catch (err: unknown) {
    await rm(destPath, { force: true });
    if (controller.signal.aborted) throw abortReason();
    throw new DownloadError('NETWORK', `下载中断：${describe(err)}`);
  } finally {
    cleanup();
  }

  const actual = hash.digest('hex');
  if (actual !== asset.sha256) {
    await rm(destPath, { force: true });
    throw new DownloadError(
      'CHECKSUM',
      // 不重试：内容与预期不符时重试只会再下一遍同样的东西。
      // 这句话要让用户知道该找谁 —— 多半是代理改写了响应，或者装的是过期的 EvoWork
      '下载到的文件与预期不符，已丢弃。可能是网络中间设备改写了内容，' +
        '或者这个版本的清单已过期。换个网络再试，或改用离线安装包。',
    );
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
