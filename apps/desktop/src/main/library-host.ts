import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { openLibraryRegistry, type LibrarySourceRecord } from '@evowork/artifacts';
import { matchesTypeFilter, type LibraryRow, type TypeFilter } from '@evowork/artifacts/library.js';
import {
  createOcrProcessor,
  extractLibraryBody,
  sourceDigest,
  verifyOcrRuntime,
  type LibraryExtraction,
} from '@evowork/ingest';
import {
  createLibraryProjection,
  createLibraryQueryRunner,
  libraryTerms,
  type SqliteLike,
} from '@evowork/store';
import type {
  LibraryDataView,
  LibrarySearchInput,
  LibrarySearchView,
  LibraryDocumentInput,
} from '../shared/ipc.js';

interface ArtifactSource {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly version: number;
  readonly fileState: string;
  readonly threadId?: string | undefined;
  readonly createdAt: number;
}
export async function createLibraryHost(options: {
  readonly home: string;
  readonly db: SqliteLike;
  readonly databasePath: string;
  readonly artifacts: () => readonly ArtifactSource[];
  readonly projects?: (() => readonly { id: string; name: string }[]) | undefined;
  readonly projectOfThread?: ((id: string) => string | undefined) | undefined;
  readonly approveArtifact: (source: ArtifactSource) => Promise<boolean>;
  readonly pickFiles: () => Promise<readonly string[]>;
  readonly openPath: (path: string) => Promise<void>;
  readonly runtimeRoot?: string | undefined;
  readonly extract?: typeof extractLibraryBody;
  readonly quotaBytes?: number | undefined;
}) {
  const home = await realpath(options.home);
  const registry = await openLibraryRegistry(join(home, 'library'));
  const projection = createLibraryProjection(options.db);
  const reader = createLibraryQueryRunner({ databasePath: options.databasePath });
  const cache = join(home, 'cache', 'library');
  await mkdir(cache, { recursive: true });
  const runtimeRoot = options.runtimeRoot ?? join(home, 'runtime', 'ocr');
  const states = new Map<
    string,
    { state: string; note?: string; total?: number; completed?: number }
  >();
  const running = new Map<string, AbortController>();
  const pending = new Set<string>();
  const epochs = new Map<string, number>();
  const fingerprints = new Map<string, string>();
  let pumping = false,
    disposed = false,
    revision = 0;
  let querying: AbortController | undefined;
  let scopeSerial = Promise.resolve();
  const get = (id: string) => registry.records().find((r) => r.id === id && !r.excluded);
  const drop = (id: string): void => {
    epochs.set(id, (epochs.get(id) ?? 0) + 1);
    running.get(id)?.abort();
    pending.delete(id);
    projection.remove(id);
    revision++;
  };
  const state = (
    id: string,
    value: { state: string; note?: string; total?: number; completed?: number },
  ): void => {
    states.set(id, value);
    revision++;
  };
  const checkedPath = async (record: LibrarySourceRecord): Promise<string> => {
    const info = await lstat(record.path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('LIBRARY_SOURCE_UNSAFE');
    const limit = ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(record.path)) ? 20 : 200;
    if (info.size > limit * 1024 * 1024) throw new Error('LIBRARY_FILE_LIMIT');
    const real = await realpath(record.path);
    if (real !== resolve(record.path)) throw new Error('LIBRARY_SOURCE_UNSAFE');
    if (record.source === 'artifact') {
      const artifact = options
        .artifacts()
        .find(
          (a) =>
            a.id === record.artifactId && a.fileState === 'PRESENT' && resolve(a.path) === real,
        );
      if (!artifact || !(await options.approveArtifact(artifact)))
        throw new Error('LIBRARY_SOURCE_OUTSIDE_SCOPE');
    } else if (real !== join(home, 'library', record.id, `original${extname(real)}`))
      throw new Error('LIBRARY_SOURCE_OUTSIDE_SCOPE');
    // Attachment registrations must be copied to managed imports; no arbitrary historical uploads.

    return real;
  };
  const enqueue = (id: string): void => {
    const record = get(id);
    if (!record || record.stopped || disposed || running.has(id)) return;
    pending.add(id);
    state(id, { state: 'queued' });
    void pump();
  };
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (pending.size && !disposed) {
        const id = pending.values().next().value as string;
        pending.delete(id);
        const record = get(id);
        if (!record || record.stopped) continue;
        if (
          (await libraryBytes(home, options.databasePath).catch(() => Infinity)) >=
          (options.quotaBytes ?? 10 * 1024 * 1024 * 1024)
        ) {
          state(id, { state: 'paused', note: '本机资料和缓存达到 10 GiB 软上限，请清理后继续。' });
          continue;
        }
        const epoch = epochs.get(id) ?? 0;
        const abort = new AbortController();
        running.set(id, abort);
        try {
          state(id, { state: 'inspecting' });
          const path = await checkedPath(record),
            hash = await sourceDigest(path, abort.signal);
          if (abort.signal.aborted) continue;
          // Hash-keyed cache never grants scope; it is read only after registration/path checks.
          const contentFile = join(cache, `${hash}-body-v1.json`);
          let result: LibraryExtraction | undefined;
          if (!record.ocrAllowed) {
            try {
              if (
                !(await lstat(contentFile)).isSymbolicLink() &&
                (await stat(contentFile)).size <= 32 * 1024 * 1024
              ) {
                const cached = JSON.parse(await readFile(contentFile, 'utf8')) as {
                  hash: string;
                  result: LibraryExtraction;
                  checksum: string;
                };
                if (
                  cached.hash === hash &&
                  cached.checksum ===
                    createHash('sha256')
                      .update(JSON.stringify({ hash: cached.hash, result: cached.result }))
                      .digest('hex') &&
                  Array.isArray(cached.result?.blocks) &&
                  cached.result.blocks.every(
                    (b) => typeof b.text === 'string' && typeof b.location === 'string',
                  ) &&
                  cached.result.blocks.reduce((sum, b) => sum + Array.from(b.text).length, 0) <=
                    2_500_000
                )
                  result = cached.result;
              }
            } catch {
              /* Damaged disposable cache is extracted again. */
            }
          }
          const image = ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(path));
          if (image && !record.ocrAllowed) {
            const fresh = get(id);
            if (!fresh || (epochs.get(id) ?? 0) !== epoch) continue;
            await registry.update({ ...fresh, hash });
            if ((epochs.get(id) ?? 0) !== epoch) continue;
            projection.publish({ id, title: record.name, hash, state: 'ocrRequired', blocks: [] });
            running.delete(id);
            state(id, {
              state: 'ocrRequired',
              note: '图片仅按文件名可搜；选择“识别文字”才会读取图片内容。',
            });
          } else {
            if (record.ocrAllowed && (image || extname(path) === '.pdf')) {
              try {
                verifyOcrRuntime(runtimeRoot);
              } catch {
                throw new Error('OCR_RUNTIME_MISSING');
              }
              state(id, { state: 'ocr' });
              const processor = createOcrProcessor({
                runtimeRoot,
                cacheRoot: join(home, 'cache', 'ingest'),
              });
              const ocr = await processor.recognize({
                path,
                priority: 'background',
                signal: abort.signal,
                startPage: record.nextPage ?? 1,
                ...(record.rotation !== undefined ? { rotation: record.rotation } : {}),
                onProgress: (p) => {
                  if ((epochs.get(id) ?? 0) === epoch && !get(id)?.stopped)
                    state(id, { state: 'ocr', completed: p.completed, total: p.total });
                },
              });
              const present = new Set(
                ocr.pages.filter((p) => p.state !== 'failed').map((p) => p.page),
              );
              let nextPage = 1;
              while (present.has(nextPage) && nextPage < ocr.total) nextPage++;
              const fresh = get(id);
              if (fresh && (epochs.get(id) ?? 0) === epoch)
                await registry.update({ ...fresh, nextPage });
              result = {
                blocks: ocr.pages
                  .filter((p) => p.state === 'complete')
                  .map((p) => ({
                    text: p.text,
                    location: `第 ${p.page} 页`,
                    page: p.page,
                    source: p.source === 'ocr' ? 'ocr' : 'textLayer',
                    ...(p.needsReview ? { needsReview: true } : {}),
                  })),
                partial: !ocr.complete,
                ocrCandidates: ocr.total - ocr.pages.filter((p) => p.state !== 'failed').length,
              };
              state(id, {
                state: 'ocr',
                total: ocr.total,
                completed: ocr.pages.filter((p) => p.state !== 'failed').length,
              });
            } else if (!result) {
              state(id, { state: 'extracting' });
              result = await (options.extract ?? extractLibraryBody)({
                path,
                signal: abort.signal,
              });
              const temp = `${contentFile}.${id}.tmp`;
              await writeFile(
                temp,
                JSON.stringify({
                  hash,
                  result,
                  checksum: createHash('sha256')
                    .update(JSON.stringify({ hash, result }))
                    .digest('hex'),
                }),
                { mode: 0o600 },
              );
              await rename(temp, contentFile);
            }
            if (disposed || (epochs.get(id) ?? 0) !== epoch || get(id)?.path !== path) continue;
            if ((await sourceDigest(path)) !== hash) throw new Error('LIBRARY_SOURCE_CHANGED');
            if (!result) throw new Error('LIBRARY_NO_RESULT');
            const fresh = get(id);
            if (!fresh) continue;
            await registry.update({ ...fresh, hash });
            if (disposed || (epochs.get(id) ?? 0) !== epoch) continue;
            const stopped = get(id)?.stopped === true;
            const next = stopped ? 'stopped' : result.partial ? 'partial' : 'searchable';
            projection.publish({
              id,
              title: record.name,
              hash,
              state: next,
              blocks: result.blocks,
            });
            const current = states.get(id);
            running.delete(id);
            state(id, {
              state: next,
              ...(current?.total
                ? { total: current.total, completed: current.completed ?? 0 }
                : {}),
              ...(result.ocrCandidates
                ? { note: `${result.ocrCandidates} 页尚需识别文字，当前仅能搜索已有正文。` }
                : result.partial
                  ? { note: '达到处理上限，仅部分正文可搜。' }
                  : {}),
            });
          }
        } catch (error) {
          if (!disposed && get(id) && (epochs.get(id) ?? 0) === epoch) {
            const code = error instanceof Error ? error.message : '';
            if (get(id)?.stopped) state(id, { state: 'stopped' });
            else {
              projection.remove(id);
              try {
                const fresh = get(id)!;
                const path = await checkedPath(fresh);
                const hash = await sourceDigest(path);
                projection.publish({ id, title: fresh.name, hash, state: 'failed', blocks: [] });
                await registry.update({ ...fresh, hash });
              } catch {
                /* Unsafe or missing sources cannot grant filename scope. */
              }
              state(id, {
                state:
                  code === 'CANCELLED'
                    ? 'paused'
                    : code.includes('RUNTIME_MISSING')
                      ? 'runtimeMissing'
                      : code.includes('CHANGED')
                        ? 'stale'
                        : 'failed',
                note:
                  code === 'CANCELLED'
                    ? '已为当前任务暂停后台识别，可以继续。'
                    : code.includes('OCR_RUNTIME')
                      ? '本地 OCR 组件尚未安装。'
                      : code.includes('LIBRARY_RUNTIME') || code.includes('OCR_BRIDGE_MISSING')
                        ? '需要安装本地办公扩展，安装后继续。'
                        : code === 'SANDBOX_UNAVAILABLE'
                          ? '当前平台尚未提供受限正文解析，保留文件名检索。'
                          : '解析未完成，请检查原文件后继续。',
              });
            }
          }
        } finally {
          running.delete(id);
        }
      }
    } finally {
      pumping = false;
    }
  };
  const reconcile = async (): Promise<void> => {
    const operation = scopeSerial.then(async () => {
      const latest = new Map<string, ArtifactSource>();
      for (const a of options.artifacts()) {
        const old = latest.get(resolve(a.path));
        if (!old || a.version > old.version) latest.set(resolve(a.path), a);
      }
      for (const a of latest.values()) {
        if (!registry.enabled() || a.fileState !== 'PRESENT' || !(await options.approveArtifact(a)))
          continue;
        const id = `artifact-${createHash('sha256').update(resolve(a.path)).digest('hex')}`;
        const old = registry.records().find((r) => r.id === id);
        if (old?.excluded) continue;
        if (!old || old.artifactId !== a.id || old.name !== a.title) {
          drop(id);
          await registry.update({
            id,
            name: a.title || basename(a.path),
            path: resolve(a.path),
            source: 'artifact',
            artifactId: a.id,
            ...(a.threadId ? { threadId: a.threadId } : {}),
            stopped: old?.stopped ?? false,
            excluded: false,
            ocrAllowed: old?.ocrAllowed ?? false,
            createdAt: a.createdAt,
          });
          enqueue(id);
        }
      }
      for (const r of registry.records().filter((r) => !r.excluded)) {
        try {
          const path = await checkedPath(r);
          const published = options.db
            .prepare('SELECT source_hash FROM library_document WHERE id=?')
            .get(r.id) as { source_hash: string } | undefined;
          if (running.has(r.id) || pending.has(r.id) || states.get(r.id)?.state === 'paused')
            continue;
          const info = await stat(path);
          const fingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
          const changed = fingerprints.get(r.id) !== fingerprint;
          fingerprints.set(r.id, fingerprint);
          const hash = changed ? await sourceDigest(path) : (published?.source_hash ?? r.hash);
          if (!published || published.source_hash !== hash) {
            drop(r.id);
            if (hash && r.hash !== hash) await registry.update({ ...r, hash, nextPage: 1 });
            if (r.stopped) state(r.id, { state: 'stopped' });
            else enqueue(r.id);
          } else if (!states.has(r.id))
            state(r.id, {
              state: r.stopped
                ? 'stopped'
                : (
                    options.db
                      .prepare('SELECT state FROM library_document WHERE id=?')
                      .get(r.id) as { state: string }
                  ).state,
            });
        } catch {
          drop(r.id);
          state(r.id, { state: 'stale', note: '源文件已移动、删除或离开允许范围。' });
        }
      }
    });
    scopeSerial = operation.catch(() => {});
    await operation;
  };
  const rows = (): LibraryDataView['rows'] =>
    registry
      .records()
      .filter((r) => !r.excluded)
      .map((r) => ({
        id: r.id,
        name: r.name,
        source: r.source === 'artifact' ? ('artifact' as const) : ('mine' as const),
        owner: '我',
        location: r.source === 'mine' ? '我的资料 · 本机副本' : dirname(r.path),
        accessedAt: r.createdAt,
        extension: extname(r.path).slice(1),
        artifactType: typeFor(extname(r.path)),
        version: r.hash ?? '',
        ...(r.stopped ? { state: 'stopped' } : states.get(r.id)),
        ...(r.threadId ? { threadId: r.threadId } : {}),
        ...(r.threadId && options.projectOfThread?.(r.threadId)
          ? { projectId: options.projectOfThread(r.threadId) }
          : {}),
      }));
  const current = async (
    input: LibraryDocumentInput,
    signal?: AbortSignal,
  ): Promise<LibrarySourceRecord> => {
    const r = get(input.documentId);
    if (!r || !r.hash || r.hash !== input.version)
      throw new Error('资料版本已变化，请刷新后重试。');
    const path = await checkedPath(r);
    if ((await sourceDigest(path, signal)) !== r.hash) {
      drop(r.id);
      state(r.id, { state: 'stale' });
      throw new Error('内容已变化，请重新索引。');
    }
    return r;
  };
  return {
    async list(): Promise<LibraryDataView> {
      await reconcile();
      return {
        rows: rows(),
        bodySearchEnabled: registry.enabled(),
        revision,
        projects: options.projects?.() ?? [],
      };
    },
    async enable(): Promise<LibraryDataView> {
      await registry.enable();
      return this.list();
    },
    async joinAttachment(path: string, threadId?: string): Promise<LibraryDataView> {
      const record = await registry.importFile(path);
      await registry.update({ ...record, source: 'attachment', ...(threadId ? { threadId } : {}) });
      enqueue(record.id);
      return this.list();
    },
    async importFiles(): Promise<LibraryDataView> {
      const paths = await options.pickFiles();
      if (paths.length > 20) throw new Error('一次最多添加 20 个文件。');
      for (const path of paths) {
        const record = await registry.importFile(path);
        enqueue(record.id);
      }
      return this.list();
    },
    async updateImport(documentId: string): Promise<LibraryDataView> {
      const record = get(documentId);
      if (!record || record.source === 'artifact') throw new Error('只能更新我的资料副本。');
      if (running.has(documentId)) throw new Error('请先停止并等待资料处理结束。');
      const paths = await options.pickFiles();
      if (!paths.length) return this.list();
      if (paths.length !== 1) throw new Error('更新副本时请选择一个同类型文件。');
      const updated = await registry.replaceImport(documentId, paths[0]!);
      drop(documentId);
      enqueue(updated.id);
      return this.list();
    },
    async search(input: LibrarySearchInput): Promise<LibrarySearchView> {
      querying?.abort();
      const abort = new AbortController();
      querying = abort;
      libraryTerms(input.query);
      if (abort.signal.aborted) throw new Error('LIBRARY_QUERY_CANCELLED');
      const timer = setTimeout(() => abort.abort(), 4000);
      try {
        const selected = rows().filter(
          (r) =>
            (input.source === undefined || input.source === 'all' || r.source === input.source) &&
            matchesTypeFilter(r as LibraryRow, (input.typeFilter ?? 'all') as TypeFilter) &&
            (!input.threadId || r.threadId === input.threadId) &&
            (!input.projectId || r.projectId === input.projectId),
        );
        const at = revision;
        const hits = await reader.search({
          query: input.query,
          documentIds: selected.map((r) => r.id),
          offset: input.offset ?? 0,
          signal: abort.signal,
          details: true,
        });
        // A query snapshot cannot authorize opening a changed source or expose its stale snippets.
        for (const hit of hits) {
          const record = get(hit.documentId);
          if (!record) throw new Error('资料范围已变化，请刷新搜索。');
          await current({ documentId: record.id, version: record.hash ?? '' }, abort.signal);
        }
        return {
          generation: input.generation,
          revision: at,
          rows: hits.flatMap((h) => {
            const row = selected.find((r) => r.id === h.documentId);
            return row ? [{ ...row, snippets: h.snippets ?? [] }] : [];
          }),
          hasMore: hits.length === 20,
        };
      } finally {
        clearTimeout(timer);
      }
    },
    cancelSearch(): void {
      querying?.abort();
    },
    async preview(input: LibraryDocumentInput) {
      const r = await current(input);
      const entries = options.db
        .prepare('SELECT meta FROM library_chunk WHERE document_id=? ORDER BY sequence')
        .all(r.id) as { meta: string }[];
      const blocks = mergeLibraryChunks(
        entries.map(
          (e) =>
            JSON.parse(e.meta) as {
              text: string;
              location: string;
              page?: number;
              needsReview?: boolean;
              offset?: number;
            },
        ),
      );
      const chosen = input.location
        ? blocks.filter((b) => b.location === input.location)
        : blocks.slice(0, 1);
      if (!chosen.length) throw new Error('此位置尚没有可预览的正文。');
      return {
        name: r.name,
        path: r.path,
        text: Array.from(chosen.map((b) => b.text).join('\n'))
          .slice(0, 12000)
          .join(''),
        page: chosen[0]?.page,
        location: chosen[0]!.location,
      };
    },
    async open(input: LibraryDocumentInput): Promise<void> {
      const r = await current(input);
      await options.openPath(r.path);
    },
    async reference(input: LibraryDocumentInput): Promise<{ name: string; text: string }> {
      const r = await current(input);
      const entries = options.db
        .prepare('SELECT meta FROM library_chunk WHERE document_id=? ORDER BY sequence')
        .all(r.id) as { meta: string }[];
      const blocks = mergeLibraryChunks(
        entries.map(
          (e) =>
            JSON.parse(e.meta) as {
              text: string;
              location: string;
              needsReview?: boolean;
              offset?: number;
            },
        ),
      );
      const chosen = input.location ? blocks.filter((b) => b.location === input.location) : blocks;
      if (!chosen.length) throw new Error('还没有可引用的正文。');
      // Copy only the selected location; a whole-document reference is capped and explicitly labeled.
      const text = chosen
        .map((b) => `### ${b.location}${b.needsReview ? '（OCR 需核对）' : ''}\n${b.text}`)
        .join('\n\n');
      const bounded = Array.from(text).slice(0, 100_000).join('');
      const status = r.stopped ? 'stopped' : states.get(r.id)?.state;
      return {
        name: `${r.name}-引用.md`,
        text: `来源：${r.name}\n版本：${r.hash}\n范围：${input.location ?? '已索引正文'}\n${status !== 'searchable' ? '注意：该文件仅部分正文可用。\n' : ''}${text.length !== bounded.length ? '注意：本次引用达到 10 万字符上限。\n' : ''}\n${bounded}`,
      };
    },
    async clearBodyCache(): Promise<LibraryDataView> {
      if (running.size || pending.size) throw new Error('请先停止资料处理，再清理正文缓存。');
      await import('node:fs/promises').then((fs) => fs.rm(cache, { recursive: true, force: true }));
      await mkdir(cache, { recursive: true });
      return this.list();
    },
    async control(input: {
      documentId: string;
      action: 'stop' | 'continue' | 'ocr' | 'remove';
      rotation?: 0 | 90 | 180 | 270 | undefined;
    }): Promise<LibraryDataView> {
      const r = get(input.documentId);
      if (!r) throw new Error('资料不存在。');
      if (input.action === 'remove') {
        drop(r.id);
        if (r.source !== 'artifact') await registry.deleteImport(r.id);
        else await registry.update({ ...r, excluded: true });
      } else if (input.action === 'stop') {
        await registry.update({ ...r, stopped: true });
        pending.delete(r.id);
        running.get(r.id)?.abort();
        state(r.id, { state: 'stopped' });
      } else {
        if (running.has(r.id)) throw new Error('正在处理，请先停止并等待结束。');
        const { rotation: _previousRotation, ...base } = r;
        await registry.update({
          ...base,
          ...(input.action === 'ocr'
            ? input.rotation !== undefined
              ? { rotation: input.rotation }
              : {}
            : r.rotation !== undefined
              ? { rotation: r.rotation }
              : {}),
          ...(input.action === 'ocr' ? { nextPage: 1 } : {}),
          stopped: false,
          ocrAllowed: r.ocrAllowed || input.action === 'ocr',
        });
        enqueue(r.id);
      }
      return {
        rows: rows(),
        bodySearchEnabled: registry.enabled(),
        revision,
        projects: options.projects?.() ?? [],
      };
    },
    dispose(): void {
      disposed = true;
      querying?.abort();
      for (const abort of running.values()) abort.abort();
      pending.clear();
    },
  };
}
export type LibraryHost = Awaited<ReturnType<typeof createLibraryHost>>;

function typeFor(ext: string): string {
  if (ext === '.pdf') return 'pdf';
  if (ext === '.xlsx') return 'spreadsheet';
  if (ext === '.pptx') return 'presentation';
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return 'image';
  if (['.csv', '.tsv', '.json'].includes(ext)) return 'data';
  return 'document';
}

async function libraryBytes(home: string, databasePath: string): Promise<number> {
  const queue = [join(home, 'cache'), join(home, 'library'), databasePath, `${databasePath}-wal`];
  let bytes = 0,
    count = 0;
  while (queue.length && count++ < 100_000) {
    const path = queue.shift()!;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory())
        for (const entry of await readdir(path)) queue.push(join(path, entry));
      else bytes += info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return queue.length ? Infinity : bytes;
}

/** Projection overlap belongs to search recall, not copied task text. */
function mergeLibraryChunks<T extends { text: string; location: string; offset?: number }>(
  chunks: T[],
): T[] {
  const blocks: T[] = [];
  for (const chunk of chunks) {
    const previous = blocks.at(-1);
    if (previous && previous.location === chunk.location && (chunk.offset ?? 0) > 0) {
      const text = Array.from(previous.text);
      text.splice(chunk.offset!, text.length - chunk.offset!, ...Array.from(chunk.text));
      blocks[blocks.length - 1] = { ...previous, text: text.join('') };
    } else blocks.push({ ...chunk });
  }
  return blocks;
}
