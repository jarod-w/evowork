import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  renameSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, createArtifactRepo, type Store } from '@evowork/store';
import { IMAGE_MODELS, ImageApiError, type ImageRequest } from '@evowork/gateway';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createImageService, inspectPng, type ImageContext } from '../src/index.js';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
let root: string, store: Store, context: ImageContext;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'evowork-image-')));
  store = openStore({ path: join(root, 'db') });
  context = {
    cwd: root,
    threadId: 'thread',
    turnId: 'turn',
    callId: 'call',
    model: IMAGE_MODELS[0].id,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3/',
  };
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
const response = () =>
  Promise.resolve({ b64: png.toString('base64'), model: IMAGE_MODELS[0].id, generatedImages: 1 });
it('PNG validates complete compressed bytes and rejects altered/truncated bytes', () => {
  expect(inspectPng(png)).toEqual({ width: 1, height: 1 });
  expect(() => inspectPng(png.subarray(0, -1))).toThrow();
  const bad = Buffer.from(png);
  bad[45] = 9;
  expect(() => inspectPng(bad)).toThrow();
});
it('declining uploads/cost makes zero paid calls; repeating the same call does not ask twice', async () => {
  const ask = vi.fn(async () => false),
    submit = vi.fn((_request: ImageRequest) => response());
  const service = createImageService({ db: store.db, valid: () => true, ask, submit });
  const first = await service.run(context, { prompt: 'a cat' });
  expect(first.status).toBe('cancelled');
  expect(await service.run(context, { prompt: 'a cat' })).toEqual(first);
  await expect(service.run(context, { prompt: 'different contents' })).rejects.toThrow(
    'IMAGE_CALL_CHANGED',
  );
  expect(ask).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
});
it('real bytes are atomically saved/indexed, repeated calls deduplicate, edit keeps both versions', async () => {
  const submit = vi.fn((_request: ImageRequest) => response()),
    indexed = vi.fn();
  const service = createImageService({
    db: store.db,
    valid: () => true,
    ask: async () => true,
    submit,
    indexed,
  });
  const [a, b] = await Promise.all([
    service.run(context, { prompt: 'a cat' }),
    service.run(context, { prompt: 'a cat' }),
  ]);
  expect(a.status).toBe('completed');
  expect(b.id).toBe(a.id);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(readFileSync(a.output_path!)).toEqual(png);
  const edit = await service.run(
    { ...context, callId: 'edit' },
    { prompt: 'make it blue', imageRef: a.artifact_id! },
  );
  expect(edit.status).toBe('completed');
  expect(edit.parent_id).toBe(a.id);
  expect(edit.output_path).not.toBe(a.output_path);
  expect(submit.mock.calls[1]![0]).toHaveProperty(
    'image',
    'data:image/png;base64,' + png.toString('base64'),
  );
  expect(createArtifactRepo(store.db).listForThread('thread')).toHaveLength(2);
  service.recover();
  expect(indexed).toHaveBeenCalledTimes(2);
});
it('unknown outcome blocks retries until explicit acknowledgment and still counts toward four calls', async () => {
  const submit = vi.fn(async () => {
    throw new ImageApiError('IMAGE_OUTCOME_UNKNOWN', true);
  });
  const service = createImageService({
    db: store.db,
    valid: () => true,
    ask: async () => true,
    submit,
  });
  const op = await service.run(context, { prompt: 'a cat' });
  expect(op.status).toBe('outcomeUnknown');
  await expect(service.run({ ...context, callId: 'two' }, { prompt: 'a cat' })).rejects.toThrow(
    'IMAGE_PREVIOUS_RESULT_UNRESOLVED',
  );
  service.acknowledge('thread', op.id);
  for (let i = 1; i < 4; i++) {
    const next = await service.run({ ...context, callId: String(i) }, { prompt: 'a cat' });
    service.acknowledge('thread', next.id);
  }
  await expect(service.run({ ...context, callId: 'five' }, { prompt: 'a cat' })).rejects.toThrow(
    'IMAGE_BUDGET_EXHAUSTED',
  );
  expect(submit).toHaveBeenCalledTimes(4);
  service.extendBudget('thread');
  await service.run({ ...context, callId: 'five' }, { prompt: 'a cat' });
  expect(submit).toHaveBeenCalledTimes(5);
});
it('cancelled or deleted tasks never deliver late provider bytes', async () => {
  let finish: ((value: Awaited<ReturnType<typeof response>>) => void) | undefined;
  const service = createImageService({
    db: store.db,
    valid: () => true,
    ask: async () => true,
    submit: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = service.run(context, { prompt: 'a cat' });
  await vi.waitFor(() => expect(finish).toBeDefined());
  service.remove('thread');
  finish!(await response());
  expect((await pending).status).toBe('outcomeUnknown');
  expect(createArtifactRepo(store.db).listForThread('thread')).toHaveLength(0);
});
it('restart restores valid partial files/indexes locally; a submitting record becomes unknown without POST', async () => {
  const service = createImageService({
    db: store.db,
    valid: () => true,
    ask: async () => true,
    submit: response,
  });
  const op = await service.run(context, { prompt: 'a cat' });
  renameSync(op.output_path!, op.output_path! + '.partial');
  store.db.prepare("UPDATE image_operation SET status='saving' WHERE id=?").run(op.id);
  const submit = vi.fn(response);
  const restored = createImageService({
    db: store.db,
    valid: () => true,
    ask: async () => true,
    submit,
  });
  expect(restored.list('thread')[0]?.status).toBe('completed');
  expect(readFileSync(op.output_path!)).toEqual(png);
  expect(submit).not.toHaveBeenCalled();
  store.db
    .prepare("UPDATE image_operation SET status='submitting',output_path=NULL WHERE id=?")
    .run(op.id);
  restored.recover();
  expect(restored.list('thread')[0]?.status).toBe('outcomeUnknown');
  expect(submit).not.toHaveBeenCalled();
});
it('only registered bounded files in the same task may be uploaded, mutations/symlinks are refused', async () => {
  const submit = vi.fn((_request: ImageRequest) => response());
  const service = createImageService({
    db: store.db,
    valid: () => true,
    ask: async () => true,
    submit,
  });
  const path = join(root, 'selected.png');
  writeFileSync(path, png);
  const ref = service.register(root, path, 'thread');
  const wrong = await service.run(
    { ...context, threadId: 'other' },
    { prompt: 'blue', imageRef: ref },
  );
  expect(wrong.error_code).toBe('IMAGE_REFERENCE_DENIED');
  writeFileSync(path, Buffer.from('changed'));
  const modified = await service.run(context, { prompt: 'blue', imageRef: ref });
  expect(modified.error_code).toBe('IMAGE_FILE_CHANGED');
  expect(submit).not.toHaveBeenCalled();
  symlinkSync(path, join(root, 'link.png'));
  expect(() => service.register(root, join(root, 'link.png'))).toThrow('IMAGE_PATH_DENIED');
});
