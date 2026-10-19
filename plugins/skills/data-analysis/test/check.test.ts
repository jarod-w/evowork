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
  dir = makeTempDir('evowork-analysis-');
});
afterEach(() => removeDir(dir));

const GOOD = {
  question: '毛利率为什么下降',
  sources: [{ file: 'revenue.xlsx', sheet: '明细' }],
  definitions: [{ name: '毛利率', formula: '毛利 / 营收' }],
  comparisons: [{ name: '同比', baseline: '去年同季', finding: '下降 2 个百分点' }],
  anomalies: ['华东区毛利率为负'],
  conclusions: ['先核对华东区折扣'],
  charts: [{ title: '分区域毛利率', source: 'revenue.xlsx 的明细表' }],
};

function run(content: unknown) {
  return runPython(CHECK, [
    '--content',
    writeContent(dir, content),
    '--out',
    join(dir, 'out.json'),
  ]);
}

describe('分析必须带来源和结论', () => {
  it('图的来源写进报告，口径单独成节', () => {
    expect(run(GOOD).status).toBe(EXIT.ok);
    const content = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as {
      blocks: { block: string; text?: string; items?: string[] }[];
    };
    const headings = content.blocks
      .filter((block) => block.block === 'heading')
      .map((block) => block.text);
    expect(headings).toEqual(['数据来源', '口径', '对比', '异常', '结论', '图']);
    const chart = content.blocks.find((block) => block.items?.[0]?.includes('分区域毛利率'));
    expect(chart?.items?.[0]).toContain('revenue.xlsx 的明细表');
  });

  it('图没有 source 时拒绝，且不把标题写进报错', () => {
    const result = run({
      ...GOOD,
      charts: [{ title: '鹏程公司毛利率', source: '' }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('source');
    expect(result.stderr).not.toContain('鹏程公司');
  });

  it('没有来源文件时拒绝', () => {
    expect(run({ ...GOOD, sources: [] }).status).toBe(EXIT.invalidContent);
  });
});
