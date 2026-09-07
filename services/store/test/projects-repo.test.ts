/**
 * `project_local` / `project_root` 两张**权威**表的读写（spec §2.2）。
 *
 * 权威类意味着没有"重建"这条路：用户建的空间丢了就是丢了。
 */
import { describe, expect, it } from 'vitest';

import { createProjectRepo, openStore } from '../src/index.js';

function fresh() {
  const store = openStore({ path: ':memory:' });
  return { store, repo: createProjectRepo(store.db) };
}

describe('createProjectRepo', () => {
  it('插入后能按 id 读回来，roots 是数组', () => {
    const { repo } = fresh();
    repo.insert({
      id: 'p1',
      name: '季度汇报',
      roots: ['/w/q3'],
      createdAt: 10,
      updatedAt: 10,
    });
    const row = repo.get('p1');
    expect(row?.name).toBe('季度汇报');
    expect(row?.roots).toEqual(['/w/q3']);
    // 没镜像成功时 kernelId 就是缺席，不是空串
    expect(row?.kernelId).toBeUndefined();
  });

  it('list 按 createdAt 倒序 —— 刚建的空间在最前面', () => {
    const { repo } = fresh();
    repo.insert({ id: 'a', name: 'A', roots: ['/a'], createdAt: 1, updatedAt: 1 });
    repo.insert({ id: 'b', name: 'B', roots: ['/b'], createdAt: 2, updatedAt: 2 });
    expect(repo.list().map((p) => p.id)).toEqual(['b', 'a']);
  });

  it('改名只动 name 与 updatedAt，roots 不受影响', () => {
    const { repo } = fresh();
    repo.insert({ id: 'p1', name: '旧名', roots: ['/w/q3'], createdAt: 1, updatedAt: 1 });
    repo.rename('p1', '新名', 99);
    const row = repo.get('p1');
    expect(row?.name).toBe('新名');
    expect(row?.updatedAt).toBe(99);
    expect(row?.roots).toEqual(['/w/q3']);
  });

  it('镜像成功后补写 kernelId', () => {
    const { repo } = fresh();
    repo.insert({ id: 'p1', name: 'A', roots: ['/a'], createdAt: 1, updatedAt: 1 });
    repo.setKernelId('p1', 'k-123');
    expect(repo.get('p1')?.kernelId).toBe('k-123');
  });

  it('移除会连 root 一起删干净 —— 留下孤儿 root 不会报错，只会让下次同路径新建被 INSERT OR IGNORE 静默吞掉，留下一条过期的孤儿行', () => {
    const { store, repo } = fresh();
    repo.insert({ id: 'p1', name: 'A', roots: ['/a'], createdAt: 1, updatedAt: 1 });
    repo.remove('p1');
    expect(repo.get('p1')).toBeUndefined();
    const left = store.db.prepare('SELECT COUNT(*) AS n FROM project_root').get() as { n: number };
    expect(left.n).toBe(0);
  });

  it('移除空间不碰 artifact 索引 —— 「只解绑不删文件」也意味着不删索引', () => {
    const { store, repo } = fresh();
    repo.insert({ id: 'p1', name: 'A', roots: ['/a'], createdAt: 1, updatedAt: 1 });
    store.db
      .prepare(
        `INSERT INTO artifact (id, path, artifact_type, output_format, title, operation_kind,
                               version, source_signal, file_state, created_at)
         VALUES ('af1','/a/r.docx','document','docx','r','create',1,'SKILL_REPORT','PRESENT',1)`,
      )
      .run();
    repo.remove('p1');
    const left = store.db.prepare('SELECT COUNT(*) AS n FROM artifact').get() as { n: number };
    expect(left.n).toBe(1);
  });
});
