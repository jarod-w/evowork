/**
 * `_shared/layout_check.py` 的契约测试（2026-10-22）。
 *
 * 它要守住的是 2026-10-12 那次 PPT 任务里 agent 现场手写渲染器才查出来的三类问题：
 * 文字溢出、字体里没有的字（会显示成方框）、内容越出页面 —— 以及**不误报**：
 * 放得下的框不报、本机没装的模板字体只提示不当成要改的问题。
 *
 * 需要办公扩展（python-pptx / python-docx / fontTools / PIL）；没装时整组跳过并写明原因，
 * 与本目录 render.test.ts 的判据一致（`hasPythonModule`）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hasPythonModule, runPython } from '../../_shared/test-helpers.js';

const SKILLS = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CHECK = join(SKILLS, '_shared', 'layout_check.py');
const SAMPLES = join(SKILLS, '_shared', 'test-fixtures', 'make_layout_samples.py');
const RENDER = join(SKILLS, 'presentations', 'container_tools', 'render.py');

interface Issue {
  readonly severity: string;
  readonly kind: string;
  readonly where: string;
  readonly detail: string;
}
interface Report {
  readonly warnings: readonly Issue[];
  readonly notes: readonly Issue[];
}

const hasOffice = hasPythonModule('pptx');
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'evowork-layout-'));
  if (hasOffice) {
    const made = runPython(SAMPLES, [dir]);
    if (made.status !== 0) throw new Error(`生成样本失败：${made.stderr}`);
  }
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function check(file: string): { report: Report; raw: string } {
  const result = runPython(CHECK, [join(dir, file)]);
  expect(result.status, result.stderr).toBe(0);
  return { report: JSON.parse(result.stdout) as Report, raw: result.stdout };
}

describe.skipIf(!hasOffice)('pptx：溢出 · 缺字 · 越界，且不误报（需要办公扩展）', () => {
  it('塞不下的框报溢出，放得下的框不报', () => {
    const { report } = check('sample.pptx');
    const overflow = report.warnings.filter((w) => w.kind === 'overflow');
    expect(overflow.map((w) => w.where)).toEqual(['第 1 页「overfull」']);
  });

  it('字体里没有的字报出码位 —— 2026-10-12 那次是 Hiragino 里没有 U+2212', () => {
    const { report } = check('sample.pptx');
    const glyph = report.warnings.find((w) => w.kind === 'missing-glyph');
    expect(glyph?.where).toContain('「glyph」');
    expect(glyph?.detail).toMatch(/DejaVu Sans.*U\+6536/);
  });

  it('越出页面的框报出来', () => {
    expect(check('sample.pptx').report.warnings.some((w) => w.kind === 'off-slide')).toBe(true);
  });

  it('**输出里没有用户内容**：只报位置、字号、码位与字体名（与四个技能的输出纪律一致）', () => {
    expect(check('sample.pptx').raw).not.toContain('张三');
    expect(check('sample.docx').raw).not.toContain('张三');
  });
});

describe.skipIf(!hasOffice)('docx：纸张 · 标题跳级 · 表格超出版心（需要办公扩展）', () => {
  it('Letter 纸只提示；标题跳级与超宽表格是要改的', () => {
    const { report } = check('sample.docx');
    expect(report.notes.some((n) => n.kind === 'paper')).toBe(true);
    expect(report.warnings.map((w) => w.kind).sort()).toEqual(['heading-skip', 'table-too-wide']);
  });
});

describe.skipIf(!hasOffice)('接在渲染器上（需要办公扩展）', () => {
  it('越界图片会保留产物并返回未验收，不能只在成功输出里附带警告', () => {
    const image = join(dir, 'wide.png');
    const made = runPython('-c', [
      'import struct,zlib,sys;from pathlib import Path;chunk=lambda t,b:struct.pack(">I",len(b))+t+b+struct.pack(">I",zlib.crc32(t+b)&0xffffffff);Path(sys.argv[1]).write_bytes(b"\\x89PNG\\r\\n\\x1a\\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",100,1,8,2,0,0,0))+chunk(b"IDAT",zlib.compress(b"\\0"+b"\\xff\\0\\0"*100))+chunk(b"IEND",b""))',
      image,
    ]);
    expect(made.status, made.stderr).toBe(0);
    const content = join(dir, 'wide.json');
    const out = join(dir, 'wide.pptx');
    writeFileSync(
      content,
      JSON.stringify({ slides: [{ layout: 'chart', title: '宽图片', chart_ref: image }] }),
    );
    const result = runPython(RENDER, ['--content', content, '--out', out]);
    expect(result.status, result.stderr).toBe(6);
    expect(existsSync(out)).toBe(true);
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ ok: false, quality: { status: 'failed' } });
    expect(report.layout_warnings.some((warning: Issue) => warning.kind === 'off-slide')).toBe(
      true,
    );
  });

  it('估算性文字溢出标为待复核，不能当作确定的通过或丢掉文件', () => {
    const content = join(dir, 'overflow.json');
    const out = join(dir, 'overflow.pptx');
    writeFileSync(
      content,
      JSON.stringify({
        slides: [
          {
            layout: 'bullets',
            title: '要点',
            bullets: Array.from({ length: 6 }, () =>
              Array.from({ length: 5 }, () => '测'.repeat(15)).join('\n'),
            ),
          },
        ],
      }),
    );
    const result = runPython(RENDER, ['--content', content, '--out', out]);
    expect(result.status, result.stderr).toBe(6);
    expect(existsSync(out)).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      quality: { status: 'needs_review' },
    });
  });
  it('渲染成功的输出里带检查结果；模板字体本机没装只算提示，不进要改的那一组', () => {
    const content = join(dir, 'content.json');
    writeFileSync(
      content,
      JSON.stringify({
        template: 'business',
        title: '测试',
        slides: [{ layout: 'bullets', title: '要点', bullets: ['营收同比 +18%', '毛利率 34%'] }],
      }),
    );
    const result = runPython(RENDER, ['--content', content, '--out', join(dir, 'deck.pptx')]);
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      layout_warnings: readonly Issue[];
      layout_notes: readonly Issue[];
    };
    expect(output.layout_warnings).toEqual([]);
    expect(Array.isArray(output.layout_notes)).toBe(true);
    expect(output.layout_notes.every((n) => n.severity === 'info')).toBe(true);
  });
});
