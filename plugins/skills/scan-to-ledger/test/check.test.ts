import { execFileSync } from 'node:child_process';
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
const DOCUMENTS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../documents/container_tools/render.py',
);
const SPREADSHEETS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../spreadsheets/container_tools/render.py',
);

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

  it('台账交给 spreadsheets 后，金额是数字，公式列仍是公式', () => {
    const result = run({
      output: 'ledger',
      source: sourceFile('scan.txt', '2026-09-01 出租车 128.00'),
      title: '报销台账',
      sheet: '明细',
      columns: [
        { header: '日期', type: 'date' },
        { header: '摘要', type: 'text' },
        { header: '金额', type: 'currency' },
        { header: '备注', type: 'currency', formula: '=C{row}' },
      ],
      rows: [['2026-09-01', '出租车', '128.00', null]],
    });
    expect(result.status, result.stderr).toBe(EXIT.ok);
    const rendered = runPython(SPREADSHEETS, [
      '--content',
      join(dir, 'out.json'),
      '--out',
      join(dir, 'ledger.xlsx'),
    ]);
    expect(rendered.status, rendered.stderr).toBe(EXIT.ok);
    const inspected = execFileSync(
      'python3',
      [
        '-c',
        [
          'from openpyxl import load_workbook',
          `book = load_workbook(${JSON.stringify(join(dir, 'ledger.xlsx'))})`,
          'sheet = book.active',
          'print(sheet["C2"].value)',
          'print(sheet["D2"].value)',
          'print(sheet["A2"].value)',
        ].join('\n'),
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(inspected.split('\n')).toEqual(['128', '=C2', '2026-09-01']);
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

function sheet(source: string, columns: { header: string; type: string }[], rows: unknown[][]) {
  return {
    output: 'ledger',
    source: sourceFile('scan.txt', source),
    title: '报销台账',
    sheet: '明细',
    columns,
    rows,
  };
}

const TEXT_AND_AMOUNT = [
  { header: '摘要', type: 'text' },
  { header: '金额', type: 'currency' },
];

function rowsOf(): unknown[][] {
  const content = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as {
    sheets: { rows: unknown[][] }[];
  };
  return content.sheets[0]?.rows ?? [];
}

describe('金额按值对上：正负号和万、千都算数', () => {
  it('原文是负数时，表里丢了负号就拒绝（-、−、会计括号几种写法）', () => {
    for (const written of ['-1,234.50', '−1,234.50', '(1,234.50)', '（1,234.50）']) {
      const result = run(sheet(`退款 ${written}`, TEXT_AND_AMOUNT, [['退款', '1234.50']]));
      expect(result.status, written).toBe(EXIT.invalidContent);
      expect(parseFailure(result.stderr).message, written).toContain('正负号');
      expect(result.stderr).not.toContain('1234.50');
      expect(existsSync(join(dir, 'out.json'))).toBe(false);
    }
  });

  it('照原文写成负数时通过，表里是负数', () => {
    expect(run(sheet('退款 (1,234.50)', TEXT_AND_AMOUNT, [['退款', '-1,234.50']])).status).toBe(
      EXIT.ok,
    );
    expect(rowsOf()).toEqual([['退款', -1234.5]]);
    expect(run(sheet('冲销 −56.00', TEXT_AND_AMOUNT, [['冲销', '−56.00']])).status).toBe(EXIT.ok);
    expect(rowsOf()).toEqual([['冲销', -56]]);
  });

  it('原文没有负号时，表里也不许加', () => {
    const result = run(sheet('出租车 128.00', TEXT_AND_AMOUNT, [['出租车', '-128.00']]));
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('正负号');
  });

  it('原文是 1.2万元、表里写 1.2 时拒绝（差了一万倍），并说清是单位', () => {
    const result = run(sheet('咨询费 1.2万元', TEXT_AND_AMOUNT, [['咨询费', '1.2']]));
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('万');
    expect(result.stderr).not.toContain('1.2万');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('换算后的数、或原样带单位，写进表里都是 12000', () => {
    for (const written of ['12000', '12,000', '1.2万']) {
      const result = run(sheet('咨询费 1.2万元', TEXT_AND_AMOUNT, [['咨询费', written]]));
      expect(result.status, written).toBe(EXIT.ok);
      expect(rowsOf()).toEqual([['咨询费', 12000]]);
    }
  });

  it('「千克」里的千是计量单位，不按一千换算', () => {
    const result = run(
      sheet(
        '大米 5千克 30.00',
        [
          { header: '品名', type: 'text' },
          { header: '数量', type: 'number' },
          { header: '金额', type: 'currency' },
        ],
        [['大米', '5', '30.00']],
      ),
    );
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(rowsOf()).toEqual([['大米', 5, 30]]);
  });
});

describe('原文的一处只能用一次', () => {
  it('同一行原文入账两次时拒绝，并指出是哪一行', () => {
    const row = ['2026-09-01', '出租车', '128.00'];
    const result = run(ledger([row, row]));
    expect(result.status).toBe(EXIT.invalidContent);
    const message = parseFailure(result.stderr).message;
    expect(message).toContain('rows/1');
    expect(message).toContain('同一行');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('一个数不能同时填进两列', () => {
    const result = run(
      sheet(
        '出租车 128.00',
        [...TEXT_AND_AMOUNT, { header: '实付', type: 'currency' }],
        [['出租车', '128.00', '128.00']],
      ),
    );
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('同一处');
  });

  it('表头超过 spreadsheets 的上限时，在检查这一步就拒绝，报的是 columns/<序号>/header', () => {
    const result = run(
      sheet(
        '出租车 128.00',
        [{ header: '摘'.repeat(41), type: 'text' }, TEXT_AND_AMOUNT[1]!],
        [['出租车', '128.00']],
      ),
    );
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('columns/0/header');
  });

  it('整行都是公式、没有一格来自原文的行被拒绝', () => {
    const result = run({
      ...sheet('出租车 128.00', [], [[null]]),
      columns: [{ header: '复核', type: 'currency', formula: '=A{row}' }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });
});

describe('日期里的数不是金额', () => {
  it('年份不能当成金额入账', () => {
    for (const source of ['2026-09-01 出租车 无金额', '2026年9月1日 出租车 无金额']) {
      const result = run(sheet(source, TEXT_AND_AMOUNT, [['出租车', '2026']]));
      expect(result.status, source).toBe(EXIT.invalidContent);
      expect(parseFailure(result.stderr).message).toContain('对不上');
    }
  });
});

describe('分不清时报「无法判定」，不放行', () => {
  it('整份原文挤在一行时，拼错的行不能借「同一行」过关', () => {
    const oneLine = LEDGER_SOURCE.split('\n').join(' ');
    const result = run(ledger([['2026-09-01', '餐饮', '1,280.50']], oneLine));
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('无法判定');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('一行原文太长时报无法判定', () => {
    const long = `出租车 128.00 ${'备注'.repeat(120)}`;
    const result = run(sheet(long, TEXT_AND_AMOUNT, [['出租车', '128.00']]));
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('无法判定');
  });

  it('括号里的整数分不清是负数还是序号', () => {
    const result = run(sheet('退款 (500)', TEXT_AND_AMOUNT, [['退款', '500']]));
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('无法判定');
  });
});

describe('原文里正常的写法照样认', () => {
  it('全角数字', () => {
    expect(run(sheet('出租车 １２８．００', TEXT_AND_AMOUNT, [['出租车', '128.00']])).status).toBe(
      EXIT.ok,
    );
    expect(rowsOf()).toEqual([['出租车', 128]]);
  });

  it('用空格做千分位', () => {
    for (const written of ['1,280.50', '1280.50', '1 280.50']) {
      const result = run(sheet('差旅费 1 280.50', TEXT_AND_AMOUNT, [['差旅费', written]]));
      expect(result.status, written).toBe(EXIT.ok);
      expect(rowsOf()).toEqual([['差旅费', 1280.5]]);
    }
  });

  it('同一行还有别的数时，空格隔开的按数量、单价、金额读', () => {
    const result = run(
      sheet(
        '办公用品 2 128.00 256.00',
        [
          { header: '品名', type: 'text' },
          { header: '数量', type: 'integer' },
          { header: '单价', type: 'currency' },
          { header: '金额', type: 'currency' },
        ],
        [['办公用品', '2', '128.00', '256.00']],
      ),
    );
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(rowsOf()).toEqual([['办公用品', 2, 128, 256]]);
  });

  it('粘在字后面的数不和后面的数拼成千分位：房间302 150.00 是房号和金额', () => {
    const result = run(sheet('房间302 150.00', TEXT_AND_AMOUNT, [['房间302', '150.00']]));
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(rowsOf()).toEqual([['房间302', 150]]);
  });

  it('数和日期后面紧跟英文逗号', () => {
    const result = run(
      ledger([['2026-09-01', '出租车', '128.00']], '2026-09-01,出租车,128.00,已报销'),
    );
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(rowsOf()).toEqual([['2026-09-01', '出租车', 128]]);
  });

  it('OCR 一格一行、按列的顺序排时，连续几行算同一笔', () => {
    const cellPerLine = ['2026-09-01', '出租车', '¥128.00', '', '2026-09-02', '餐饮', '56.00'];
    const result = run(
      ledger(
        [
          ['2026-09-01', '出租车', '128.00'],
          ['2026-09-02', '餐饮', '56.00'],
        ],
        cellPerLine.join('\n'),
      ),
    );
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(rowsOf()).toEqual([
      ['2026-09-01', '出租车', 128],
      ['2026-09-02', '餐饮', 56],
    ]);
  });

  it('一格一行时错开一格去配，不算同一笔', () => {
    const cellPerLine = ['2026-09-01', '出租车', '128.00', '2026-09-02', '餐饮', '56.00'];
    const result = run(ledger([['2026-09-02', '出租车', '128.00']], cellPerLine.join('\n')));
    expect(result.status).toBe(EXIT.invalidContent);
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('OCR 按列输出（先全部日期再全部摘要）时说清为什么不收', () => {
    const byColumn = ['2026-09-01', '2026-09-02', '出租车', '餐饮', '128.00', '56.00'];
    const result = run(ledger([['2026-09-01', '出租车', '128.00']], byColumn.join('\n')));
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('一格一行');
  });
});

describe('扫描文本才能写纪要', () => {
  const MINUTES_SOURCE = [
    '2026年9月5日 参会：甲、乙',
    '决议：通过三季度预算',
    '待办：催收逾期款 负责人甲 2026-09-12',
  ].join('\n');

  function minutes(overrides: Record<string, unknown> = {}, extra: readonly string[] = []) {
    return {
      output: 'minutes',
      source: sourceFile('notes.txt', [MINUTES_SOURCE, ...extra].join('\n')),
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

  it('纪要交给 documents 后决议还在', () => {
    expect(run(minutes()).status).toBe(EXIT.ok);
    const rendered = runPython(DOCUMENTS, [
      '--content',
      join(dir, 'out.json'),
      '--out',
      join(dir, 'minutes.md'),
    ]);
    expect(rendered.status, rendered.stderr).toBe(EXIT.ok);
    const markdown = readFileSync(join(dir, 'minutes.md'), 'utf8');
    expect(markdown).toContain('通过三季度预算');
    expect(markdown).toContain('催收逾期款');
  });

  it('原文没有的决议被拒绝，且不把决议写进报错', () => {
    const result = run(minutes({ decisions: ['秘密追加预算'] }));
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('决议');
    expect(result.stderr).not.toContain('秘密追加预算');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('决议多到 documents 收不下时，在检查这一步就拒绝，报的是 decisions', () => {
    const many = Array.from({ length: 31 }, (_, index) => `决议${index}`);
    const result = run(minutes({ decisions: many }, many));
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('decisions');
  });

  it('原文是「不同意」时，决议写成「同意」被拒绝', () => {
    for (const said of ['决议：不同意追加预算', '决议：暂未同意追加预算']) {
      const result = run(minutes({ decisions: ['同意追加预算'] }, [said]));
      expect(result.status, said).toBe(EXIT.invalidContent);
      expect(parseFailure(result.stderr).message).toContain('意思相反');
      expect(result.stderr).not.toContain('追加预算');
      expect(existsSync(join(dir, 'out.json'))).toBe(false);
    }
  });

  it('「分别通过」里的「别」不是否定', () => {
    const result = run(
      minutes({ decisions: ['通过四季度预算'] }, ['决议：分别通过四季度预算和明年预算']),
    );
    expect(result.status, result.stderr).toBe(EXIT.ok);
  });

  it('同一条决议写两次被拒绝', () => {
    const result = run(minutes({ decisions: ['通过三季度预算', '通过三季度预算'] }));
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('decisions/1');
  });

  it('标了缺席或请假的人不能列进参会人', () => {
    for (const said of ['列席：张三（缺席）', '缺席：张三', '张三请假']) {
      const result = run(minutes({ attendees: ['甲', '张三'] }, [said]));
      expect(result.status, said).toBe(EXIT.invalidContent);
      expect(parseFailure(result.stderr).message).toContain('缺席');
      expect(result.stderr).not.toContain('张三');
    }
  });

  it('没标缺席的人照样能列进参会人', () => {
    const result = run(minutes({ attendees: ['甲', '张三'] }, ['列席：张三']));
    expect(result.status, result.stderr).toBe(EXIT.ok);
  });

  it('两条待办挤在原文同一行、各有截止日期时报无法判定', () => {
    const result = run(
      minutes(
        {
          actions: [
            { task: '催收逾期款', owner: '甲', due: '2026-09-12' },
            { task: '核对发票', owner: '乙', due: '2026-09-19' },
          ],
        },
        ['待办：催收逾期款 负责人甲 2026-09-19；核对发票 负责人乙 2026-09-12'],
      ),
    );
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('actions/1 无法判定');
  });
});
