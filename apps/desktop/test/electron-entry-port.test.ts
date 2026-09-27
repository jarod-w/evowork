/**
 * **真入口填没填满 bootstrap 要的那个端口。**
 *
 * `bootstrap.ts` 刻意不 import electron，能力全靠 `ElectronApi` 注入；其中好几项写成
 * 可选、用 `?.` 调用 —— 那是**对的**，理由写在类型里：测试要能跑到「没有这项能力时
 * 会怎样」那条路径（`showOpenDialog` 没给时引导卡住、`safeStorage` 没给时密钥库不可用）。
 *
 * 代价是这一条：**真入口漏填一项，tsc 什么都不会说，运行时也不报错，
 * 那个功能只是静默地不存在。** 而真入口是 `.mjs`（它自己的头注释解释了为什么：
 * 仓库里没装 electron，写成 .ts 会让 typecheck 因为找不到模块而红），
 * 所以它本来就不在类型检查的覆盖面里。两件事叠起来，中间这一段没有任何人看着。
 *
 * 2026-09-27 实测到后果：`electron-entry.mjs` 从来没提供过
 * `setAsDefaultProtocolClient` / `onOpenUrl` / `onSecondInstance`，
 * 于是 `evowork://` 在装出来的应用上点了毫无反应 —— 而 `deeplink.ts`、它的单测、
 * bootstrap 里的接线**三样各自都是对的**（CLAUDE.md §9.1「两个模块各自对，合起来可能不对」）。
 *
 * 所以这条断的是**包含关系**，不是那三个名字：以后往端口上加一项、忘了在真入口填，
 * 同样会在这里红。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), '../src/main');

/**
 * 去掉注释与字符串。
 *
 * 两件事都得去：注释里出现 `electron.app.onOpenUrl` 会让这条测试**假绿**
 * （那正是这个文件在讲的故障形状），而模板串里的 `${...}` 会让下面的括号配对错位。
 */
function stripCommentsAndStrings(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < src.length && src.slice(i, i + 2) !== '*/') i += 1;
      i += 2;
      continue;
    }
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      i += 1;
      while (i < src.length && src[i] !== ch) {
        i += src[i] === '\\' ? 2 : 1;
      }
      i += 1;
      // 留一个占位，免得 `a:'x'` 塌成 `a:` 之后被当成别的东西
      out += '_';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * 取出某个对象字面量**自己这一层**的键。
 *
 * 只看这一层是关键：把 `onOpenUrl` 填在顶层而不是 `app` 里，应用照样是坏的，
 * 而"这个名字在文件里出现过"会让那种写法通过。
 */
function ownKeys(src: string, anchor: RegExp): readonly string[] | undefined {
  const at = anchor.exec(src);
  if (!at) return undefined;
  const open = src.indexOf('{', at.index);
  if (open < 0) return undefined;

  let depth = 0;
  let shallow = '';
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i] as string;
    if (ch === '{' || ch === '[' || ch === '(') {
      depth += 1;
      shallow += depth === 1 ? ch : ' ';
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth -= 1;
      if (depth === 0) break;
      shallow += ' ';
      continue;
    }
    shallow += depth === 1 ? ch : ' ';
  }

  const keys: string[] = [];
  for (const m of shallow.matchAll(/(?:^|[{,])\s*([A-Za-z_$][\w$]*)\s*:/g)) {
    keys.push(m[1] as string);
  }
  return keys;
}

const bootstrapSrc = stripCommentsAndStrings(readFileSync(join(MAIN, 'bootstrap.ts'), 'utf8'));
const entrySrc = stripCommentsAndStrings(readFileSync(join(MAIN, 'electron-entry.mjs'), 'utf8'));

/** bootstrap 真正碰过的端口成员（`const { electron } = options` 之后的那个名字）。 */
function usedBy(prefix: string): readonly string[] {
  const seen = new Set<string>();
  for (const m of bootstrapSrc.matchAll(
    new RegExp(`${prefix.replace('.', '\\.')}\\??\\.([A-Za-z_$][\\w$]*)`, 'g'),
  )) {
    seen.add(m[1] as string);
  }
  return [...seen].sort();
}

describe('electron-entry.mjs 是 bootstrap 那个端口的唯一真实实现', () => {
  it('bootstrap 在 electron.app 上调的每一个方法，真入口都得提供', () => {
    const needed = usedBy('electron.app');
    const provided = ownKeys(entrySrc, /\bapp\s*:\s*\{/);

    expect(
      provided,
      'electron-entry.mjs 里找不到 `app: {` —— 端口的形状变了，这条测试要跟着改',
    ).toBeDefined();
    expect(
      needed.length,
      'bootstrap.ts 里一个 electron.app.* 都没扫到 —— 判据此刻什么都没在守',
    ).toBeGreaterThan(4);

    const missing = needed.filter((name) => !(provided ?? []).includes(name));
    expect(
      missing,
      `真入口没提供：${missing.join(' / ')}。bootstrap 用 ?. 调它们，` +
        '所以漏填不会报错，只会让那个功能静默消失（深链就是这么没的）',
    ).toEqual([]);
  });

  it('顶层那几项能力同样一个都不能少', () => {
    /*
     * `showOpenDialog` / `openPath` / `openExternal` / `safeStorage` 在类型里是可选的，
     * 但**可选是给测试用的**：真应用少任何一个，对应功能就没了
     * —— 引导选不了工作空间、项目页打不开文件夹、登录打不开浏览器、密钥库不可用。
     */
    const needed = usedBy('electron').filter((name) => name !== 'app');
    const provided = ownKeys(entrySrc, /\belectron\s*:\s*\{/);

    expect(provided, 'electron-entry.mjs 里找不到 `electron: {`').toBeDefined();
    expect(needed).toContain('safeStorage');

    const missing = needed.filter((name) => !(provided ?? []).includes(name));
    expect(missing, `真入口没提供：${missing.join(' / ')}`).toEqual([]);
  });
});
