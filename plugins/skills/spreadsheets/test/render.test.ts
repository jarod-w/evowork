/**
 * spreadsheets 技能的契约测试。
 *
 * 重点全部压在**「公式而非硬编码结果」**这条上（08 §5.2 的关键质量点）：
 * 它是这个技能存在的理由，而它一旦被绕过，产出的表看起来完全正常 ——
 * 只有当用户改了输入列、发现合计没变时才会暴露，那时已经带进汇报了。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
const FIXTURE = join(SKILL_ROOT, 'test', 'workbook_fixture.py');
const hasOpenpyxl = hasPythonModule('openpyxl');
// 造带图片的样本要 Pillow（办公扩展里有）；提取本身不需要它 —— 图片是从 xlsx 包里数的
const hasPillow = hasOpenpyxl && hasPythonModule('PIL');

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

describe('**条件汇总的条件一个都对不上** → 拒绝（2026-09-28 外部测试 A4）', () => {
  /*
   * A4 两轮交付的表：汇总表按区域写 SUMIF，条件区域却是明细表的「机构代码」列。
   * 条件永远不成立，三个区域的合计全是 0 —— 而表看起来完全正常，模型自己的核对也是绿的。
   */
  const detail = (withRegion: boolean) => ({
    name: '存款',
    columns: [
      { header: '机构代码', type: 'text' },
      ...(withRegion ? [{ header: '区域', type: 'text' }] : []),
      { header: '年末余额', type: 'integer' },
    ],
    rows: [
      ['B001', ...(withRegion ? ['华北'] : []), 100],
      ['B002', ...(withRegion ? ['华北'] : []), 200],
      ['B003', ...(withRegion ? ['华东'] : []), 300],
    ],
  });
  const summary = (formula: string, regions: readonly string[] = ['华北', '华东']) => ({
    name: '汇总',
    columns: [
      { header: '区域', type: 'text' },
      { header: '存款合计', type: 'integer', formula },
    ],
    rows: regions.map((region) => [region, null]),
  });
  const validate = (sheets: readonly unknown[]) => run({ sheets }, 'x.xlsx', ['--validate-only']);

  it('条件区域是「机构代码」、条件是区域名 → 拒绝，说清是哪两列', () => {
    const result = validate([
      detail(false),
      summary('=SUMIF(存款!$A$2:$A$4,A{row},存款!$B$2:$B$4)'),
    ]);
    expect(result.status).toBe(EXIT.invalidContent);
    const { message } = parseFailure(result.stderr);
    expect(message).toContain('「区域」列');
    expect(message).toContain('「机构代码」列');
    expect(message).toContain('全会算成 0');
    // 与「失败输出不含用户内容」同口径：只报列名与地址，不报格子里的值
    expect(result.stderr).not.toContain('华北');
    expect(result.stderr).not.toContain('B001');
  });

  it('条件区域换成明细表的「区域」列 → 通过', () => {
    const result = validate([
      detail(true),
      summary('=SUMIF(存款!$B$2:$B$4,A{row},存款!$C$2:$C$4)'),
    ]);
    expect(result.status).toBe(EXIT.ok);
  });

  it('只有某一个分组对不上 → 放行（那个区域本来就可以没有机构）', () => {
    const result = validate([
      detail(true),
      summary('=SUMIF(存款!$B$2:$B$4,A{row},存款!$C$2:$C$4)', ['华北', '华东', '华南']),
    ]);
    expect(result.status).toBe(EXIT.ok);
  });

  it('条件是字面量、一个都没命中 → 放行（「没有逾期」是一个合法的 0）', () => {
    const result = validate([detail(true), summary('=COUNTIF(存款!$B$2:$B$4,"华南")')]);
    expect(result.status).toBe(EXIT.ok);
  });

  it('SUMIFS 的第二对条件指错了列 → 同样拒绝', () => {
    const result = validate([
      detail(true),
      summary('=SUMIFS(存款!$C$2:$C$4,存款!$B$2:$B$4,A{row},存款!$A$2:$A$4,A{row})'),
    ]);
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('SUMIFS');
  });
});

describe('改已有文件：提取成内容 JSON', () => {
  it('csv 往返保留文字和整数，不把公式列的空单元格当成结果', () => {
    const content = {
      sheets: [
        {
          name: 'plain',
          columns: [
            { header: '产品', type: 'text' },
            { header: '数量', type: 'integer' },
          ],
          rows: [
            ['A 线', 2],
            ['B 线', 3],
          ],
          freeze_header: true,
        },
      ],
    };
    expect(run(content, 'plain.csv').status).toBe(EXIT.ok);
    const extracted = runPython(RENDER, [
      '--extract',
      join(dir, 'plain.csv'),
      '--out',
      join(dir, 'plain.json'),
    ]);
    expect(extracted.status, extracted.stderr).toBe(EXIT.ok);
    expect(JSON.parse(readFileSync(join(dir, 'plain.json'), 'utf8'))).toEqual(content);

    expect(run(SHEET, 'formula.csv').status).toBe(EXIT.ok);
    const refused = runPython(RENDER, [
      '--extract',
      join(dir, 'formula.csv'),
      '--out',
      join(dir, 'formula.json'),
    ]);
    expect(refused.status).toBe(EXIT.invalidContent);
    expect(parseFailure(refused.stderr).message).toContain('xlsx');
  });

  it.runIf(hasOpenpyxl)('xlsx 把同一列公式收成 {row}，合计行收成 total_row', () => {
    expect(run(SHEET, 'book.xlsx').status).toBe(EXIT.ok);
    const extracted = runPython(RENDER, [
      '--extract',
      join(dir, 'book.xlsx'),
      '--out',
      join(dir, 'book.json'),
    ]);
    expect(extracted.status, extracted.stderr).toBe(EXIT.ok);
    const sheet = (
      JSON.parse(readFileSync(join(dir, 'book.json'), 'utf8')) as {
        sheets: {
          columns: { header: string; formula?: string }[];
          rows: unknown[][];
          total_row?: boolean;
          freeze_header?: boolean;
        }[];
      }
    ).sheets[0]!;
    expect(sheet.columns[3]).toMatchObject({ header: '金额', formula: '=B{row}*C{row}' });
    expect(sheet.rows).toEqual([
      ['A 线', 12.5, 100, null],
      ['B 线', 8, 200, null],
    ]);
    expect(sheet.total_row).toBe(true);
    expect(sheet.freeze_header).toBe(true);
  });
});

interface ExtractedSheet {
  name: string;
  columns: { header: string; type?: string; formula?: string }[];
  rows: unknown[][];
  total_row?: boolean;
  freeze_header?: boolean;
  note?: string;
  conditional_formats?: { column: string; rule: string }[];
}
type Cells = Record<string, Record<string, [unknown, string]>>;

/** 用 openpyxl 直接造一份 xlsx：用户手做的、或别的工具导出的那种（见 workbook_fixture.py）。 */
function userWorkbook(name: string, code: string): string {
  const path = join(dir, name);
  const built = runPython(FIXTURE, ['build', path, code]);
  expect(built.status, built.stderr).toBe(0);
  return path;
}

/** 读回一份 xlsx 里每一格存的是什么：公式是公式文本，日期是 ISO 字符串加 data_type 'd'。 */
function readCells(path: string): Cells {
  const read = runPython(FIXTURE, ['read', path]);
  expect(read.status, read.stderr).toBe(0);
  return JSON.parse(read.stdout) as Cells;
}

function extract(source: string, extra: readonly string[] = []) {
  const out = join(dir, `${basename(source)}.json`);
  const result = runPython(RENDER, ['--extract', source, '--out', out, ...extra]);
  return {
    result,
    out,
    sheets: () => (JSON.parse(readFileSync(out, 'utf8')) as { sheets: ExtractedSheet[] }).sheets,
    dropped: () =>
      (JSON.parse(result.stdout) as { dropped?: Record<string, number> }).dropped ?? {},
  };
}

/** 提取 → 原样再渲染成一个新文件，返回新文件里存的东西。 */
function rerender(json: string, name: string): Cells {
  const rendered = runPython(RENDER, ['--content', json, '--out', join(dir, name)]);
  expect(rendered.status, rendered.stderr).toBe(EXIT.ok);
  return readCells(join(dir, name));
}

describe('提取用户的 xlsx：收得回来的原样收回，收不回来的报出来', () => {
  const TITLED = [
    'ws.title = "销售"',
    'ws["A1"] = "2026年三季度销售表"',
    'ws.merge_cells("A1:E1")',
    'ws.append(["产品", "单价", "数量", "金额", "占比"])',
    'ws.append(["A 线", 12.5, 100, "=B3*C3", "=D3/D$5"])',
    'ws.append(["B 线", 8, 200, "=B4*C4", "=D4/D$5"])',
    'ws.append(["合计", "=SUM(B3:B4)", "=SUM(C3:C4)", "=SUM(D3:D4)"])',
    'for row in (3, 4): ws.cell(row, 5).number_format = "0.0%"',
    'ws.freeze_panes = "A3"',
  ].join('\n');

  it.runIf(hasOpenpyxl)(
    '合并的标题行（A1:E1）：标题不当表头、五列一列不少；标题写不回去，先报出来',
    () => {
      const source = userWorkbook('titled.xlsx', TITLED);

      // 2026-10-22 之前：标题被当成表头，B–E 整列不见，而提取说成功
      const refused = extract(source);
      expect(refused.result.status).toBe(EXIT.invalidContent);
      expect(parseFailure(refused.result.stderr).message).toContain('标题行 1 处');
      // 失败输出只报种类和处数，不带标题原文（Q14 同口径）
      expect(refused.result.stderr).not.toContain('三季度销售表');

      const accepted = extract(source, ['--allow-lossy']);
      expect(accepted.result.status, accepted.result.stderr).toBe(EXIT.ok);
      expect(accepted.dropped()).toEqual({ 标题行: 1 });
      const [sheet] = accepted.sheets();
      expect(sheet!.columns.map((column) => column.header)).toEqual([
        '产品',
        '单价',
        '数量',
        '金额',
        '占比',
      ]);
      expect(sheet!.rows).toEqual([
        ['A 线', 12.5, 100, null, null],
        ['B 线', 8, 200, null, null],
      ]);
      expect(sheet!.total_row).toBe(true);
      // 冻结的是表头下面那一行（A3），写回去之后就是渲染器的「冻结首行」
      expect(sheet!.freeze_header).toBe(true);
      expect(sheet!.columns[3]!.formula).toBe('=B{row}*C{row}');

      // 标题行不写回去，整张表上移一行：「占比」除以的合计行从第 5 行变成第 4 行。
      // 绝对行号原样照抄的话，写回去的 D$5 指向合计行下面的空格，占比全是 #DIV/0!
      const cells = rerender(accepted.out, 'titled-again.xlsx')['销售']!;
      expect(cells['E2']![0]).toBe('=D2/D$4');
      expect(cells['D4']![0]).toBe('=SUM(D2:D3)');
    },
  );

  it.runIf(hasOpenpyxl)('表格右边还有一块内容：不悄悄丢掉，报成「表格区域外的单元格」', () => {
    const source = userWorkbook(
      'side.xlsx',
      [
        'ws.append(["产品", "数量", None, "备注"])',
        'ws.append(["A 线", 100, None, "急单"])',
        'ws.append(["B 线", 200])',
      ].join('\n'),
    );
    expect(extract(source).result.status).toBe(EXIT.invalidContent);
    const accepted = extract(source, ['--allow-lossy']);
    expect(accepted.result.status, accepted.result.stderr).toBe(EXIT.ok);
    expect(accepted.dropped()).toEqual({ 表格区域外的单元格: 2 });
    expect(accepted.sheets()[0]!.columns.map((column) => column.header)).toEqual(['产品', '数量']);
  });

  it.runIf(hasOpenpyxl)('表头空了一格、下面却有数据 → 拒绝：那是表里的一列，不能当表外丢掉', () => {
    const source = userWorkbook(
      'gap.xlsx',
      ['ws.append(["产品", None, "数量"])', 'ws.append(["A 线", "华北", 100])'].join('\n'),
    );
    const result = extract(source, ['--allow-lossy']);
    expect(result.result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.result.stderr).message).toContain('补上表头');
  });

  it.runIf(hasPillow)(
    '图表、图表工作表、图片、批注、合并单元格、数据验证：渲染器写不出来的都按种类报出来',
    () => {
      const source = userWorkbook(
        'objects.xlsx',
        [
          'ws.title = "明细"',
          'ws.append(["产品", "数量"])',
          'for row in (["A 线", 100], ["B 线", 200], ["C 线", 300]): ws.append(row)',
          'chart = BarChart()',
          'chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=4), titles_from_data=True)',
          'ws.add_chart(chart, "D2")',
          'sheet_chart = BarChart()',
          'sheet_chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=4), titles_from_data=True)',
          'wb.create_chartsheet("图").add_chart(sheet_chart)',
          'ws.add_image(Image(png()), "D20")',
          'ws["B2"].comment = Comment("核对过", "张三")',
          'ws["C10"] = "x"',
          'ws.merge_cells("C10:D10")',
          'check = DataValidation(type="list", formula1=\'"华北,华东"\')',
          'ws.add_data_validation(check)',
          'check.add("A2:A4")',
        ].join('\n'),
      );
      const refused = extract(source);
      expect(refused.result.status).toBe(EXIT.invalidContent);
      const { message } = parseFailure(refused.result.stderr);
      for (const kind of [
        '图表 1 处',
        '图表工作表 1 处',
        '图片 1 处',
        '批注 1 处',
        '合并单元格 1 处',
      ]) {
        expect(message).toContain(kind);
      }
      expect(refused.result.stderr).not.toContain('核对过');

      const accepted = extract(source, ['--allow-lossy']);
      expect(accepted.result.status, accepted.result.stderr).toBe(EXIT.ok);
      expect(accepted.dropped()).toEqual({
        图表: 1,
        图表工作表: 1,
        图片: 1,
        批注: 1,
        合并单元格: 1,
        表格区域外的单元格: 1,
        '数据验证（下拉列表等）': 1,
      });
      // 数据本身一格不少
      expect(accepted.sheets()[0]!.rows).toEqual([
        ['A 线', 100],
        ['B 线', 200],
        ['C 线', 300],
      ]);
    },
  );

  it.runIf(hasOpenpyxl)('认不出的条件格式报成「条件格式」，不再整份拒绝；认得出的照常收回', () => {
    const source = userWorkbook(
      'scale.xlsx',
      [
        'ws.append(["产品", "数量"])',
        'for row in (["A 线", 100], ["B 线", -5]): ws.append(row)',
        'ws.conditional_formatting.add("B2:B3", ColorScaleRule(start_type="min", start_color="FFFFFF", end_type="max", end_color="FF0000"))',
        'ws.conditional_formatting.add("B2:B3", CellIsRule(operator="lessThan", formula=["0"], font=Font(color="A53227")))',
      ].join('\n'),
    );
    const accepted = extract(source, ['--allow-lossy']);
    expect(accepted.result.status, accepted.result.stderr).toBe(EXIT.ok);
    expect(accepted.dropped()).toEqual({ 条件格式: 1 });
    expect(accepted.sheets()[0]!.conditional_formats).toEqual([
      { column: '数量', rule: 'negative-red' },
    ]);
  });
});

describe('提取时公式只改单元格引用里的相对行号', () => {
  it.runIf(hasOpenpyxl)('只有一行数据：常量与字符串里的数字不跟着行号变', () => {
    const source = userWorkbook(
      'one-row.xlsx',
      [
        'ws.title = "调整"',
        'ws.append(["基数", "调整后", "档位"])',
        'ws.append([10, "=A2*1.2", \'=IF(A2>2,"第2档","第1档")\'])',
      ].join('\n'),
    );
    const extracted = extract(source);
    expect(extracted.result.status, extracted.result.stderr).toBe(EXIT.ok);
    const [sheet] = extracted.sheets();
    // 2026-10-22 之前收成 =A{row}*1.{row}：新加的第 3 行变成 =A3*1.3，系数悄悄从 1.2 变成 1.3
    expect(sheet!.columns[1]!.formula).toBe('=A{row}*1.2');
    expect(sheet!.columns[2]!.formula).toBe('=IF(A{row}>2,"第2档","第1档")');

    // 用户加一行，再写回去：新的一行仍然乘 1.2
    sheet!.rows.push([20, null, null]);
    const json = writeContent(dir, { sheets: [sheet] }, 'one-row-edited.json');
    const cells = rerender(json, 'one-row-again.xlsx')['调整']!;
    expect(cells['B3']![0]).toBe('=A3*1.2');
    expect(cells['C3']![0]).toBe('=IF(A3>2,"第2档","第1档")');
  });

  it.runIf(hasOpenpyxl)('多行时 =A2/A$12 收成同一个模板，$ 锁住的行号原样保留', () => {
    const source = userWorkbook(
      'share.xlsx',
      [
        'ws.append(["金额", "占全年"])',
        'for row in range(2, 13): ws.append([row * 10, f"=A{row}/A$12"])',
      ].join('\n'),
    );
    // 2026-10-22 之前：A$12 里的 2 被当成行号，各行"模板不同"而被拒
    const extracted = extract(source);
    expect(extracted.result.status, extracted.result.stderr).toBe(EXIT.ok);
    expect(extracted.sheets()[0]!.columns[1]!.formula).toBe('=A{row}/A$12');
  });
});

describe('本技能自己的备注与合计行能原样读回来', () => {
  const NOTED = {
    sheets: [
      {
        name: '台账',
        columns: [
          { header: '产品', type: 'text' },
          { header: '数量', type: 'integer' },
        ],
        rows: [
          ['A 线', 2],
          ['B 线', 3],
        ],
        freeze_header: true,
        note: '数据来源：ERP 导出',
      },
    ],
  };

  it.runIf(hasOpenpyxl)('只有备注：读回来还是备注，不是垫着两行空行的一行数据', () => {
    expect(run(NOTED, 'noted.xlsx').status).toBe(EXIT.ok);
    const extracted = extract(join(dir, 'noted.xlsx'));
    expect(extracted.result.status, extracted.result.stderr).toBe(EXIT.ok);
    expect(extracted.dropped()).toEqual({});
    expect(JSON.parse(readFileSync(extracted.out, 'utf8'))).toEqual(NOTED);
  });

  it.runIf(hasOpenpyxl)('备注加合计行：两样都收回来（之前报的是"既有公式又有常量"）', () => {
    const content = { sheets: [{ ...NOTED.sheets[0]!, total_row: true }] };
    expect(run(content, 'noted-total.xlsx').status).toBe(EXIT.ok);
    const extracted = extract(join(dir, 'noted-total.xlsx'));
    expect(extracted.result.status, extracted.result.stderr).toBe(EXIT.ok);
    expect(JSON.parse(readFileSync(extracted.out, 'utf8'))).toEqual(content);
  });

  it.runIf(hasOpenpyxl)('第一列是序号时，「合计」两个字不被序号之和覆盖，读回来仍是合计行', () => {
    const content = {
      sheets: [
        {
          name: '明细',
          columns: [
            { header: '序号', type: 'integer' },
            { header: '数量', type: 'integer' },
          ],
          rows: [
            [1, 20],
            [2, 30],
          ],
          freeze_header: true,
          total_row: true,
        },
      ],
    };
    expect(run(content, 'numbered.xlsx').status).toBe(EXIT.ok);
    const cells = readCells(join(dir, 'numbered.xlsx'))['明细']!;
    expect(cells['A4']![0]).toBe('合计');
    expect(cells['B4']![0]).toBe('=SUM(B2:B3)');
    const extracted = extract(join(dir, 'numbered.xlsx'));
    expect(extracted.result.status, extracted.result.stderr).toBe(EXIT.ok);
    expect(JSON.parse(readFileSync(extracted.out, 'utf8'))).toEqual(content);
  });

  it.runIf(hasOpenpyxl)('四种条件格式写出去再读回来，一条不多一条不少', () => {
    const content = {
      sheets: [
        {
          ...SHEET.sheets[0]!,
          conditional_formats: [
            { column: '单价', rule: 'negative-red' },
            { column: '数量', rule: 'above-average-green' },
            { column: '金额', rule: 'top10-green' },
            { column: '金额', rule: 'data-bar' },
          ],
        },
      ],
    };
    expect(run(content, 'formats.xlsx').status).toBe(EXIT.ok);
    const extracted = extract(join(dir, 'formats.xlsx'));
    expect(extracted.result.status, extracted.result.stderr).toBe(EXIT.ok);
    expect(extracted.sheets()[0]!.conditional_formats).toEqual(
      content.sheets[0]!.conditional_formats,
    );
  });
});

describe('货币格式与日期', () => {
  it.runIf(hasOpenpyxl)(
    '"¥"#,##0.00 的 SUM 合计行收成 total_row；真日期读回来是日期，写回去还是日期',
    () => {
      const source = userWorkbook(
        'ledger.xlsx',
        [
          'ws.title = "报销"',
          'ws.append(["日期", "摘要", "金额"])',
          'ws.append([datetime.date(2026, 9, 1), "出租车", 128])',
          'ws.append([datetime.date(2026, 9, 2), "午餐", 45.5])',
          'ws.append(["合计", None, "=SUM(C2:C3)"])',
          'for row in (2, 3, 4): ws.cell(row, 3).number_format = \'"¥"#,##0.00\'',
          'for row in (2, 3): ws.cell(row, 1).number_format = "yyyy/m/d"',
        ].join('\n'),
      );
      // 2026-10-22 之前：货币格式不认识，合计行的 SUM 被说成"写死的数"而拒绝
      const extracted = extract(source);
      expect(extracted.result.status, extracted.result.stderr).toBe(EXIT.ok);
      const [sheet] = extracted.sheets();
      expect(sheet!.columns).toEqual([
        { header: '日期', type: 'date' },
        { header: '摘要', type: 'text' },
        { header: '金额', type: 'currency' },
      ]);
      expect(sheet!.rows).toEqual([
        ['2026-09-01', '出租车', 128],
        ['2026-09-02', '午餐', 45.5],
      ]);
      expect(sheet!.total_row).toBe(true);

      // 写回去之后日期仍是日期（data_type 'd'），不是一串字 —— 否则用户没法按日期排序、相减
      const cells = rerender(extracted.out, 'ledger-again.xlsx')['报销']!;
      expect(cells['A2']).toEqual(['2026-09-01T00:00:00', 'd']);
      expect(cells['C4']![0]).toBe('=SUM(C2:C3)');
    },
  );

  it.runIf(hasOpenpyxl)('别的货币（$）如实报成「数字格式」，不悄悄换成 ¥', () => {
    const source = userWorkbook(
      'usd.xlsx',
      [
        'ws.append(["客户", "金额"])',
        'ws.append(["Acme", 1200])',
        'ws.cell(2, 2).number_format = "$#,##0.00"',
      ].join('\n'),
    );
    const accepted = extract(source, ['--allow-lossy']);
    expect(accepted.result.status, accepted.result.stderr).toBe(EXIT.ok);
    expect(accepted.dropped()).toEqual({ 数字格式: 1 });
  });

  it.runIf(hasOpenpyxl)('date 列写成真日期；写不成日期的字原样留着', () => {
    const content = {
      sheets: [
        {
          name: '计划',
          columns: [
            { header: '事项', type: 'text' },
            { header: '截止', type: 'date' },
          ],
          rows: [
            ['对账', '2026-09-30'],
            ['盘点', '待定'],
          ],
        },
      ],
    };
    expect(run(content, 'plan.xlsx').status).toBe(EXIT.ok);
    const cells = readCells(join(dir, 'plan.xlsx'))['计划']!;
    expect(cells['B2']).toEqual(['2026-09-30T00:00:00', 'd']);
    expect(cells['B3']).toEqual(['待定', 's']);
  });
});

describe('csv 提取不丢格子、不改内容', () => {
  it('比表头宽的行 → 拒绝（之前多出来的那格被静默丢掉，提取照样成功）', () => {
    // 典型来源：值里有没加引号的逗号，一格被拆成两格
    const source = join(dir, 'ragged.csv');
    writeFileSync(source, '客户,金额\n鹏程公司,5,备注\n华远公司,6\n', 'utf8');
    const result = extract(source, ['--allow-lossy']);
    expect(result.result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.result.stderr).message).toContain('补上表头');
    expect(result.result.stderr).not.toContain('鹏程公司');
  });

  it('隔一列空列的另一块内容报成「表格区域外的单元格」；001 这类编号保持文字', () => {
    const source = join(dir, 'ids.csv');
    writeFileSync(source, '编号,数量,,备注\n001,5,,急单\n002,6\n', 'utf8');
    const refused = extract(source);
    expect(refused.result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(refused.result.stderr).message).toContain('表格区域外的单元格 2 处');

    const accepted = extract(source, ['--allow-lossy']);
    expect(accepted.result.status, accepted.result.stderr).toBe(EXIT.ok);
    const [sheet] = accepted.sheets();
    expect(sheet!.columns).toEqual([
      { header: '编号', type: 'text' },
      { header: '数量', type: 'integer' },
    ]);
    // 当成数的话 001 变成 1，编号就对不上了
    expect(sheet!.rows).toEqual([
      ['001', 5],
      ['002', 6],
    ]);
  });
});
