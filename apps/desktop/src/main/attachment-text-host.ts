import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { createOcrProcessor, sourceDigest } from '@evowork/ingest';
import type { ComposerAttachmentView, AttachmentTextInput } from '../shared/ipc.js';

interface Source {
  readonly id: string;
  readonly root: string;
  path: string;
  view: ComposerAttachmentView;
  stopped: boolean;
  hash?: string;
  nextPage?: number;
  rotation?: 0 | 90 | 180 | 270;
  result?: {
    readonly complete: boolean;
    readonly text: string;
    readonly total: number;
    readonly completed: number;
    readonly hash: string;
  };
}
/** Selected attachment registrations only. Never enumerate old upload directories. */
export function createAttachmentTextHost(options: {
  readonly home: string;
  readonly runtimeRoot: string;
}) {
  const records = new Map<string, Source>(),
    jobs = new Map<string, AbortController>();
  const folder = join(options.home, 'attachment-sources');
  const file = (id: string) => {
    if (!/^attachment-[a-f0-9-]{36}$/.test(id))
      throw new Error('此附件不支持正文处理，请重新添加。');
    return join(folder, `${id}.json`);
  };
  let saving = Promise.resolve();
  const save = (record: Source): Promise<void> => {
    const path = file(record.id),
      snapshot = JSON.stringify(record);
    const operation = saving.then(async () => {
      await mkdir(folder, { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, path);
    });
    saving = operation.catch(() => {});
    return operation;
  };
  const get = async (root: string, id: string): Promise<Source> => {
    let record = records.get(id);
    if (!record) {
      const path = file(id);
      if ((await lstat(path)).size > 16 * 1024 * 1024) throw new Error('附件记录损坏。');
      record = JSON.parse(await readFile(path, 'utf8')) as Source;
      if (record.id !== id || typeof record.path !== 'string' || record.view?.id !== id)
        throw new Error('附件记录损坏。');
      if (record.view.state === 'parsing') {
        record.stopped = true;
        record.view = {
          ...record.view,
          state: 'failed',
          error: '处理已中断，可继续识别剩余页。',
          textProcessing: { state: 'stopped' },
        };
      }
      records.set(id, record);
    }
    const realRoot = await realpath(root),
      path = await realpath(record.path);
    if (
      record.root !== realRoot ||
      path !== resolve(record.path) ||
      !path.startsWith(`${realRoot}/uploads/`) ||
      (await lstat(record.path)).isSymbolicLink()
    )
      throw new Error('附件不在当前任务目录。');
    return record;
  };
  const start = (record: Source, input: AttachmentTextInput) => {
    if (jobs.has(record.id)) throw new Error('附件仍在处理，请等待停止完成。');
    const abort = new AbortController();
    jobs.set(record.id, abort);
    record.stopped = false;
    if (input.action === 'ocr') {
      if (input.rotation === undefined) delete record.rotation;
      else record.rotation = input.rotation;
      record.nextPage = 1;
      delete record.result;
      delete record.hash;
    }
    record.view = {
      ...record.view,
      state: 'parsing',
      references: [],
      textProcessing: { state: 'ocr' },
    };
    void (async () => {
      await save(record);
      try {
        const result = await createOcrProcessor({
          runtimeRoot: options.runtimeRoot,
          cacheRoot: join(options.home, 'cache', 'ingest'),
        }).recognize({
          path: record.path,
          signal: abort.signal,
          ...(record.rotation !== undefined ? { rotation: record.rotation } : {}),
          startPage: input.startPage ?? record.nextPage ?? 1,
          onProgress: (p) => {
            if (record.stopped || record.view.textProcessing?.state === 'removed') return;
            record.view = {
              ...record.view,
              textProcessing: {
                state: 'ocr',
                completed: p.completed,
                total: p.total,
                failed: p.failed,
              },
            };
          },
        });
        if (record.view.textProcessing?.state === 'removed') return;
        const completed = result.pages.filter(
          (p) => p.state === 'complete' || p.state === 'blank',
        ).length;
        const present = new Set(
          result.pages.filter((p) => p.state !== 'failed').map((p) => p.page),
        );
        let nextPage = 1;
        while (present.has(nextPage) && nextPage < result.total) nextPage++;
        record.nextPage = nextPage;
        record.result = {
          complete: result.complete,
          text: result.markdown,
          total: result.total,
          completed,
          hash: result.sourceHash,
        };
        record.hash = result.sourceHash;
        if (result.complete && !record.stopped) await use(record, true);
        else
          record.view = {
            ...record.view,
            state: 'failed',
            error: record.stopped
              ? '识别已停止。可以继续，或明确使用已完成部分。'
              : '仅完成部分页，请选择继续或使用已完成部分。',
            textProcessing: {
              state: record.stopped ? 'stopped' : 'partial',
              completed,
              total: result.total,
            },
          };
      } catch (error) {
        if (record.view.textProcessing?.state === 'removed') return;
        record.view = {
          ...record.view,
          state: 'failed',
          references: [],
          error: record.stopped
            ? '识别已停止，可继续。'
            : error instanceof Error &&
                (error.message.includes('RUNTIME') || error.message.includes('ENOENT'))
              ? '需要安装本地 OCR 组件。PDF 另需办公扩展进行渲染。'
              : '识别失败，请检查文件和组件后重试。',
          textProcessing: { state: record.stopped ? 'stopped' : 'failed' },
        };
      } finally {
        jobs.delete(record.id);
        await save(record);
      }
    })().catch(() => {
      jobs.delete(record.id);
    });
  };
  const use = async (record: Source, automatic = false) => {
    const result = record.result;
    if (!result || !result.text.trim()) throw new Error('还没有可引用的文字。');
    if ((await sourceDigest(record.path)) !== result.hash)
      throw new Error('附件内容已变化，请重新识别。');
    if (record.view.textProcessing?.state === 'removed' || (automatic && record.stopped)) return;
    const path = join(record.path.slice(0, record.path.lastIndexOf('/')), 'ocr-content.md');
    const text = `来源：${record.view.name}\n${result.complete ? '完整识别' : `仅使用已完成 ${result.completed}/${result.total} 页；未完成页未包含。`}\n识别文字可能有误，请核对原件。\n\n${result.text}`;
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
    if (record.view.textProcessing?.state === 'removed' || (automatic && record.stopped)) return;
    record.view = {
      ...record.view,
      state: 'ready',
      error: undefined,
      kind: 'document',
      references: [
        { type: 'mention', name: record.view.name, path },
        { type: 'text', text: `识别正文：${path}\n${Array.from(text).slice(0, 400).join('')}` },
      ],
      textProcessing: {
        state: result.complete ? 'complete' : 'partial',
        completed: result.completed,
        total: result.total,
      },
    };
  };
  return {
    async register(
      root: string,
      path: string,
      view: ComposerAttachmentView,
    ): Promise<ComposerAttachmentView> {
      if (!['.pdf', '.png', '.jpg', '.jpeg', '.webp'].includes(extname(path).toLowerCase()))
        return view;
      const record: Source = {
        id: view.id,
        root: await realpath(root),
        path,
        view: {
          ...view,
          rawReference: view.rawReference ?? {
            type: 'mention',
            name: view.name,
            path: await realpath(path),
          },
          textProcessing: { state: 'available' },
        },
        stopped: false,
      };
      record.path = await realpath(path);
      records.set(view.id, record);
      await save(record);
      return record.view;
    },
    async status(root: string, id: string): Promise<ComposerAttachmentView> {
      return (await get(root, id)).view;
    },
    async source(root: string, id: string): Promise<string> {
      return (await get(root, id)).path;
    },
    async control(root: string, input: AttachmentTextInput): Promise<ComposerAttachmentView> {
      const record = await get(root, input.attachmentId);
      if (input.action === 'stop' || input.action === 'remove') {
        record.stopped = true;
        jobs.get(record.id)?.abort();
        record.view = {
          ...record.view,
          state: 'failed',
          references: [],
          textProcessing: { state: input.action === 'remove' ? 'removed' : 'stopped' },
        };
      } else if (input.action === 'partial') {
        if (jobs.has(record.id)) throw new Error('先停止识别，再使用已完成部分。');
        await use(record);
      } else start(record, input);
      await save(record);
      return record.view;
    },
    stop(): void {
      for (const abort of jobs.values()) abort.abort();
    },
  };
}
export type AttachmentTextHost = ReturnType<typeof createAttachmentTextHost>;
