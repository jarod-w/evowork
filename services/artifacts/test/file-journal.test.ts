import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileJournal, fileTextDiff } from '../src/file-journal.js';

let directory: string, root: string, cache: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'evowork-journal-'));
  root = join(directory, '.evowork', 'workspaces', 'task');
  cache = join(directory, 'undo');
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const make = (over: Partial<Parameters<typeof createFileJournal>[0]> = {}) =>
  createFileJournal({ directory: cache, rootOf: () => root, ...over });
const write = (path: string, content: string | Buffer) => writeFileSync(join(root, path), content);

describe('真实磁盘发现、净差异与归属', () => {
  it('shell 写入、修改和删除都能发现，扫描不认领作者；隐藏父目录不屏蔽正常输出', () => {
    write('existing.txt', 'before\n');
    write('deleted.txt', 'remove\n');
    const journal = make();
    journal.begin('task', 'turn');
    write('existing.txt', 'after\n');
    write('new.py', 'print(1)\n');
    rmSync(join(root, 'deleted.txt'));
    journal.finish('task');
    const view = journal.view('task')!;
    expect(
      view.thread.map((file) => [file.path.split('/').at(-1), file.kind, file.source]),
    ).toEqual([
      ['deleted.txt', 'delete', 'workspace'],
      ['existing.txt', 'modify', 'workspace'],
      ['new.py', 'add', 'workspace'],
    ]);
    journal.claim('task', join(root, 'new.py'));
    expect(journal.view('task')?.files.find((file) => file.path.endsWith('new.py'))?.source).toBe(
      'task',
    );
    expect(view.thread.find((file) => file.path.endsWith('existing.txt'))?.diff).toMatch(
      /-before[\s\S]*\+after/,
    );
  });

  it('同路径多回合显示开始到当前的净差异，恢复原文则净差异归零', () => {
    write('note.txt', 'original\n');
    const journal = make();
    journal.begin('task', 'one');
    write('note.txt', 'middle\n');
    journal.finish('task');
    journal.begin('task', 'two');
    write('note.txt', 'final\n');
    journal.finish('task');
    expect(journal.view('task')?.thread[0]?.diff).toMatch(/-original[\s\S]*\+final/);
    expect(journal.view('task')?.thread[0]?.diff).not.toContain('middle');
    expect(journal.view('task')?.turn[0]?.diff).toMatch(/-middle[\s\S]*\+final/);
    journal.begin('task', 'three');
    write('note.txt', 'original\n');
    journal.finish('task');
    expect(journal.view('task')?.thread).toEqual([]);
  });

  it('超过 64 KB 后的等长变更也会被完整哈希发现', () => {
    const prefix = 'a'.repeat(70000);
    write('large.txt', prefix + 'before');
    const journal = make();
    journal.begin('task', 'one');
    write('large.txt', prefix + 'after!');
    journal.finish('task');
    expect(journal.view('task')?.thread).toHaveLength(1);
  });
});

describe('按后态校验的磁盘撤销', () => {
  it('伪造路径不能删除未纳入记录的隐藏文件，也不能撤销没有变化的文件', () => {
    write('.env', 'secret');
    write('unchanged.txt', 'original');
    const journal = make();
    journal.begin('task', 'one');
    write('generated.txt', 'created');
    journal.finish('task');
    const revision = journal.view('task')!.thread[0]!.revision;
    for (const path of ['.env', 'unchanged.txt', 'never-seen.txt'])
      expect(() => journal.revert({ threadId: 'task', path, scope: 'thread', revision })).toThrow(
        '没有可撤销',
      );
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('secret');
  });
  it('撤销一个文件不能把另一个文件的外部编辑当成本任务后态', () => {
    write('one.txt', 'original');
    write('two.txt', 'original');
    const journal = make();
    journal.begin('task', 'one');
    write('one.txt', 'agent');
    write('two.txt', 'agent');
    journal.finish('task');
    write('two.txt', 'user');
    const file = journal.view('task')!.thread.find((f) => f.path.endsWith('one.txt'))!;
    journal.revert({ threadId: 'task', path: file.path, scope: 'thread', revision: file.revision });
    const other = journal.view('task')!.thread[0]!;
    expect(other.reversible).toBe(false);
    expect(() =>
      journal.revert({
        threadId: 'task',
        path: other.path,
        scope: 'thread',
        revision: other.revision,
      }),
    ).toThrow('其他操作修改');
    expect(readFileSync(join(root, 'two.txt'), 'utf8')).toBe('user');
  });

  it('跨回合外部编辑不可被全任务撤销覆盖，本回合仍能恢复到用户的版本', () => {
    write('file.txt', 'original');
    const journal = make();
    journal.begin('task', 'one');
    write('file.txt', 'agent one');
    journal.finish('task');
    write('file.txt', 'user edit');
    journal.begin('task', 'two');
    write('file.txt', 'agent two');
    journal.finish('task');
    const view = journal.view('task')!;
    expect(view.thread[0]!.reversible).toBe(false);
    expect(view.turn[0]!.reversible).toBe(true);
    const file = view.turn[0]!;
    journal.revert({ threadId: 'task', path: file.path, scope: 'turn', revision: file.revision });
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('user edit');
  });
  it.each(['modify', 'create', 'delete', 'binary'] as const)(
    '%s 在重开记录后仍可恢复实际字节',
    (operation) => {
      const original =
        operation === 'binary' ? Buffer.from([0, 1, 2, 255]) : Buffer.from('before\n');
      if (operation !== 'create') write('file.bin', original);
      let journal = make();
      journal.begin('task', 'one');
      if (operation === 'delete') rmSync(join(root, 'file.bin'));
      else write('file.bin', 'after\n');
      journal.finish('task');
      journal.stop();
      journal = make();
      const file = journal.view('task')!.thread[0]!;
      expect(file.reversible).toBe(true);
      journal.revert({
        threadId: 'task',
        path: file.path,
        scope: 'thread',
        revision: file.revision,
      });
      if (operation === 'create') expect(existsSync(join(root, 'file.bin'))).toBe(false);
      else expect(readFileSync(join(root, 'file.bin'))).toEqual(original);
      expect(journal.view('task')?.thread).toEqual([]);
    },
  );

  it('外部改动、过期版本与运行中的任务一律不能覆盖', () => {
    write('file.txt', 'before');
    let busy = false;
    const journal = make({ busy: () => busy });
    journal.begin('task', 'one');
    write('file.txt', 'after');
    journal.finish('task');
    const file = journal.view('task')!.thread[0]!;
    const input = {
      threadId: 'task',
      path: file.path,
      scope: 'thread' as const,
      revision: file.revision,
    };
    busy = true;
    expect(() => journal.revert(input)).toThrow('任务运行');
    busy = false;
    expect(() => journal.revert({ ...input, revision: 'old' })).toThrow('记录已更新');
    write('file.txt', 'user changes');
    expect(journal.view('task')?.thread[0]?.reversible).toBe(false);
    expect(() => journal.revert(input)).toThrow('其他操作修改');
    expect(readFileSync(join(root, 'file.txt'), 'utf8')).toBe('user changes');
  });

  it('目录内换成越界软链后不读、不写目标；路径穿越同样拒绝', () => {
    write('file.txt', 'before');
    const journal = make();
    journal.begin('task', 'one');
    write('file.txt', 'after');
    journal.finish('task');
    const file = journal.view('task')!.thread[0]!;
    const outside = join(directory, 'outside.txt');
    writeFileSync(outside, 'private');
    rmSync(join(root, 'file.txt'));
    symlinkSync(outside, join(root, 'file.txt'));
    expect(() => journal.safeFile('task', '../outside.txt')).toThrow('工作目录');
    expect(() =>
      journal.revert({
        threadId: 'task',
        path: file.path,
        scope: 'thread',
        revision: file.revision,
      }),
    ).toThrow('符号链接');
    expect(readFileSync(outside, 'utf8')).toBe('private');
  });

  it('缓存与文件上限显式给出限制，不提供虚假的撤销按钮', () => {
    write('file.txt', 'too big for cache');
    const journal = make({ maxCacheBytes: 4 });
    journal.begin('task', 'one');
    write('file.txt', 'changed');
    journal.finish('task');
    expect(journal.view('task')?.warnings.join(' ')).toContain('容量');
    expect(journal.view('task')?.thread[0]?.reversible).toBe(false);
  });
});

it('文本 diff 准确保留最后一行没有换行的情况，二进制不编造文本', () => {
  expect(fileTextDiff('x', Buffer.from('old'), Buffer.from('new')).diff).toContain(
    'No newline at end of file',
  );
  expect(fileTextDiff('x', Buffer.from([0, 1]), Buffer.from([0, 2])).diff).toContain('二进制');
});
