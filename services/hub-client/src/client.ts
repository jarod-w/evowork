/**
 * 插件 Hub 的下行通道（13 §4.4–§4.6、§5.1）。
 *
 * **K6 登记：这是唯一为 Hub 出网的包。** 它只做 GET，只带 `If-None-Match`：
 * 不带账号令牌（登录了也不带）、不带设备标识、不带 App 版本（`minAppVersion` 在客户端过滤）、
 * 不回传装了什么。什么时候允许它出网（登录与否、设置开关、企业策略）由调用方决定 ——
 * 这一层不知道「用户是谁」，也就没有东西可带。
 *
 * 失败的处理一律是「留着缓存，如实说」（4.5）：验签失败 / `sequence` 回退 / 不认识的 `schemaVer`
 * 都丢弃这份新索引，**不提供「仍然使用」**。缓存每次读都重新验签：磁盘上的缓存被人改过，同样不认。
 */
import { parseSignedEnvelope } from '@evowork/account';
import {
  isUpstreamPackage,
  MAX_PACKAGE_BYTES,
  sha256Hex,
  treeSha256,
  unpackTarGz,
  verifyHubIndex,
  type HubIndexEnvelope,
  type HubIndexPayload,
  type HubItem,
  type TarFile,
  type TrustedHubKey,
} from '@evowork/hub-protocol';

export interface HubSource {
  /** 与索引里的 `source.id` 必须一致。 */
  readonly id: string;
  /** 例如 `https://hub.example/v1`；索引在 `<baseUrl>/<id>/index.json`。 */
  readonly baseUrl: string;
  readonly trustedKeys: readonly TrustedHubKey[];
}

export interface FetchResponseLike {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (
  url: string,
  init: {
    readonly headers: Readonly<Record<string, string>>;
    readonly redirect: 'manual';
    readonly signal?: AbortSignal | undefined;
  },
) => Promise<FetchResponseLike>;

export interface HubFs {
  readonly readText: (path: string) => string | undefined;
  /** 先写临时文件再改名：写到一半断电不会留下半份索引。 */
  readonly writeTextAtomic: (path: string, text: string) => void;
}

export interface HubClientPorts {
  readonly fetch: FetchLike;
  readonly fs: HubFs;
  /** 例如 `~/.evowork/hub`；每个源一个子目录。 */
  readonly cacheRoot: string;
  /** 当前时间（秒）。 */
  readonly now: () => number;
  readonly timeoutMs?: number | undefined;
}

export interface VerifiedIndex {
  readonly payload: HubIndexPayload;
  /** 上一次从源那里确认过它是最新的时间（秒）。304 也算。 */
  readonly fetchedAt: number;
  /** 4.5：过期照样展示，但不允许新装。 */
  readonly expired: boolean;
}

export type RefreshOutcome =
  | { readonly status: 'updated' | 'not-modified'; readonly index: VerifiedIndex }
  | {
      readonly status: 'rejected' | 'unreachable';
      readonly reason: string;
      /** 缓存还在就照样给（「显示的是缓存内容（更新于 X）」）。 */
      readonly index?: VerifiedIndex | undefined;
    };

/** 索引本身的大小上限。几百个条目的索引是几百 KB 的量级。 */
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;

interface CacheMeta {
  readonly etag?: string | undefined;
  readonly fetchedAt: number;
}

/* ── 索引 ───────────────────────────────────────────────────────────────── */

/** 读缓存并**重新验签**。没有、坏了、被改过 → undefined。 */
export function readCachedIndex(
  ports: HubClientPorts,
  source: HubSource,
): VerifiedIndex | undefined {
  const cached = loadCached(ports, source);
  if (cached === undefined) return undefined;
  return {
    payload: cached.payload,
    fetchedAt: cached.meta.fetchedAt,
    expired: ports.now() > cached.payload.expiresAt,
  };
}

export async function refreshIndex(
  ports: HubClientPorts,
  source: HubSource,
  signal?: AbortSignal,
): Promise<RefreshOutcome> {
  const cached = loadCached(ports, source);
  const cachedIndex = cached
    ? { payload: cached.payload, fetchedAt: cached.meta.fetchedAt }
    : undefined;
  const withCache = (fetchedAt?: number): VerifiedIndex | undefined =>
    cachedIndex === undefined
      ? undefined
      : {
          payload: cachedIndex.payload,
          fetchedAt: fetchedAt ?? cachedIndex.fetchedAt,
          expired: ports.now() > cachedIndex.payload.expiresAt,
        };

  const url = `${trimSlash(source.baseUrl)}/${encodeURIComponent(source.id)}/index.json`;
  const headers: Record<string, string> = {};
  // 缓存验得过才带 ETag：否则 304 会让一份坏缓存永远「是最新的」
  if (cached?.meta.etag !== undefined) headers['If-None-Match'] = cached.meta.etag;

  let response: FetchResponseLike;
  let body: Uint8Array;
  try {
    response = await fetchWithTimeout(ports, url, headers, signal);
    if (response.status === 304 && cached !== undefined) {
      const now = ports.now();
      writeMeta(ports, source, { ...cached.meta, fetchedAt: now });
      return { status: 'not-modified', index: withCache(now)! };
    }
    if (response.status !== 200) {
      return {
        status: 'unreachable',
        reason: `源返回了 ${String(response.status)}`,
        index: withCache(),
      };
    }
    body = await readCapped(response, MAX_INDEX_BYTES);
  } catch (error: unknown) {
    return { status: 'unreachable', reason: networkReason(error), index: withCache() };
  }

  const text = Buffer.from(body).toString('utf8');
  const checked = checkIndex(text, source);
  if (!checked.ok) return { status: 'rejected', reason: checked.reason, index: withCache() };
  const payload = checked.payload;
  if (cached !== undefined) {
    if (payload.sequence < cached.payload.sequence) {
      return {
        status: 'rejected',
        reason: `索引的序号回退了（${String(payload.sequence)} < ${String(cached.payload.sequence)}），可能是有人拿旧索引回滚`,
        index: withCache(),
      };
    }
    if (payload.sequence === cached.payload.sequence && text !== cached.raw) {
      return {
        status: 'rejected',
        reason: '同一个序号出现了两份不同的索引',
        index: withCache(),
      };
    }
  }
  const now = ports.now();
  ports.fs.writeTextAtomic(indexPath(ports, source), text);
  const etag = response.headers.get('etag') ?? undefined;
  writeMeta(ports, source, { ...(etag !== undefined ? { etag } : {}), fetchedAt: now });
  return {
    status: 'updated',
    index: { payload, fetchedAt: now, expired: now > payload.expiresAt },
  };
}

/* ── 内容包 ─────────────────────────────────────────────────────────────── */

export type DownloadResult =
  | { readonly ok: true; readonly files: readonly TarFile[] }
  | {
      readonly ok: false;
      /** integrity = 签名 / 哈希对不上（4.5：拒装，不提供重试）；unreachable = 网络。 */
      readonly kind: 'integrity' | 'unreachable';
      readonly reason: string;
      /** unreachable 时要能访问的主机（5.3：「需要能访问 <host>」）。 */
      readonly host?: string | undefined;
    };

/**
 * 下载并校验一个条目的内容包，返回解开后的文件（还没落盘）。
 *
 * - 托管在我们 CDN 上的：比对**归档**的 sha256 与大小，对上了才解包。
 * - 上游固定提交（HUB-Q5a=A）：只能先解开，再比对 `subdir` 的**文件树哈希**。
 *   取不到时如实说要能访问哪台主机，**不退回我们的 CDN**。
 */
export async function downloadItem(
  ports: HubClientPorts,
  source: HubSource,
  item: HubItem,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const pkg = item.package;
  if (isUpstreamPackage(pkg)) {
    const host = hostOf(pkg.url);
    let bytes: Uint8Array;
    try {
      bytes = await getFollowingHttps(ports, pkg.url, MAX_PACKAGE_BYTES, signal);
    } catch (error: unknown) {
      return { ok: false, kind: 'unreachable', reason: networkReason(error), host };
    }
    const unpacked = unpackTarGz(bytes);
    if (!unpacked.ok) return { ok: false, kind: 'integrity', reason: unpacked.reason };
    const files = selectSubdir(stripTopDir(unpacked.files), pkg.subdir);
    if (files.length === 0 || treeSha256(files) !== pkg.treeSha256) {
      return { ok: false, kind: 'integrity', reason: '上游内容与索引登记的不一致' };
    }
    return { ok: true, files };
  }

  const url = `${trimSlash(source.baseUrl)}/${encodeURIComponent(source.id)}/${pkg.path}`;
  let bytes: Uint8Array;
  try {
    const response = await fetchWithTimeout(ports, url, {}, signal);
    if (response.status !== 200) {
      return {
        ok: false,
        kind: 'unreachable',
        reason: `源返回了 ${String(response.status)}`,
        host: hostOf(url),
      };
    }
    bytes = await readCapped(response, Math.min(pkg.size, MAX_PACKAGE_BYTES));
  } catch (error: unknown) {
    if (error instanceof TooLargeError) {
      return { ok: false, kind: 'integrity', reason: '内容包比索引登记的大' };
    }
    return { ok: false, kind: 'unreachable', reason: networkReason(error), host: hostOf(url) };
  }
  if (bytes.length !== pkg.size || sha256Hex(bytes) !== pkg.sha256) {
    return { ok: false, kind: 'integrity', reason: '内容包与索引登记的不一致' };
  }
  const unpacked = unpackTarGz(bytes);
  if (!unpacked.ok) return { ok: false, kind: 'integrity', reason: unpacked.reason };
  return { ok: true, files: unpacked.files };
}

/* ── 内部 ───────────────────────────────────────────────────────────────── */

interface Cached {
  readonly raw: string;
  readonly payload: HubIndexPayload;
  readonly meta: CacheMeta;
}

function loadCached(ports: HubClientPorts, source: HubSource): Cached | undefined {
  const raw = ports.fs.readText(indexPath(ports, source));
  if (raw === undefined) return undefined;
  const checked = checkIndex(raw, source);
  if (!checked.ok) return undefined;
  const meta = readMeta(ports, source) ?? { fetchedAt: checked.payload.issuedAt };
  return { raw, payload: checked.payload, meta };
}

function checkIndex(
  text: string,
  source: HubSource,
):
  | { readonly ok: true; readonly payload: HubIndexPayload }
  | { readonly ok: false; readonly reason: string } {
  let envelope: HubIndexEnvelope | undefined;
  try {
    envelope = parseSignedEnvelope(JSON.parse(text) as unknown);
  } catch {
    envelope = undefined;
  }
  if (envelope === undefined) return { ok: false, reason: '索引不是签名信封' };
  const verified = verifyHubIndex(envelope, source.trustedKeys);
  if (!verified.ok) {
    const reason =
      verified.reason === 'bad-kid'
        ? '索引的签名密钥不在信任列表里'
        : verified.reason === 'bad-payload'
          ? '索引的格式不认识（可能需要更新 EvoWork）'
          : '索引签名校验失败';
    return { ok: false, reason };
  }
  if (verified.payload.source.id !== source.id) {
    return { ok: false, reason: '索引声明的来源与请求的不一致' };
  }
  return { ok: true, payload: verified.payload };
}

function indexPath(ports: HubClientPorts, source: HubSource): string {
  return `${ports.cacheRoot}/${safeSegment(source.id)}/index.json`;
}

function metaPath(ports: HubClientPorts, source: HubSource): string {
  return `${ports.cacheRoot}/${safeSegment(source.id)}/meta.json`;
}

function readMeta(ports: HubClientPorts, source: HubSource): CacheMeta | undefined {
  const raw = ports.fs.readText(metaPath(ports, source));
  if (raw === undefined) return undefined;
  try {
    const rec = JSON.parse(raw) as Record<string, unknown>;
    const fetchedAt = typeof rec.fetchedAt === 'number' ? rec.fetchedAt : undefined;
    if (fetchedAt === undefined) return undefined;
    const etag = typeof rec.etag === 'string' && rec.etag.length <= 200 ? rec.etag : undefined;
    return { fetchedAt, ...(etag !== undefined ? { etag } : {}) };
  } catch {
    return undefined;
  }
}

function writeMeta(ports: HubClientPorts, source: HubSource, meta: CacheMeta): void {
  ports.fs.writeTextAtomic(metaPath(ports, source), `${JSON.stringify(meta)}\n`);
}

class TooLargeError extends Error {}

async function fetchWithTimeout(
  ports: HubClientPorts,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
): Promise<FetchResponseLike> {
  const timeout = AbortSignal.timeout(ports.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const combined = signal !== undefined ? AbortSignal.any([signal, timeout]) : timeout;
  return ports.fetch(url, { headers, redirect: 'manual', signal: combined });
}

/** 跟随重定向（上游归档常见），但每一跳都必须还是 https；最多 3 跳。 */
async function getFollowingHttps(
  ports: HubClientPorts,
  url: string,
  max: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop < 4; hop += 1) {
    if (!current.startsWith('https://')) throw new Error('重定向到了非 https 地址');
    const response = await fetchWithTimeout(ports, current, {}, signal);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location === null) throw new Error(`重定向没有目标（${String(response.status)}）`);
      current = new URL(location, current).toString();
      continue;
    }
    if (response.status !== 200) throw new Error(`上游返回了 ${String(response.status)}`);
    return readCapped(response, max);
  }
  throw new Error('重定向次数太多');
}

async function readCapped(response: FetchResponseLike, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > max) throw new TooLargeError('too large');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > max) throw new TooLargeError('too large');
  return bytes;
}

/** 代码托管站的归档都多一层 `<repo>-<sha>/` 顶层目录。只有一个顶层目录时去掉它。 */
function stripTopDir(files: readonly TarFile[]): readonly TarFile[] {
  const tops = new Set(files.map((f) => f.path.split('/')[0]));
  if (tops.size !== 1 || files.some((f) => !f.path.includes('/'))) return files;
  return files.map((f) => ({ path: f.path.slice(f.path.indexOf('/') + 1), bytes: f.bytes }));
}

function selectSubdir(files: readonly TarFile[], subdir: string): readonly TarFile[] {
  if (subdir === '') return files;
  const prefix = `${subdir}/`;
  return files
    .filter((f) => f.path.startsWith(prefix))
    .map((f) => ({ path: f.path.slice(prefix.length), bytes: f.bytes }));
}

function networkReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return '连接超时';
    return error.message !== '' ? error.message : '网络错误';
  }
  return '网络错误';
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, '_');
}
