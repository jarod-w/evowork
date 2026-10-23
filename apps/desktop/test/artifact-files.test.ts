import {
  renameSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { createArtifactWatcher, type IndexPort } from '@evowork/artifacts';
import { openStore, createArtifactRepo } from '@evowork/store';
import { createArtifactFileIO, ARTIFACT_VERIFY_MS } from '../src/main/artifact-files.js';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evowork-file-cache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
it('稳定文件反复扫描与登记只计算一次完整哈希，期满仍会复核', async () => {
  const path = join(dir, 'large.json');
  writeFileSync(path, Buffer.alloc(1024 * 1024, 1));
  let now = 0;
  const reads: number[] = [];
  const io = createArtifactFileIO({ now: () => now, onHash: (bytes) => reads.push(bytes) });
  io.listFiles(dir).forEach(io.fingerprint);
  expect(reads).toEqual([]);
  const first = await io.scan(dir);
  await io.scan(dir);
  io.stat(path);
  await io.scan(dir);
  expect(reads).toEqual([1024 * 1024]);
  expect(io.stat(path)?.contentHash).toBe(first.get(path)?.contentHash);
  now = ARTIFACT_VERIFY_MS;
  await io.scan(dir);
  expect(reads).toEqual([1024 * 1024, 1024 * 1024]);
});
it('等长尾部修改且恢复 mtime 仍触发重算，原子替换也不会复用旧缓存', async () => {
  const path = join(dir, 'report.json'),
    bytes = Buffer.alloc(128 * 1024, 1);
  const stamp = new Date('2020-01-01');
  writeFileSync(path, bytes);
  utimesSync(path, stamp, stamp);
  const io = createArtifactFileIO();
  const old = (await io.scan(dir)).get(path)?.contentHash;
  bytes[bytes.length - 1] = 2;
  writeFileSync(path, bytes);
  utimesSync(path, stamp, stamp);
  const updated = (await io.scan(dir)).get(path)?.contentHash;
  expect(updated).not.toBe(old);
  expect(updated).toBe(io.stat(path)?.contentHash);
  rmSync(path);
  writeFileSync(path, Buffer.alloc(bytes.length, 3));
  utimesSync(path, stamp, stamp);
  expect((await io.scan(dir)).get(path)?.contentHash).not.toBe(updated);
});
it('上传副本、缓存和非产物在读正文前排除，符号链接不跟随', async () => {
  for (const name of ['uploads', 'node_modules', '.cache', '__pycache__']) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'huge.json'), 'ignored');
  }
  writeFileSync(join(dir, 'code.ts'), 'code');
  writeFileSync(join(dir, 'keep.json'), 'keep');
  symlinkSync(join(dir, 'keep.json'), join(dir, 'link.json'));
  const reads: number[] = [];
  const io = createArtifactFileIO({ onHash: (n) => reads.push(n) });
  expect(io.listFiles(dir)).toEqual([join(dir, 'keep.json')]);
  expect([...(await io.scan(dir)).keys()]).toEqual([join(dir, 'keep.json')]);
  expect(reads).toEqual([4]);
  expect(io.stat(join(dir, 'link.json'))).toBeUndefined();
});
it('重叠目录同时扫描共享正在计算的哈希，文件删除后不会返回旧值', async () => {
  const path = join(dir, 'data.json');
  writeFileSync(path, Buffer.alloc(1024 * 1024, 1));
  const reads: number[] = [];
  const io = createArtifactFileIO({ onHash: (n) => reads.push(n) });
  await Promise.all([io.scan(dir), io.scan(dir)]);
  expect(reads).toHaveLength(1);
  rmSync(path);
  expect((await io.scan(dir)).size).toBe(0);
  expect(io.stat(path)).toBeUndefined();
});

it('真实 SQLite 对账移动只保留原记录与版本链，不产生同路径副本', () => {
  const work = join(dir, 'work');
  mkdirSync(work);
  const store = openStore({ path: join(dir, 'host.db') });
  const io = createArtifactFileIO(),
    repo = createArtifactRepo(store.db);
  let sequence = 0;
  const watcher = createArtifactWatcher({
    fs: { ...io, watch: () => () => undefined },
    index: repo as unknown as IndexPort,
    now: () => 0,
    newId: () => String(++sequence),
  });
  try {
    watcher.start(work);
    const old = join(work, 'chart.svg');
    writeFileSync(old, '<svg/>');
    watcher.ingestSkillReport(
      { skill: 'charts', path: old, outputFormat: 'svg', operationKind: 'create' },
      { threadId: 'owner', turnId: 'turn' },
    );
    const before = store.db.prepare('SELECT id,version,content_hash FROM artifact').get();
    const target = join(work, 'moved.svg');
    renameSync(old, target);
    expect(watcher.reconcile(work)).toEqual({ added: 0, moved: 1, missing: 0 });
    expect(store.db.prepare('SELECT id,version,content_hash FROM artifact').all()).toEqual([
      before,
    ]);
    expect(
      store.db.prepare('SELECT path,thread_id,turn_id,file_state FROM artifact').get(),
    ).toEqual({ path: target, thread_id: 'owner', turn_id: 'turn', file_state: 'PRESENT' });
  } finally {
    watcher.stop();
    store.close();
  }
});
