import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  dir = makeTempDir('evowork-scan-');
});
afterEach(() => removeDir(dir));

function sourceFile(name: string, text: string): string {
  const path = join(dir, name);
  writeFileSync(path, text, 'utf8');
  return path;
}

function run(content: unknown) {
  return runPython(CHECK, [
    '--content',
    writeContent(dir, content),
    '--out',
    join(dir, 'out.json'),
  ]);
}

const LEDGER_SOURCE = [
  '2026-09-01 出租车 128.00',
  '2026-09-02 餐饮 56.00',
  '办公用品 1,280.50',
].join('\n');

function ledger(rows: unknown[][], source = LEDGER_SOURCE) {
  return {
    output: 'ledger',
    source: sourceFile('scan.txt', source),
    title: '报销台账',
    sheet: '明细',
    columns: [
      { header: '日期', type: 'date' },
      { header: '摘要', type: 'text' },
      { header: '金额', type: 'currency' },
    ],
    rows,
  };
}

describe('扫描文本才能入账', () => {
  it('同一行对得上时写出可计算的金额', () => {
    const result = run(ledger([['2026-09-01', '出租车', '128.00']]));
    expect(result.status).toBe(EXIT.ok);
    const content = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as {
      sheets: { rows: unknown[][]; columns: { type: string }[] }[];
    };
    expect(content.sheets[0]?.columns.map((column) => column.type)).toEqual([
      'date',
      'text',
      'currency',
    ]);
    expect(content.sheets[0]?.rows).toEqual([['2026-09-01', '出租车', 128]]);
  });

  it('千分位按原文对上，但表里写成数字', () => {
    const result = run({
      output: 'ledger',
      source: sourceFile('scan.txt', LEDGER_SOURCE),
      title: '报销台账',
      sheet: '明细',
      columns: [
        { header: '摘要', type: 'text' },
        { header: '金额', type: 'currency' },
      ],
      rows: [['办公用品', '1,280.50']],
    });
    expect(result.status).toBe(EXIT.ok);
    const content = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as {
      sheets: { rows: unknown[][] }[];
    };
    expect(content.sheets[0]?.rows).toEqual([['办公用品', 1280.5]]);
  });

  it('原文没有的金额被拒绝，而且不落盘、不把金额写进报错', () => {
    const result = run(ledger([['2026-09-01', '出租车', '999.99']]));
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('对不上');
    expect(result.stderr).not.toContain('999.99');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('不把 1000 里的 100 当成一笔金额', () => {
    const result = run({
      output: 'ledger',
      source: sourceFile('scan.txt', '合计 1000.00'),
      title: '报销台账',
      sheet: '明细',
      columns: [{ header: '金额', type: 'currency' }],
      rows: [['100']],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('不把两行的摘要和金额拼成一行', () => {
    const result = run(ledger([['2026-09-01', '餐饮', '128.00']]));
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('两行');
  });

  it('公式里写死税率时拒绝', () => {
    const result = run({
      output: 'ledger',
      source: sourceFile('scan.txt', '出租车 128.00'),
      title: '报销台账',
      sheet: '明细',
      columns: [
        { header: '摘要', type: 'text' },
        { header: '金额', type: 'currency' },
        { header: '税额', type: 'currency', formula: '=B{row}*0.06' },
      ],
      rows: [['出租车', '128.00', null]],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('写死数字');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('图片不识别', () => {
    const path = join(dir, 'page.png');
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const result = run({
      output: 'ledger',
      source: path,
      title: '报销台账',
      sheet: '明细',
      columns: [{ header: '摘要', type: 'text' }],
      rows: [['出租车']],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('不识别');
    expect(result.stderr).not.toMatch(/https?:\/\//);
  });
});

describe('扫描文本才能写纪要', () => {
  const MINUTES_SOURCE = [
    '2026年9月5日 参会：甲、乙',
    '决议：通过三季度预算',
    '待办：催收逾期款 负责人甲 2026-09-12',
  ].join('\n');

  function minutes(overrides: Record<string, unknown> = {}) {
    return {
      output: 'minutes',
      source: sourceFile('notes.txt', MINUTES_SOURCE),
      title: '周例会纪要',
      date: '2026-09-05',
      attendees: ['甲', '乙'],
      decisions: ['通过三季度预算'],
      actions: [{ task: '催收逾期款', owner: '甲', due: '2026-09-12' }],
      ...overrides,
    };
  }

  it('中文日期和同一行待办可以收成纪要', () => {
    const result = run(minutes());
    expect(result.status).toBe(EXIT.ok);
    const content = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as {
      template: string;
      blocks: { block: string; text?: string; items?: string[] }[];
    };
    expect(content.template).toBe('memo');
    expect(content.blocks.find((block) => block.text === '决议')).toBeDefined();
    expect(content.blocks.find((block) => block.block === 'bullets')?.items).toEqual([
      '通过三季度预算',
    ]);
  });

  it('原文没有的决议被拒绝，且不把决议写进报错', () => {
    const result = run(minutes({ decisions: ['秘密追加预算'] }));
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('决议');
    expect(result.stderr).not.toContain('秘密追加预算');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });
});
