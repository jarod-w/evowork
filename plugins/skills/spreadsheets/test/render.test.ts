/**
 * spreadsheets 技能的契约测试。
 *
 * 重点全部压在**「公式而非硬编码结果」**这条上（08 §5.2 的关键质量点）：
 * 它是这个技能存在的理由，而它一旦被绕过，产出的表看起来完全正常 ——
 * 只有当用户改了输入列、发现合计没变时才会暴露，那时已经带进汇报了。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXIT,
  WITHOUT_OFFICE_RUNTIME,
  hasPythonModule,
  makeTempDir,
  parseFailure,
  removeDir,
  runPython,
  writeContent,
} from '../../_shared/test-helpers.js';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = join(SKILL_ROOT, 'container_tools', 'render.py');
const hasOpenpyxl = hasPythonModule('openpyxl');

let dir: string;
beforeEach(() => {
  dir = makeTempDir('evowork-xlsx-');
});
afterEach(() => removeDir(dir));

const SHEET = {
  sheets: [
    {
      name: '明细',
      columns: [
        { header: '产品', type: 'text' },
        { header: '单价', type: 'currency' },
        { header: '数量', type: 'integer' },
        { header: '金额', type: 'currency', formula: '=B{row}*C{row}' },
      ],
      rows: [
        ['A 线', 12.5, 100, null],
        ['B 线', 8, 200, null],
      ],
      total_row: true,
    },
  ],
};

function run(
  content: unknown,
  out: string,
  extra: readonly string[] = [],
  env: Readonly<Record<string, string>> = {},
) {
  return runPython(
    RENDER,
    ['--content', writeContent(dir, content), '--out', join(dir, out), ...extra],
    env,
  );
}

describe('**公式而非硬编码结果**（08 §5.2 的关键质量点）', () => {
  it('计算列的位置填了算好的数 → 拒绝，并说清为什么', () => {
    const bad = JSON.parse(JSON.stringify(SHEET)) as typeof SHEET;
    (bad.sheets[0]!.rows[0] as unknown[])[3] = 1250;
    const result = run(bad, 'x.xlsx', ['--validate-only']);

    expect(result.status).toBe(EXIT.invalidContent);
    const { message } = parseFailure(result.stderr);
    expect(message).toContain('计算列');
    // 报错要解释后果，否则模型下次还会这么填
    expect(message).toContain('结果不更新');
  });

  it('计算列填 null 时通过', () => {
    expect(run(SHEET, 'x.xlsx', ['--validate-only']).status).toBe(EXIT.ok);
  });

  it('formula 必须以 = 开头（schema 拦）', () => {
    const bad = JSON.parse(JSON.stringify(SHEET)) as typeof SHEET;
    bad.sheets[0]!.columns[3]!.formula = 'B{row}*C{row}';
    expect(run(bad, 'x.xlsx', ['--validate-only']).status).toBe(EXIT.invalidContent);
  });
});

describe('跨字段一致性', () => {
  it('行的格数与列数不一致 → 指出是哪一行、两边各多少', () => {
    const bad = JSON.parse(JSON.stringify(SHEET)) as typeof SHEET;
    bad.sheets[0]!.rows[1] = ['B 线', 8];
    const { message } = parseFailure(run(bad, 'x.xlsx', ['--validate-only']).stderr);
    expect(message).toContain('rows/1');
    expect(message).toContain('4 列');
  });

  it('表头重名 → 拒绝（公式与条件格式会指错列）', () => {
    const bad = JSON.parse(JSON.stringify(SHEET)) as typeof SHEET;
    bad.sheets[0]!.columns[2]!.header = '单价';
    expect(parseFailure(run(bad, 'x.xlsx', ['--validate-only']).stderr).message).toContain('重名');
  });

  it('条件格式指向不存在的列 → 拒绝', () => {
    const bad = JSON.parse(JSON.stringify(SHEET)) as typeof SHEET & {
      sheets: { conditional_formats?: unknown[] }[];
    };
    bad.sheets[0]!.conditional_formats = [{ column: '毛利', rule: 'negative-red' }];
    expect(parseFailure(run(bad, 'x.xlsx', ['--validate-only']).stderr).message).toContain('毛利');
  });

  it('工作表名里的非法字符被 schema 拦（Excel 不允许 : \\ / ? * [ ]）', () => {
    const bad = JSON.parse(JSON.stringify(SHEET)) as typeof SHEET;
    bad.sheets[0]!.name = '2026/09 明细';
    expect(run(bad, 'x.xlsx', ['--validate-only']).status).toBe(EXIT.invalidContent);
  });
});

describe('csv 是基础包能力，且降级是显式的', () => {
  it('不需要办公扩展也能产出 csv', () => {
    const result = run(SHEET, 'out.csv');
    expect(result.status).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout).format).toBe('csv');
  });

  it('**计算列留空并在表头标注**，而不是悄悄算一个值填进去', () => {
    run(SHEET, 'out.csv');
    const csv = readFileSync(join(dir, 'out.csv'), 'utf8');
    expect(csv).toContain('金额（公式列，csv 不支持）');
    // 用户看到空列会来问；看到一个数不会。（行尾是 CRLF：csv 模块的默认值，Excel 也期望它）
    expect(csv).toContain('A 线,12.5,100,\r\n');
  });

  it('带 BOM —— 没有它 Excel 打开 UTF-8 csv 会把中文显示成乱码', () => {
    run(SHEET, 'out.csv');
    expect(readFileSync(join(dir, 'out.csv'))[0]).toBe(0xef);
  });

  it('多张表输出 csv → 拒绝并给两条出路', () => {
    const many = { sheets: [SHEET.sheets[0], { ...SHEET.sheets[0], name: '汇总' }] };
    const { message } = parseFailure(run(many, 'out.csv').stderr);
    expect(message).toContain('xlsx');
  });
});

describe('运行时与格式（08 §4）', () => {
  it('只接受 .xlsx 与 .csv', () => {
    expect(parseFailure(run(SHEET, 'x.ods').stderr).message).toContain('.xlsx');
  });

  // 不用 skipIf：**强制**无扩展环境，装没装扩展的机器上都验得到
  it('没装办公扩展时给可操作提示 + 退出码 3', () => {
    const result = run(SHEET, 'x.xlsx', [], WITHOUT_OFFICE_RUNTIME);
    expect(result.status).toBe(EXIT.runtimeMissing);
    expect(parseFailure(result.stderr).message).toContain('办公扩展');
    expect(result.stderr).not.toContain('Traceback');
  });
});

describe('装了办公扩展时真的产出 xlsx，且**公式是公式**', () => {
  it.runIf(hasOpenpyxl)('金额列与合计行在文件里是 =B2*C2 与 =SUM(...)，不是算好的数', () => {
    const out = join(dir, 'book.xlsx');
    expect(run(SHEET, 'book.xlsx').status).toBe(EXIT.ok);

    // xlsx 是 zip：直接读 sheet1.xml 看单元格里存的是什么
    const xml = execFileSync('python3', [
      '-c',
      [
        'import sys,zipfile',
        'z=zipfile.ZipFile(sys.argv[1])',
        'print(z.read("xl/worksheets/sheet1.xml").decode("utf-8"))',
      ].join('\n'),
      out,
    ]).toString();

    // <f> 是公式节点。有它才说明写进去的是公式而不是常量
    expect(xml).toContain('<f>B2*C2</f>');
    expect(xml).toContain('SUM(D2:D3)');
  });

  it.runIf(hasOpenpyxl)('冻结首行真的落进了文件', () => {
    expect(run(SHEET, 'book2.xlsx').status).toBe(EXIT.ok);
    const xml = execFileSync('python3', [
      '-c',
      [
        'import sys,zipfile',
        'z=zipfile.ZipFile(sys.argv[1])',
        'print(z.read("xl/worksheets/sheet1.xml").decode("utf-8"))',
      ].join('\n'),
      join(dir, 'book2.xlsx'),
    ]).toString();
    expect(xml).toContain('topLeftCell="A2"');
  });
});

describe('失败输出不含用户内容（Q14 同口径）', () => {
  it('报错里不出现单元格里的业务数据', () => {
    const bad = {
      sheets: [
        {
          name: '欠款',
          columns: [{ header: '客户' }, { header: '金额', type: 'currency', formula: '=A{row}' }],
          rows: [['鹏程公司', 128000]],
        },
      ],
    };
    const result = run(bad, 'x.xlsx', ['--validate-only']);
    expect(result.status).toBe(EXIT.invalidContent);
    expect(result.stderr).not.toContain('鹏程公司');
    expect(result.stderr).not.toContain('128000');
  });
});
