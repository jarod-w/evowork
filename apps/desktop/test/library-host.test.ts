import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openStore, type Store } from '@evowork/store';
import { createLibraryHost, type LibraryHost } from '../src/main/library-host.js';
let root: string, store: Store, host: LibraryHost;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'evowork-library-host-')));
  store = openStore({ path: join(root, 'library.db') });
});
afterEach(async () => {
  host?.dispose();
  store.close();
  await rm(root, { recursive: true, force: true });
});
const start = async (paths: readonly string[]) =>
  createLibraryHost({
    home: root,
    db: store.db,
    databasePath: join(root, 'library.db'),
    artifacts: () => [],
    approveArtifact: async () => false,
    pickFiles: async () => paths,
    openPath: async () => {},
  });
const settled = async () => {
  for (let n = 0; n < 100; n++) {
    const data = await host.list();
    if (
      data.rows.every((r) => !['queued', 'inspecting', 'extracting', 'ocr'].includes(r.state ?? ''))
    )
      return data;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('index never settled');
};
it('imports a controlled copy, searches body with cross-block AND/snippets, and copies only a selected location', async () => {
  const source = join(root, 'external.txt');
  await writeFile(source, '合同 毛利率\n' + 'a'.repeat(4500) + '\n付款方式 全角ＡＢＣ');
  host = await start([source]);
  await host.importFiles();
  await host.enable();
  const data = await settled();
  expect(data.rows).toHaveLength(1);
  expect(data.rows[0]?.state).toBe('searchable');
  const result = await host.search({ query: '毛利率 付款', generation: 9 });
  expect(result.rows).toHaveLength(1);
  expect(result.generation).toBe(9);
  const row = result.rows[0]!;
  expect(row.snippets?.length).toBeGreaterThan(0);
  expect(row.snippets?.every((s) => Array.from(s.text).length <= 240)).toBe(true);
  const selected = await host.reference({
    documentId: row.id,
    version: row.version!,
    location: row.snippets![0]!.location,
  });
  expect(selected.text).toContain('范围：');
  expect(selected.text).toContain('合同');
  expect((await host.search({ query: 'ａｂｃ', generation: 10 })).rows).toHaveLength(1);
  await writeFile(source, 'outside was changed');
  expect((await host.search({ query: '毛利率', generation: 11 })).rows).toHaveLength(1);
  await host.control({ documentId: row.id, action: 'remove' });
  expect((await host.list()).rows).toHaveLength(0);
  expect(await readFile(source, 'utf8')).toBe('outside was changed');
  host.dispose();
  host = await start([]);
  expect((await host.list()).rows).toHaveLength(0);
});
it('rejects an old result after a managed source changed and never opens outside its registration', async () => {
  const source = join(root, '外部.txt');
  await writeFile(source, '已核对付款条件');
  host = await start([source]);
  await host.importFiles();
  await host.enable();
  const row = (await settled()).rows[0]!;
  await writeFile(join(root, 'library', row.id, 'original.txt'), '不同版本');
  await expect(host.open({ documentId: row.id, version: row.version! })).rejects.toThrow(
    '内容已变化',
  );
  expect((await host.search({ query: '已核对', generation: 1 })).rows).toHaveLength(0);
});
it('explicit stops survive a restart and rebuilding projection does not re-authorize them', async () => {
  const source = join(root, 'notes.txt');
  await writeFile(source, '合同付款');
  host = await createLibraryHost({
    home: root,
    db: store.db,
    databasePath: join(root, 'library.db'),
    artifacts: () => [],
    approveArtifact: async () => false,
    pickFiles: async () => [source],
    openPath: async () => {},
    extract: async (input) =>
      new Promise((resolve) => {
        input.signal?.addEventListener(
          'abort',
          () => resolve({ blocks: [], partial: true, ocrCandidates: 0 }),
          { once: true },
        );
      }),
  });
  const row = (await host.importFiles()).rows[0]!;
  await host.control({ documentId: row.id, action: 'stop' });
  await settled();
  host.dispose();
  store.db.exec(
    'DELETE FROM library_index; DELETE FROM library_chunk; DELETE FROM library_document;',
  );
  host = await start([]);
  expect((await host.list()).rows[0]?.state).toBe('stopped');
  expect(await readFile(source, 'utf8')).toBe('合同付款');
});
it('only current approved artifact versions enter scope after enabling; removals stay excluded', async () => {
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const path = join(workspace, 'report.txt');
  await writeFile(path, '内部合同');
  let version = 1;
  const artifacts = () => [
    {
      id: `version-${version}`,
      path,
      title: 'report.txt',
      version,
      fileState: 'PRESENT',
      threadId: 'task',
      createdAt: 1,
    },
  ];
  const options = {
    home: root,
    db: store.db,
    databasePath: join(root, 'library.db'),
    artifacts,
    approveArtifact: async () => true,
    pickFiles: async () => [],
    openPath: async () => {},
  };
  host = await createLibraryHost(options);
  expect((await host.list()).rows).toEqual([]);
  await host.enable();
  const row = (await settled()).rows[0]!;
  expect((await host.search({ query: '内部合同', generation: 1 })).rows).toHaveLength(1);
  await host.control({ documentId: row.id, action: 'remove' });
  version = 2;
  host.dispose();
  host = await createLibraryHost(options);
  expect((await host.list()).rows).toHaveLength(0);
  expect(await readFile(path, 'utf8')).toBe('内部合同');
});

it('a disk soft limit pauses new parsing while the selected managed copy remains available', async () => {
  const path = join(root, 'quota.txt');
  await writeFile(path, 'x'.repeat(1500));
  host = await createLibraryHost({
    home: root,
    db: store.db,
    databasePath: join(root, 'library.db'),
    artifacts: () => [],
    approveArtifact: async () => false,
    pickFiles: async () => [path],
    openPath: async () => {},
    quotaBytes: 1000,
  });
  await host.importFiles();
  const rows = (await settled()).rows;
  expect(rows[0]?.state).toBe('paused');
  expect(await readFile(path, 'utf8')).toHaveLength(1500);
});

it('explicitly updates a managed copy while preserving its identity and both external originals', async () => {
  const first = join(root, 'first.txt'),
    replacement = join(root, 'replacement.txt');
  await writeFile(first, '旧版合同');
  await writeFile(replacement, '新版付款');
  let picked = first;
  host = await createLibraryHost({
    home: root,
    db: store.db,
    databasePath: join(root, 'library.db'),
    artifacts: () => [],
    approveArtifact: async () => false,
    pickFiles: async () => [picked],
    openPath: async () => {},
  });
  await host.importFiles();
  await host.enable();
  const old = (await settled()).rows[0]!;
  picked = replacement;
  await host.updateImport(old.id);
  const next = (await settled()).rows[0]!;
  expect(next.id).toBe(old.id);
  expect(next.version).not.toBe(old.version);
  expect((await host.search({ query: '旧版', generation: 1 })).rows).toHaveLength(0);
  expect((await host.search({ query: '新版', generation: 2 })).rows).toHaveLength(1);
  await expect(host.reference({ documentId: old.id, version: old.version! })).rejects.toThrow(
    '版本已变化',
  );
  expect(await readFile(first, 'utf8')).toBe('旧版合同');
  expect(await readFile(replacement, 'utf8')).toBe('新版付款');
});
it('task and project filters apply before pagination, and joined attachments stay explicitly scoped', async () => {
  const paths = [join(root, 'a.txt'), join(root, 'b.txt')];
  await Promise.all(paths.map((p) => writeFile(p, '相同合同正文')));
  host = await createLibraryHost({
    home: root,
    db: store.db,
    databasePath: join(root, 'library.db'),
    artifacts: () => [],
    projects: () => [{ id: 'project-a', name: 'A' }],
    projectOfThread: (id) => (id === 'task-a' ? 'project-a' : undefined),
    approveArtifact: async () => false,
    pickFiles: async () => [],
    openPath: async () => {},
  });
  expect((await host.list()).rows).toHaveLength(0);
  await host.joinAttachment(paths[0]!, 'task-a');
  await host.joinAttachment(paths[1]!, 'task-b');
  await host.enable();
  await settled();
  expect(
    (await host.search({ query: '合同', generation: 1, projectId: 'project-a' })).rows.map(
      (r) => r.threadId,
    ),
  ).toEqual(['task-a']);
  expect(
    (await host.search({ query: '合同', generation: 2, threadId: 'task-b' })).rows.map(
      (r) => r.threadId,
    ),
  ).toEqual(['task-b']);
});
it('a long selected source block is copied once without projection overlap', async () => {
  const path = join(root, 'long.txt');
  await writeFile(path, 'source');
  const text = '起点' + 'x'.repeat(2900) + '终点';
  host = await createLibraryHost({
    home: root,
    db: store.db,
    databasePath: join(root, 'library.db'),
    artifacts: () => [],
    approveArtifact: async () => false,
    pickFiles: async () => [path],
    openPath: async () => {},
    extract: async () => ({
      blocks: [{ text, location: '段落 1', source: 'text' }],
      partial: false,
      ocrCandidates: 0,
    }),
  });
  await host.importFiles();
  const row = (await settled()).rows[0]!;
  const reference = await host.reference({
    documentId: row.id,
    version: row.version!,
    location: '段落 1',
  });
  expect(reference.text.match(/x{20,}/gu)).toEqual(['x'.repeat(2900)]);
});
