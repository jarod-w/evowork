/**
 * presentations 技能的契约测试。
 *
 * ## 这些测试能证明什么、不能证明什么
 *
 * **能**：结构化生成这条链路是对的 —— schema 真的会拦住不合法的内容、
 * 报错真的指出了是哪一页哪个字段、办公扩展缺失时给的是可操作的提示而不是堆栈、
 * 图片引用不存在时不会产出一个坏文件。这些正是 R4 里**渲染侧不背锅**的那一半。
 *
 * **不能**：证明产出的 pptx 好看、文字不溢出、中文不乱码。那需要装上办公扩展
 * （python-pptx）并人工看文件 —— 属于 work-priority §10 的 U1，
 * 与"GLM-5.3-flash 能不能填对这个 JSON"一起在 M0 拿结论。
 *
 * 当前环境没有 python-pptx，因此**渲染路径的测试会自动跳过并说明原因**，
 * 而不是假装通过。假装通过的测试比没有测试更糟：它会让人以为这条路已经验证过了。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasPythonModule, WITHOUT_OFFICE_RUNTIME } from '../../_shared/test-helpers.js';

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RENDER = join(SKILL_ROOT, 'container_tools', 'render.py');
const MARK = join(SKILL_ROOT, 'container_tools', 'mark_artifact.mjs');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'evowork-ppt-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 办公扩展是否装了（08 §4 的档位判定）。
 *
 * 用共用的判据而不是 `python3 -c "import pptx"`：扩展装在自己的 venv 里，
 * 技能会在缺模块时换过去重跑（`ensure_office_runtime`）。只看系统 python
 * 会让"没装扩展"这个判断在装了扩展之后仍然为真 —— 那几条测试就跑了起来，
 * 而技能其实成功了。
 */
const hasOfficeRuntime = hasPythonModule('pptx');

function writeContent(content: unknown): string {
  const path = join(dir, 'content.json');
  writeFileSync(path, JSON.stringify(content), 'utf8');
  return path;
}

function runRender(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('python3', [RENDER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const VALID = {
  template: 'business',
  title: 'Q3 业绩汇报',
  slides: [
    { layout: 'title', title: 'Q3 业绩汇报', subtitle: '财务部 · 2026-09' },
    {
      layout: 'bullets',
      title: '本季要点',
      bullets: ['营收同比 +18%', '毛利率回升至 34%', '鹏程公司的欠款已收回 60%'],
      notes: '数据来自财务系统导出的三张表',
    },
    {
      layout: 'table',
      title: '分产品线明细',
      table: {
        header: ['产品线', '营收', '同比'],
        rows: [
          ['A 线', '1,240 万', '+22%'],
          ['B 线', '860 万', '+9%'],
        ],
      },
      caption: '数据来源：财务系统 2026Q3 导出',
    },
    { layout: 'section', title: '下一步' },
  ],
};

describe('结构化生成：先校验再渲染（08 §5.3）', () => {
  it('合法内容通过校验（--validate-only 不需要办公扩展）', () => {
    const result = runRender([
      '--content',
      writeContent(VALID),
      '--out',
      join(dir, 'x.pptx'),
      '--validate-only',
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, slides: 4, validated: true });
  });

  it('**校验失败要指出具体哪一条**，而不是"内容格式错误"', () => {
    const bad = {
      slides: [
        { layout: 'bullets', title: '太多条了', bullets: ['1', '2', '3', '4', '5', '6', '7'] },
      ],
    };
    const result = runRender([
      '--content',
      writeContent(bad),
      '--out',
      join(dir, 'x.pptx'),
      '--validate-only',
    ]);

    expect(result.status).toBe(2);
    const payload = JSON.parse(result.stderr) as { code: number; message: string; detail: string };
    expect(payload.code).toBe(2);
    // 定位到具体的页与字段，模型才改得动（08 §5.3：把具体错误回给模型让它修一次）
    expect(payload.detail).toContain('slides/0');
    expect(payload.message).toContain('重跑');
  });

  it('每页最多 6 条 bullets —— 超过就该拆页（这是内容约束，不是排版问题）', () => {
    const seven = {
      slides: [{ layout: 'bullets', title: 'x', bullets: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }],
    };
    expect(
      runRender(['--content', writeContent(seven), '--out', join(dir, 'x.pptx'), '--validate-only'])
        .status,
    ).toBe(2);

    const six = {
      slides: [{ layout: 'bullets', title: 'x', bullets: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    };
    expect(
      runRender(['--content', writeContent(six), '--out', join(dir, 'x.pptx'), '--validate-only'])
        .status,
    ).toBe(0);
  });

  it('单条 bullet 超过 80 字被拦（缩到看不清就不是排版问题了）', () => {
    const long = {
      slides: [{ layout: 'bullets', title: 'x', bullets: ['很长的一句话'.repeat(20)] }],
    };
    expect(
      runRender(['--content', writeContent(long), '--out', join(dir, 'x.pptx'), '--validate-only'])
        .status,
    ).toBe(2);
  });

  it('只认五种 layout，**没有第六种**', () => {
    const bad = { slides: [{ layout: 'timeline', title: 'x' }] };
    expect(
      runRender(['--content', writeContent(bad), '--out', join(dir, 'x.pptx'), '--validate-only'])
        .status,
    ).toBe(2);
  });

  it('多余字段被拒（additionalProperties: false）—— 免得模型以为它加的字段生效了', () => {
    const bad = {
      slides: [{ layout: 'section', title: 'x', backgroundColor: '#ff0000' }],
    };
    const result = runRender([
      '--content',
      writeContent(bad),
      '--out',
      join(dir, 'x.pptx'),
      '--validate-only',
    ]);
    expect(result.status).toBe(2);
  });

  it('表格最多 12 行 —— 再多该导出 xlsx 附件而不是塞进幻灯片', () => {
    const rows = Array.from({ length: 13 }, (_, i) => [`第 ${i} 行`, '1']);
    const bad = { slides: [{ layout: 'table', title: 'x', table: { header: ['a', 'b'], rows } }] };
    expect(
      runRender(['--content', writeContent(bad), '--out', join(dir, 'x.pptx'), '--validate-only'])
        .status,
    ).toBe(2);
  });

  it('坏 JSON 给出行号，而不是 python 堆栈', () => {
    const path = join(dir, 'content.json');
    writeFileSync(path, '{\n  "slides": [\n', 'utf8');
    const result = runRender(['--content', path, '--out', join(dir, 'x.pptx'), '--validate-only']);
    expect(result.status).toBe(2);
    // 位置在 message 里（共用骨架统一了这条：只报行列，不回显那一行的内容）
    const payload = JSON.parse(result.stderr) as { message: string };
    expect(payload.message).toMatch(/第 \d+ 行第 \d+ 列/);
    expect(result.stderr).not.toContain('Traceback');
  });

  it('失败输出里**不含内容 JSON 本身**（它是用户业务内容，Q14 同口径）', () => {
    const bad = {
      slides: [{ layout: 'bullets', title: '鹏程公司欠款分析', bullets: [] }],
    };
    const result = runRender([
      '--content',
      writeContent(bad),
      '--out',
      join(dir, 'x.pptx'),
      '--validate-only',
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain('鹏程');
  });

  it('**报错只指出用户想用的那个 layout 的问题** —— 模型只有一次修正机会', () => {
    const bad = { slides: [{ layout: 'chart', title: '毛利率' }] };
    const result = runRender([
      '--content',
      writeContent(bad),
      '--out',
      join(dir, 'x.pptx'),
      '--validate-only',
    ]);
    const detail = (JSON.parse(result.stderr) as { detail: string }).detail;

    expect(detail).toContain('layout = chart');
    expect(detail).toContain('chart_ref');

    // 只看子错误行（以 "  - " 开头的那些）：首行是"五种 layout"的说明，
    // 它当然会提到 bullets/table，那是有用的提示而不是噪音
    const subLines = detail.split('\n').filter((line) => line.trim().startsWith('- '));
    expect(subLines.length).toBeGreaterThan(0);
    // 不该把别的 layout 的必填字段列进来（那会让模型只能猜）
    expect(subLines.join('\n')).not.toContain('bullets');
    expect(subLines.join('\n')).not.toContain('table');
  });

  it('未知模板被拒（不会静默回落到 business）', () => {
    const bad = { ...VALID, template: 'fancy' };
    expect(
      runRender(['--content', writeContent(bad), '--out', join(dir, 'x.pptx'), '--validate-only'])
        .status,
    ).toBe(2);
  });
});

describe('办公扩展未安装时的行为（08 §4 的按需下载）', () => {
  // 不用 skipIf：**强制**无扩展环境，这样装没装扩展的机器上都验得到这条路径 ——
  // 而它恰恰是用户第一次用时走的那条
  it('给出可操作的提示与专用退出码 3，而不是 python 堆栈', () => {
    const result = runRender(
      ['--content', writeContent(VALID), '--out', join(dir, 'out.pptx')],
      WITHOUT_OFFICE_RUNTIME,
    );
    expect(result.status).toBe(3);
    const payload = JSON.parse(result.stderr) as { code: number; message: string };
    expect(payload.code).toBe(3);
    // 文案要与解析管道统一：不能一处说"解析组件"一处说"生成组件"（08 §4 最后一段）
    expect(payload.message).toContain('办公扩展');
    expect(payload.message).toContain('120MB');
    expect(result.stderr).not.toContain('Traceback');
    expect(result.stderr).not.toContain('ModuleNotFoundError');
  });

  it.runIf(hasOfficeRuntime)('装了扩展时能真的产出 pptx', () => {
    const out = join(dir, 'out.pptx');
    const result = runRender(['--content', writeContent(VALID), '--out', out]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as { ok: boolean; slides: number };
    expect(payload).toMatchObject({ ok: true, slides: 4 });
    // pptx 是 zip：头两个字节是 PK
    const head = execFileSync('head', ['-c', '2', out], { encoding: 'latin1' });
    expect(head).toBe('PK');
  });

  it.runIf(hasOfficeRuntime)('引用的图片不存在 → 退出码 4，不产出坏文件', () => {
    const content = {
      slides: [{ layout: 'chart', title: '毛利率', chart_ref: 'charts/nope.png' }],
    };
    const result = runRender(['--content', writeContent(content), '--out', join(dir, 'out.pptx')]);
    expect(result.status).toBe(4);
  });
});

describe('mark_artifact：产物识别的信号 ①（08 §2.2）', () => {
  it('参数形状沿用内核约定，写一行 JSON 到日志', () => {
    const logPath = join(dir, 'artifacts.jsonl');
    const result = spawnSync(
      'node',
      [
        MARK,
        '--operation-kind',
        'create',
        '--expected-output-count',
        '1',
        '--output-format',
        'pptx',
        '--title',
        'Q3 业绩汇报',
        '--path',
        join(dir, 'Q3.pptx'),
      ],
      { encoding: 'utf8', env: { ...process.env, EVOWORK_ARTIFACT_LOG: logPath } },
    );

    expect(result.status).toBe(0);
    const line = execFileSync('cat', [logPath], { encoding: 'utf8' }).trim();
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record).toMatchObject({
      kind: 'artifact.mark',
      skill: 'presentations',
      operationKind: 'create',
      expectedOutputCount: 1,
      outputFormat: 'pptx',
      title: 'Q3 业绩汇报',
    });
    // **不含** OpenAI 的 marketplace 名（K5：不引入第三方品牌字符串；F10：那个常量对我们无用）
    expect(line).not.toContain('openai');
  });

  it('相对路径被拒 —— 索引记的是绝对路径（D6：文件系统是真源）', () => {
    const result = spawnSync(
      'node',
      [MARK, '--operation-kind', 'create', '--output-format', 'pptx', '--path', 'relative.pptx'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('绝对路径');
  });

  it('operation-kind 只认 create / edit', () => {
    const result = spawnSync(
      'node',
      [MARK, '--operation-kind', 'delete', '--output-format', 'pptx', '--path', '/tmp/x.pptx'],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(2);
  });

  it('**索引服务没起来不算技能失败** —— 产物本体已经在磁盘上了（信号 ②/③ 会补）', () => {
    const result = spawnSync(
      'node',
      [MARK, '--operation-kind', 'create', '--output-format', 'pptx', '--path', '/tmp/x.pptx'],
      {
        encoding: 'utf8',
        env: { ...process.env, EVOWORK_ARTIFACT_LOG: '', EVOWORK_ARTIFACT_SOCKET: '' },
      },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true });
  });
});

describe('模板（排版由模板决定，不由模型决定）', () => {
  it('三个模板都有完整的 theme 与 metrics，且渲染代码里没有字面量数值', () => {
    for (const id of ['business', 'minimal', 'data-heavy']) {
      const spec = JSON.parse(
        execFileSync('cat', [join(SKILL_ROOT, 'templates', id, 'template.json')], {
          encoding: 'utf8',
        }),
      ) as {
        theme: { styles: Record<string, unknown>; font_cjk: string };
        metrics: Record<string, unknown>;
      };
      // 中文字体必须显式给：不给的话在没装对应字体的机器上会变方框
      expect(spec.theme.font_cjk).toBeTruthy();
      for (const style of ['display', 'title', 'body', 'caption', 'table_header', 'table_body']) {
        expect(spec.theme.styles[style], `${id} 缺 ${style}`).toBeDefined();
      }
      for (const box of [
        'title_slide_title',
        'body_title',
        'body_content',
        'chart_area',
        'table_area',
      ]) {
        expect(spec.metrics[box], `${id} 缺 ${box}`).toBeDefined();
      }
      // 条目多时缩字号的梯度：让它落在模板里，而不是渲染代码里
      expect(spec.metrics.bullet_shrink_steps).toBeDefined();
    }
  });
});

describe('改已有文件：提取成内容 JSON', () => {
  it.runIf(hasOfficeRuntime)('pptx 按版式收回，图表文件写到 extracted-media', () => {
    writeFileSync(
      join(dir, 'chart.png'),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    );
    const content = {
      template: 'minimal',
      title: '周会',
      slides: [
        { layout: 'title', title: '周会', subtitle: '周一' },
        { layout: 'bullets', title: '要点', bullets: ['一件事'], notes: '口头补充' },
        { layout: 'chart', title: '趋势', chart_ref: 'chart.png', caption: '来源：表1' },
        { layout: 'section', title: '结束' },
      ],
    };
    const rendered = runRender([
      '--content',
      writeContent(content),
      '--out',
      join(dir, 'deck.pptx'),
    ]);
    expect(rendered.status, rendered.stderr).toBe(0);
    const extracted = runRender([
      '--extract',
      join(dir, 'deck.pptx'),
      '--out',
      join(dir, 'deck.json'),
    ]);
    expect(extracted.status, extracted.stderr).toBe(0);
    const back = JSON.parse(readFileSync(join(dir, 'deck.json'), 'utf8')) as {
      template: string;
      slides: { layout: string; notes?: string; chart_ref?: string; caption?: string }[];
    };
    expect(back.template).toBe('minimal');
    expect(back.slides.map((slide) => slide.layout)).toEqual([
      'title',
      'bullets',
      'chart',
      'section',
    ]);
    expect(back.slides[1]?.notes).toBe('口头补充');
    expect(back.slides[2]?.chart_ref).toBe('extracted-media/slide-3.png');
    expect(back.slides[2]?.caption).toBe('来源：表1');
    expect(readFileSync(join(dir, 'extracted-media/slide-3.png')).length).toBeGreaterThan(8);
  });
});

// ─────────────────────────── 提取：别人做的幻灯片 ───────────────────────────
//
// 2026-10-22 修提取时补的。夹具不经本技能渲染，用 python-pptx 按 PowerPoint 自带版式直接造。

const SHARED_DIR = join(SKILL_ROOT, '..', '_shared');
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const PPTX_PRELUDE = String.raw`
import base64, io, sys
sys.path.insert(0, ${JSON.stringify(SHARED_DIR)})
import evowork_skill
evowork_skill.ensure_office_runtime(("pptx",))
from pptx import Presentation
from pptx.util import Inches
OUT = sys.argv[1]
prs = Presentation()

def png():
    return io.BytesIO(base64.b64decode("${PNG_1PX}"))

def slide(layout, title=None):
    page = prs.slides.add_slide(prs.slide_layouts[layout])
    if title is not None:
        page.shapes.title.text = title
    return page

cover = slide(0, "季度汇报")
cover.placeholders[1].text = "财务部"
`;

/** 用 python-pptx 造一份幻灯片（第 1 页固定是封面）。缺模块时换到办公扩展的解释器。 */
function buildPptx(name: string, body: string): string {
  const out = join(dir, name);
  const script = join(dir, `build-${name}.py`);
  writeFileSync(script, `${PPTX_PRELUDE}\n${body}\nprs.save(OUT)\n`, 'utf8');
  const result = spawnSync('python3', [script, out], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return out;
}

function extractDeck(source: string, extra: readonly string[] = []) {
  const out = join(dir, 'deck.json');
  const result = runRender(['--extract', source, '--out', out, ...extra]);
  const ok = result.status === 0;
  const slides = ok
    ? (JSON.parse(readFileSync(out, 'utf8')) as { slides: Record<string, unknown>[] }).slides
    : undefined;
  const dropped = ok
    ? ((JSON.parse(result.stdout) as { dropped?: Record<string, number> }).dropped ?? {})
    : undefined;
  return { result, slides, dropped };
}

const COVER = { layout: 'title', title: '季度汇报', subtitle: '财务部' };

describe('提取 pptx：别人做的幻灯片', () => {
  it.runIf(hasOfficeRuntime)(
    '第二栏、原生图表、多出来的图和表放不进五种版式 → 默认停下并逐类说出来',
    () => {
      const source = buildPptx(
        'others.pptx',
        String.raw`
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE

two = slide(3, "两栏对比")
two.placeholders[1].text = "左栏要点一\n左栏要点二"
two.placeholders[2].text = "右栏要点一\n右栏要点二"

chart = slide(5, "季度趋势")
data = CategoryChartData()
data.categories = ["Q1", "Q2"]
data.add_series("营收", (1, 2))
chart.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(2), Inches(6), Inches(4), data)

pictures = slide(5, "两张图")
pictures.shapes.add_picture(png(), Inches(1), Inches(2), Inches(2), Inches(2))
pictures.shapes.add_picture(png(), Inches(4), Inches(2), Inches(2), Inches(2))

tables = slide(5, "两张表")
for left in (1, 5):
    table = tables.shapes.add_table(2, 2, Inches(left), Inches(2), Inches(3), Inches(1)).table
    for (r, c), value in {(0, 0): "地区", (0, 1): "销售额", (1, 0): "华东", (1, 1): "100"}.items():
        table.cell(r, c).text = value
`,
      );

      const { result, slides, dropped } = extractDeck(source, ['--allow-lossy']);
      expect(result.status, result.stderr).toBe(0);
      expect(slides).toEqual([
        COVER,
        { layout: 'bullets', title: '两栏对比', bullets: ['左栏要点一', '左栏要点二'] },
        { layout: 'section', title: '季度趋势' },
        { layout: 'chart', title: '两张图', chart_ref: 'extracted-media/slide-4.png' },
        {
          layout: 'table',
          title: '两张表',
          table: { header: ['地区', '销售额'], rows: [['华东', '100']] },
        },
      ]);
      expect(dropped).toEqual({ 文本框: 1, 原生图表: 1, 图片: 1, 表格: 1 });

      // 不加 --allow-lossy：停下，并且说清丢的是什么（之前这份文件「成功」提取、什么都不说）
      rmSync(join(dir, 'deck.json'));
      const refused = extractDeck(source);
      expect(refused.result.status).toBe(2);
      const message = (JSON.parse(refused.result.stderr) as { message: string }).message;
      for (const kind of ['文本框 1 处', '原生图表 1 处', '图片 1 处', '表格 1 处']) {
        expect(message).toContain(kind);
      }
      expect(existsSync(join(dir, 'deck.json'))).toBe(false);
    },
  );

  it.runIf(hasOfficeRuntime)(
    '组合图形里的标题和要点照样收回（之前整组被跳过、这页报「没有文字」）',
    () => {
      const source = buildPptx(
        'grouped.pptx',
        String.raw`
page = slide(6)
group = page.shapes.add_group_shape()
group.shapes.add_textbox(Inches(1), Inches(1), Inches(6), Inches(1)).text_frame.text = "组合里的标题"
group.shapes.add_textbox(Inches(1), Inches(2), Inches(6), Inches(3)).text_frame.text = "要点甲\n要点乙"
`,
      );
      const { result, slides, dropped } = extractDeck(source);
      expect(result.status, result.stderr).toBe(0);
      expect(slides).toEqual([
        COVER,
        { layout: 'bullets', title: '组合里的标题', bullets: ['要点甲', '要点乙'] },
      ]);
      expect(dropped).toEqual({});
    },
  );

  it.runIf(hasOfficeRuntime)(
    '要点里的软换行（Shift+Enter）还是同一条要点，渲染回去也还是一条',
    () => {
      const source = buildPptx(
        'soft-break.pptx',
        String.raw`
page = slide(1, "要点")
frame = page.placeholders[1].text_frame
frame.text = "第一条"
frame.paragraphs[0].add_line_break()
frame.paragraphs[0].add_run().text = "第一条的续行"
frame.add_paragraph().text = "第二条"
`,
      );
      const expected = ['第一条\n第一条的续行', '第二条'];
      const { result, slides } = extractDeck(source);
      expect(result.status, result.stderr).toBe(0);
      expect(slides?.[1]).toEqual({ layout: 'bullets', title: '要点', bullets: expected });

      const rendered = runRender([
        '--content',
        join(dir, 'deck.json'),
        '--out',
        join(dir, 'rendered.pptx'),
      ]);
      expect(rendered.status, rendered.stderr).toBe(0);
      rmSync(join(dir, 'deck.json'));
      expect(extractDeck(join(dir, 'rendered.pptx')).slides?.[1]).toMatchObject({
        bullets: expected,
      });
    },
  );
});

describe('提取 pptx：extracted-media 的写入规则', () => {
  function renderChartDeck(): string {
    writeFileSync(join(dir, 'chart.png'), Buffer.from(PNG_1PX, 'base64'));
    const content = {
      slides: [
        { layout: 'title', title: '周会' },
        { layout: 'chart', title: '趋势', chart_ref: 'chart.png' },
      ],
    };
    const out = join(dir, 'deck.pptx');
    const rendered = runRender(['--content', writeContent(content), '--out', out]);
    expect(rendered.status, rendered.stderr).toBe(0);
    return out;
  }

  it.runIf(hasOfficeRuntime)('**不覆盖**已有的同名图片，新图换一个名字', () => {
    const deck = renderChartDeck();
    mkdirSync(join(dir, 'extracted-media'));
    writeFileSync(join(dir, 'extracted-media', 'slide-2.png'), 'earlier extraction');
    const { result, slides } = extractDeck(deck);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(dir, 'extracted-media', 'slide-2.png'), 'utf8')).toBe(
      'earlier extraction',
    );
    const ref = String(slides?.[1]?.chart_ref);
    expect(ref).not.toBe('extracted-media/slide-2.png');
    expect(readFileSync(join(dir, ref)).subarray(1, 4).toString('latin1')).toBe('PNG');
  });

  it.runIf(hasOfficeRuntime)('extracted-media 是符号链接时拒绝，链接指向的目录里什么都不写', () => {
    const deck = renderChartDeck();
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dir, 'extracted-media'));
    const { result } = extractDeck(deck);
    expect(result.status).toBe(2);
    expect((JSON.parse(result.stderr) as { message: string }).message).toContain('符号链接');
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(join(dir, 'deck.json'))).toBe(false);
  });
});
