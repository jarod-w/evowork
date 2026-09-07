/**
 * 文件树（spec §3.3 · D-P5）。
 *
 * `resolveChildPath` 是这个包里**安全相关**的那个函数：主进程用它决定
 * 「渲染层要展开的这个目录能不能读」。写错就是把 fs 读能力交给渲染层。
 */
import { describe, expect, it } from 'vitest';

import { NOISE_DIRS, resolveChildPath, sortEntries } from '../src/index.js';

const HOME = '/Users/li';

describe('sortEntries', () => {
  it('目录在前、各自按名排 —— 文件混在目录里没法扫读', () => {
    const out = sortEntries([
      { name: 'b.txt', isDirectory: false },
      { name: 'z-dir', isDirectory: true },
      { name: 'a.txt', isDirectory: false },
      { name: 'a-dir', isDirectory: true },
    ]);
    expect(out.map((e) => e.name)).toEqual(['a-dir', 'z-dir', 'a.txt', 'b.txt']);
  });

  it('噪声目录被标出来但仍然在列表里 —— 隐藏会让人以为文件丢了', () => {
    const out = sortEntries([
      { name: 'node_modules', isDirectory: true },
      { name: 'src', isDirectory: true },
    ]);
    expect(out.map((e) => e.name)).toContain('node_modules');
    expect(out.find((e) => e.name === 'node_modules')?.noisy).toBe(true);
    expect(out.find((e) => e.name === 'src')?.noisy).toBe(false);
  });

  it('同名的文件不算噪声 —— 噪声判定只针对目录', () => {
    const out = sortEntries([{ name: 'dist', isDirectory: false }]);
    expect(out[0]?.noisy).toBe(false);
  });

  it('.git 在清单里', () => {
    expect(NOISE_DIRS).toContain('.git');
  });
});

describe('resolveChildPath', () => {
  it('root 内的目录给出归一化后的绝对路径', () => {
    expect(resolveChildPath('/w/proj', '/w/proj/src', HOME)).toBe('/w/proj/src');
  });

  it('root 自身可以读', () => {
    expect(resolveChildPath('/w/proj', '/w/proj', HOME)).toBe('/w/proj');
  });

  it('越界返回 null —— 渲染层传 <root>/../.ssh 时主进程必须拒读', () => {
    expect(resolveChildPath('/Users/li/work', '/Users/li/work/../.ssh', HOME)).toBeNull();
  });

  it('平级同前缀目录也越界', () => {
    expect(resolveChildPath('/w/proj', '/w/project-x', HOME)).toBeNull();
  });

  it('绝对路径与 ~ 混写仍判得对', () => {
    expect(resolveChildPath('~/work', '/Users/li/work/a', HOME)).toBe('/Users/li/work/a');
  });

  it('空 root 一律拒绝 —— 一条脏记录不该变成读全盘的入口', () => {
    expect(resolveChildPath('', '/anything', HOME)).toBeNull();
  });
});
