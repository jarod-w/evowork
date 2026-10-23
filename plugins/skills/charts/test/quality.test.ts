import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import {
  hasPythonModule,
  makeTempDir,
  removeDir,
  runPython,
  writeContent,
} from '../../_shared/test-helpers.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const renderer = join(root, 'container_tools/render.py');
let temp: string;
beforeEach(() => {
  temp = makeTempDir('evowork-chart-quality-');
});
afterEach(() => removeDir(temp));
function facts(content: unknown) {
  const script = `import importlib.util,sys,json\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1]);from evowork_skill import ensure_office_runtime;ensure_office_runtime(('matplotlib',))\nspec=importlib.util.spec_from_file_location('chart',sys.argv[2]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nfrom matplotlib.figure import Figure\nsaved=[];save=Figure.savefig\ndef capture(self,*args,**kwargs):\n save(self,*args,**kwargs);saved.append(self)\nFigure.savefig=capture\ncontent=json.loads(Path(sys.argv[3]).read_text());result=m.render(content,Path(sys.argv[4]));fig=saved[-1];ax=fig.axes[0]\nprint(json.dumps({'quality':result,'ticks':[t.get_text() for t in ax.get_yticklabels()],'bars':[[float(p.get_y()),float(p.get_height())] for p in ax.patches]},ensure_ascii=False))`;
  const probe = join(temp, 'probe.py');
  writeFileSync(probe, script);
  const result = runPython(probe, [
    resolve(root, '../_shared'),
    renderer,
    writeContent(temp, content),
    join(temp, 'chart.png'),
  ]);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as { quality: unknown; ticks: string[]; bars: number[][] };
}
describe.runIf(hasPythonModule('matplotlib'))('图表数值必须和数据含义一致', () => {
  it.each(['bar', 'line', 'scatter'])('%s 的比例数值实际显示为百分比', (chart) => {
    const result = facts({
      chart,
      title: 'Rate',
      value_format: 'percent',
      categories: ['A', 'B'],
      series: [
        {
          name: 'Margin',
          values: [0.25, 0.5],
          ...(chart === 'scatter' ? { x_values: [1, 2] } : {}),
        },
      ],
    });
    expect(result.ticks).toContain('50.0%');
    expect(result.ticks.every((v) => v.endsWith('%'))).toBe(true);
  });
  it('负值从零线下方累计，不覆盖已有正值', () => {
    const result = facts({
      chart: 'stacked-bar',
      title: 'Profit',
      categories: ['A'],
      series: [
        { name: 'Income', values: [100] },
        { name: 'Loss', values: [-50] },
        { name: 'More income', values: [20] },
        { name: 'More loss', values: [-10] },
      ],
    });
    expect(result.bars).toEqual([
      [0, 100],
      [0, -50],
      [100, 20],
      [-50, -10],
    ]);
  });
  it.each([
    ['thousands', 1000, '1,000'],
    ['decimal1', 1000, '1,000.0'],
  ])('%s 用于实际坐标刻度', (value_format, value, label) => {
    const result = facts({
      chart: 'bar',
      title: 'Value',
      value_format,
      categories: ['A'],
      series: [{ name: 'Value', values: [value] }],
    });
    expect(result.ticks).toContain(label);
  });
});
describe.runIf(hasPythonModule('matplotlib'))('缺字不能冒充成功交付', () => {
  it('正常中文与负数图生成后有明确的字形检查通过状态', () => {
    const out = join(temp, 'ok.png');
    const content = {
      chart: 'bar',
      title: '毛利率',
      value_format: 'percent',
      categories: ['华东', '华西'],
      series: [{ name: '毛利率', values: [-0.25, 0.5] }],
    };
    const result = runPython(renderer, ['--content', writeContent(temp, content), '--out', out]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      quality: { status: 'passed', checks: ['glyphs'] },
    });
    expect(readFileSync(out).byteLength).toBeGreaterThan(1000);
  });
  it.each(['png', 'svg'])('%s 缺字保留产物、退出 6，只报告码位和位置', (format) => {
    const out = join(temp, `missing.${format}`);
    const content = {
      chart: 'bar',
      title: '͸',
      categories: ['A'],
      series: [{ name: 'Value', values: [10] }],
    };
    const result = runPython(renderer, ['--content', writeContent(temp, content), '--out', out]);
    expect(result.status).toBe(6);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      quality: { status: 'failed', checks: ['glyphs'] },
    });
    expect(result.stderr).not.toContain('͸');
    expect(result.stdout).not.toContain('͸');
  });
  it('实际字形检查抛异常时，文件仍保留但必须待复核、退出 6', () => {
    const script = `import sys,importlib.util
from pathlib import Path
sys.path.insert(0,sys.argv[1]);from evowork_skill import ensure_office_runtime;ensure_office_runtime(('matplotlib',))
spec=importlib.util.spec_from_file_location('chart',sys.argv[2]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
import matplotlib;matplotlib.use('Agg');import matplotlib.pyplot as plt
subplots=plt.subplots
def broken_check(*args,**kwargs):
 fig,ax=subplots(*args,**kwargs);draw=fig.canvas.draw
 def fail_once():
  fig.canvas.draw=draw;raise RuntimeError('probe')
 fig.canvas.draw=fail_once;return fig,ax
plt.subplots=broken_check
sys.argv=[sys.argv[2],'--content',sys.argv[3],'--out',sys.argv[4]];m.main()`;
    const probe = join(temp, 'broken-check.py');
    writeFileSync(probe, script);
    const out = join(temp, 'review.png');
    const result = runPython(probe, [
      resolve(root, '../_shared'),
      renderer,
      writeContent(temp, {
        chart: 'bar',
        title: 'Value',
        categories: ['A'],
        series: [{ name: 'Value', values: [10] }],
      }),
      out,
    ]);
    expect(result.status, result.stderr).toBe(6);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      quality: { status: 'needs_review' },
    });
  });
});
