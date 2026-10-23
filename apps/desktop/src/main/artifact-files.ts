/** 产物专用文件快照：元数据缓存 + 异步分块重算，避免轮询阻塞主进程。 */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
} from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { join, sep } from 'node:path';
import { isIgnored, typeFromPath, type FileSnapshot } from '@evowork/artifacts';

export const ARTIFACT_VERIFY_MS = 10 * 60_000;
type FileStat = { sizeBytes: number; contentHash: string };
const token = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
const ignored = (relative: string) => isIgnored(relative.replaceAll('\\', '/'));
const eligible = (relative: string) => !ignored(relative) && typeFromPath(relative) !== undefined;

export function createArtifactFileIO(
  options: { now?: () => number; onHash?: (bytes: number) => void } = {},
) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { fingerprint: string; stat: FileStat; verifiedAt: number }>();
  const inFlight = new Map<string, Promise<FileSnapshot>>();
  function fingerprint(path: string) {
    try {
      const s = lstatSync(path, { bigint: true });
      return s.isFile() ? token(s) : undefined;
    } catch {
      return undefined;
    }
  }
  function stat(path: string): FileStat | undefined {
    const before = fingerprint(path);
    if (before === undefined) {
      cache.delete(path);
      return undefined;
    }
    const entry = cache.get(path);
    if (entry?.fingerprint === before && now() - entry.verifiedAt < ARTIFACT_VERIFY_MS)
      return entry.stat;
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const s = fstatSync(fd, { bigint: true });
      if (!s.isFile() || token(s) !== before) return undefined;
      const hash = createHash('sha256'),
        buffer = Buffer.alloc(64 * 1024);
      let count: number;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0)
        hash.update(buffer.subarray(0, count));
      if (token(fstatSync(fd, { bigint: true })) !== before || fingerprint(path) !== before)
        return undefined;
      const value = { sizeBytes: Number(s.size), contentHash: hash.digest('hex') };
      cache.set(path, { fingerprint: before, stat: value, verifiedAt: now() });
      options.onHash?.(value.sizeBytes);
      return value;
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  function listFiles(root: string, depth = 0, relative = ''): string[] {
    if (depth > 8) return [];
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const out: string[] = [];
    for (const entry of entries) {
      const rel = join(relative, entry.name),
        path = join(root, entry.name);
      if (ignored(rel + '/')) continue;
      if (entry.isDirectory()) out.push(...listFiles(path, depth + 1, rel));
      else if (entry.isFile() && eligible(rel)) out.push(path);
    }
    return out;
  }
  async function files(root: string, depth = 0, relative = ''): Promise<string[]> {
    if (depth > 8) return [];
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const out: string[] = [];
    for (const entry of entries) {
      const rel = join(relative, entry.name),
        path = join(root, entry.name);
      if (ignored(rel + '/')) continue;
      if (entry.isDirectory()) out.push(...(await files(path, depth + 1, rel)));
      else if (entry.isFile() && eligible(rel)) out.push(path);
    }
    return out;
  }
  async function readSnapshot(path: string): Promise<FileSnapshot> {
    let before: BigIntStats;
    try {
      before = await lstat(path, { bigint: true });
    } catch {
      return { fingerprint: 'unavailable' };
    }
    const stamp = token(before);
    if (!before.isFile()) return { fingerprint: stamp };
    const entry = cache.get(path);
    if (entry?.fingerprint === stamp && now() - entry.verifiedAt < ARTIFACT_VERIFY_MS)
      return { fingerprint: stamp, contentHash: entry.stat.contentHash };
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (token(await handle.stat({ bigint: true })) !== stamp) return { fingerprint: stamp };
      const hash = createHash('sha256'),
        buffer = Buffer.alloc(64 * 1024);
      let count: number;
      while ((count = (await handle.read(buffer, 0, buffer.length, null)).bytesRead) > 0)
        hash.update(buffer.subarray(0, count));
      if (
        token(await handle.stat({ bigint: true })) !== stamp ||
        token(await lstat(path, { bigint: true })) !== stamp
      )
        return { fingerprint: stamp };
      const value = { sizeBytes: Number(before.size), contentHash: hash.digest('hex') };
      cache.set(path, { fingerprint: stamp, stat: value, verifiedAt: now() });
      options.onHash?.(value.sizeBytes);
      return { fingerprint: stamp, contentHash: value.contentHash };
    } catch {
      return { fingerprint: stamp };
    } finally {
      await handle?.close();
    }
  }
  async function snapshot(path: string) {
    let work = inFlight.get(path);
    if (!work) {
      work = readSnapshot(path).finally(() => inFlight.delete(path));
      inFlight.set(path, work);
    }
    return work;
  }
  async function scan(root: string): Promise<ReadonlyMap<string, FileSnapshot>> {
    const paths = await files(root);
    const current = new Map<string, FileSnapshot>();
    // Sequential reads cap memory and yield between every block, so UI/stop IPC can run.
    for (const path of paths) current.set(path, await snapshot(path));
    const prefix = root.endsWith(sep) ? root : root + sep;
    for (const path of cache.keys())
      if (path.startsWith(prefix) && !current.has(path)) cache.delete(path);
    return current;
  }
  return { listFiles, stat, fingerprint, scan };
}
