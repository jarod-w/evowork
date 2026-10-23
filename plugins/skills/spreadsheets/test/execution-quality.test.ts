import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDir, removeDir, runPython, writeContent } from '../../_shared/test-helpers.js';

const shared = resolve(dirname(fileURLToPath(import.meta.url)), '../../_shared');
const render = resolve(shared, '../spreadsheets/container_tools/render.py');
let temp: string;
beforeEach(() => {
  temp = makeTempDir('evowork-quality-');
});
afterEach(() => removeDir(temp));

function generate(formula: string) {
  const content = {
    sheets: [
      {
        name: 'Data',
        columns: [
          { header: 'Input', type: 'number' },
          { header: 'Result', type: 'number', formula },
        ],
        rows: [[12, null]],
      },
    ],
  };
  const out = join(temp, 'out.xlsx');
  return {
    out,
    result: runPython(render, ['--content', writeContent(temp, content), '--out', out]),
  };
}

describe('计算过公式再交付', () => {
  it('跨表汇总、条件、百分比和字符串结果与独立的预期值一致', () => {
    const samples: readonly [string, number | string | boolean][] = [
      ['=SUM(Detail!B2:B4)', 60],
      ['=SUMIF(Detail!A2:A4,"East",Detail!B2:B4)', 40],
      ['=SUMIFS(Detail!B2:B4,Detail!A2:A4,"East",Detail!B2:B4,">15")', 30],
      ['=COUNTIFS(Detail!A2:A4,"East",Detail!B2:B4,">15")', 1],
      ['=AVERAGEIF(Detail!A2:A4,"East",Detail!B2:B4)', 20],
      ['=AVERAGEIFS(Detail!B2:B4,Detail!A2:A4,"East")', 20],
      ['=COUNTIF(Detail!A2:A4,"E*")', 2],
      ['=COUNTIF(Detail!B2:B5,"*")', 0],
      ['=COUNTIF(Detail!A2:A5,"*")', 3],
      ['=SUMIF(Detail!B2:B4,"*",Detail!C2:C4)', 0],
      ['=COUNTIF(Detail!B2:B5,"??")', 0],
      ['=COUNT(Detail!B2:B4)', 3],
      ['=COUNTA(Detail!A2:A4)', 3],
      ['=MIN(Detail!B2:B4)', 10],
      ['=MAX(Detail!B2:B4)', 30],
      ['=SUMPRODUCT(Detail!B2:B4,Detail!C2:C4)', 14],
      ['=ROUND(2.675,2)', 2.68],
      ['=SUM("2",3)', 5],
      ['=COUNT("2",TRUE,Detail!B2)', 3],
      ['=IFERROR(1/0,7)', 7],
      ['=IF(FALSE,1/0,8)', 8],
      ['=50%*Detail!B2', 5],
      ['=-1^2', 1],
      ['=LEN("中文")', 2],
      ['="核对"&"通过"', '核对通过'],
      ['=AND(Detail!B2>0,TRUE)', true],
    ];
    const content = {
      sheets: [
        {
          name: 'Detail',
          columns: [
            { header: 'Region' },
            { header: 'Amount', type: 'number' },
            { header: 'Ratio', type: 'number' },
          ],
          rows: [
            ['East', 10, 0.1],
            ['West', 20, 0.2],
            ['East', 30, 0.3],
          ],
        },
        {
          name: 'Summary',
          columns: samples.map(([formula], index) => ({
            header: `C${index}`,
            type: 'number',
            formula,
          })),
          rows: [samples.map(() => null)],
        },
      ],
    };
    const out = join(temp, 'matrix.xlsx');
    const result = runPython(render, ['--content', writeContent(temp, content), '--out', out]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const read = runPython('-c', [
      'import sys,json;from openpyxl import load_workbook;print(json.dumps(list(load_workbook(sys.argv[1],data_only=True)["Summary"].values)[1]))',
      out,
    ]);
    expect(JSON.parse(read.stdout)).toEqual(samples.map(([, expected]) => expected));
  });
  it.each([
    '=SUMPRODUCT(A1:B1,A1:A2)',
    "='MissingSheet'!A{row}",
    '=A{row}/0',
    '=B{row}+1',
    '=SUM(A{row},#REF!)',
    '=(-1)^0.5',
    '=IFERROR(B{row},0)',
  ])('%s 有确定错误时不写文件', (formula) => {
    const { out, result } = generate(formula);
    expect(result.status).toBe(2);
    expect(existsSync(out)).toBe(false);
    expect(result.stderr).not.toContain('MissingSheet');
  });
  it('修正原文件时遇到错误公式，不破坏已有文件', () => {
    const { out, result } = generate('=A{row}*2');
    expect(result.status, result.stderr).toBe(0);
    const before = readFileSync(out);
    const content = {
      sheets: [
        {
          name: 'Data',
          columns: [{ header: 'Invalid', type: 'number', formula: '=1/0' }],
          rows: [[null]],
        },
      ],
    };
    const failed = runPython(render, [
      '--content',
      writeContent(temp, content, 'invalid.json'),
      '--out',
      out,
      '--overwrite',
    ]);
    expect(failed.status).toBe(2);
    expect(readFileSync(out)).toEqual(before);
  });
  it('公式保留、计算缓存能被读回，输入 12 的结果是 24', () => {
    const { out, result } = generate('=A{row}*2');
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).quality.status).toBe('passed');
    const read = runPython('-c', [
      'from openpyxl import load_workbook; import sys,json; print(json.dumps([load_workbook(sys.argv[1],data_only=False).active["B2"].value,load_workbook(sys.argv[1],data_only=True).active["B2"].value]))',
      out,
    ]);
    expect(JSON.parse(read.stdout)).toEqual(['=A2*2', 24]);
  });
  it('不认识的函数保留文件、标记待复核，不能冒充计算通过', () => {
    const { out, result } = generate('=CUSTOMFUNC(A{row})');
    expect(result.status).toBe(6);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      quality: { status: 'needs_review' },
    });
  });
  it('IF 与 IFERROR 不计算没选中的错误分支', () => {
    expect(generate('=IF(A{row}>0,A{row}*2,1/0)').result.status).toBe(0);
    removeDir(temp);
    temp = makeTempDir('evowork-quality-');
    expect(generate('=IFERROR(A{row}/0,0)').result.status).toBe(0);
  });
});

describe('成品检查的结果必须可信', () => {
  it('检查本身失败标记待复核，不能用空警告伪装检查通过', () => {
    const result = runPython('-c', [
      `import sys,json;sys.path.insert(0,sys.argv[1]);from layout_check import for_output;from pathlib import Path;print(json.dumps(for_output(Path(sys.argv[2]))))`,
      shared,
      join(temp, 'missing.pptx'),
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).quality.status).toBe('needs_review');
  });
  it.each(['failed', 'needs_review'])(
    '%s 的检查结果用专用退出码保留产物并要求修正或复核',
    (status) => {
      const result = runPython('-c', [
        `import sys;sys.path.insert(0,sys.argv[1]);from evowork_skill import succeeded;succeeded(quality={'status':sys.argv[2],'checks':['layout']})`,
        shared,
        status,
      ]);
      expect(result.status).toBe(6);
      expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, code: 6, quality: { status } });
    },
  );
});

describe('字体缓存跨 Python 命令复用', () => {
  it('两个新进程用相同的可写私有目录，第一次写的缓存第二次仍可读', () => {
    const code = `import sys,os,json;sys.path.insert(0,sys.argv[1]);from evowork_skill import configure_plot_cache;from pathlib import Path;configure_plot_cache();p=Path(os.environ['MPLCONFIGDIR']);m=p/'audit-marker';print(json.dumps({'path':str(p),'existing':m.exists(),'mode':p.stat().st_mode&0o777}));m.write_text('cache')`;
    const env = { TMPDIR: temp, MPLCONFIGDIR: '/nonexistent/evowork-audit-readonly/cache' };
    const first = runPython('-c', [code, shared], env);
    const second = runPython('-c', [code, shared], env);
    expect(first.status, first.stderr).toBe(0);
    expect(second.status, second.stderr).toBe(0);
    const one = JSON.parse(first.stdout),
      two = JSON.parse(second.stdout);
    expect(two).toMatchObject({ path: one.path, existing: true, mode: 0o700 });
    expect(readFileSync(join(one.path, 'audit-marker'), 'utf8')).toBe('cache');
  });
});
