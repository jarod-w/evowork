import { mkdtemp, mkdir, readFile, writeFile, realpath, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore, type Store } from '@evowork/store';
import { createTaskEnvironments, type TaskEnvironments } from '../src/main/task-environments.js';

let home: string;
let store: Store;
let environments: TaskEnvironments;
const roots = new Map<string, string>();
beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'evowork-environment-')));
  store = openStore({ path: ':memory:' });
  roots.clear();
  environments = createTaskEnvironments({
    store,
    home,
    dataDir: join(home, '.evowork'),
    projectRoot: (id) => roots.get(id),
  });
});
afterEach(async () => {
  store.close();
  await rm(home, { recursive: true, force: true });
});

describe('任务环境的真实文件系统后果', () => {
  it('丢弃未发送草稿清理未绑定环境，已绑定任务保留产物', async () => {
    const abandoned = await environments.prepare('draft-abandoned');
    await environments.discard('draft-abandoned');
    await expect(realpath(abandoned.cwd)).rejects.toThrow();
    const bound = await environments.prepare('draft-bound');
    environments.bind('thread-bound', bound);
    await writeFile(join(bound.cwd, 'output.txt'), '产物');
    await environments.discard('draft-bound');
    expect(await readFile(join(bound.cwd, 'output.txt'), 'utf8')).toBe('产物');
    expect((await environments.prepare('draft-bound')).threadId).toBe('thread-bound');
  });

  it('无项目首次发送创建独立目录；重试、宿主重建和续聊沿用同一目录', async () => {
    const first = await environments.prepare('draft-1');
    const second = await environments.prepare('draft-2');
    expect(first.cwd).not.toBe(second.cwd);
    expect(first.projectId).toBeNull();
    environments.bind('thread-1', first);
    await writeFile(join(first.cwd, 'result.txt'), '产物');
    const restored = createTaskEnvironments({
      store,
      home,
      dataDir: join(home, '.evowork'),
      projectRoot: (id) => roots.get(id),
    });
    expect((await restored.prepare('draft-1')).threadId).toBe('thread-1');
    expect(await readFile(join(restored.task('thread-1')!.cwd, 'result.txt'), 'utf8')).toBe('产物');
    await expect(restored.prepare('draft-1', 'another')).rejects.toThrow('任务已经创建');
  });
  it('草稿附件归入最终项目，引用和解析文件中的绝对资产路径同步更新', async () => {
    const draft = await environments.draftRoot('draft-1');
    await mkdir(join(draft, 'uploads', 'file'), { recursive: true });
    const source = join(draft, 'uploads', 'file', 'document.md');
    await writeFile(source, `![图](${join(draft, 'uploads', 'file', 'image.png')})`);
    const project = join(home, 'repo');
    await mkdir(project);
    roots.set('p1', project);
    const environment = await environments.prepare('draft-1', 'p1');
    const refs = await environments.references('draft-1', environment.cwd, [
      { type: 'mention', name: '附件', path: source },
    ]);
    const reference = refs[0]!;
    expect(reference.type).toBe('mention');
    if (reference.type !== 'mention') throw new Error('wrong reference');
    expect(reference.path.startsWith(project)).toBe(true);
    expect(await readFile(reference.path, 'utf8')).not.toContain(draft);
    expect(await readFile(source, 'utf8')).toContain(draft);
  });
  it('无法通过软链把附件复制进项目外；失败时源暂存保留', async () => {
    const draft = await environments.draftRoot('draft-1');
    await mkdir(join(draft, 'uploads'));
    const source = join(draft, 'uploads', 'file.md');
    await writeFile(source, '资料');
    const project = join(home, 'repo');
    const outside = join(home, 'outside');
    await mkdir(project);
    await mkdir(outside);
    await symlink(outside, join(project, 'uploads'));
    await expect(
      environments.references('draft-1', project, [
        { type: 'mention', name: '资料', path: source },
      ]),
    ).rejects.toThrow('附件目录被替换');
    expect(await readFile(source, 'utf8')).toBe('资料');
  });
  it('任务目录被换成软链、home 和任意祖先、任意内部目录都拒绝', async () => {
    const environment = await environments.prepare('draft-1');
    await rm(environment.cwd, { recursive: true });
    await symlink(home, environment.cwd);
    await expect(environments.validate(environment.cwd)).rejects.toThrow();
    await expect(environments.validate(home)).rejects.toThrow('范围过大');
    await expect(environments.validate('/')).rejects.toThrow('范围过大');
    await mkdir(join(home, '.evowork', 'secrets'));
    await expect(environments.validate(join(home, '.evowork', 'secrets'))).rejects.toThrow(
      '应用的数据目录',
    );
  });
  it('删除托管任务清理附件和产物；项目任务不会删除项目文件', async () => {
    const environment = await environments.prepare('draft-1');
    environments.bind('thread-1', environment);
    await writeFile(join(environment.cwd, 'output.txt'), '产物');
    await environments.remove('thread-1');
    await expect(readFile(join(environment.cwd, 'output.txt'))).rejects.toThrow();
    const project = join(home, 'repo');
    await mkdir(project);
    roots.set('p1', project);
    const linked = await environments.prepare('draft-2', 'p1');
    environments.bind('thread-2', linked);
    await writeFile(join(project, 'output.txt'), '用户文件');
    await environments.remove('thread-2');
    expect(await readFile(join(project, 'output.txt'), 'utf8')).toBe('用户文件');
  });
});
