/**
 * documents 技能的契约测试。
 *
 * 两个重点：**md 是一等输出**（不装扩展也能干活），以及**标题层级不许跳级**
 * （跳级会让 Word 的目录缺一层、导航窗格错位，而生成时不报错）。
 */
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
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

/** docx 就是个 zip，直接把主文档 XML 读出来断言 —— 比解 docx 的库更贴契约。 */
function readDocumentXml(out: string): string {
  return execFileSync('python3', [
    '-c',
    [
      'import sys,zipfile',
      'z=zipfile.ZipFile(sys.argv[1])',
      'print(z.read("word/document.xml").decode("utf-8"))',
    ].join('\n'),
    out,
  ]).toString();
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
  it('未知扩展名仍然拒绝', () => {
    const message = parseFailure(run(DOC, 'x.rtf').stderr).message;
    expect(message).toContain('.docx');
    expect(message).toContain('.pdf');
  });

  it('没有 soffice 时 PDF 以退出码 3 失败，并且不落盘', () => {
    const result = run(DOC, 'x.pdf', [], { EVOWORK_OFFICE_CONVERTER: '/nonexistent/soffice' });
    expect(result.status).toBe(EXIT.runtimeMissing);
    expect(parseFailure(result.stderr).message).toContain('LibreOffice');
    expect(result.stderr).not.toMatch(/zip/i);
    expect(existsSync(join(dir, 'x.pdf'))).toBe(false);
  });

  // 不用 skipIf：**强制**无扩展环境
  it('没装办公扩展时给可操作提示 + 退出码 3', () => {
    const result = run(DOC, 'x.docx', [], WITHOUT_OFFICE_RUNTIME);
    expect(result.status).toBe(EXIT.runtimeMissing);
    expect(parseFailure(result.stderr).message).toContain('办公扩展');
    expect(result.stderr).not.toContain('Traceback');
  });
});

describe('PDF 由本机 LibreOffice 转出（2026-10-22：经与预览转换器相同的隔离）', () => {
  const onMac = process.platform === 'darwin';

  /**
   * 假转换器写成 /bin/sh 脚本：转换在 seatbelt 沙箱里跑，只读得到系统目录与转换器自己所在的目录
   * —— `#!/usr/bin/env python3` 在沙箱里找不到 python 的家，那正是隔离生效的样子。
   */
  function fakeConverter(body: string): string {
    const script = join(dir, 'soffice');
    writeFileSync(script, `#!/bin/sh\n${body}`, 'utf8');
    chmodSync(script, 0o755);
    return script;
  }

  /** 核对预览那组参数与一次性配置（关宏、不更新外部链接），再写一个带 %PDF 头的文件 */
  const ACCEPTING = `
for item in --headless --convert-to --outdir --nologo --norestore --nolockcheck; do
  case " $* " in *" $item "*) ;; *) echo "missing $item" >&2; exit 1;; esac
done
outdir=""; profile=""
prev=""
for arg in "$@"; do
  [ "$prev" = "--outdir" ] && outdir="$arg"
  case "$arg" in -env:UserInstallation=file://*) profile="\${arg#-env:UserInstallation=file://}";; esac
  prev="$arg"
done
xcu="$profile/user/registrymodifications.xcu"
/usr/bin/grep -q DisableMacrosExecution "$xcu" || { echo "macros not disabled" >&2; exit 1; }
/usr/bin/grep -q 'Writer/Content/Update' "$xcu" || { echo "links not locked" >&2; exit 1; }
printf '%%PDF-1.4\\n%%fake\\n' > "$outdir/document.pdf"
`;

  it.runIf(hasDocx && onMac)('假 soffice 按预览那组参数写出带 %PDF 头的文件', () => {
    const result = run(DOC, 'out.pdf', [], { EVOWORK_OFFICE_CONVERTER: fakeConverter(ACCEPTING) });
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(readFileSync(join(dir, 'out.pdf')).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(existsSync(join(dir, 'out.docx'))).toBe(false);
    // PDF 是从中间 docx 转的：版式检查在转之前做，结果随成功输出给模型
    expect(JSON.parse(result.stdout)).toHaveProperty('layout_warnings');
  });

  it.runIf(hasDocx && onMac)(
    '**转换时连不了网**：转换器想访问本机 HTTP 服务，一个请求都到不了（K6）',
    async () => {
      let hits = 0;
      const server = createServer((_req, res) => {
        hits += 1;
        res.end('ok');
      });
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
      const port = (server.address() as AddressInfo).port;
      try {
        const script = fakeConverter(
          `/usr/bin/curl -s -m 2 http://127.0.0.1:${port}/leak >/dev/null 2>&1\n${ACCEPTING}`,
        );
        const result = run(DOC, 'out.pdf', [], { EVOWORK_OFFICE_CONVERTER: script });
        expect(result.status, result.stderr).toBe(EXIT.ok);
        // 对照：不经隔离直接连，服务是通的 —— 所以上面的 0 是隔离挡的，不是服务没起来
        // 异步发：同步调用会堵住本进程的事件循环，服务就没法应答
        await new Promise((done) =>
          execFile('/usr/bin/curl', ['-s', '-m', '2', `http://127.0.0.1:${port}/control`], done),
        );
        await new Promise((done) => setTimeout(done, 300));
        expect(hits).toBe(1);
      } finally {
        server.close();
      }
    },
  );

  it.runIf(hasDocx && onMac)(
    '已经在内核的沙箱里（默认档）套不上第二层时，在那一层里照常转换',
    () => {
      const result = spawnSync(
        '/usr/bin/sandbox-exec',
        [
          '-p',
          '(version 1)(allow default)(deny network*)',
          'python3',
          RENDER,
          '--content',
          writeContent(dir, DOC),
          '--out',
          join(dir, 'nested.pdf'),
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, EVOWORK_OFFICE_CONVERTER: fakeConverter(ACCEPTING) },
        },
      );
      expect(result.status, result.stderr).toBe(EXIT.ok);
      expect(readFileSync(join(dir, 'nested.pdf')).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    },
  );

  it.runIf(hasDocx && !onMac)('还没有隔离手段的平台上拒绝转换，不裸跑转换器、不落盘', () => {
    const result = run(DOC, 'out.pdf', [], { EVOWORK_OFFICE_CONVERTER: fakeConverter(ACCEPTING) });
    expect(result.status).toBe(EXIT.runtimeMissing);
    expect(parseFailure(result.stderr).message).toContain('隔离');
    expect(existsSync(join(dir, 'out.pdf'))).toBe(false);
  });

  it.runIf(hasDocx && onMac)(
    '转换程序失败时不留下 PDF，退出码是「转换失败」而不是「缺运行时」',
    () => {
      const script = fakeConverter('echo "converter failed" >&2\nexit 1');
      const result = run(DOC, 'out.pdf', [], { EVOWORK_OFFICE_CONVERTER: script });
      expect(result.status).toBe(EXIT.conversionFailed);
      expect(existsSync(join(dir, 'out.pdf'))).toBe(false);
      expect(existsSync(join(dir, 'out.docx'))).toBe(false);
    },
  );

  it.runIf(hasDocx && onMac)('转换结果没有 PDF 头时不把文件留下', () => {
    const script = fakeConverter(`
prev=""; outdir=""
for arg in "$@"; do [ "$prev" = "--outdir" ] && outdir="$arg"; prev="$arg"; done
printf 'PK not a pdf' > "$outdir/document.pdf"
`);
    const result = run(DOC, 'out.pdf', [], { EVOWORK_OFFICE_CONVERTER: script });
    expect(result.status).toBe(EXIT.conversionFailed);
    expect(parseFailure(result.stderr).message).toContain('不是 PDF');
    expect(existsSync(join(dir, 'out.pdf'))).toBe(false);
  });
});

describe('装了办公扩展时真的产出 docx', () => {
  it.runIf(hasDocx)('产出的是 zip 容器（docx 的真实形状），且目录域写进去了', () => {
    const out = join(dir, 'doc.docx');
    expect(run(DOC, 'doc.docx').status).toBe(EXIT.ok);
    expect(readFileSync(out).subarray(0, 2).toString('latin1')).toBe('PK');

    const xml = readDocumentXml(out);
    // TOC 是一个域（field），不是一段文字 —— 这正是要在文档里跟用户解释的那件事
    expect(xml).toContain('TOC');
    expect(xml).toContain('F9');
  });

  // 目录域的 `\u` 开关按大纲级别收条目。只写直接格式化的标题不带大纲级别，
  // 结果就是用户按了 F9 目录仍然是空的 —— 生成时不报错，只有打开文档才发现
  it.runIf(hasDocx)('每个标题都带大纲级别（否则目录域按 F9 也刷不出内容）', () => {
    const out = join(dir, 'outline.docx');
    expect(run(DOC, 'outline.docx').status).toBe(EXIT.ok);

    const xml = readDocumentXml(out);
    const levels = [...xml.matchAll(/<w:outlineLvl w:val="(\d+)"\/>/g)].map((m) => Number(m[1]));
    // DOC 里两个标题：h1「总体情况」→ 0，h2「下一步」→ 1；"目录" 这个标签不算标题
    expect(levels).toEqual([0, 1]);
  });
});

describe('纸张默认是 A4（2026-09-28 外部验收 A1）', () => {
  /*
   * python-docx 的空白模板是**美式 Letter**（12240×15840 twip）。技能只设了页边距，
   * 于是渲染出来的每一份文档都是 Letter —— 验收 A1 明确要求 A4，照着技能做就错了，
   * 而在 Word 里不看「布局 → 纸张大小」根本发现不了。
   */
  it.runIf(hasDocx)('三个模板渲染出来都是 A4 竖版', () => {
    for (const template of ['report', 'memo', 'minimal']) {
      const out = join(dir, `${template}.docx`);
      expect(run({ ...DOC, template }, `${template}.docx`).status).toBe(EXIT.ok);
      const size = readDocumentXml(out).match(/<w:pgSz[^>]*w:w="(\d+)"[^>]*w:h="(\d+)"/);
      expect(size, template).not.toBeNull();
      // A4 = 11906 × 16838 twip；换算有一两个 twip 的舍入
      expect(Math.abs(Number(size![1]) - 11906), template).toBeLessThanOrEqual(2);
      expect(Math.abs(Number(size![2]) - 16838), template).toBeLessThanOrEqual(2);
    }
  });
});

describe('改已有文件：提取成内容 JSON', () => {
  it('md 往返保留标题、层级、表格和分页', () => {
    const source = { ...DOC, template: 'memo', author: '财务部', date: '2026-09-05' };
    expect(run(source, 'out.md').status).toBe(EXIT.ok);
    const extracted = runPython(RENDER, [
      '--extract',
      join(dir, 'out.md'),
      '--out',
      join(dir, 'back.json'),
    ]);
    expect(extracted.status, extracted.stderr).toBe(EXIT.ok);
    const content = JSON.parse(readFileSync(join(dir, 'back.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(content.template).toBe('memo');
    expect(content.title).toBe(DOC.title);
    expect(content.author).toBe('财务部');
    expect(content.date).toBe('2026-09-05');
    expect(content.toc).toBe(true);
    expect(content.blocks).toEqual(DOC.blocks);
  });

  it('找不到文件时退出码 2，且不报堆栈', () => {
    const result = runPython(RENDER, [
      '--extract',
      join(dir, 'missing.md'),
      '--out',
      join(dir, 'back.json'),
    ]);
    expect(result.status).toBe(EXIT.invalidContent);
    expect(result.stderr).not.toContain('Traceback');
    expect(parseFailure(result.stderr).message).toContain('missing.md');
  });

  it.runIf(hasDocx)('docx 往返保留模板、大纲、列表和表格', () => {
    const source = {
      template: 'memo',
      title: '周报',
      author: '财务部',
      date: '2026-09-05',
      blocks: [
        { block: 'heading', level: 1, text: '本期' },
        { block: 'paragraph', text: '营收同比增长 18%。' },
        { block: 'bullets', items: ['A 线', 'B 线'] },
        { block: 'table', header: ['产品线', '营收'], rows: [['A 线', '1,240 万']] },
        { block: 'pagebreak' },
        { block: 'heading', level: 2, text: '下周' },
      ],
    };
    expect(run(source, 'note.docx').status).toBe(EXIT.ok);
    const extracted = runPython(RENDER, [
      '--extract',
      join(dir, 'note.docx'),
      '--out',
      join(dir, 'note.json'),
    ]);
    expect(extracted.status, extracted.stderr).toBe(EXIT.ok);
    const content = JSON.parse(readFileSync(join(dir, 'note.json'), 'utf8')) as {
      template: string;
      blocks: unknown;
    };
    expect(content.template).toBe('memo');
    expect(content.blocks).toEqual(source.blocks);
  });

  it('没装办公扩展时提取 docx 给出安装提示', () => {
    writeFileSync(join(dir, 'x.docx'), 'not-a-docx');
    const result = runPython(
      RENDER,
      ['--extract', join(dir, 'x.docx'), '--out', join(dir, 'x.json')],
      WITHOUT_OFFICE_RUNTIME,
    );
    expect(result.status).toBe(EXIT.runtimeMissing);
    expect(parseFailure(result.stderr).message).toContain('办公扩展');
    expect(result.stderr).not.toContain('Traceback');
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

// ─────────────────────────── 提取：别人做的文件 ───────────────────────────
//
// 2026-10-22 修提取时补的。夹具**不经本技能渲染**，用 python-docx 直接造、按 Word / WPS
// 实际写出的 XML 形状拼 —— 只拿自己渲染的文件做往返测试，测的只是「我们认得自己」。

const SHARED_DIR = join(SKILL_ROOT, '..', '_shared');
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const DOCX_PRELUDE = String.raw`
import base64, sys
sys.path.insert(0, ${JSON.stringify(SHARED_DIR)})
import evowork_skill
evowork_skill.ensure_office_runtime(("docx",))
import docx
from docx.oxml import parse_xml
OUT = sys.argv[1]
W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
PNG = base64.b64decode("${PNG_1PX}")
doc = docx.Document()

def block(xml):
    anchor = doc.add_paragraph()._p
    anchor.addnext(parse_xml(xml))
    anchor.getparent().remove(anchor)
`;

/** 用 python-docx 造一份 docx。缺模块时与技能一样换到办公扩展的解释器。 */
function buildDocx(name: string, body: string): string {
  const out = join(dir, name);
  const script = join(dir, `build-${name}.py`);
  writeFileSync(script, `${DOCX_PRELUDE}\n${body}\ndoc.save(OUT)\n`, 'utf8');
  const result = spawnSync('python3', [script, out], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return out;
}

interface Extracted {
  readonly title: string;
  readonly subtitle?: string;
  readonly author?: string;
  readonly date?: string;
  readonly toc?: boolean;
  readonly blocks: Record<string, unknown>[];
}

function extract(source: string, extra: readonly string[] = [], out = join(dir, 'out.json')) {
  const result = runPython(RENDER, ['--extract', source, '--out', out, ...extra]);
  const ok = result.status === EXIT.ok;
  const content = ok ? (JSON.parse(readFileSync(out, 'utf8')) as Extracted) : undefined;
  const dropped = ok
    ? ((JSON.parse(result.stdout) as { dropped?: Record<string, number> }).dropped ?? {})
    : undefined;
  return { result, content, dropped };
}

describe('提取 docx：别人做的文件', () => {
  it.runIf(hasDocx)('内容控件（w:sdt）里的正文收回来，块级和行内的都算', () => {
    const source = buildDocx(
      'controls.docx',
      String.raw`
doc.add_paragraph("前言")
block(f'<w:sdt {W}><w:sdtPr><w:alias w:val="正文"/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>控件里的第一段</w:t></w:r></w:p><w:p><w:r><w:t>控件里的第二段</w:t></w:r></w:p></w:sdtContent></w:sdt>')
p = doc.add_paragraph("填写人：")
p._p.append(parse_xml(f'<w:sdt {W}><w:sdtContent><w:r><w:t>张三</w:t></w:r></w:sdtContent></w:sdt>'))
`,
    );
    const { result, content } = extract(source);
    // 没有收不回的东西：不需要 --allow-lossy
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(content?.blocks).toEqual([
      { block: 'paragraph', text: '前言' },
      { block: 'paragraph', text: '控件里的第一段' },
      { block: 'paragraph', text: '控件里的第二段' },
      { block: 'paragraph', text: '填写人：张三' },
    ]);
  });

  it.runIf(hasDocx)('页眉页脚、文本框、脚注、批注收不回来 → 默认停下并逐类说出来，不静默丢', () => {
    const source = buildDocx(
      'extras.docx',
      String.raw`
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.opc.packuri import PackURI
from docx.opc.part import XmlPart

doc.sections[0].header.paragraphs[0].text = "内部资料 请勿外传"
first = doc.add_paragraph("正文第一段")
doc.add_comment(first.runs, text="这里的数字要再核对", author="审阅人")

NS = W + ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml"'
box = '<w:txbxContent><w:p><w:r><w:t>文本框里的说明</w:t></w:r></w:p></w:txbxContent>'
second = doc.add_paragraph("正文第二段")
second._p.append(parse_xml(f'<w:r {NS}><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:inline><wp:extent cx="1828800" cy="457200"/><wp:docPr id="10" name="文本框 1"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:spPr/><wps:txbx>{box}</wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox>{box}</v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r>'))

notes = parse_xml(f'<w:footnotes {W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>数据来自 2026 年报</w:t></w:r></w:p></w:footnote></w:footnotes>')
part = XmlPart(PackURI("/word/footnotes.xml"), "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml", notes, doc.part.package)
doc.part.relate_to(part, RT.FOOTNOTES)
third = doc.add_paragraph("正文第三段")
third._p.append(parse_xml(f'<w:r {W}><w:footnoteReference w:id="1"/></w:r>'))
`,
    );

    const refused = extract(source);
    expect(refused.result.status).toBe(EXIT.invalidContent);
    const { message } = parseFailure(refused.result.stderr);
    for (const kind of ['页眉页脚 1 处', '文本框 1 处', '脚注 1 处', '批注 1 处']) {
      expect(message).toContain(kind);
    }
    expect(existsSync(join(dir, 'out.json'))).toBe(false);

    const allowed = extract(source, ['--allow-lossy']);
    expect(allowed.result.status, allowed.result.stderr).toBe(EXIT.ok);
    expect(allowed.dropped).toEqual({ 页眉页脚: 1, 文本框: 1, 脚注: 1, 批注: 1 });
    // 文本框的字是报出来的，不是混进正文：Choice 与 Fallback 是同一个框的两种写法，也不重复计数
    expect(allowed.content?.blocks).toEqual([
      { block: 'paragraph', text: '正文第一段' },
      { block: 'paragraph', text: '正文第二段' },
      { block: 'paragraph', text: '正文第三段' },
    ]);
  });

  it.runIf(hasDocx)('目录域跨好几段（WPS 的写法）与目录控件（Word 的写法）都收回 toc', () => {
    const bare = buildDocx(
      'toc-field.docx',
      String.raw`
doc.add_paragraph("目录")
block(rf'<w:p {W}><w:pPr><w:pStyle w:val="TOC1"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \o "1-3" </w:instrText></w:r><w:r><w:instrText xml:space="preserve">\h \z \u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>第一章 总则</w:t></w:r><w:r><w:tab/><w:t>1</w:t></w:r></w:p>')
block(rf'<w:p {W}><w:pPr><w:pStyle w:val="TOC2"/></w:pPr><w:r><w:t>1.1 适用范围</w:t></w:r><w:r><w:tab/><w:t>2</w:t></w:r></w:p>')
block(rf'<w:p {W}><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>')
doc.add_heading("第一章 总则", 1)
doc.add_paragraph("正文。")
`,
    );
    const wrapped = buildDocx(
      'toc-control.docx',
      String.raw`
block(rf'<w:sdt {W}><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent><w:p><w:pPr><w:pStyle w:val="TOCHeading"/></w:pPr><w:r><w:t>目录</w:t></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \o "1-3" \h \z \u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>第一章 总则</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:sdtContent></w:sdt>')
doc.add_heading("第一章 总则", 1)
doc.add_paragraph("正文。")
`,
    );
    for (const source of [bare, wrapped]) {
      const { result, content } = extract(source);
      expect(result.status, result.stderr).toBe(EXIT.ok);
      expect(content?.toc, source).toBe(true);
      // 目录条目与「目录」两个字都不进正文 —— 重新渲染时目录由域重新生成
      expect(content?.blocks, source).toEqual([
        { block: 'heading', level: 1, text: '第一章 总则' },
        { block: 'paragraph', text: '正文。' },
      ]);
    }
  });

  it.runIf(hasDocx)('工具栏做的列表（列表段落 + 编号）按编号格式分有序 / 无序', () => {
    const source = buildDocx(
      'lists.docx',
      String.raw`
numbering = doc.part.numbering_part.element
def abstract(ident, fmt0, fmt1):
    return parse_xml(f'<w:abstractNum {W} w:abstractNumId="{ident}"><w:multiLevelType w:val="hybridMultilevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="{fmt0}"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="{fmt1}"/><w:lvlText w:val="%2)"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>')
numbering.insert(0, abstract(90, "bullet", "bullet"))
numbering.insert(1, abstract(91, "chineseCounting", "decimal"))
numbering.append(parse_xml(f'<w:num {W} w:numId="90"><w:abstractNumId w:val="90"/></w:num>'))
numbering.append(parse_xml(f'<w:num {W} w:numId="91"><w:abstractNumId w:val="91"/></w:num>'))

def item(text, num, level=0):
    p = doc.add_paragraph(text, style="List Paragraph")
    numPr = p._p.get_or_add_pPr().get_or_add_numPr()
    numPr.get_or_add_ilvl().val = level
    numPr.get_or_add_numId().val = num

doc.add_paragraph("准备材料：")
item("身份证", 90)
item("复印两份", 90, 1)
item("劳动合同", 90)
doc.add_paragraph("办理步骤：")
item("填表", 91)
item("盖章", 91)
`,
    );
    const { result, content, dropped } = extract(source, ['--allow-lossy']);
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(content?.blocks).toEqual([
      { block: 'paragraph', text: '准备材料：' },
      // 二级项并进同一个列表：内容 JSON 的列表只有一层，层级报出来
      { block: 'bullets', items: ['身份证', '复印两份', '劳动合同'] },
      { block: 'paragraph', text: '办理步骤：' },
      // 「一、二、」也是有序列表，不是只有 1. 2. 才算
      { block: 'ordered', items: ['填表', '盖章'] },
    ]);
    expect(dropped).toEqual({ 嵌套列表层级: 1 });
  });

  it.runIf(hasDocx)('WPS 给正文写的 outlineLvl=9 是正文，不是第 10 级标题', () => {
    const source = buildDocx(
      'wps-body.docx',
      String.raw`
doc.add_heading("一、总体情况", 1)
for text in ("本季营收同比增长。", "毛利率回升。"):
    p = doc.add_paragraph(text)
    p._p.get_or_add_pPr().append(parse_xml(f'<w:outlineLvl {W} w:val="9"/>'))
`,
    );
    const { result, content } = extract(source);
    // 之前整份提取以「标题层级超过 4」失败
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(content?.blocks).toEqual([
      { block: 'heading', level: 1, text: '一、总体情况' },
      { block: 'paragraph', text: '本季营收同比增长。' },
      { block: 'paragraph', text: '毛利率回升。' },
    ]);
  });

  it.runIf(hasDocx)('合并单元格的字只出现一次；合并本身收不回，报出来', () => {
    const source = buildDocx(
      'merged.docx',
      String.raw`
table = doc.add_table(rows=4, cols=3)
for r, row in enumerate([["地区", "季度", "销售额"], ["华东", "Q1", "100"], ["", "Q2", "120"], ["合计", "", "220"]]):
    for c, value in enumerate(row):
        table.cell(r, c).text = value
table.cell(1, 0).merge(table.cell(2, 0))
table.cell(3, 0).merge(table.cell(3, 1))

header = doc.add_table(rows=2, cols=2)
for r, row in enumerate([["销售额", ""], ["100", "120"]]):
    for c, value in enumerate(row):
        header.cell(r, c).text = value
header.cell(0, 0).merge(header.cell(0, 1))
`,
    );
    const { result, content, dropped } = extract(source, ['--allow-lossy']);
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(content?.blocks).toEqual([
      {
        block: 'table',
        header: ['地区', '季度', '销售额'],
        // 「华东」纵向合并了两行、「合计」横向合并了两列：之前各出现两遍，重新渲染就是两个华东
        rows: [
          ['华东', 'Q1', '100'],
          [null, 'Q2', '120'],
          ['合计', null, '220'],
        ],
      },
      // 表头每列都要有字（schema），合并留下的空位只能占位 —— 占位也报出来
      { block: 'table', header: ['销售额', '—'], rows: [['100', '120']] },
    ]);
    expect(dropped).toEqual({ 合并单元格: 3, 表头空白格: 1 });
  });

  it.runIf(hasDocx)('没有核心属性标题时用「标题」样式的那一段，而不是文件名', () => {
    const source = buildDocx(
      'annual.docx',
      String.raw`
doc.add_paragraph("2026 年度总结", style="Title")
doc.add_paragraph("今年做了三件事。")
`,
    );
    const { result, content } = extract(source);
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(content?.title).toBe('2026 年度总结');
    // 标题那一段不再重复成正文
    expect(content?.blocks).toEqual([{ block: 'paragraph', text: '今年做了三件事。' }]);
  });

  it.runIf(hasDocx)('引用、表题、图题收成 quote 与 caption；找不到表或图的题注报出来', () => {
    const source = buildDocx(
      'captions.docx',
      String.raw`
import io
doc.add_paragraph("引言：")
doc.add_paragraph("千里之行，始于足下。", style="Quote")
doc.add_paragraph("表 1 各区销售额", style="Caption")
table = doc.add_table(rows=2, cols=2)
for r, row in enumerate([["地区", "销售额"], ["华东", "100"]]):
    for c, value in enumerate(row):
        table.cell(r, c).text = value
doc.add_picture(io.BytesIO(PNG))
doc.add_paragraph("图 1 销售趋势", style="Caption")
doc.add_paragraph("注：数据未经审计", style="Caption")
doc.add_paragraph("结尾。")
`,
    );
    const { result, content, dropped } = extract(source, ['--allow-lossy']);
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(content?.blocks).toEqual([
      { block: 'paragraph', text: '引言：' },
      { block: 'quote', text: '千里之行，始于足下。' },
      // 中文习惯表题在表上、图题在图下：两种位置都认
      {
        block: 'table',
        header: ['地区', '销售额'],
        rows: [['华东', '100']],
        caption: '表 1 各区销售额',
      },
      { block: 'image', path: 'extracted-media/image-1.png', caption: '图 1 销售趋势' },
      { block: 'paragraph', text: '注：数据未经审计' },
      { block: 'paragraph', text: '结尾。' },
    ]);
    expect(dropped).toEqual({ 题注: 1 });
  });

  it.runIf(hasDocx)('**不覆盖** extracted-media 里已有的图，新图换一个名字', () => {
    const source = buildDocx('picture.docx', 'import io\ndoc.add_picture(io.BytesIO(PNG))');
    mkdirSync(join(dir, 'extracted-media'));
    writeFileSync(join(dir, 'extracted-media', 'image-1.png'), 'earlier extraction');
    const { result, content } = extract(source);
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(readFileSync(join(dir, 'extracted-media', 'image-1.png'), 'utf8')).toBe(
      'earlier extraction',
    );
    const path = String(content?.blocks[0]?.path);
    expect(path).not.toBe('extracted-media/image-1.png');
    expect(readFileSync(join(dir, path)).subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it.runIf(hasDocx)('extracted-media 是符号链接时拒绝，链接指向的目录里什么都不写', () => {
    const source = buildDocx('picture.docx', 'import io\ndoc.add_picture(io.BytesIO(PNG))');
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dir, 'extracted-media'));
    const { result } = extract(source);
    expect(result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(result.stderr).message).toContain('符号链接');
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });
});

describe('提取 docx：我们自己渲染的文件往返不丢', () => {
  it.runIf(hasDocx)('目录、引用与出处、表题、图题都原样回来', () => {
    writeFileSync(join(dir, 'chart.png'), Buffer.from(PNG_1PX, 'base64'));
    const source = {
      template: 'report',
      title: '季度报告',
      toc: true,
      blocks: [
        { block: 'heading', level: 1, text: '概况' },
        { block: 'quote', text: '数据是最好的证据。', cite: '财务部' },
        {
          block: 'table',
          header: ['地区', '销售额'],
          rows: [['华东', '100']],
          caption: '表 1 各区销售额',
        },
        { block: 'image', path: 'chart.png', caption: '图 1 销售趋势' },
        { block: 'paragraph', text: '结论。' },
      ],
    };
    expect(run(source, 'report.docx').status).toBe(EXIT.ok);
    const { result, content } = extract(join(dir, 'report.docx'));
    // report 模板的页眉写的是标题、页脚是页码域：模板会重新生成，不算收不回
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(content?.toc).toBe(true);
    expect(content?.blocks).toEqual(
      source.blocks.map((block) =>
        block.block === 'image' ? { ...block, path: 'extracted-media/image-1.png' } : block,
      ),
    );
  });
});

describe('提取 Markdown：普通的 md 文件', () => {
  function writeMd(text: string, name = 'note.md'): string {
    const path = join(dir, name);
    writeFileSync(path, text, 'utf8');
    return path;
  }

  it('表格的对齐行（|:---|）不是数据行', () => {
    const { result, content } = extract(writeMd('# 表\n\n| 列 | 值 |\n|:---|---:|\n| a | 1 |\n'));
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(content?.blocks).toEqual([{ block: 'table', header: ['列', '值'], rows: [['a', '1']] }]);
  });

  it('标题后第一段带「 · 」也是正文，不被当成作者和日期吞掉', () => {
    const { result, content } = extract(
      writeMd('# 方案\n\n甲 · 乙 两种方案对比如下。\n\n正文。\n'),
    );
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(content?.author).toBeUndefined();
    expect(content?.date).toBeUndefined();
    expect(content?.blocks[0]).toEqual({ block: 'paragraph', text: '甲 · 乙 两种方案对比如下。' });
  });

  it('* 列表、嵌套列表、代码块各归各位；代码块里的 # 注释不是标题', () => {
    const md = [
      '# 清单',
      '',
      '* 苹果',
      '* 香蕉',
      '  - 小米蕉',
      '* 橙子',
      '',
      '说明。',
      '',
      '```python',
      '# 这是注释',
      'print("hi")',
      '```',
      '',
    ].join('\n');
    const { result, content, dropped } = extract(writeMd(md), ['--allow-lossy']);
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(content?.blocks).toEqual([
      { block: 'bullets', items: ['苹果', '香蕉', '小米蕉', '橙子'] },
      { block: 'paragraph', text: '说明。' },
      // 代码块连同围栏原样留成一段：写回 md 还是代码块
      { block: 'paragraph', text: '```python\n# 这是注释\nprint("hi")\n```' },
    ]);
    expect(dropped).toEqual({ 嵌套列表层级: 1 });
  });

  it('第二个 h1 与六级标题报出真实原因，而不是「超过 4 级」一刀切地失败', () => {
    const md = '# 标题\n\n## 一\n\n#话题 不是标题\n\n# 第二个一级\n\n###### 六级\n';
    const refused = extract(writeMd(md));
    expect(refused.result.status).toBe(EXIT.invalidContent);
    expect(parseFailure(refused.result.stderr).message).toContain('多余的一级标题 1 处');

    const { result, content, dropped } = extract(writeMd(md), ['--allow-lossy']);
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(content?.blocks).toEqual([
      { block: 'heading', level: 1, text: '一' },
      { block: 'paragraph', text: '#话题 不是标题' },
      { block: 'heading', level: 1, text: '第二个一级' },
      { block: 'paragraph', text: '六级' },
    ]);
    expect(dropped).toEqual({ 多余的一级标题: 1, '超过 4 级的标题': 1 });
  });

  it('往返：表题（隔一个空行）、开头的引用、只有作者没有日期都不变形', () => {
    const source = {
      title: '周报',
      author: '财务部',
      blocks: [
        { block: 'quote', text: '先说结论。' },
        { block: 'table', header: ['项', '值'], rows: [['a|b', '1']], caption: '表 1 明细' },
        { block: 'paragraph', text: '结尾。' },
      ],
    };
    expect(run(source, 'weekly.md').status).toBe(EXIT.ok);
    const { result, content } = extract(join(dir, 'weekly.md'));
    expect(result.status, result.stderr).toBe(EXIT.ok);
    // 开头的引用之前会被当成副标题，表题会变成一段「*表 1 明细*」
    expect(content).toEqual(source);
  });

  it('图片按 .md 所在目录解析并写成绝对路径；目录树之外的图不收，报出来', () => {
    const docDir = join(dir, 'doc');
    mkdirSync(join(docDir, 'img'), { recursive: true });
    writeFileSync(join(docDir, 'img', 'chart.png'), Buffer.from(PNG_1PX, 'base64'));
    writeFileSync(join(dir, 'secret.png'), 'not for the document');
    // 树里的符号链接指向树外：按真实位置判
    symlinkSync(join(dir, 'secret.png'), join(docDir, 'img', 'link.png'));
    const md = [
      '# 笔记',
      '',
      '![趋势](img/chart.png)',
      '',
      '![](../secret.png)',
      '',
      '![](img/link.png)',
      '',
      `![](${join(dir, 'secret.png')})`,
      '',
    ].join('\n');
    const source = writeMd(md, join('doc', 'note.md'));
    // 内容 JSON 写进别的目录（中间文件放临时目录是规矩）
    const out = join(dir, 'tmp', 'note.json');

    const refused = extract(source, [], out);
    expect(refused.result.status).toBe(EXIT.invalidContent);
    const { message } = parseFailure(refused.result.stderr);
    expect(message).toContain('目录外的图片 3 处');
    expect(message).not.toContain('charts');

    const { result, content, dropped } = extract(source, ['--allow-lossy'], out);
    expect(result.status, result.stderr).toBe(EXIT.ok);
    expect(content?.blocks).toEqual([
      { block: 'image', path: realpathSync(join(docDir, 'img', 'chart.png')), caption: '趋势' },
    ]);
    expect(readFileSync(out, 'utf8')).not.toContain('secret');
    expect(dropped).toEqual({ 目录外的图片: 3 });

    // 写回 .md 旁边时换回相对路径：用户的 md 里不该出现本机目录
    const rendered = runPython(RENDER, ['--content', out, '--out', join(docDir, 'edited.md')]);
    expect(rendered.status, rendered.stderr).toBe(EXIT.ok);
    expect(readFileSync(join(docDir, 'edited.md'), 'utf8')).toContain('![趋势](img/chart.png)');
  });
});
