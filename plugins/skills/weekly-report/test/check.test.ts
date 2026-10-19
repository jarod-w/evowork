import { readFileSync } from 'node:fs';
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

  it('省掉风险节时拒绝', () => {
    const { risks: _risks, ...rest } = GOOD;
    const result = run(rest);
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('风险');
  });
});
