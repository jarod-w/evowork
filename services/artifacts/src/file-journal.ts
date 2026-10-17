/** Bounded, local undo copies. Workspace discovery never establishes authorship. */
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  chmodSync,
  constants,
  fstatSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isIgnored } from './types.js';

interface FileState {
  hash: string;
  size: number;
  mode: number;
  stored: boolean;
}
interface Snapshot {
  files: Record<string, FileState>;
  warnings: string[];
}
interface Journal {
  version: 1;
  threadId: string;
  root: string;
  turnId: string;
  revision: string;
  before: Snapshot;
  turnBefore: Snapshot;
  after: Snapshot;
  owned: string[];
  threadConflicts?: string[];
}
export interface WorkspaceFileChange {
  readonly path: string;
  readonly displayPath?: string;
  readonly added: number;
  readonly removed: number;
  readonly diff: string;
  readonly kind: 'add' | 'modify' | 'delete';
  readonly source: 'task' | 'workspace';
  readonly reversible: boolean;
  readonly revision: string;
  readonly diffMode: 'net';
}
export interface WorkspaceFilesView {
  readonly turnId: string;
  readonly thread: readonly WorkspaceFileChange[];
  readonly turn: readonly WorkspaceFileChange[];
  readonly files: readonly { path: string; source: 'task' | 'workspace' }[];
  readonly warnings: readonly string[];
}

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function same(a: FileState | undefined, b: FileState | undefined): boolean {
  return a?.hash === b?.hash && a?.mode === b?.mode;
}
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}

/** Complete single-hunk diff; unchanged prefixes/suffixes are bounded to three context lines. */
export function fileTextDiff(path: string, before?: Buffer, after?: Buffer) {
  if (
    before?.includes(0) ||
    after?.includes(0) ||
    (before !== undefined && !Buffer.from(before.toString('utf8')).equals(before)) ||
    (after !== undefined && !Buffer.from(after.toString('utf8')).equals(after)) ||
    (before?.length ?? 0) + (after?.length ?? 0) > 2_000_000
  )
    return { added: 0, removed: 0, diff: '二进制或较大文件内容已变化；可打开文件查看。' };
  const lines = (bytes?: Buffer) =>
    bytes?.length ? (bytes.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) ?? []) : [];
  const a = lines(before),
    b = lines(after);
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  if (prefix === a.length && prefix === b.length) return { added: 0, removed: 0, diff: '' };
  const start = Math.max(0, prefix - 3),
    endA = Math.min(a.length, a.length - suffix + 3),
    endB = Math.min(b.length, b.length - suffix + 3);
  const render = (line: string, marker: string) =>
    marker + line + (line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n');
  const body =
    a
      .slice(start, prefix)
      .map((line) => render(line, ' '))
      .join('') +
    a
      .slice(prefix, a.length - suffix)
      .map((line) => render(line, '-'))
      .join('') +
    b
      .slice(prefix, b.length - suffix)
      .map((line) => render(line, '+'))
      .join('') +
    a
      .slice(a.length - suffix, endA)
      .map((line) => render(line, ' '))
      .join('');
  return {
    added: b.length - prefix - suffix,
    removed: a.length - prefix - suffix,
    diff: `diff --git a/${path} b/${path}\n--- ${before ? 'a/' + path : '/dev/null'}\n+++ ${after ? 'b/' + path : '/dev/null'}\n@@ -${endA === start ? start : start + 1},${endA - start} +${endB === start ? start : start + 1},${endB - start} @@\n${body}`,
  };
}

export function createFileJournal(options: {
  directory: string;
  rootOf: (threadId: string) => string | undefined;
  busy?: (root: string) => boolean;
  maxFileBytes?: number;
  maxCacheBytes?: number;
  maxFiles?: number;
}) {
  const directory = resolve(options.directory),
    blobs = join(directory, 'blobs');
  mkdirSync(blobs, { recursive: true, mode: 0o700 });
  const active = new Set<string>();
  const states = new Map<string, Journal>();
  const maxFile = options.maxFileBytes ?? 32 * 1024 * 1024;
  const maxCache = options.maxCacheBytes ?? 256 * 1024 * 1024;
  let cachedBytes = readdirSync(blobs)
    .filter((name) => /^[a-f0-9]{64}$/.test(name))
    .reduce((size, name) => size + statSync(join(blobs, name)).size, 0);
  const manifest = (threadId: string) => join(directory, digest(threadId) + '.json');
  function rootOf(threadId: string): string {
    const root = options.rootOf(threadId);
    if (!root) throw new Error('任务没有可用的工作目录。');
    return realpathSync(root);
  }
  function safePath(root: string, path: string): string {
    let target = resolve(root, path);
    if (isAbsolute(path) && !within(root, target)) {
      // macOS /var and /private/var aliases may refer to the same authorized root.
      try {
        target = join(realpathSync(dirname(target)), basename(target));
      } catch {
        /* missing or outside remains denied */
      }
    }
    if (!within(root, target)) throw new Error('只能操作任务工作目录内的文件。');
    let current = root;
    for (const segment of relative(root, target).split(sep)) {
      current = join(current, segment);
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error('不能操作符号链接。');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return target;
  }
  function scan(root: string, save: boolean): Snapshot {
    const files: Record<string, FileState> = Object.create(null) as Record<string, FileState>;
    const warnings = new Set<string>();
    let count = 0,
      scannedBytes = 0;
    const walk = (folder: string) => {
      if (count >= (options.maxFiles ?? 5000)) {
        warnings.add('工作目录文件过多，未覆盖的文件无法撤销。');
        return;
      }
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (isIgnored(relative(root, path)) || path === directory || within(directory, path))
          continue;
        if (++count > (options.maxFiles ?? 5000)) {
          warnings.add('工作目录文件过多，未覆盖的文件无法撤销。');
          break;
        }
        if (entry.isSymbolicLink()) {
          warnings.add('已跳过符号链接；其目标不纳入差异和撤销。');
          continue;
        }
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const info = lstatSync(path);
          if (info.size > maxFile || scannedBytes + info.size > 256 * 1024 * 1024) {
            warnings.add('较大文件仅比较元数据，不支持内容差异和磁盘撤销。');
            files[relative(root, path)] = {
              hash: `large-${info.size}-${info.mtimeMs}-${info.ctimeMs}`,
              size: info.size,
              mode: info.mode & 0o777,
              stored: false,
            };
            continue;
          }
          scannedBytes += info.size;
          const fd = openSync(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          );
          let hash: string, bytes: Buffer, stat: ReturnType<typeof fstatSync>;
          try {
            const before = fstatSync(fd);
            if (!before.isFile()) throw new Error('NOT_REGULAR_FILE');
            const hasher = createHash('sha256'),
              buffer = Buffer.alloc(64 * 1024);
            const chunks: Buffer[] = [];
            let size: number;
            while ((size = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
              hasher.update(buffer.subarray(0, size));
              chunks.push(Buffer.from(buffer.subarray(0, size)));
              if (chunks.length * buffer.length > maxFile + buffer.length)
                throw new Error('FILE_GROWING');
            }
            hash = hasher.digest('hex');
            bytes = Buffer.concat(chunks);
            stat = fstatSync(fd);
            const current = lstatSync(path);
            if (
              !current.isFile() ||
              current.ino !== stat.ino ||
              current.dev !== stat.dev ||
              before.size !== stat.size ||
              before.mtimeMs !== stat.mtimeMs ||
              before.mode !== stat.mode
            )
              throw new Error('FILE_CHANGED');
          } finally {
            closeSync(fd);
          }
          const blob = join(blobs, hash);
          let stored = existsSync(blob);
          if (save && !stored && stat.size <= maxFile && cachedBytes + stat.size <= maxCache) {
            writeFileSync(blob, bytes, { mode: 0o600, flag: 'wx' });
            cachedBytes += bytes.length;
            stored = true;
          }
          if (save && !stored) warnings.add('部分文件超出撤销缓存容量，只能查看变化，无法恢复。');
          files[relative(root, path)] = { hash, size: stat.size, mode: stat.mode & 0o777, stored };
        } catch {
          warnings.add('部分文件无法读取，未纳入差异和撤销。');
        }
      }
    };
    try {
      walk(root);
    } catch {
      warnings.add('工作目录扫描未完成，部分变化可能尚未列出。');
    }
    return { files, warnings: [...warnings] };
  }
  function save(state: Journal) {
    const temp = manifest(state.threadId) + '.' + randomUUID();
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    renameSync(temp, manifest(state.threadId));
    states.set(state.threadId, state);
  }
  function load(threadId: string): Journal | undefined {
    let state = states.get(threadId);
    if (!state && existsSync(manifest(threadId))) {
      const bytes = readFileSync(manifest(threadId));
      if (bytes.length > 6_000_000) throw new Error('文件变更记录过大。');
      state = JSON.parse(bytes.toString('utf8')) as Journal;
      if (state.version !== 1 || state.threadId !== threadId) throw new Error('文件变更记录无效。');
      states.set(threadId, state);
    }
    if (state && state.root !== rootOf(threadId))
      throw new Error('任务目录已改变，无法使用原目录撤销记录。');
    return state;
  }
  function blob(state?: FileState): Buffer | undefined {
    if (!state?.stored || !/^[a-f0-9]{64}$/.test(state.hash)) return undefined;
    const bytes = readFileSync(join(blobs, state.hash));
    if (digest(bytes) !== state.hash) throw new Error('撤销副本校验失败。');
    return bytes;
  }
  function currentBytes(root: string, path: string, expected: FileState): Buffer | undefined {
    if (expected.size > maxFile) return undefined;
    const fd = openSync(
      safePath(root, path),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      if (!fstatSync(fd).isFile()) throw new Error('文件正在变化，请刷新后重试。');
      const bytes = Buffer.alloc(expected.size + 1);
      let size = 0,
        count = 0;
      while (
        size < bytes.length &&
        (count = readSync(fd, bytes, size, bytes.length - size, null)) > 0
      )
        size += count;
      const result = bytes.subarray(0, size);
      if (size !== expected.size || digest(result) !== expected.hash)
        throw new Error('文件正在变化，请刷新后重试。');
      return result;
    } finally {
      closeSync(fd);
    }
  }
  function capture(threadId: string) {
    const state = load(threadId);
    if (!state || !active.has(threadId)) return;
    const after = scan(state.root, true);
    if (JSON.stringify(after) !== JSON.stringify(state.after))
      save({ ...state, after, revision: randomUUID() });
  }
  return {
    safeFile(threadId: string, path: string) {
      const target = safePath(rootOf(threadId), path);
      if (!lstatSync(target).isFile()) throw new Error('请选择普通文件。');
      return target;
    },
    begin(threadId: string, turnId: string) {
      const root = rootOf(threadId),
        before = scan(root, true),
        previous = load(threadId);
      save({
        version: 1,
        threadId,
        root,
        turnId,
        revision: randomUUID(),
        before: previous?.before ?? before,
        turnBefore: before,
        after: before,
        owned: previous?.owned ?? [],
        threadConflicts: [
          ...new Set([
            ...(previous?.threadConflicts ?? []),
            ...(previous
              ? [
                  ...new Set([...Object.keys(previous.after.files), ...Object.keys(before.files)]),
                ].filter((path) => !same(previous.after.files[path], before.files[path]))
              : []),
          ]),
        ],
      });
      active.add(threadId);
    },
    capture,
    finish(threadId: string) {
      capture(threadId);
      active.delete(threadId);
    },
    claim(threadId: string, path: string) {
      const state = load(threadId);
      if (!state) return;
      const target = safePath(state.root, path),
        rel = relative(state.root, target);
      if (!state.owned.includes(rel)) save({ ...state, owned: [...state.owned, rel] });
    },
    view(threadId: string): WorkspaceFilesView | undefined {
      const state = load(threadId);
      if (!state) return undefined;
      const current = scan(state.root, false),
        warnings = [
          ...new Set([
            ...state.before.warnings,
            ...state.turnBefore.warnings,
            ...state.after.warnings,
            ...current.warnings,
          ]),
        ];
      const changes = (before: Snapshot, scope: 'turn' | 'thread'): WorkspaceFileChange[] =>
        [...new Set([...Object.keys(before.files), ...Object.keys(current.files)])]
          .sort()
          .flatMap((path) => {
            const a = before.files[path],
              b = current.files[path];
            if (same(a, b)) return [];
            const prior = blob(a),
              next = b ? currentBytes(state.root, path, b) : undefined;
            const diff =
              (!a || prior) && (!b || next)
                ? fileTextDiff(path, prior, next)
                : { added: 0, removed: 0, diff: '缺少完整撤销副本；文件内容已变化。' };
            if (!diff.diff && a?.mode !== b?.mode) diff.diff = '文件权限发生变化。';
            return [
              {
                ...diff,
                path: join(state.root, path),
                displayPath: path,
                kind: !a ? 'add' : !b ? 'delete' : 'modify',
                source: state.owned.includes(path) ? 'task' : 'workspace',
                reversible:
                  warnings.length === 0 &&
                  (scope !== 'thread' || !state.threadConflicts?.includes(path)) &&
                  (!a || a.stored) &&
                  same(b, state.after.files[path]) &&
                  !active.has(threadId) &&
                  !options.busy?.(state.root),
                revision: state.revision,
                diffMode: 'net',
              } satisfies WorkspaceFileChange,
            ];
          });
      const thread = changes(state.before, 'thread'),
        turn = changes(state.turnBefore, 'turn');
      if (state.threadConflicts?.length)
        warnings.push('回合之间存在外部文件改动；这些文件仅能撤销本回合，不能按任务起点覆盖。');
      const paths = new Set([
        ...thread.map((file) => relative(state.root, file.path)),
        ...state.owned,
      ]);
      return {
        turnId: state.turnId,
        thread,
        turn,
        warnings,
        files: [...paths]
          .filter((path) => current.files[path])
          .map((path) => ({
            path: join(state.root, path),
            source: state.owned.includes(path) ? 'task' : 'workspace',
          })),
      };
    },
    revert(input: { threadId: string; path: string; scope: 'turn' | 'thread'; revision: string }) {
      if (input.scope !== 'turn' && input.scope !== 'thread') throw new Error('撤销范围无效。');
      const state = load(input.threadId);
      if (!state || state.revision !== input.revision)
        throw new Error('变更记录已更新，请重新查看后撤销。');
      if (active.has(input.threadId) || options.busy?.(state.root))
        throw new Error('工作目录仍有任务运行，请等待完成后撤销。');
      const target = safePath(state.root, input.path),
        rel = relative(state.root, target);
      if (input.scope === 'thread' && state.threadConflicts?.includes(rel))
        throw new Error('文件在回合之间被其他操作修改，不能按任务起点撤销。');
      const snapshot = scan(state.root, false);
      if (
        snapshot.warnings.length ||
        state.before.warnings.length ||
        state.turnBefore.warnings.length ||
        state.after.warnings.length
      )
        throw new Error('快照未覆盖全部文件，请先处理文件记录中的限制，不能安全撤销。');
      const current = snapshot.files[rel];
      if (!same(current, state.after.files[rel]))
        throw new Error('文件已被其他操作修改，已拒绝覆盖新内容。');
      const before = (input.scope === 'turn' ? state.turnBefore : state.before).files[rel];
      if (isIgnored(rel) || (!before && !state.after.files[rel]) || same(before, current))
        throw new Error('这个路径没有可撤销的已记录变更。');
      const bytes = blob(before);
      if (before && !bytes) throw new Error('缺少完整撤销副本，无法恢复。');
      if (!before) rmSync(target, { force: true });
      else {
        mkdirSync(dirname(target), { recursive: true });
        safePath(state.root, target);
        const temp = target + '.evowork-undo-' + randomUUID();
        try {
          writeFileSync(temp, bytes!, { flag: 'wx', mode: before.mode });
          chmodSync(temp, before.mode);
          // Stage first, then verify again before the atomic replacement.
          if (!same(scan(state.root, false).files[rel], current))
            throw new Error('文件刚刚发生变化，撤销已取消。');
          renameSync(temp, target);
        } finally {
          rmSync(temp, { force: true });
        }
      }
      const restored = scan(state.root, true),
        after = { ...state.after, files: { ...state.after.files } };
      // Only advance the verified state of this file. Never bless unrelated external edits.
      if (restored.files[rel]) after.files[rel] = restored.files[rel];
      else delete after.files[rel];
      save({ ...state, after, revision: randomUUID() });
    },
    stop() {
      active.clear();
    },
  };
}
