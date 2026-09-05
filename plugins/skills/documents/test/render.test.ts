/**
 * documents 技能的契约测试。
 *
 * 两个重点：**md 是一等输出**（不装扩展也能干活），以及**标题层级不许跳级**
 * （跳级会让 Word 的目录缺一层、导航窗格错位，而生成时不报错）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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
const hasDocx = hasPythonModule('docx');

let dir: string;
beforeEach(() => {
  dir = makeTempDir('evowork-docx-');
});
afterEach(() => removeDir(dir));

const DOC = {
  title: 'Q3 经营分析',
  subtitle: '财务部 · 2026 年 9 月',
  toc: true,
  blocks: [
    { block: 'heading', level: 1, text: '总体情况' },
    { block: 'paragraph', text: '本季营收同比增长 18%。' },
    { block: 'bullets', items: ['A 线增长最快', 'B 线毛利率回升'] },
    { block: 'table', header: ['产品线', '营收'], rows: [['A 线', '1,240 万']] },
    { block: 'pagebreak' },
    { block: 'heading', level: 2, text: '下一步' },
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

describe('结构化生成：先校验再渲染（08 §5.3）', () => {
  it('合法内容通过校验（不需要办公扩展）', () => {
    const result = run(DOC, 'x.docx', ['--validate-only']);
    expect(result.status).toBe(EXIT.ok);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, blocks: 6, validated: true });
  });

  it('未知的 block 种类被拦下，且报错精确到"按你声明的那种检查"', () => {
    const bad = { ...DOC, blocks: [{ block: 'callout', text: 'x' }] };
    const result = run(bad, 'x.docx', ['--validate-only']);
    expect(result.status).toBe(EXIT.invalidContent);
    expect(result.stderr).not.toContain('Traceback');
  });

  it('oneOf 的报错只列**用户声明的那种 block** 的问题', () => {
    // 一个缺 items 的 bullets：不该同时抱怨"缺 text""缺 header"
    const bad = { ...DOC, blocks: [{ block: 'bullets' }] };
    const { detail } = parseFailure(run(bad, 'x.docx', ['--validate-only']).stderr);
    expect(detail).toContain('block = bullets');
    expect(detail).toContain('items');
    expect(detail).not.toContain('header');
  });
});

describe('**标题层级不许跳级** —— 跳了 Word 的目录会缺一层，而生成时不报错', () => {
  it('h1 直接到 h3 被拒绝，并说清应该是 h2', () => {
    const bad = {
      ...DOC,
      blocks: [
        { block: 'heading', level: 1, text: 'A' },
        { block: 'heading', level: 3, text: 'B' },
      ],
    };
    const { message } = parseFailure(run(bad, 'x.docx', ['--validate-only']).stderr);
    expect(message).toContain('h2');
    expect(message).toContain('目录会缺一层');
  });

  it('逐级下降与任意幅度的上升都合法（h3 回到 h1 是正常的换章）', () => {
    const ok = {
      ...DOC,
      blocks: [
        { block: 'heading', level: 1, text: 'A' },
        { block: 'heading', level: 2, text: 'B' },
        { block: 'heading', level: 3, text: 'C' },
        { block: 'heading', level: 1, text: 'D' },
      ],
    };
    expect(run(ok, 'x.docx', ['--validate-only']).status).toBe(EXIT.ok);
  });
});

describe('表格与图片的跨字段约束', () => {
  it('行的格数与表头列数不一致 → 指出是哪一行', () => {
    const bad = {
      ...DOC,
      blocks: [{ block: 'table', header: ['a', 'b'], rows: [['only-one']] }],
    };
    expect(parseFailure(run(bad, 'x.docx', ['--validate-only']).stderr).message).toContain(
      'rows/0',
    );
  });

  it('引用不存在的图片 → 专用退出码 4，让模型先去生成它', () => {
    const bad = { ...DOC, blocks: [{ block: 'image', path: 'charts/nope.png' }] };
    const result = run(bad, 'x.docx', ['--validate-only']);
    expect(result.status).toBe(EXIT.missingAsset);
    expect(parseFailure(result.stderr).message).toContain('charts 技能');
  });

  it('图片存在时通过', () => {
    writeFileSync(join(dir, 'chart.png'), 'not-a-real-png-but-exists');
    const ok = { ...DOC, blocks: [{ block: 'image', path: 'chart.png' }] };
    expect(run(ok, 'x.docx', ['--validate-only']).status).toBe(EXIT.ok);
  });
});

describe('md 是一等输出，不是降级（不需要办公扩展）', () => {
  it('产出 md 并保留层级', () => {
    const result = run(DOC, 'out.md');
    expect(result.status).toBe(EXIT.ok);
    const md = readFileSync(join(dir, 'out.md'), 'utf8');
    // 文档 title 占 h1，所以 heading level 1 落到 ##
    expect(md).toContain('# Q3 经营分析');
    expect(md).toContain('## 总体情况');
    expect(md).toContain('### 下一步');
  });

  it('表格转成 md 表格', () => {
    run(DOC, 'out.md');
    const md = readFileSync(join(dir, 'out.md'), 'utf8');
    expect(md).toContain('| 产品线 | 营收 |');
    expect(md).toContain('| A 线 | 1,240 万 |');
  });

  it('分页符转成水平线，而不是被静默丢掉', () => {
    run(DOC, 'out.md');
    expect(readFileSync(join(dir, 'out.md'), 'utf8')).toContain('\n---\n');
  });
});

describe('运行时与格式（08 §4）', () => {
  it('只接受 .docx 与 .md', () => {
    expect(parseFailure(run(DOC, 'x.pdf').stderr).message).toContain('.docx');
  });

  // 不用 skipIf：**强制**无扩展环境
  it('没装办公扩展时给可操作提示 + 退出码 3', () => {
    const result = run(DOC, 'x.docx', [], WITHOUT_OFFICE_RUNTIME);
    expect(result.status).toBe(EXIT.runtimeMissing);
    expect(parseFailure(result.stderr).message).toContain('办公扩展');
    expect(result.stderr).not.toContain('Traceback');
  });
});

describe('装了办公扩展时真的产出 docx', () => {
  it.runIf(hasDocx)('产出的是 zip 容器（docx 的真实形状），且目录域写进去了', () => {
    const out = join(dir, 'doc.docx');
    expect(run(DOC, 'doc.docx').status).toBe(EXIT.ok);
    expect(readFileSync(out).subarray(0, 2).toString('latin1')).toBe('PK');

    const xml = execFileSync('python3', [
      '-c',
      [
        'import sys,zipfile',
        'z=zipfile.ZipFile(sys.argv[1])',
        'print(z.read("word/document.xml").decode("utf-8"))',
      ].join('\n'),
      out,
    ]).toString();
    // TOC 是一个域（field），不是一段文字 —— 这正是要在文档里跟用户解释的那件事
    expect(xml).toContain('TOC');
    expect(xml).toContain('F9');
  });
});

describe('失败输出不含用户内容（Q14 同口径）', () => {
  it('报错里不出现正文', () => {
    const bad = {
      title: '鹏程公司欠款分析',
      blocks: [{ block: 'table', header: ['客户'], rows: [['鹏程公司', '128000']] }],
    };
    const result = run(bad, 'x.docx', ['--validate-only']);
    expect(result.status).toBe(EXIT.invalidContent);
    expect(result.stderr).not.toContain('鹏程公司');
    expect(result.stderr).not.toContain('128000');
  });
});
