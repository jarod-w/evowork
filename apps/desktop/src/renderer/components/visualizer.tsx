/**
 * Visualizer（04 §7 / 总纲 §6.10）—— **这是 R5（XSS）的落点，规则不可放宽**。
 *
 * agent 用受控 fence 输出，前端识别渲染：
 *
 * | Fence | 渲染 | 安全 |
 * |---|---|---|
 * | ```mermaid | mermaid → SVG | 库本地打包 · `securityLevel:'strict'` · **插入前过白名单清洗** |
 * | ```evowork-chart | JSON spec → 图表 | **spec 先过 Schema 校验**，非法字段拒绝渲染并显示原始 JSON |
 * | ```html | 沙箱 iframe | **独立 origin**（给 `allow-scripts`，**不给** `allow-same-origin`）+ 严格 CSP |
 * | 其他 | 代码块 | 高亮 + 复制，**不执行** |
 *
 * ## 三条最容易被"优化"掉的
 *
 * 1. **`allow-scripts` 与 `allow-same-origin` 不能同时给。** 同时给等于没有沙箱：
 *    iframe 里的脚本能访问父页面的同源资源。这条有一条测试专门盯着。
 * 2. **mermaid 的输出仍要清洗。** `securityLevel:'strict'` 是 mermaid 自己的开关，
 *    而我们插入的是它产出的 SVG 字符串 —— 中间任何一个环节出问题，清洗是最后一道。
 * 3. **chart spec 里不允许函数/表达式字符串。** 图表库普遍支持"formatter 是一个函数"，
 *    而那正是把任意代码塞进来的入口。
 *
 * ## 为什么渲染器是注入的
 *
 * mermaid 是个大依赖，且它的加载与打包属于 M9。这里把 `MermaidRenderer` 做成接口，
 * 于是**清洗与安全参数可以在没有 mermaid 的情况下被测**——
 * 而那恰恰是这个文件里唯一不能出错的部分。
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { IconButton, PillButton } from './primitives.js';

export type FenceKind = 'mermaid' | 'evowork-chart' | 'html' | 'code';

export interface FenceBlock {
  readonly kind: FenceKind;
  /** `code` 时的语言标注 */
  readonly language?: string | undefined;
  readonly source: string;
}

/**
 * 把一段 Markdown 切成"普通文本"与"受控 fence"。
 *
 * 只认**行首**的 ``` —— 缩进的三反引号在 Markdown 里是代码块内容，不是围栏。
 * 认错的表现是把一段展示 mermaid 语法的文档当成图去渲染。
 */
export function parseFences(
  markdown: string,
): readonly ({ kind: 'text'; text: string } | FenceBlock)[] {
  const out: ({ kind: 'text'; text: string } | FenceBlock)[] = [];
  const lines = markdown.split('\n');
  let buffer: string[] = [];
  let fence: { language: string; body: string[] } | undefined;

  const flushText = (): void => {
    if (buffer.length > 0) {
      out.push({ kind: 'text', text: buffer.join('\n') });
      buffer = [];
    }
  };

  for (const line of lines) {
    const open = /^```([A-Za-z0-9_-]*)\s*$/.exec(line);
    if (fence === undefined && open) {
      flushText();
      fence = { language: (open[1] ?? '').toLowerCase(), body: [] };
      continue;
    }
    if (fence !== undefined && /^```\s*$/.test(line)) {
      out.push(toBlock(fence));
      fence = undefined;
      continue;
    }
    if (fence !== undefined) fence.body.push(line);
    else buffer.push(line);
  }

  // 未闭合的围栏：按代码块处理，**不按它声明的类型渲染** ——
  // 流式输出时半个 html 围栏很常见，那时渲染它等于渲染半份文档
  if (fence !== undefined)
    out.push({ kind: 'code', language: fence.language, source: fence.body.join('\n') });
  flushText();
  return out;
}

function toBlock(fence: { language: string; body: string[] }): FenceBlock {
  const source = fence.body.join('\n');
  if (fence.language === 'mermaid') return { kind: 'mermaid', source };
  if (fence.language === 'evowork-chart') return { kind: 'evowork-chart', source };
  if (fence.language === 'html') return { kind: 'html', source };
  return { kind: 'code', language: fence.language, source };
}

/* ───────────────────────────── SVG 清洗 ───────────────────────────── */

/** 允许的 SVG 标签。白名单而不是黑名单 —— 黑名单永远漏。 */
const SVG_TAG_ALLOWLIST = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'defs',
  'marker',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
  'use',
  'title',
  'desc',
  'style',
  'pattern',
  'filter',
  'feGaussianBlur',
  'feOffset',
  'feMerge',
  'feMergeNode',
  'feColorMatrix',
]);

/**
 * 清洗 mermaid 产出的 SVG。
 *
 * 三件事：删非白名单标签（含 `<script>` 与 **`<foreignObject>`**）、
 * 删所有事件属性（`on*`）、删 `javascript:` 之类的危险 URL。
 *
 * `<foreignObject>` 单独点名是因为它能在 SVG 里嵌入任意 HTML ——
 * 它不像 `<script>` 那样显眼，但效果一样。
 */
export function sanitizeSvg(svg: string, doc: Document = document): string {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = parsed.documentElement;
  if (!root || root.nodeName === 'parsererror') return '';

  const walk = (node: Element): void => {
    for (const child of [...node.children]) {
      if (!SVG_TAG_ALLOWLIST.has(child.nodeName)) {
        child.remove();
        continue;
      }
      for (const attribute of [...child.attributes]) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.replace(/\s+/g, '').toLowerCase();
        // 事件属性一律删；URL 型属性只允许 # 与 data:image
        if (name.startsWith('on')) child.removeAttribute(attribute.name);
        else if (
          (name === 'href' || name === 'xlink:href' || name === 'src') &&
          !(value.startsWith('#') || value.startsWith('data:image/'))
        ) {
          child.removeAttribute(attribute.name);
        } else if (value.includes('javascript:')) {
          child.removeAttribute(attribute.name);
        }
      }
      walk(child);
    }
  };

  if (!SVG_TAG_ALLOWLIST.has(root.nodeName)) return '';
  for (const attribute of [...root.attributes]) {
    if (attribute.name.toLowerCase().startsWith('on')) root.removeAttribute(attribute.name);
  }
  walk(root);
  void doc;
  return new XMLSerializer().serializeToString(root);
}

/* ─────────────────────────── chart spec 校验 ─────────────────────────── */

export interface ChartSpec {
  readonly chart: 'bar' | 'stacked-bar' | 'line' | 'pie' | 'scatter';
  readonly title?: string;
  readonly categories?: readonly string[];
  readonly series: readonly { readonly name: string; readonly values: readonly number[] }[];
  readonly x_label?: string;
  readonly y_label?: string;
}

const CHART_KINDS = ['bar', 'stacked-bar', 'line', 'pie', 'scatter'];
/** spec 里允许出现的键。多一个就拒绝 —— 未知键往往是"我以为它会生效"的来源。 */
const CHART_KEYS = new Set(['chart', 'title', 'categories', 'series', 'x_label', 'y_label']);

export type ChartValidation =
  { readonly ok: true; readonly spec: ChartSpec } | { readonly ok: false; readonly reason: string };

/**
 * 校验 chart spec。**非法就拒绝渲染并显示原始 JSON**（04 §7），不是尽力而为地画一个。
 *
 * 最关键的一条是最后那个检查：**不允许函数/表达式字符串**。
 * 图表库普遍支持 `formatter: "function(v){...}"`，那是把任意代码塞进来的入口。
 */
export function validateChartSpec(source: string): ChartValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, reason: '不是合法 JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: '顶层必须是一个对象' };
  }
  const spec = parsed as Record<string, unknown>;

  for (const key of Object.keys(spec)) {
    if (!CHART_KEYS.has(key)) return { ok: false, reason: `不认识的字段：${key}` };
  }
  if (typeof spec.chart !== 'string' || !CHART_KINDS.includes(spec.chart)) {
    return { ok: false, reason: `chart 必须是 ${CHART_KINDS.join(' / ')} 之一` };
  }
  if (!Array.isArray(spec.series) || spec.series.length === 0) {
    return { ok: false, reason: 'series 必须是非空数组' };
  }
  for (const item of spec.series) {
    if (typeof item !== 'object' || item === null)
      return { ok: false, reason: 'series 的元素必须是对象' };
    const series = item as Record<string, unknown>;
    if (typeof series.name !== 'string') return { ok: false, reason: 'series.name 必须是字符串' };
    if (!Array.isArray(series.values) || series.values.some((v) => typeof v !== 'number')) {
      return { ok: false, reason: 'series.values 必须是数字数组' };
    }
  }
  if (containsExecutable(spec)) {
    return { ok: false, reason: 'spec 里不允许出现函数或表达式' };
  }
  return { ok: true, spec: spec as unknown as ChartSpec };
}

/** 递归找函数、以及看起来像函数/表达式的字符串。 */
export function containsExecutable(value: unknown, depth = 0): boolean {
  if (depth > 6) return true; // 过深的结构直接拒绝，省得成为绕过手段
  if (typeof value === 'function') return true;
  if (typeof value === 'string') {
    return (
      /^\s*(function\b|\(?\s*\w*\s*\)?\s*=>|new\s+Function)/.test(value) ||
      /javascript:/i.test(value)
    );
  }
  if (Array.isArray(value)) return value.some((item) => containsExecutable(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => containsExecutable(item, depth + 1));
  }
  return false;
}

/* ─────────────────────────── 沙箱 iframe ─────────────────────────── */

/**
 * HTML 沙箱的两个参数。**它们是这个文件里最不能改的东西。**
 *
 * `allow-scripts` 让模型生成的交互式页面能跑；**不给 `allow-same-origin`** 让它
 * 拿不到父页面的同源能力。两者同时给等于没有沙箱 —— 这是 MDN 都写着的经典错误，
 * 而它"看起来能用"，所以特别容易在调试时被顺手加上。
 */
export const IFRAME_SANDBOX = 'allow-scripts';

/** 严格 CSP（04 §7）：禁一切外链，只允许内联样式与 data: 图片。 */
export const IFRAME_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'unsafe-inline'";

/** 高度上限 600，超出内部滚动（04 §7）。 */
export const IFRAME_MAX_HEIGHT = 600;

export function buildSandboxDocument(html: string, prefersDark: boolean): string {
  // 注入 prefers-color-scheme 但**不强制**：模型生成的 HTML 自带样式时不覆盖（04 §7）
  const scheme = prefersDark ? 'dark' : 'light';
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${IFRAME_CSP}">`,
    `<style>:root{color-scheme:${scheme}}body{margin:0;font-family:system-ui,sans-serif}</style>`,
    '</head><body>',
    html,
    '</body></html>',
  ].join('');
}

/* ─────────────────────────── 组件 ─────────────────────────── */

export interface MermaidRenderer {
  /** 返回 SVG 字符串。实现方负责 `securityLevel: 'strict'` */
  render(source: string, id: string): Promise<string>;
}

export interface VisualizerProps {
  readonly block: FenceBlock;
  readonly mermaid?: MermaidRenderer | undefined;
  /** 图表的实际绘制交给宿主（M8 的图表库接线） */
  readonly renderChart?: ((spec: ChartSpec) => ReactNode) | undefined;
  readonly prefersDark?: boolean | undefined;
  readonly onSaveAsFile?: ((block: FenceBlock) => void) | undefined;
}

export function Visualizer(props: VisualizerProps) {
  const [showSource, setShowSource] = useState(false);
  const { block } = props;

  return (
    <figure className="ew-visualizer" data-kind={block.kind}>
      <div className="ew-visualizer-actions">
        {/* 三类都要提供「查看源码」与「保存为文件」（04 §7） */}
        <PillButton variant="ghost" onClick={() => setShowSource((v) => !v)}>
          {showSource ? '收起源码' : '查看源码'}
        </PillButton>
        {props.onSaveAsFile ? (
          <IconButton label="保存为文件" icon="↓" onClick={() => props.onSaveAsFile?.(block)} />
        ) : null}
      </div>

      {showSource ? (
        <pre className="ew-visualizer-source">{block.source}</pre>
      ) : (
        <Body {...props} />
      )}
    </figure>
  );
}

function Body({ block, mermaid, renderChart, prefersDark }: VisualizerProps): ReactNode {
  if (block.kind === 'mermaid') return <MermaidBlock source={block.source} renderer={mermaid} />;
  if (block.kind === 'evowork-chart')
    return <ChartBlock source={block.source} render={renderChart} />;
  if (block.kind === 'html')
    return <HtmlBlock html={block.source} prefersDark={prefersDark ?? false} />;
  return (
    <pre className="ew-visualizer-code" data-language={block.language}>
      {block.source}
    </pre>
  );
}

function MermaidBlock({
  source,
  renderer,
}: {
  source: string;
  renderer?: MermaidRenderer | undefined;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!renderer) return;
    let cancelled = false;
    renderer
      .render(source, `mermaid-${id}`)
      .then((raw) => {
        if (cancelled) return;
        // 即使 mermaid 开了 strict，插入前也要清洗一遍（见文件头第 2 条）
        setSvg(sanitizeSvg(raw));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '图表语法有误');
      });
    return () => {
      cancelled = true;
    };
  }, [source, renderer, id]);

  if (!renderer) {
    return <pre className="ew-visualizer-code">{source}</pre>;
  }
  if (error) {
    return <p className="ew-visualizer-error">这张图渲染失败：{error}</p>;
  }
  return (
    <div
      className="ew-visualizer-svg"
      // 内容已过白名单清洗（sanitizeSvg）：删标签、删事件属性、删危险 URL
      dangerouslySetInnerHTML={{ __html: svg ?? '' }}
    />
  );
}

function ChartBlock({
  source,
  render,
}: {
  source: string;
  render?: ((spec: ChartSpec) => ReactNode) | undefined;
}) {
  const validation = useMemo(() => validateChartSpec(source), [source]);
  if (!validation.ok) {
    // 04 §7：非法字段**拒绝渲染并显示原始 JSON**
    return (
      <div className="ew-visualizer-invalid">
        <p className="ew-visualizer-error">
          这段图表数据不合法（{validation.reason}），按原文显示：
        </p>
        <pre className="ew-visualizer-code">{source}</pre>
      </div>
    );
  }
  return <div className="ew-visualizer-chart">{render?.(validation.spec) ?? null}</div>;
}

function HtmlBlock({ html, prefersDark }: { html: string; prefersDark: boolean }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const document_ = useMemo(() => buildSandboxDocument(html, prefersDark), [html, prefersDark]);

  return (
    <iframe
      ref={ref}
      className="ew-visualizer-frame"
      title="生成的网页"
      // **不给 allow-same-origin**（见 IFRAME_SANDBOX 的注释）
      sandbox={IFRAME_SANDBOX}
      srcDoc={document_}
    />
  );
}
