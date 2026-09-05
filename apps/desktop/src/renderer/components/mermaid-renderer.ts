/**
 * mermaid 的真实渲染器（04 §7）。
 *
 * `visualizer.tsx` 只认 `MermaidRenderer` 接口 —— 那是为了让**清洗与安全参数**
 * 在没有 mermaid 的情况下也能被测（见那个文件的头注释）。这里是接口的实现。
 *
 * ## 三条与安全直接相关的配置
 *
 * 1. `securityLevel: 'strict'` —— mermaid 自己的开关：禁 HTML 标签、禁点击回调。
 * 2. `htmlLabels: false` —— 不生成 `<foreignObject>` 包裹的 HTML 标签。
 *    开着的话 mermaid 会用 HTML 排版文字，而 `sanitizeSvg` 会把 `foreignObject` 删掉，
 *    结果是**图里的文字全没了**。关掉它既更安全，也让清洗后的图仍然完整。
 * 3. `startOnLoad: false` —— 我们自己控制什么时候渲染哪一段，不让它扫描整个文档。
 *
 * **即使这三条都开着，输出仍要过 `sanitizeSvg`**（visualizer 里做）——
 * 那是最后一道，而不是重复劳动：这三条是 mermaid 的承诺，清洗是我们自己的。
 *
 * ## 为什么是动态 import
 *
 * mermaid 打进主包会显著拖慢首屏，而大多数会话里一张图都没有。
 * 动态 import 让它在**第一次真的要渲染一张图**时才加载。
 */
import {
  DARK_NEUTRAL,
  DARK_SEMANTIC,
  FONT_STACK,
  LIGHT_NEUTRAL,
  LIGHT_SEMANTIC,
} from '@evowork/tokens';

import type { MermaidRenderer } from './visualizer.js';

let loading: Promise<typeof import('mermaid').default> | undefined;

async function loadMermaid(): Promise<typeof import('mermaid').default> {
  if (!loading) {
    loading = import('mermaid').then((module) => {
      const mermaid = module.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        // 主题色从 01 §2 的 token 注入（04 §7：暗色自动切换）
        theme: 'base',
        themeVariables: readThemeVariables(),
      });
      return mermaid;
    });
  }
  return loading;
}

/**
 * 从 CSS 变量里读主题色。
 *
 * 兜底值不写字面量，而是**取自 `@evowork/tokens` 的同一批常量** ——
 * `@evowork/no-style-literals` 会拦下前者，而它拦得对：写死的兜底色会在暗色与高对比模式下
 * 变成一张配色不对的图，且绕过 01 §8.2 的对比度约束。
 *
 * （这段兜底几乎不会走到：CSS 变量在 `main.tsx` 里注入，而它在渲染任何东西之前。
 * 但"几乎不会走到"的分支写错了最难发现，所以它也走同一个真源。）
 */
function readThemeVariables(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const dark =
    document.documentElement.dataset.theme === 'dark' ||
    (document.documentElement.dataset.theme !== 'light' &&
      globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true);
  const neutral = dark ? DARK_NEUTRAL : LIGHT_NEUTRAL;
  const semantic = dark ? DARK_SEMANTIC : LIGHT_SEMANTIC;

  const token = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;

  return {
    primaryColor: token('--accent-weak', semantic['accent-weak']),
    primaryBorderColor: token('--accent', semantic.accent),
    primaryTextColor: token('--text-primary', neutral['text-primary']),
    lineColor: token('--border-strong', neutral['border-strong']),
    secondaryColor: token('--bg-sunken', neutral['bg-sunken']),
    tertiaryColor: token('--bg-surface', neutral['bg-surface']),
    background: token('--bg-canvas', neutral['bg-canvas']),
    fontFamily: token('--font-cjk', FONT_STACK.cjk),
  };
}

export function createMermaidRenderer(): MermaidRenderer {
  return {
    async render(source: string, id: string): Promise<string> {
      const mermaid = await loadMermaid();
      // parse 先行：语法错误在这里抛，能给出比渲染失败更具体的信息
      await mermaid.parse(source);
      const { svg } = await mermaid.render(id, source);
      return svg;
    },
  };
}
