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

  // Task 4 实现时用一次性探针跑过 home = '/' 与 home = '' 两组退化输入，
  // 确认过没问题就把探针文件删了——committed 用例里从没落过这条轴。
  // membership.ts 已经在这条轴上摔过两次（home 恰好是 '/' 时 `~` 折叠吞掉
  // 整个文件系统、以及 trimTrailing 只去一个斜杠放过 `//`），toAbsolute
  // 之所以在两个文件间共享，就是为了不让这类修复分叉成两份。这里把当时的
  // 探针钉成表，回归了就是 CI 红，而不是要等到下一次有人手工再跑一遍。
  describe('degenerate home（home 退化成 / 或 空串时不能失守）', () => {
    const degenerateHomes = ['/', ''] as const;

    interface Row {
      readonly home: string;
      readonly desc: string;
      readonly root: string;
      readonly requested: string;
      readonly expectNull: boolean;
      readonly expected?: string;
    }

    it.each<Row>(
      degenerateHomes.flatMap((home): Row[] => [
        {
          home,
          desc: `home = ${JSON.stringify(home)} 时，正常 root 下的子路径仍要能读 —— 退化 home 不该连累合法请求`,
          root: '/w/proj',
          requested: '/w/proj/src',
          expectNull: false,
          expected: '/w/proj/src',
        },
        {
          home,
          desc: `home = ${JSON.stringify(home)} 时，越界请求仍要被拒 —— 否则 home 一退化，/etc/passwd 就被当成空间内`,
          root: '/w/proj',
          requested: '/etc/passwd',
          expectNull: true,
        },
        {
          home,
          desc: `home = ${JSON.stringify(home)} 时，root 为空串要拒绝 —— 空 root 不能因为 home 也退化就蒙混过关`,
          root: '',
          requested: '/anything',
          expectNull: true,
        },
        {
          home,
          desc: `home = ${JSON.stringify(home)} 时，root 为 '/' 要拒绝 —— 否则整个文件系统被当成一个空间`,
          root: '/',
          requested: '/anything',
          expectNull: true,
        },
        {
          home,
          desc: `home = ${JSON.stringify(home)} 时，root 为 '//' 要拒绝 —— 只去一个结尾斜杠会把它误判成 '/'`,
          root: '//',
          requested: '/anything',
          expectNull: true,
        },
        {
          home,
          desc: `home = ${JSON.stringify(home)} 时，root 为 '/..' 要拒绝 —— 解析完 '..' 就是文件系统根，不能放行`,
          root: '/..',
          requested: '/anything',
          expectNull: true,
        },
      ]),
    )('$desc', ({ root, requested, home, expectNull, expected }) => {
      const out = resolveChildPath(root, requested, home);
      if (expectNull) {
        expect(out).toBeNull();
      } else {
        expect(out).toBe(expected);
      }
    });
  });

  // Finding 1 的 fail-closed 分支（toAbsolute(...) 去掉结尾斜杠后削成空串）
  // 在当前 isUnderRoot 的退化根守卫下不可达：isUnderRoot 通过就意味着
  // absoluteRoot 非空且不是 '/'，而 requested 落在 root 之内的前提下，
  // 它的绝对形式至少和 absoluteRoot 一样长，去掉结尾斜杠也不可能变空串。
  // 这里不伪造一条能命中它的输入——写不出真实输入，就不该写一条假测试。
});
