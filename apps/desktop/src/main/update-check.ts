/**
 * 在线升级：检查 · 下载 · 退出并打开安装包（在线升级提案 §4 B4；总纲 Q46 与 D9 的 K6 登记）。
 *
 * ## 什么时候出网（Q46 + Q30）
 *
 * | 触发 | 什么时候发请求 |
 * |---|---|
 * | 用户点「检查更新」 | 发（Q30：显式触发） |
 * | 自动检查 | 每天最多一次，而且**当前登录状态下那个开关开着**才发：已登录默认开、未登录默认关，各自可改 |
 * | 下载 | 只在用户点「下载」时（Q46-4：只提示，不自动下载） |
 * | `EVOWORK_UPDATE_FEED=off` / 没有公钥 | 一个请求都不发，手动点也不发 |
 *
 * 请求里**不带**账号令牌、设备 id、版本号（版本在本机比）：一次检查关联不到任何账号。
 *
 * ## 先验签，再相信清单里的任何一个字
 *
 * 清单 → 按它原始字节的 sha256 取 `signatures/<sha256>.sig` → 验签 → 解析 → 比版本。
 * 没有 Developer ID 之前，应用内下载的文件不带 quarantine 标记、Gatekeeper 不看（提案 §7），
 * 所以签名是唯一的真实性校验：**验不过就停，没有「仍然下载」**。下载完再按清单里的 sha512 校验，
 * 打开安装包之前**再校验一次**（「下载」文件夹里的东西用户、别的程序都能动）。
 *
 * 这里是主进程里唯一为更新出网的模块（K6 登记的「出口」一行）。
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { Logger } from '@evowork/logging';

import type { UpdateQuitImpactView, UpdateStatusView } from '../shared/ipc.js';
import {
  compareVersions,
  manifestNameFor,
  parseUpdateManifest,
  pickPackageFor,
  signatureNameFor,
  verifyUpdateManifest,
  type UpdateManifestFile,
  type UpdatePublicKey,
} from './update-manifest.js';

/** 与 `build/electron-builder.yml` 的 `publish.url`（channel = latest）同一个地址；有测试对着两边 */
export const DEFAULT_UPDATE_FEED = 'https://update.nucleant.cn/latest';
/** Q46-1：每天最多一次 */
export const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** 60 秒收不到字节就判定连接死了（与办公扩展安装同一条经验：没有它，进度条会永远停在某处） */
export const DOWNLOAD_STALL_MS = 60_000;

/* ───────────────────────────── 更新源 ───────────────────────────── */

export type UpdateFeed =
  | { readonly kind: 'on'; readonly baseUrl: string }
  | { readonly kind: 'off' }
  | { readonly kind: 'invalid' };

/**
 * `EVOWORK_UPDATE_FEED`（Q46-6，MDM 下发）：不设 = 官方源；`off` = 关掉；
 * 其余必须是 https 地址（企业内网镜像）。本机回环放行 http，给开发与 E2E 用。
 */
export function updateFeedFrom(env: Readonly<Record<string, string | undefined>>): UpdateFeed {
  const raw = env.EVOWORK_UPDATE_FEED?.trim();
  if (raw === undefined || raw === '') return { kind: 'on', baseUrl: DEFAULT_UPDATE_FEED };
  if (raw.toLowerCase() === 'off') return { kind: 'off' };
  try {
    const url = new URL(raw);
    const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) {
      return { kind: 'on', baseUrl: raw.replace(/\/+$/, '') };
    }
  } catch {
    // 落到下面
  }
  return { kind: 'invalid' };
}

/* ───────────────────────────── 端口 ───────────────────────────── */

export interface UpdateFetchResponse {
  readonly status: number;
  readonly body?: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type UpdateFetch = (
  url: string,
  init: { readonly signal: AbortSignal; readonly headers: Record<string, string> },
) => Promise<UpdateFetchResponse>;

export interface UpdateHostPorts {
  readonly appVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly feed: UpdateFeed;
  readonly keys: readonly UpdatePublicKey[];
  readonly signedIn: () => boolean;
  /** `~/.evowork/update.json`：两个自动检查开关与上次检查时间 */
  readonly prefsPath: string;
  /** 「下载」文件夹（Electron 的 `app.getPath('downloads')`） */
  readonly downloadsDir: () => string;
  readonly fetch: UpdateFetch;
  /** 毫秒 */
  readonly now: () => number;
  readonly openPath: (path: string) => Promise<void>;
  readonly quit: () => void;
  readonly emit: (status: UpdateStatusView) => void;
  readonly quitImpact: () => UpdateQuitImpactView;
  readonly stallMs?: number | undefined;
  readonly logger?: Logger | undefined;
}

interface Offer {
  readonly version: string;
  readonly file: UpdateManifestFile;
  readonly notes: readonly string[];
  readonly baseUrl: string;
}

/** 进程内的状态。不落盘：重启之后从「还没检查」开始，下好的包靠文件本身的校验认回来 */
export interface UpdateRuntime {
  phase: UpdateStatusView['phase'];
  offer?: Offer | undefined;
  percent?: number | undefined;
  receivedBytes?: number | undefined;
  cancelled?: boolean | undefined;
  error?: UpdateStatusView['error'];
  message?: string | undefined;
  downloadedPath?: string | undefined;
  abort?: AbortController | undefined;
}

export function createUpdateRuntime(): UpdateRuntime {
  return { phase: 'idle' };
}

/* ───────────────────────────── 偏好 ───────────────────────────── */

interface UpdatePrefs {
  readonly autoWhenSignedIn: boolean;
  readonly autoWhenSignedOut: boolean;
  readonly lastCheckedAt?: number | undefined;
  readonly lastAutoCheckAt?: number | undefined;
}

export function readUpdatePrefs(ports: Pick<UpdateHostPorts, 'prefsPath'>): UpdatePrefs {
  // Q46-1：已登录默认开；Q46-2：未登录默认关
  const defaults: UpdatePrefs = { autoWhenSignedIn: true, autoWhenSignedOut: false };
  if (!existsSync(ports.prefsPath)) return defaults;
  try {
    const raw = JSON.parse(readFileSync(ports.prefsPath, 'utf8')) as Record<string, unknown>;
    return {
      autoWhenSignedIn: raw.autoWhenSignedIn !== false,
      autoWhenSignedOut: raw.autoWhenSignedOut === true,
      ...(typeof raw.lastCheckedAt === 'number' ? { lastCheckedAt: raw.lastCheckedAt } : {}),
      ...(typeof raw.lastAutoCheckAt === 'number' ? { lastAutoCheckAt: raw.lastAutoCheckAt } : {}),
    };
  } catch {
    return defaults;
  }
}

function writeUpdatePrefs(
  ports: Pick<UpdateHostPorts, 'prefsPath'>,
  patch: Partial<UpdatePrefs>,
): void {
  const next = { ...readUpdatePrefs(ports), ...patch };
  mkdirSync(dirname(ports.prefsPath), { recursive: true });
  writeFileSync(ports.prefsPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

/** 设置页那个开关：改的是**当前登录状态**对应的那一个 */
export function setAutoCheck(
  ports: UpdateHostPorts,
  runtime: UpdateRuntime,
  enabled: boolean,
): UpdateStatusView {
  writeUpdatePrefs(
    ports,
    ports.signedIn() ? { autoWhenSignedIn: enabled } : { autoWhenSignedOut: enabled },
  );
  return publish(ports, runtime);
}

function availability(ports: UpdateHostPorts): UpdateStatusView['availability'] {
  if (ports.feed.kind !== 'on') return ports.feed.kind;
  return ports.keys.length === 0 ? 'no-keys' : 'on';
}

/** 自动检查能不能发请求（不看 24 小时）。Q30：零请求管的是自动 / 后台请求 */
export function canAutoCheck(ports: UpdateHostPorts): boolean {
  if (availability(ports) !== 'on') return false;
  const prefs = readUpdatePrefs(ports);
  return ports.signedIn() ? prefs.autoWhenSignedIn : prefs.autoWhenSignedOut;
}

/* ───────────────────────────── 视图 ───────────────────────────── */

export function updateStatusView(ports: UpdateHostPorts, runtime: UpdateRuntime): UpdateStatusView {
  const prefs = readUpdatePrefs(ports);
  const signedIn = ports.signedIn();
  const offer = runtime.offer;
  return {
    currentVersion: ports.appVersion,
    availability: availability(ports),
    signedIn,
    autoCheck: signedIn ? prefs.autoWhenSignedIn : prefs.autoWhenSignedOut,
    ...(prefs.lastCheckedAt !== undefined ? { lastCheckedAt: prefs.lastCheckedAt } : {}),
    phase: runtime.phase,
    ...(offer
      ? {
          offer: {
            version: offer.version,
            sizeBytes: offer.file.size,
            notes: offer.notes,
            fileName: fileNameOf(offer.file),
          },
        }
      : {}),
    ...(runtime.percent !== undefined ? { percent: runtime.percent } : {}),
    ...(runtime.receivedBytes !== undefined ? { receivedBytes: runtime.receivedBytes } : {}),
    ...(runtime.cancelled ? { cancelled: true } : {}),
    ...(runtime.error !== undefined ? { error: runtime.error } : {}),
    ...(runtime.message !== undefined ? { message: runtime.message } : {}),
  };
}

function publish(ports: UpdateHostPorts, runtime: UpdateRuntime): UpdateStatusView {
  const view = updateStatusView(ports, runtime);
  ports.emit(view);
  return view;
}

function fail(
  ports: UpdateHostPorts,
  runtime: UpdateRuntime,
  error: NonNullable<UpdateStatusView['error']>,
  message: string,
): UpdateStatusView {
  runtime.phase = 'error';
  runtime.error = error;
  runtime.message = message;
  runtime.percent = undefined;
  runtime.receivedBytes = undefined;
  ports.logger?.warn('desktop.update.failed', { reason: error });
  return publish(ports, runtime);
}

/* ───────────────────────────── 检查 ───────────────────────────── */

/**
 * `auto`：开关关着、或 24 小时内已经自动检查过，就**一个请求都不发**，原样返回当前视图。
 * `manual`：用户点的，只要更新源可用就发。
 */
export async function checkForUpdate(
  ports: UpdateHostPorts,
  runtime: UpdateRuntime,
  trigger: 'manual' | 'auto',
): Promise<UpdateStatusView> {
  if (availability(ports) !== 'on' || ports.feed.kind !== 'on')
    return updateStatusView(ports, runtime);
  if (
    runtime.phase === 'checking' ||
    runtime.phase === 'downloading' ||
    runtime.phase === 'verifying'
  ) {
    return updateStatusView(ports, runtime);
  }
  if (trigger === 'auto') {
    if (!canAutoCheck(ports)) return updateStatusView(ports, runtime);
    const last = readUpdatePrefs(ports).lastAutoCheckAt;
    if (last !== undefined && ports.now() - last < AUTO_CHECK_INTERVAL_MS) {
      return updateStatusView(ports, runtime);
    }
  }
  const baseUrl = ports.feed.baseUrl;

  runtime.phase = 'checking';
  runtime.error = undefined;
  runtime.message = undefined;
  runtime.cancelled = undefined;
  publish(ports, runtime);
  const now = ports.now();
  writeUpdatePrefs(
    ports,
    trigger === 'auto' ? { lastCheckedAt: now, lastAutoCheckAt: now } : { lastCheckedAt: now },
  );

  // 不带任何头：没有令牌、没有设备 id、没有版本号
  const get = (path: string) =>
    ports.fetch(`${baseUrl}/${path}`, { signal: AbortSignal.timeout(30_000), headers: {} });

  let manifestBytes: Uint8Array;
  let signature: string;
  try {
    const res = await get(manifestNameFor(ports.platform));
    if (res.status === 404)
      return fail(ports, runtime, 'server', '更新服务器上还没有这个平台的版本。');
    if (res.status !== 200)
      return fail(
        ports,
        runtime,
        'server',
        `更新服务器出了问题（${String(res.status)}），稍后再试。`,
      );
    manifestBytes = new Uint8Array(await res.arrayBuffer());
    const sig = await get(`signatures/${signatureNameFor(manifestBytes)}`);
    // 没有签名 = 没法确认来源，与签名不对同样处理
    if (sig.status !== 200) return badSignature(ports, runtime, `missing-${String(sig.status)}`);
    signature = Buffer.from(await sig.arrayBuffer()).toString('utf8');
  } catch {
    return fail(
      ports,
      runtime,
      'offline',
      `连不上更新服务器（${hostOf(baseUrl)}）。检查网络后再试一次。`,
    );
  }

  const verified = verifyUpdateManifest(manifestBytes, signature, ports.keys);
  if (!verified.ok) return badSignature(ports, runtime, verified.reason);

  const parsed = parseUpdateManifest(Buffer.from(manifestBytes).toString('utf8'));
  if (!parsed.ok)
    return fail(ports, runtime, 'bad-manifest', `版本清单的格式不对：${parsed.reason}`);
  const manifest = parsed.manifest;

  // 等于或更低一律当成「已是最新」：客户端不降级
  if (compareVersions(manifest.version, ports.appVersion) <= 0) {
    runtime.phase = 'latest';
    runtime.offer = undefined;
    ports.logger?.info('desktop.update.latest', {});
    return publish(ports, runtime);
  }
  const file = pickPackageFor(manifest, ports.platform, ports.arch);
  if (!file)
    return fail(
      ports,
      runtime,
      'bad-manifest',
      `EvoWork ${manifest.version} 没有适合这台电脑的安装包。`,
    );

  runtime.offer = { version: manifest.version, file, notes: manifest.notes, baseUrl };
  // 之前下好、还没装的那份：校验过就直接能装，不再下一遍
  const finalPath = join(ports.downloadsDir(), fileNameOf(file));
  if (existsSync(finalPath) && (await fileMatches(finalPath, file))) {
    runtime.phase = 'ready';
    runtime.downloadedPath = finalPath;
  } else {
    runtime.phase = 'available';
  }
  ports.logger?.info('desktop.update.available', {});
  return publish(ports, runtime);
}

function badSignature(
  ports: UpdateHostPorts,
  runtime: UpdateRuntime,
  reason: string,
): UpdateStatusView {
  ports.logger?.warn('desktop.update.bad_signature', {
    reason: reason.replace(/[^a-z0-9-]/gi, '').slice(0, 40),
  });
  return fail(
    ports,
    runtime,
    'bad-signature',
    '收到的版本清单没有通过签名校验，已丢弃。为了安全，这次不能下载更新。反复出现时，可能是网络被劫持或更新服务器出了问题。',
  );
}

/* ───────────────────────────── 下载 ───────────────────────────── */

export async function downloadUpdate(
  ports: UpdateHostPorts,
  runtime: UpdateRuntime,
): Promise<UpdateStatusView> {
  const offer = runtime.offer;
  if (!offer || runtime.phase === 'downloading' || runtime.phase === 'verifying') {
    return updateStatusView(ports, runtime);
  }
  const dir = ports.downloadsDir();
  const finalPath = join(dir, fileNameOf(offer.file));
  const partPath = `${finalPath}.part`;
  const abort = new AbortController();
  runtime.abort = abort;
  runtime.phase = 'downloading';
  runtime.percent = 0;
  runtime.receivedBytes = 0;
  runtime.cancelled = undefined;
  runtime.error = undefined;
  runtime.message = undefined;
  publish(ports, runtime);

  const stallMs = ports.stallMs ?? DOWNLOAD_STALL_MS;
  let stalled = false;
  let watchdog = setTimeout(() => {
    stalled = true;
    abort.abort();
  }, stallMs);
  const kick = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      stalled = true;
      abort.abort();
    }, stallMs);
  };

  const hash = createHash('sha512');
  let received = 0;
  try {
    mkdirSync(dir, { recursive: true });
    const res = await ports.fetch(`${offer.baseUrl}/${encodeURI(offer.file.url)}`, {
      signal: abort.signal,
      headers: {},
    });
    if (res.status !== 200 || !res.body) {
      clearTimeout(watchdog);
      return fail(
        ports,
        runtime,
        'server',
        `更新服务器出了问题（${String(res.status)}），稍后再试。`,
      );
    }
    const handle = await open(partPath, 'w');
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        kick();
        hash.update(value);
        await handle.write(value);
        received += value.byteLength;
        const percent = Math.min(99, Math.floor((received / offer.file.size) * 100));
        if (percent !== runtime.percent) {
          runtime.percent = percent;
          runtime.receivedBytes = received;
          publish(ports, runtime);
        }
      }
    } finally {
      await handle.close();
    }
  } catch (err: unknown) {
    clearTimeout(watchdog);
    rmSync(partPath, { force: true });
    runtime.abort = undefined;
    if (abort.signal.aborted && !stalled) {
      // 用户点了「取消下载」
      runtime.phase = 'available';
      runtime.cancelled = true;
      runtime.percent = undefined;
      runtime.receivedBytes = undefined;
      return publish(ports, runtime);
    }
    if (stalled)
      return fail(ports, runtime, 'stall', '下载 60 秒没有进展，已停止。检查网络后重新下载。');
    if ((err as { code?: string }).code === 'ENOSPC') {
      return fail(
        ports,
        runtime,
        'disk',
        '「下载」文件夹所在的磁盘空间不够，清出一些空间后重新下载。',
      );
    }
    return fail(ports, runtime, 'offline', '下载中断了。检查网络后重新下载。');
  }
  clearTimeout(watchdog);
  runtime.abort = undefined;

  runtime.phase = 'verifying';
  runtime.percent = 100;
  publish(ports, runtime);
  if (received !== offer.file.size || hash.digest('base64') !== offer.file.sha512) {
    rmSync(partPath, { force: true });
    return fail(ports, runtime, 'mismatch', '下载的安装包与版本清单不一致，已删除，没有打开它。');
  }
  rmSync(finalPath, { force: true });
  renameSync(partPath, finalPath);
  runtime.phase = 'ready';
  runtime.downloadedPath = finalPath;
  runtime.percent = undefined;
  runtime.receivedBytes = undefined;
  ports.logger?.info('desktop.update.downloaded', { byteSize: received });
  return publish(ports, runtime);
}

export function cancelUpdateDownload(runtime: UpdateRuntime): void {
  runtime.abort?.abort();
}

/* ───────────────────────────── 退出并打开 ───────────────────────────── */

/**
 * 打开之前**再校验一次**：「下载」文件夹谁都能动，下好到点下去之间文件可能已经不是那一份了。
 * 先打开安装包、再退出：顺序反过来，退出之后就没人去打开它了。
 */
export async function quitAndOpenInstaller(
  ports: UpdateHostPorts,
  runtime: UpdateRuntime,
): Promise<{ readonly ok: boolean; readonly refused?: string | undefined }> {
  const path = runtime.downloadedPath;
  const offer = runtime.offer;
  if (runtime.phase !== 'ready' || !path || !offer)
    return { ok: false, refused: '还没有下载好的安装包。' };
  if (!existsSync(path) || !(await fileMatches(path, offer.file))) {
    runtime.downloadedPath = undefined;
    fail(
      ports,
      runtime,
      'mismatch',
      '「下载」文件夹里的安装包被改动过或已经不在了，没有打开它。请重新下载。',
    );
    return { ok: false, refused: runtime.message };
  }
  await ports.openPath(path);
  ports.logger?.info('desktop.update.quit_to_install', {});
  ports.quit();
  return { ok: true };
}

/* ───────────────────────────── 小工具 ───────────────────────────── */

function fileNameOf(file: UpdateManifestFile): string {
  return file.url.slice(file.url.lastIndexOf('/') + 1);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function fileMatches(path: string, file: UpdateManifestFile): Promise<boolean> {
  try {
    if (statSync(path).size !== file.size) return false;
    const hash = createHash('sha512');
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(1 << 20);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    return hash.digest('base64') === file.sha512;
  } catch {
    return false;
  }
}
