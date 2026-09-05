/**
 * charts 技能的契约测试。
 *
 * **能证明**：schema + 跨字段校验真的拦得住画不出来的数据、配色确实来自 design token、
 * 没有中文字体时**不产出方框图**而是明确失败。
 *
 * **不能证明**：图好不好看、坐标轴刻度合不合理。那要装上 matplotlib 并人工看图（U1）。
 */
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
const hasMatplotlib = hasPythonModule('matplotlib');

let dir: string;
beforeEach(() => {
  dir = makeTempDir('evowork-charts-');
});
afterEach(() => removeDir(dir));

function validate(content: unknown) {
  return runPython(RENDER, [
    '--content',
    writeContent(dir, content),
    '--out',
    join(dir, 'x.png'),
    '--validate-only',
  ]);
}

const BAR = {
  chart: 'bar',
  title: '分产品线季度营收',
  categories: ['Q1', 'Q2', 'Q3'],
  series: [{ name: 'A 线', values: [1240, 1380, 1510] }],
  source: 'revenue.xlsx',
};

describe('结构化生成：先校验再渲染（08 §5.3）', () => {
  it('合法内容通过校验（不需要办公扩展）', () => {
    const result = validate(BAR);
    expect(result.status).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, series: 1, validated: true });
  });

  it('未知的 chart 种类被拦下，并列出五种合法取值', () => {
    const result = validate({ ...BAR, chart: 'radar' });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).detail).toContain('bar');
    expect(parseFailure(result.stderr).detail).toContain('pie');
  });

  it('schema 不允许多余字段 —— 免得你以为指定了颜色就生效了', () => {
    const result = validate({ ...BAR, colors: ['#ff0000'] });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).detail).toContain('多余字段');
  });
});

describe('跨字段一致性：JSON Schema 表达不了、matplotlib 的报错又看不懂', () => {
  it('values 与 categories 长度不一致 → 指出具体是哪一条 series 与两边的长度', () => {
    const result = validate({
      ...BAR,
      series: [
        { name: 'A', values: [1, 2, 3] },
        { name: 'B', values: [1, 2] },
      ],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    const { message } = parseFailure(result.stderr);
    expect(message).toContain('series[1]');
    expect(message).toContain('2 个');
    expect(message).toContain('3 个');
  });

  it('bar 缺 categories', () => {
    const noCategories = { chart: 'bar', title: 'x', series: [{ name: 'A', values: [1] }] };
    expect(validate(noCategories).status).toBe(EXIT.invalidContent);
  });

  it('pie 只能有一个 series，且不能有负数', () => {
    expect(
      parseFailure(
        validate({
          ...BAR,
          chart: 'pie',
          series: [
            { name: 'A', values: [1, 2, 3] },
            { name: 'B', values: [1, 2, 3] },
          ],
        }).stderr,
      ).message,
    ).toContain('一个 series');

    expect(
      parseFailure(
        validate({ ...BAR, chart: 'pie', series: [{ name: 'A', values: [1, -2, 3] }] }).stderr,
      ).message,
    ).toContain('不能为负');
  });

  it('scatter 必须给 x_values，且与 values 等长', () => {
    expect(
      parseFailure(
        validate({ chart: 'scatter', title: 'x', series: [{ name: 'A', values: [1, 2] }] }).stderr,
      ).message,
    ).toContain('x_values');

    expect(
      validate({
        chart: 'scatter',
        title: 'x',
        series: [{ name: 'A', values: [1, 2], x_values: [1] }],
      }).status,
    ).toBe(EXIT.invalidContent);
  });
});

describe('配色来自 design token（01 §2），不是在技能里挑的', () => {
  it('八条系列色逐个等于 palette.ts 里的语义色', () => {
    const theme = JSON.parse(
      readFileSync(join(SKILL_ROOT, 'templates/default/theme.json'), 'utf8'),
    ) as { palette: string[] };
    const palette = readFileSync(
      resolve(SKILL_ROOT, '../../../packages/tokens/src/palette.ts'),
      'utf8',
    );

    // 四个语义基色 + 它们的加深变体：这样八条线在灰度打印下也能区分
    const expected = [
      'accent',
      'info',
      'warning',
      'danger',
      'accent-strong',
      'info-text',
      'warning-text',
      'danger-text',
    ];
    expect(theme.palette).toHaveLength(expected.length);
    expected.forEach((name, index) => {
      const match = new RegExp(`'?${name}'?: '(#[0-9A-Fa-f]{6})'`).exec(palette);
      expect(match?.[1]?.toUpperCase(), `token ${name}`).toBe(theme.palette[index]?.toUpperCase());
    });
  });
});

describe('输出格式与运行时（08 §4）', () => {
  it('只接受 .svg 与 .png', () => {
    const result = runPython(RENDER, [
      '--content',
      writeContent(dir, BAR),
      '--out',
      join(dir, 'x.pdf'),
    ]);
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('.svg');
  });

  // 不用 skipIf：**强制**无扩展环境，这样装没装扩展的机器上都验得到这条路径
  it('没装办公扩展时给可操作提示 + 专用退出码 3，而不是 python 堆栈', () => {
    const result = runPython(
      RENDER,
      ['--content', writeContent(dir, BAR), '--out', join(dir, 'x.png')],
      WITHOUT_OFFICE_RUNTIME,
    );
    expect(result.status).toBe(EXIT.runtimeMissing);
    // 文案必须与解析管道一致（08 §4：不能一处说"解析组件"一处说"生成组件"）
    expect(parseFailure(result.stderr).message).toContain('办公扩展');
    expect(result.stderr).not.toContain('Traceback');
  });
});

describe('装了办公扩展时真的能画出来', () => {
  it.runIf(hasMatplotlib)('产出 png，且文件不是空的', () => {
    const out = join(dir, 'chart.png');
    const result = runPython(RENDER, ['--content', writeContent(dir, BAR), '--out', out]);
    expect(result.status).toBe(EXIT.ok);
    // png 的魔数
    expect(readFileSync(out).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it.runIf(hasMatplotlib)('中文标题不会因为缺字体而失败（本机有 CJK 字体时）', () => {
    const out = join(dir, 'cjk.png');
    const result = runPython(RENDER, ['--content', writeContent(dir, BAR), '--out', out]);
    // 缺字体时是退出码 3 且**不产出文件** —— 两种结果都合法，但不能是"产出一张方框图"
    if (result.status === EXIT.runtimeMissing) {
      expect(parseFailure(result.stderr).message).toContain('中文字体');
    } else {
      expect(result.status).toBe(EXIT.ok);
      expect(readFileSync(out).byteLength).toBeGreaterThan(1000);
    }
  });
});

describe('失败输出不含用户内容（Q14 同口径）', () => {
  it('报错里不出现标题、分类名与数字', () => {
    const result = validate({
      chart: 'bar',
      title: '鹏程公司欠款分析',
      categories: ['华东大区'],
      series: [{ name: '逾期金额', values: [1, 2] }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    for (const secret of ['鹏程', '华东大区', '逾期金额']) {
      expect(result.stderr, `不该出现：${secret}`).not.toContain(secret);
    }
  });
});
