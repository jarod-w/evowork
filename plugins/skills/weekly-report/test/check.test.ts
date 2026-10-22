import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXIT,
  makeTempDir,
  parseFailure,
  removeDir,
  runPython,
  writeContent,
} from '../../_shared/test-helpers.js';

const CHECK = resolve(dirname(fileURLToPath(import.meta.url)), '../container_tools/check.py');
const DOCUMENTS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../documents/container_tools/render.py',
);

let dir: string;
beforeEach(() => {
  dir = makeTempDir('evowork-weekly-');
});
afterEach(() => removeDir(dir));

const GOOD = {
  title: '财务部周报',
  date: '2026-09-05',
  period: ['完成三季度对账'],
  risks: ['本周没有新的风险'],
  next: ['周五前发出催收函'],
};

function run(content: unknown) {
  return runPython(CHECK, [
    '--content',
    writeContent(dir, content),
    '--out',
    join(dir, 'out.json'),
  ]);
}

describe('周报三节都要在', () => {
  it('本期、风险、下周各成一节', () => {
    expect(run(GOOD).status).toBe(EXIT.ok);
    const content = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as {
      template: string;
      blocks: { block: string; text?: string; items?: string[] }[];
    };
    expect(content.template).toBe('memo');
    expect(
      content.blocks.filter((block) => block.block === 'heading').map((block) => block.text),
    ).toEqual(['本期', '风险', '下周']);
    expect(
      content.blocks.filter((block) => block.block === 'bullets').map((block) => block.items),
    ).toEqual([['完成三季度对账'], ['本周没有新的风险'], ['周五前发出催收函']]);
  });

  it('交给 documents 后三节能出现在 markdown 里', () => {
    expect(run(GOOD).status).toBe(EXIT.ok);
    const rendered = runPython(DOCUMENTS, [
      '--content',
      join(dir, 'out.json'),
      '--out',
      join(dir, 'weekly.md'),
    ]);
    expect(rendered.status, rendered.stderr).toBe(EXIT.ok);
    const markdown = readFileSync(join(dir, 'weekly.md'), 'utf8');
    expect(markdown).toContain('本期');
    expect(markdown).toContain('完成三季度对账');
    expect(markdown).toContain('周五前发出催收函');
  });

  it('省掉风险节时拒绝', () => {
    const { risks: _risks, ...rest } = GOOD;
    const result = run(rest);
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('风险');
  });
});

describe('检查放行的，documents 也收；超了报原来的字段名', () => {
  it('一节超过 30 条时在检查这一步拒绝，报的是 period', () => {
    const result = run({ ...GOOD, period: Array.from({ length: 31 }, (_, i) => `完成 ${i}`) });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('period');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('一条超过 300 字时报 risks/<序号>，不是 blocks/3 items/0，也不把内容写进报错', () => {
    const result = run({ ...GOOD, risks: ['没有新的风险', `鹏程公司${'欠'.repeat(300)}`] });
    expect(result.status).toBe(EXIT.invalidContent);
    const message = parseFailure(result.stderr).message;
    expect(message).toContain('risks/1');
    expect(message).not.toContain('blocks');
    expect(result.stderr).not.toContain('鹏程公司');
  });

  it('标题超过 120 字时拒绝', () => {
    const result = run({ ...GOOD, title: '周'.repeat(121) });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('title');
  });

  it('正好在上限上的周报能渲染出来', () => {
    const full = (word: string) => Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(300, word));
    const result = run({
      ...GOOD,
      title: '周'.repeat(120),
      period: full('做'),
      risks: full('险'),
      next: full('计'),
    });
    expect(result.status, result.stderr).toBe(EXIT.ok);
    const rendered = runPython(DOCUMENTS, [
      '--content',
      join(dir, 'out.json'),
      '--out',
      join(dir, 'weekly.md'),
    ]);
    expect(rendered.status, rendered.stderr).toBe(EXIT.ok);
  });
});
