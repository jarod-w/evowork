/**
 * Q39：登出与注销都不碰本机表。数据属于这台机器，不属于账号。
 *
 * 不打开 sqlite：这条断言的对象是账号模块，不是 store。打开库会把「fts5 装没装」
 * 混进这条测试，而那是另一台机器上的环境问题。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createAccountSession, REFRESH_SECRET, type AccountVault } from '../src/main/account.js';

describe('登出不删本机数据（Q39）', () => {
  it('account.ts 不 import store，logout 只清 refresh', async () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../src/main/account.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/@evowork\/store/);
    expect(src).not.toMatch(/DELETE FROM/i);

    const map = new Map<string, string>([[REFRESH_SECRET, 'rt_x']]);
    const vault: AccountVault = {
      get: (name) => map.get(name),
      set: (name, value) => {
        map.set(name, value);
        return true;
      },
      remove: (name) => map.delete(name),
    };
    const session = createAccountSession({
      vault,
      readFlag: () => undefined,
      writeFlag: () => undefined,
      openExternal: async () => undefined,
      identityOrigin: 'https://id.example.com',
      webOrigin: 'https://web.example.com',
    });
    await session.logout();
    expect(map.has(REFRESH_SECRET)).toBe(false);
  });
});
