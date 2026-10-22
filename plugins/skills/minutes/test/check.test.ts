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

  it('交给 documents 后能写出纪要正文', () => {
    expect(run(GOOD).status).toBe(EXIT.ok);
    const content = join(dir, 'out.json');
    const markdown = runPython(DOCUMENTS, ['--content', content, '--out', join(dir, 'minutes.md')]);
    expect(markdown.status, markdown.stderr).toBe(EXIT.ok);
    expect(readFileSync(join(dir, 'minutes.md'), 'utf8')).toContain('通过三季度预算');
    const docx = runPython(DOCUMENTS, ['--content', content, '--out', join(dir, 'minutes.docx')]);
    expect(docx.status, docx.stderr).toBe(EXIT.ok);
    expect(readFileSync(join(dir, 'minutes.docx')).subarray(0, 2).toString('latin1')).toBe('PK');
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

describe('材料里没定的不编', () => {
  it('负责人、截止日期没定时明写「待定」「未定」可以通过，纪要里照写，并报出有几条没定', () => {
    const result = run({
      ...GOOD,
      actions: [
        { task: '催收逾期款', owner: '待定', due: '未定' },
        { task: '核对发票', owner: '乙', due: '待定' },
        { task: '发会议通知', owner: '甲', due: '2026-09-06' },
      ],
    });
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect((JSON.parse(result.stdout) as { undecided: number }).undecided).toBe(2);
    const content = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as {
      blocks: { block: string; rows?: string[][] }[];
    };
    expect(content.blocks.find((block) => block.block === 'table')?.rows).toEqual([
      ['催收逾期款', '待定', '未定'],
      ['核对发票', '乙', '待定'],
      ['发会议通知', '甲', '2026-09-06'],
    ]);
  });

  it('「无」「-」「TBD」这类说不清的占位不收，要明写待定', () => {
    for (const owner of ['-', '无', 'TBD', 'N/A']) {
      const result = run({ ...GOOD, actions: [{ task: '催收', owner, due: '2026-09-12' }] });
      expect(result.status, owner).toBe(EXIT.invalidContent);
      expect(parseFailure(result.stderr).message).toContain('待定');
    }
  });

  it('截止日期早于会议日期时拒绝', () => {
    const result = run({
      ...GOOD,
      actions: [{ task: '鹏程公司的逾期款', owner: '甲', due: '2026-09-04' }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('actions/0/due');
    expect(result.stderr).not.toContain('鹏程公司');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('会议当天截止可以', () => {
    const result = run({ ...GOOD, actions: [{ task: '发通知', owner: '甲', due: GOOD.date }] });
    expect(result.status, result.stderr).toBe(EXIT.ok);
  });
});

describe('检查放行的，documents 也收', () => {
  it('决议多到 documents 收不下时，在检查这一步就拒绝，报的是 decisions', () => {
    const result = run({
      ...GOOD,
      decisions: Array.from({ length: 31 }, (_, index) => `决议 ${index}`),
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('decisions');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('一条决议太长时报的是 decisions/<序号>，不是 blocks/2 items/0', () => {
    const result = run({ ...GOOD, decisions: ['通过', '甲'.repeat(301)] });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('decisions/1');
  });

  it('正好在上限上的纪要能渲染出来', () => {
    const result = run({
      ...GOOD,
      title: '题'.repeat(120),
      decisions: Array.from({ length: 30 }, (_, index) => `${index}`.padEnd(300, '议')),
      actions: Array.from({ length: 200 }, (_, index) => ({
        task: `事项 ${index}`,
        owner: '甲',
        due: '2026-09-12',
      })),
    });
    expect(result.status, result.stderr).toBe(EXIT.ok);
    const markdown = runPython(DOCUMENTS, [
      '--content',
      join(dir, 'out.json'),
      '--out',
      join(dir, 'minutes.md'),
    ]);
    expect(markdown.status, markdown.stderr).toBe(EXIT.ok);
  });
});
