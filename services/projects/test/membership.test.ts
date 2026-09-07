/**
 * 归属判定（spec §2.1 / D-P3）。
 *
 * 这里的每条断言写的都是**判错的后果**，不是"函数返回 true"。
 */
import { describe, expect, it } from 'vitest';

import { isUnderRoot } from '../src/index.js';

const HOME = '/Users/li';

describe('isUnderRoot', () => {
  it('root 自身算在内', () => {
    expect(isUnderRoot('/w/proj', '/w/proj', HOME)).toBe(true);
  });

  it('子目录算在内', () => {
    expect(isUnderRoot('/w/proj', '/w/proj/sub/deep', HOME)).toBe(true);
  });

  it('只在路径分隔符边界上匹配 —— 否则两个平级目录的任务互相串台', () => {
    expect(isUnderRoot('/w/proj', '/w/project-x', HOME)).toBe(false);
    expect(isUnderRoot('/work', '/workspace/a', HOME)).toBe(false);
  });

  it('`..` 在匹配前被解析掉 —— 否则 <root>/../.ssh 会被判成空间内', () => {
    expect(isUnderRoot('/Users/li/work', '/Users/li/work/../.ssh', HOME)).toBe(false);
  });

  it('~ 与绝对路径是同一个位置，混着写也判得对', () => {
    expect(isUnderRoot('~/work', '/Users/li/work/a', HOME)).toBe(true);
    expect(isUnderRoot('/Users/li/work', '~/work/a', HOME)).toBe(true);
  });

  it('结尾多一个斜杠不改变结果 —— 用户从访达拖进来的路径常带它', () => {
    expect(isUnderRoot('/w/proj/', '/w/proj/a', HOME)).toBe(true);
  });

  it('home 是 / 不该连累正常 root 的判断 —— 该拦的仍要拦，该放的仍要放', () => {
    expect(isUnderRoot('/w/proj', '/etc/passwd', '/')).toBe(false);
    expect(isUnderRoot('/w/proj', '/w/proj/a', '/')).toBe(true);
  });

  // 退化 root 不是一个案例，是一类：`''`、`/`、`//`、`///`、`/..`、`/.`、`~`……
  // 任何"名义上是路径、实际上没落在文件系统根之下的一个真实目录"的写法都算。
  // 这条守卫已经写第三次了——前两次每次都只堵住了当时测出来的那个输入形状：
  // 第一次判折叠后的字符串，被 home === '/' 时的全局折叠绕了过去；
  // 第二次改判原始参数，又被 `trimTrailing` 只去一个结尾斜杠（`'//'` 漏判）、
  // 以及 `..`/`.` 只有在 normalizePath 内部才被解析这两点绕了过去。
  // 只要还在一个个补案例，就还会有下一个没被枚举到的输入形状。
  // 所以这里把它写成一张表，把两次修复趟过的输入形状全部枚举在一起，
  // 只要表还成立，这一类就是关着的，不必再等下一次真实数据踩出新形状。
  it.each([
    ['/Users/li', ''],
    ['/Users/li', '/'],
    ['/Users/li', '//'],
    ['/Users/li', '///'],
    ['/Users/li', '/..'],
    ['/Users/li', '/.'],
    ['/', ''],
    ['/', '/'],
    ['/', '//'],
    ['/', '///'],
    ['/', '/..'],
    ['/', '/.'],
    ['/', '~'],
  ])(
    '退化 root 在 home=%s 下也不该把 /etc/passwd 当成空间内 —— 否则一条脏记录会把全盘任务收进一个空间（root=%s）',
    (home, root) => {
      expect(isUnderRoot(root, '/etc/passwd', home)).toBe(false);
    },
  );
});
