import { spawnSync } from 'node:child_process';
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

let dir: string;
let data: string;
beforeEach(() => {
  dir = makeTempDir('evowork-analysis-');
  data = join(dir, 'revenue.xlsx');
  writeFileSync(data, 'PK');
});
afterEach(() => removeDir(dir));

function good() {
  return {
    question: '毛利率为什么下降',
    sources: [{ file: data, sheet: '明细' }],
    definitions: [{ name: '毛利率', formula: '毛利 / 营收' }],
    comparisons: [{ name: '同比', baseline: '去年同季', finding: '下降 2 个百分点' }],
    anomalies: ['华东区毛利率为负'],
    conclusions: ['先核对华东区折扣'],
    charts: [{ title: '分区域毛利率', source: `${data} / 明细` }],
  };
}

function run(content: unknown) {
  return runPython(CHECK, [
    '--content',
    writeContent(dir, content),
    '--out',
    join(dir, 'out.json'),
  ]);
}

/** 指定工作目录跑一次：相对路径按它算。 */
function runIn(cwd: string, content: unknown) {
  const result = spawnSync(
    'python3',
    [CHECK, '--content', writeContent(dir, content), '--out', join(dir, 'out.json')],
    { cwd, encoding: 'utf8' },
  );
  return { status: result.status ?? -1, stderr: result.stderr ?? '' };
}

describe('分析必须带来源和结论', () => {
  it('图的来源写进报告，口径单独成节', () => {
    expect(run(good()).status).toBe(EXIT.ok);
    const content = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as {
      blocks: { block: string; text?: string; items?: string[] }[];
    };
    const headings = content.blocks
      .filter((block) => block.block === 'heading')
      .map((block) => block.text);
    expect(headings).toEqual(['数据来源', '口径', '对比', '异常', '结论', '图']);
    const chart = content.blocks.find((block) => block.items?.[0]?.includes('分区域毛利率'));
    expect(chart?.items?.[0]).toContain('revenue.xlsx / 明细');
  });

  it('图没有 source 时拒绝，且不把标题写进报错', () => {
    const result = run({
      ...good(),
      charts: [{ title: '鹏程公司毛利率', source: '' }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('source');
    expect(result.stderr).not.toContain('鹏程公司');
  });

  it('报告交给 documents 后，来源和结论都在正文里', () => {
    expect(run(good()).status).toBe(EXIT.ok);
    const rendered = runPython(DOCUMENTS, [
      '--content',
      join(dir, 'out.json'),
      '--out',
      join(dir, 'analysis.md'),
    ]);
    expect(rendered.status, rendered.stderr).toBe(EXIT.ok);
    const markdown = readFileSync(join(dir, 'analysis.md'), 'utf8');
    expect(markdown).toContain('revenue.xlsx / 明细');
    expect(markdown).toContain('先核对华东区折扣');
    expect(markdown).toContain('来源：');
  });

  it('没有来源文件时拒绝', () => {
    expect(run({ ...good(), sources: [] }).status).toBe(EXIT.invalidContent);
  });
});

describe('来源要真的在，图和表只能引用声明过的来源', () => {
  it('来源文件不存在时拒绝，且不把路径写进报错', () => {
    const result = run({
      ...good(),
      sources: [{ file: join(dir, '鹏程公司.xlsx'), sheet: '明细' }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('sources/0/file');
    expect(result.stderr).not.toContain('鹏程公司');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('来源是目录而不是文件时拒绝', () => {
    const result = run({ ...good(), sources: [{ file: dir, sheet: '明细' }], charts: undefined });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('sources/0/file');
  });

  it('相对路径按当前工作目录找：在数据所在目录能找到，换个目录就找不到', () => {
    const content = {
      ...good(),
      sources: [{ file: 'revenue.xlsx', sheet: '明细' }],
      charts: [{ title: '分区域毛利率', source: 'revenue.xlsx' }],
    };
    expect(runIn(dir, content).status).toBe(EXIT.ok);
    const empty = makeTempDir('evowork-analysis-cwd-');
    try {
      const elsewhere = runIn(empty, content);
      expect(elsewhere.status).toBe(EXIT.invalidContent);
      expect(parseFailure(elsewhere.stderr).message).toContain('sources/0/file');
    } finally {
      removeDir(empty);
    }
  });

  it('图或表的 source 不在 sources 里时拒绝', () => {
    const chart = run({
      ...good(),
      charts: [{ title: '分区域毛利率', source: 'cost.xlsx 的明细表' }],
    });
    expect(chart.status).toBe(EXIT.invalidContent);
    expect(parseFailure(chart.stderr).message).toContain('charts/0/source');
    expect(chart.stderr).not.toContain('cost.xlsx');

    const table = run({ ...good(), tables: [{ title: '分区域明细', source: `${data} / 汇总` }] });
    expect(table.status).toBe(EXIT.invalidContent);
    expect(parseFailure(table.stderr).message).toContain('tables/0/source');
  });

  it('source 写 sources 里的 file，或写成「file / sheet」都可以', () => {
    const result = run({
      ...good(),
      charts: [{ title: '分区域毛利率', source: data }],
      tables: [{ title: '分区域明细', source: `${data} / 明细` }],
    });
    expect(result.status, result.stderr).toBe(EXIT.ok);
  });
});

describe('检查放行的，documents 也收；超了报原来的字段名', () => {
  it('一条对比拼起来超过 300 字时报 comparisons/0，不是 blocks/5 items/0', () => {
    const result = run({
      ...good(),
      comparisons: [{ name: '同比', baseline: '去年同季', finding: '降'.repeat(295) }],
    });
    expect(result.status).toBe(EXIT.invalidContent);
    const message = parseFailure(result.stderr).message;
    expect(message).toContain('comparisons/0');
    expect(message).not.toContain('blocks');
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('一个列表超过 30 条时报那个字段', () => {
    const result = run({ ...good(), anomalies: Array.from({ length: 31 }, (_, i) => `异常 ${i}`) });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('anomalies');
  });

  it('一条异常超过 300 字时报 anomalies/<序号>', () => {
    const result = run({ ...good(), anomalies: ['正常', '异'.repeat(301)] });
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('anomalies/1');
  });

  it('正好在上限上的报告能渲染出来', () => {
    const thirty = <T>(make: (i: number) => T) => Array.from({ length: 30 }, (_, i) => make(i));
    const fill = (prefix: string, length: number, word: string) => prefix.padEnd(length, word);
    const result = run({
      question: '问'.repeat(4000),
      sources: thirty(() => ({ file: data, sheet: fill('', 300 - data.length - 3, '表') })),
      definitions: thirty((i) => ({
        name: `${i}`,
        formula: fill('', 300 - `${i}`.length - 3, '式'),
      })),
      comparisons: thirty((i) => ({
        name: `${i}`,
        baseline: '去年',
        finding: fill('', 300 - `${i}`.length - 2 - 5, '降'),
      })),
      anomalies: thirty((i) => fill(`${i}`, 300, '异')),
      conclusions: thirty((i) => fill(`${i}`, 300, '论')),
      charts: thirty((i) => ({ title: fill(`${i}`, 300 - data.length - 5, '图'), source: data })),
      tables: thirty((i) => ({ title: fill(`${i}`, 300 - data.length - 5, '表'), source: data })),
    });
    expect(result.status, result.stderr).toBe(EXIT.ok);
    const content = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as {
      blocks: { items?: string[] }[];
    };
    const longest = Math.max(
      ...content.blocks.flatMap((block) => block.items ?? []).map((item) => item.length),
    );
    expect(longest).toBe(300);
    const rendered = runPython(DOCUMENTS, [
      '--content',
      join(dir, 'out.json'),
      '--out',
      join(dir, 'analysis.md'),
    ]);
    expect(rendered.status, rendered.stderr).toBe(EXIT.ok);
  });
});
