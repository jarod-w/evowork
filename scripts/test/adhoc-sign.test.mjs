/**
 * 未签名 mac 包必须 ad-hoc 重签。不重签时别的 Mac 报「已损坏」，
 * 本地 `spctl` 则是 `code has no resources but signature indicates they must be present`。
 */
import { describe, expect, it } from 'vitest';

import { adhocSign, adhocSignArgs, shouldAdhocSign } from '../adhoc-sign.mjs';

describe('未签名 macOS 包的 ad-hoc 重签（U4）', () => {
  it('只在 darwin + 未签名降级时动手 —— 有证书时让 electron-builder 自己签', () => {
    expect(shouldAdhocSign('darwin', null)).toBe(true);
    expect(shouldAdhocSign('darwin', 'null')).toBe(true);
    expect(shouldAdhocSign('darwin', undefined, 'false')).toBe(true);
    expect(shouldAdhocSign('darwin', undefined)).toBe(false);
    expect(shouldAdhocSign('linux', null)).toBe(false);
  });

  it('codesign 用 --force --deep -s - 盖掉 Electron 残签，含 Helper 与嵌套 .app', () => {
    expect(adhocSignArgs('/tmp/EvoWork.app')).toEqual([
      '--force',
      '--deep',
      '--sign',
      '-',
      '/tmp/EvoWork.app',
    ]);
  });

  it('adhocSign 把参数原样交给 codesign，不自己发明第二条命令', () => {
    const calls = [];
    adhocSign('/tmp/EvoWork.app', (cmd, args) => {
      calls.push([cmd, args]);
    });
    expect(calls).toEqual([['codesign', adhocSignArgs('/tmp/EvoWork.app')]]);
  });
});
