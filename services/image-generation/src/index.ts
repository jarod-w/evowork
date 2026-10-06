import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { ImageApiError, type ImageRequest, type ImageResponse } from '@evowork/gateway';
import { createArtifactRepo, readMeta, writeMeta, type SqliteLike } from '@evowork/store';
import { inspectPng } from './png.js';
export { inspectPng } from './png.js';
export { inspectImageInput } from './input.js';
export type ImageState =
  | 'awaitingApproval'
  | 'submitting'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'outcomeUnknown';
export interface ImageOperation {
  id: string;
  cwd: string;
  provider_endpoint: string;
  operation_kind: 'generate' | 'edit';
  thread_id: string;
  turn_id: string;
  call_id: string;
  model: string;
  request_hash: string;
  status: ImageState;
  output_path: string | null;
  output_hash: string | null;
  artifact_id: string | null;
  parent_id: string | null;
  width: number | null;
  height: number | null;
  error_code: string | null;
  submitted_at: number | null;
  created_at: number;
  cancelled: number;
}
export interface ImageContext {
  threadId: string;
  turnId: string;
  callId: string;
  cwd: string;
  model: string;
  baseUrl: string;
}
export type ImageToolInput = { prompt: string; imageRef?: string };
export interface ImageServiceOptions {
  db: SqliteLike;
  ask: (context: ImageContext, message: string, signal: AbortSignal) => Promise<boolean>;
  submit: (request: ImageRequest, signal: AbortSignal) => Promise<ImageResponse>;
  valid: (context: ImageContext) => boolean;
  changed?: (threadId: string) => void;
  indexed?: (threadId: string) => void;
  validateOutput?: ((bytes: Buffer) => void) | undefined;
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !rel.startsWith(sep);
}
function securePath(root: string, path: string) {
  const realRoot = realpathSync(root);
  if (
    !inside(realRoot, resolve(path)) ||
    realpathSync(path) !== resolve(path) ||
    !lstatSync(path).isFile() ||
    lstatSync(path).size > 32 * 1024 * 1024
  )
    throw new ImageApiError('IMAGE_PATH_DENIED');
  return path;
}
export function createImageService(options: ImageServiceOptions) {
  const db = options.db;
  const pending = new Map<
    string,
    { context: ImageContext; abort: AbortController; promise: Promise<ImageOperation> }
  >();
  const get = (id: string) =>
    db.prepare('SELECT * FROM image_operation WHERE id=?').get(id) as ImageOperation | undefined;
  const list = (threadId: string) =>
    db
      .prepare('SELECT * FROM image_operation WHERE thread_id=? ORDER BY created_at DESC')
      .all(threadId) as ImageOperation[];
  function update(id: string, values: Partial<ImageOperation>) {
    const keys = Object.keys(values) as (keyof ImageOperation)[];
    db.prepare(`UPDATE image_operation SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(
      ...keys.map((k) => values[k]),
      id,
    );
    const op = get(id);
    if (op) options.changed?.(op.thread_id);
  }
  function index(op: ImageOperation) {
    if (!op.output_path || !op.output_hash) throw new ImageApiError('IMAGE_FILE_MISSING');
    securePath(op.cwd, op.output_path);
    const bytes = readFileSync(op.output_path);
    inspectPng(bytes);
    options.validateOutput?.(bytes);
    if (hash(bytes) !== op.output_hash) throw new ImageApiError('IMAGE_FILE_CHANGED');
    const repo = createArtifactRepo(db),
      artifactId = op.artifact_id ?? op.id;
    if (!repo.latestFor(op.output_path)) {
      repo.insert({
        id: artifactId,
        threadId: op.thread_id,
        turnId: op.turn_id,
        path: op.output_path,
        artifactType: 'image',
        outputFormat: 'png',
        title: 'AI 图片',
        operationKind: op.operation_kind,
        sizeBytes: bytes.length,
        contentHash: op.output_hash,
        version: 1,
        sourceSignal: 'SKILL_REPORT',
        fileState: 'PRESENT',
        createdAt: op.created_at,
      });
      options.indexed?.(op.thread_id);
    }
    update(op.id, { status: 'completed', artifact_id: artifactId, error_code: null });
  }
  /** Only previously selected upload copies or existing task image artifacts become references. */
  function register(cwd: string, path: string, threadId?: string): string {
    securePath(cwd, path);
    const bytes = readFileSync(path);
    if (bytes.length > 10 * 1024 * 1024) throw new ImageApiError('IMAGE_INPUT_TOO_LARGE');
    inspectPng(bytes);
    const ref = 'img_' + randomUUID();
    writeMeta(
      db,
      'image.ref.' + ref,
      JSON.stringify({
        cwd: realpathSync(cwd),
        path,
        hash: hash(bytes),
        threadId: threadId ?? null,
      }),
    );
    return ref;
  }
  function inputImage(context: ImageContext, ref: string) {
    let info: { cwd: string; path: string; hash: string; threadId: string | null };
    const saved = readMeta(db, 'image.ref.' + ref);
    if (!saved) {
      const artifact = createArtifactRepo(db)
        .listForThread(context.threadId)
        .find((a) => a.id === ref && a.artifactType === 'image' && a.fileState === 'PRESENT');
      if (!artifact) throw new ImageApiError('IMAGE_REFERENCE_UNKNOWN');
      const op = list(context.threadId).find(
        (o) => o.artifact_id === artifact.id && o.status === 'completed',
      );
      if (!op) throw new ImageApiError('IMAGE_REFERENCE_UNKNOWN');
      securePath(context.cwd, artifact.path);
      const bytes = readFileSync(artifact.path);
      if (bytes.length > 10 * 1024 * 1024) throw new ImageApiError('IMAGE_INPUT_TOO_LARGE');
      if (hash(bytes) !== op.output_hash) throw new ImageApiError('IMAGE_FILE_CHANGED');
      return { bytes, parentId: op.id, name: artifact.path };
    }
    try {
      info = JSON.parse(saved) as typeof info;
    } catch {
      throw new ImageApiError('IMAGE_REFERENCE_UNKNOWN');
    }
    if (
      info.cwd !== realpathSync(context.cwd) ||
      (info.threadId && info.threadId !== context.threadId)
    )
      throw new ImageApiError('IMAGE_REFERENCE_DENIED');
    securePath(context.cwd, info.path);
    const bytes = readFileSync(info.path);
    if (bytes.length > 10 * 1024 * 1024 || hash(bytes) !== info.hash)
      throw new ImageApiError('IMAGE_FILE_CHANGED');
    inspectPng(bytes);
    if (!info.threadId)
      writeMeta(db, 'image.ref.' + ref, JSON.stringify({ ...info, threadId: context.threadId }));
    return { bytes, parentId: null, name: info.path };
  }
  function cleanupReferences(threadId?: string) {
    const rows = db.prepare("SELECT key,value FROM meta WHERE key LIKE 'image.ref.%'").all() as {
      key: string;
      value: string;
    }[];
    for (const row of rows) {
      try {
        const info = JSON.parse(row.value) as { cwd: string; path: string; threadId?: string };
        if (
          threadId
            ? info.threadId !== threadId
            : Date.now() - lstatSync(info.path).mtimeMs < 24 * 60 * 60 * 1000
        )
          continue;
        // Only the explicitly named normalization copy is disposable; original files stay.
        if (/^image-edit-[a-f0-9-]+\.png$/.test(basename(info.path))) {
          securePath(info.cwd, info.path);
          rmSync(info.path, { force: true });
        }
        db.prepare('DELETE FROM meta WHERE key=?').run(row.key);
      } catch {
        /* A missing or changed file is never chased outside its recorded root. */
      }
    }
  }
  cleanupReferences();
  function recover() {
    const rows = db.prepare('SELECT * FROM image_operation').all() as ImageOperation[];
    for (const op of rows) {
      if (pending.has(op.id)) continue;
      if (
        op.output_path &&
        existsSync(op.output_path + '.partial') &&
        Date.now() - lstatSync(op.output_path + '.partial').mtimeMs > 24 * 60 * 60 * 1000
      ) {
        try {
          securePath(op.cwd, op.output_path + '.partial');
          rmSync(op.output_path + '.partial', { force: true });
        } catch {
          /* No external cleanup. */
        }
      }
      if (['completed', 'failed', 'cancelled', 'outcomeUnknown'].includes(op.status)) continue;
      if (op.cancelled) {
        update(op.id, {
          status: op.submitted_at ? 'outcomeUnknown' : 'cancelled',
          error_code: 'IMAGE_CANCELLED',
        });
        continue;
      }
      if (
        op.status === 'saving' &&
        op.output_path &&
        !existsSync(op.output_path) &&
        existsSync(op.output_path + '.partial')
      ) {
        try {
          securePath(op.cwd, op.output_path + '.partial');
          const bytes = readFileSync(op.output_path + '.partial');
          inspectPng(bytes);
          options.validateOutput?.(bytes);
          if (hash(bytes) !== op.output_hash) throw new ImageApiError('IMAGE_FILE_CHANGED');
          renameSync(op.output_path + '.partial', op.output_path);
        } catch {
          update(op.id, { status: 'saving', error_code: 'IMAGE_SAVE_FAILED' });
          continue;
        }
      }
      if (op.status === 'saving' && op.output_path && existsSync(op.output_path)) {
        try {
          index(op);
        } catch {
          update(op.id, { status: 'saving', error_code: 'IMAGE_SAVE_FAILED' });
        }
      } else
        update(op.id, {
          status: op.submitted_at ? 'outcomeUnknown' : 'cancelled',
          error_code: op.submitted_at ? 'IMAGE_OUTCOME_UNKNOWN' : 'IMAGE_APPROVAL_EXPIRED',
        });
    }
  }
  recover();
  async function execute(
    context: ImageContext,
    input: ImageToolInput,
    controller: AbortController,
    op: ImageOperation,
  ) {
    let stage = 'approval';
    try {
      const reference = input.imageRef ? inputImage(context, input.imageRef) : undefined;
      const before = reference ? hash(reference.bytes) : null;
      const message = `${reference ? '编辑' : '生成'}一张 AI 图片\n模型：${context.model}\n服务地址：${context.baseUrl}\n凭据：用户自带（BYOK）\n尺寸：2K，PNG，保留服务商水印\n${reference ? `将上传：${reference.name}\n` : ''}最终提示词：${input.prompt}\n服务商计费，金额暂不能确认；本任务额度 ${readMeta(db, 'image.budget.' + context.threadId) ?? '4'} 次（含结果未知的已提交请求）。确认接受本次费用并${reference ? '上传所选图片' : '发送提示词'}？\n原图保留，结果另存。`;
      if (!(await options.ask(context, message, controller.signal))) {
        update(op.id, { status: 'cancelled', error_code: 'IMAGE_DECLINED' });
        return get(op.id)!;
      }
      if (controller.signal.aborted || !options.valid(context))
        throw new ImageApiError('IMAGE_CANCELLED');
      if (reference && hash(inputImage(context, input.imageRef!).bytes) !== before)
        throw new ImageApiError('IMAGE_FILE_CHANGED');
      stage = 'submit';
      update(op.id, {
        status: 'submitting',
        submitted_at: Date.now(),
        parent_id: reference?.parentId ?? null,
      });
      const result = await options.submit(
        {
          model: context.model,
          prompt: input.prompt,
          ...(reference
            ? { image: 'data:image/png;base64,' + reference.bytes.toString('base64') }
            : {}),
        },
        controller.signal,
      );
      if (controller.signal.aborted || !options.valid(context) || get(op.id)?.cancelled)
        throw new ImageApiError('IMAGE_CANCELLED', true);
      stage = 'save';
      const bytes = Buffer.from(result.b64, 'base64');
      const size = inspectPng(bytes);
      options.validateOutput?.(bytes);
      const root = realpathSync(context.cwd);
      let dir = root;
      for (const part of ['artifacts', 'images', op.id]) {
        dir = join(dir, part);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (lstatSync(dir).isSymbolicLink() || realpathSync(dir) !== dir)
          throw new ImageApiError('IMAGE_PATH_DENIED');
      }
      const path = join(dir, 'result.png'),
        partial = path + '.partial';
      update(op.id, {
        status: 'saving',
        output_path: path,
        output_hash: hash(bytes),
        width: size.width,
        height: size.height,
      });
      writeFileSync(partial, bytes, { mode: 0o600, flag: 'wx' });
      const fd = openSync(partial, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (!options.valid(context) || controller.signal.aborted) {
        rmSync(partial, { force: true });
        throw new ImageApiError('IMAGE_CANCELLED', true);
      }
      if (existsSync(path)) throw new ImageApiError('IMAGE_OUTPUT_EXISTS');
      renameSync(partial, path);
      const directory = openSync(dirname(path), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      index(get(op.id)!);
    } catch (e) {
      const error =
        e instanceof ImageApiError
          ? e
          : new ImageApiError(
              stage === 'save' ? 'IMAGE_SAVE_FAILED' : 'IMAGE_OUTCOME_UNKNOWN',
              stage === 'submit',
            );
      update(op.id, {
        status:
          stage === 'save' && get(op.id)?.output_path
            ? 'saving'
            : error.outcomeUnknown
              ? 'outcomeUnknown'
              : controller.signal.aborted
                ? 'cancelled'
                : 'failed',
        error_code: error.code,
      });
    }
    return get(op.id)!;
  }
  return {
    list,
    register,
    recover,
    busy: () => pending.size > 0,
    acknowledge(threadId: string, operationId: string) {
      const op = get(operationId);
      if (!op || op.thread_id !== threadId || op.status !== 'outcomeUnknown')
        throw new ImageApiError('IMAGE_OPERATION_INVALID');
      writeMeta(db, 'image.ack.' + op.id, '1');
    },
    extendBudget(threadId: string) {
      const budget = Number(readMeta(db, 'image.budget.' + threadId) ?? '4');
      writeMeta(db, 'image.budget.' + threadId, String(Math.min(100, budget + 4)));
    },
    run(context: ImageContext, input: ImageToolInput): Promise<ImageOperation> {
      if (!options.valid(context)) return Promise.reject(new ImageApiError('IMAGE_CONTEXT_DENIED'));
      if (!input.prompt.trim() || input.prompt.length > 8000)
        return Promise.reject(new ImageApiError('IMAGE_REQUEST_INVALID'));
      const prior = db
        .prepare('SELECT * FROM image_operation WHERE thread_id=? AND turn_id=? AND call_id=?')
        .get(context.threadId, context.turnId, context.callId) as ImageOperation | undefined;
      const requestHash = hash(
        JSON.stringify({ model: context.model, baseUrl: context.baseUrl, input }),
      );
      if (prior) {
        if (prior.request_hash !== requestHash)
          return Promise.reject(new ImageApiError('IMAGE_CALL_CHANGED'));
        return pending.get(prior.id)?.promise ?? Promise.resolve(prior);
      }
      if (pending.size) return Promise.reject(new ImageApiError('IMAGE_BUSY'));
      if (
        list(context.threadId).filter((o) => o.submitted_at !== null).length >=
        Number(readMeta(db, 'image.budget.' + context.threadId) ?? '4')
      )
        return Promise.reject(new ImageApiError('IMAGE_BUDGET_EXHAUSTED'));
      if (
        list(context.threadId).some(
          (o) =>
            (o.status === 'outcomeUnknown' && readMeta(db, 'image.ack.' + o.id) !== '1') ||
            o.status === 'saving',
        )
      )
        return Promise.reject(new ImageApiError('IMAGE_PREVIOUS_RESULT_UNRESOLVED'));
      const id = randomUUID();
      db.prepare(
        "INSERT INTO image_operation(id,cwd,thread_id,turn_id,call_id,model,provider_endpoint,operation_kind,request_hash,status,created_at,cancelled) VALUES(?,?,?,?,?,?,?,?,?,'awaitingApproval',?,0)",
      ).run(
        id,
        realpathSync(context.cwd),
        context.threadId,
        context.turnId,
        context.callId,
        context.model,
        context.baseUrl,
        input.imageRef ? 'edit' : 'generate',
        requestHash,
        Date.now(),
      );
      const abort = new AbortController();
      // Schedule after map insertion so concurrent same-call retries see the same promise.
      const promise = Promise.resolve()
        .then(() => execute(context, input, abort, get(id)!))
        .finally(() => pending.delete(id));
      pending.set(id, { context, abort, promise });
      return promise;
    },
    cancel(threadId?: string) {
      for (const [id, entry] of pending)
        if (!threadId || entry.context.threadId === threadId) {
          update(id, { cancelled: 1 });
          entry.abort.abort();
        }
    },
    remove(threadId: string) {
      this.cancel(threadId);
      cleanupReferences(threadId);
      for (const op of list(threadId))
        if (op.output_path && existsSync(op.output_path + '.partial')) {
          try {
            securePath(op.cwd, op.output_path + '.partial');
            rmSync(op.output_path + '.partial', { force: true });
          } catch {
            /* Preserve any unowned path. */
          }
        }
      // Tombstones retain uncertain accounting; completed user files stay on disk.
      db.prepare('UPDATE image_operation SET cancelled=1 WHERE thread_id=?').run(threadId);
    },
  };
}
