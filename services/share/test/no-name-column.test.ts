/**
 * 结构扫描：云端**不知道文件名**。
 *
 * `services/artifacts/src/upload.ts` 只上传 `x-evowork-name-digest`，理由写在那边：
 * 文件名可能本身就是敏感信息（「XX公司裁员名单.xlsx」）。
 * 那条纪律在服务端的落点就是这份 DDL 里没有 name 列 ——
 * **想记就得先改 DDL，而改它会在这里被拦下来。**
 *
 * 接收方看到的名字来自链接片段（`/s/<id>#<name>`），浏览器不会把 `#` 之后发给服务器。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SHARE_DDL } from '../src/schema.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '../src');

/**
 * 扫代码时要先去注释：这些文件的注释里**就在讲**"不种 cookie""不记文件名"，
 * 连注释一起扫的话，把规矩写清楚反而会让守规矩的测试变红。
 */
function code(file: string): string {
  return readFileSync(join(SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('云端不知道文件名', () => {
  it('DDL 里没有文件名列，只有 digest', () => {
    const lower = SHARE_DDL.toLowerCase();
    expect(lower).toContain('name_digest');
    for (const forbidden of ['file_name', 'filename', 'original_name', 'display_name', 'title']) {
      expect(lower, `DDL 出现了 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('DDL 里也没有任务 / 产物 / 工作空间列', () => {
    const lower = SHARE_DDL.toLowerCase();
    for (const forbidden of ['thread_id', 'artifact_id', 'prompt', 'cwd', 'workspace', 'path']) {
      expect(lower, `DDL 出现了 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('HTTP 层不读任何带文件名的头 —— 上传契约里本来就没有那一个', () => {
    const http = code('http.ts');
    expect(http).toContain('x-evowork-name-digest');
    expect(http).not.toMatch(/x-evowork-(file)?name['"`]/i);
  });

  it('日志里只有 id 与字节数，没有名字', () => {
    const http = code('http.ts');
    const calls = [...http.matchAll(/logger\?\.(info|warn|error)\('([^']+)',\s*\{([^}]*)\}/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call[3] ?? '').not.toMatch(/name|fileName|digest/);
    }
  });
});

describe('分享页的读取面不碰账号', () => {
  it('读取路由不验 authorization —— 收件人没有账号（验收口径第 25 条）', () => {
    const http = code('http.ts');
    // `actorOf` 只在上传与撤销那两条路由上出现
    const uses = [...http.matchAll(/actorOf\(req\)/g)];
    expect(uses.length).toBe(2);
    expect(http).not.toMatch(/set-cookie/i);
  });

  it('跨源头不开 credentials —— 开了就等于允许带 cookie 来读', () => {
    const http = code('http.ts');
    expect(http).not.toMatch(/access-control-allow-credentials/i);
  });
});
