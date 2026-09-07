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

  it('空 root 不匹配任何东西 —— 否则一条脏记录会把全盘任务收进一个空间', () => {
    expect(isUnderRoot('', '/w/proj', HOME)).toBe(false);
    expect(isUnderRoot('/', '/w/proj', HOME)).toBe(false);
  });

  it('home 本身是 / 时，退化 root 依然不该把整个文件系统当成工作空间 —— 否则任意文件都能被当成空间内读走', () => {
    expect(isUnderRoot('/', '/etc/passwd', '/')).toBe(false);
    expect(isUnderRoot('', '/etc/passwd', '/')).toBe(false);
  });

  it('home 是 / 不该连累正常 root 的判断 —— 该拦的仍要拦，该放的仍要放', () => {
    expect(isUnderRoot('/w/proj', '/etc/passwd', '/')).toBe(false);
    expect(isUnderRoot('/w/proj', '/w/proj/a', '/')).toBe(true);
  });
});
