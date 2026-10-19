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
  dir = makeTempDir('evowork-minutes-');
});
afterEach(() => removeDir(dir));

const GOOD = {
  title: '周例会纪要',
  date: '2026-09-05',
  attendees: ['甲', '乙'],
  decisions: ['通过三季度预算'],
  actions: [{ task: '催收逾期款', owner: '甲', due: '2026-09-12' }],
};

function run(content: unknown) {
  return runPython(CHECK, [
    '--content',
    writeContent(dir, content),
    '--out',
    join(dir, 'out.json'),
  ]);
}

describe('会议纪要必须能跟进', () => {
  it('写出决议和带负责人、截止日期的待办表', () => {
    expect(run(GOOD).status).toBe(EXIT.ok);
    const content = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as {
      template: string;
      blocks: { block: string; text?: string; header?: string[]; items?: string[] }[];
    };
    expect(content.template).toBe('memo');
    expect(content.blocks.find((block) => block.text === '决议')).toBeDefined();
    expect(content.blocks.find((block) => block.block === 'table')?.header).toEqual([
      '事项',
      '负责人',
      '截止日期',
    ]);
  });

  it('没有决议时拒绝', () => {
    const result = run({ ...GOOD, decisions: [] });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('决议');
  });

  it('待办缺负责人时拒绝，且不把事项原文写进报错', () => {
    const result = run({
      ...GOOD,
      actions: [{ task: '鹏程公司的逾期款', owner: '', due: '2026-09-12' }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('owner');
    expect(result.stderr).not.toContain('鹏程公司');
  });

  it('截止日期不是 YYYY-MM-DD 时拒绝', () => {
    const result = run({
      ...GOOD,
      actions: [{ task: '催收', owner: '甲', due: '周五' }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('YYYY-MM-DD');
  });
});
