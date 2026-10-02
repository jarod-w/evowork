/**
 * 内容包的 tar.gz（13 §4.2）。
 *
 * **不用系统 `tar` 解包**：runtime-installer 解的是我们钉死 sha256 的 Python 发行版，
 * 用系统 tar 没问题；这里解的东西里有一类（HUB-Q5a 的上游归档）是**先解开、后校验**的，
 * 系统 tar 对符号链接、绝对路径、`..` 的处理各平台不一样（GNU tar / bsdtar / Windows 自带的 bsdtar），
 * 一个指向 `~/.ssh` 的符号链接就能把后面的文件写到工作区外面。
 *
 * 所以自己读：只认普通文件和目录，其余类型（符号链接、硬链接、设备）**整个包拒绝**，
 * 不是跳过 —— 跳过会让「包里有什么」和「装上的是什么」对不上。
 */
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

export interface TarFile {
  /** 相对路径，`/` 分隔。 */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface UnpackLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
}

export const DEFAULT_UNPACK_LIMITS: UnpackLimits = {
  maxFiles: 5000,
  maxTotalBytes: 128 * 1024 * 1024,
};

export type UnpackResult =
  | { readonly ok: true; readonly files: readonly TarFile[] }
  | { readonly ok: false; readonly reason: string };

/** 解 tar.gz。只返回普通文件；目录只用来建层级，不单独返回。 */
export function unpackTarGz(
  archive: Uint8Array,
  limits: UnpackLimits = DEFAULT_UNPACK_LIMITS,
): UnpackResult {
  let tar: Buffer;
  try {
    tar = gunzipSync(archive, { maxOutputLength: limits.maxTotalBytes + 1024 * 1024 });
  } catch {
    return { ok: false, reason: '内容包不是有效的 gzip，或解开后超过大小上限' };
  }
  return unpackTar(tar, limits);
}

export function unpackTar(
  tar: Uint8Array,
  limits: UnpackLimits = DEFAULT_UNPACK_LIMITS,
): UnpackResult {
  const files: TarFile[] = [];
  const seen = new Set<string>();
  let total = 0;
  let offset = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    if (!checksumOk(header)) return { ok: false, reason: '内容包的 tar 头校验和不对' };
    const size = readOctal(header, 124, 12);
    if (size === undefined) return { ok: false, reason: '内容包的 tar 头无法解析' };
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) return { ok: false, reason: '内容包被截断了' };
    const data = tar.subarray(dataStart, dataEnd);
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = cString(data);
      continue;
    }
    if (type === 'x') {
      paxPath = parsePaxPath(data) ?? paxPath;
      continue;
    }
    if (type === 'g') continue;

    const rawName = paxPath ?? longName ?? headerName(header);
    longName = undefined;
    paxPath = undefined;
    const name = safeRelative(rawName);
    if (name === undefined) return { ok: false, reason: `内容包里有不安全的路径：${rawName}` };

    if (type === '5') continue;
    if (type !== '0' && type !== '\0' && type !== '7') {
      return { ok: false, reason: `内容包里有不允许的条目类型（${describeType(type)}）：${name}` };
    }
    if (name === '') return { ok: false, reason: '内容包里有没有名字的文件' };
    if (seen.has(name)) return { ok: false, reason: `内容包里有重复的文件：${name}` };
    seen.add(name);
    total += size;
    if (files.length + 1 > limits.maxFiles || total > limits.maxTotalBytes) {
      return { ok: false, reason: '内容包解开后超过大小上限' };
    }
    files.push({ path: name, bytes: new Uint8Array(data) });
  }
  return { ok: true, files };
}

/**
 * 打一个确定性的 tar.gz（同样的输入 → 同样的字节）：路径排序、mtime 归零、uid/gid 归零。
 * 管道发布与离线包都用它，这样内容包的 sha256 只取决于内容。
 */
export function packTarGz(files: readonly TarFile[]): Uint8Array {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const chunks: Buffer[] = [];
  for (const file of sorted) {
    const name = safeRelative(file.path);
    if (name === undefined || name === '') throw new Error(`不安全的路径：${file.path}`);
    if (Buffer.byteLength(name) > 100) {
      const longData = Buffer.from(`${name}\0`, 'utf8');
      chunks.push(header('././@LongLink', longData.length, 'L'), pad(longData));
    }
    const data = Buffer.from(file.bytes);
    chunks.push(header(name.slice(0, 100), data.length, '0'), pad(data));
  }
  chunks.push(Buffer.alloc(1024));
  return new Uint8Array(gzipSync(Buffer.concat(chunks), { level: 9 }));
}

/**
 * 文件树哈希：`sha256( 每个文件一行 "<path>\0<sha256(内容)>\n"，按路径排序 )`。
 * 上游归档的字节不稳定，只能比解出来的树（HUB-Q5a 的条目）。
 */
export function treeSha256(files: readonly TarFile[]): string {
  const lines = files
    .map((f) => `${f.path}\0${createHash('sha256').update(f.bytes).digest('hex')}\n`)
    .sort();
  return createHash('sha256').update(lines.join('')).digest('hex');
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/* ── 内部 ───────────────────────────────────────────────────────────────── */

function headerName(header: Uint8Array): string {
  const name = cString(header.subarray(0, 100));
  const magic = cString(header.subarray(257, 263));
  const prefix = magic.startsWith('ustar') ? cString(header.subarray(345, 500)) : '';
  return prefix !== '' ? `${prefix}/${name}` : name;
}

/** 规范化成相对路径。绝对路径、盘符、`..`、反斜杠一律不认。 */
function safeRelative(raw: string): string | undefined {
  if (raw.includes('\\') || raw.includes('\0')) return undefined;
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return undefined;
  const parts = raw.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) return undefined;
  return parts.join('/');
}

function cString(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString('utf8');
}

function readOctal(header: Uint8Array, start: number, len: number): number | undefined {
  const raw = cString(header.subarray(start, start + len)).trim();
  if (raw === '') return 0;
  if (!/^[0-7]+$/.test(raw)) return undefined;
  const n = parseInt(raw, 8);
  return Number.isSafeInteger(n) ? n : undefined;
}

function checksumOk(header: Uint8Array): boolean {
  const stored = readOctal(header, 148, 8);
  if (stored === undefined) return false;
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 32 : (header[i] ?? 0);
  return sum === stored;
}

function parsePaxPath(data: Uint8Array): string | undefined {
  const text = Buffer.from(data).toString('utf8');
  for (const line of text.split('\n')) {
    const m = /^\d+ path=(.*)$/.exec(line);
    if (m?.[1] !== undefined) return m[1];
  }
  return undefined;
}

function describeType(type: string): string {
  if (type === '1') return '硬链接';
  if (type === '2') return '符号链接';
  if (type === '3' || type === '4') return '设备文件';
  if (type === '6') return '命名管道';
  return `类型 ${JSON.stringify(type)}`;
}

function header(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += h[i] ?? 0;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

function pad(data: Buffer): Buffer {
  const rest = data.length % 512;
  return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}
