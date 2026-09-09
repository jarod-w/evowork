/**
 * 结构扫描：想把内容写进账号协议，得先改类型，而改类型会被这条测试看见。
 *
 * 与 K6 在 ingest 的整目录扫法、D10 在 store 的 schema 扫描是同一条：
 * 一份「手工列的字段名单」只在写它的那天是完整的。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

function srcFiles(): string[] {
  return readdirSync(SRC)
    .filter((name) => name.endsWith('.ts'))
    .map((name) => join(SRC, name));
}

describe('账号协议源码不含内容面字段', () => {
  it('src/ 里没有 threadId / password / prompt / userId 作为字段名', () => {
    const offenders: string[] = [];
    for (const file of srcFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const word of ['threadId', 'password', 'prompt', 'userId']) {
        // 注释里提到「没有 password」是合法的；匹配的是标识符
        const re = new RegExp(`(^|[^A-Za-z])${word}([^A-Za-z]|$)`);
        if (re.test(text) && !text.includes(`没有 \`${word}\``) && !text.includes(`没有 ${word}`)) {
          // 允许在注释里否定这些名字。真正的字段声明是 `readonly password`
          if (new RegExp(`readonly ${word}\\b|['"]${word}['"]`).test(text)) {
            offenders.push(`${file}:${word}`);
          }
        }
      }
    }
    expect(offenders, `账号协议类型里出现了内容面字段：${offenders.join(', ')}`).toEqual([]);
  });
});
