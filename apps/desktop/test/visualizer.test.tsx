/**
 * Visualizer（04 §7）——**R5（XSS）的落点**。
 *
 * 这个文件里的每一条都在问同一个问题：**模型生成的内容能不能拿到它不该拿到的东西**。
 * 三条最关键的：iframe 不给 `allow-same-origin`、SVG 插入前过白名单、
 * chart spec 里不许有函数字符串。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  buildSandboxDocument,
  containsExecutable,
  IFRAME_CSP,
  IFRAME_SANDBOX,
  parseFences,
  sanitizeSvg,
  validateChartSpec,
  Visualizer,
  type FenceBlock,
} from '../src/renderer/components/visualizer.js';

describe('fence 识别', () => {
  it('识别三种受控 fence，其余按代码块', () => {
    const parsed = parseFences(
      ['前言', '```mermaid', 'graph TD; A-->B;', '```', '```python', 'print(1)', '```'].join('\n'),
    );
    expect(parsed.map((p) => p.kind)).toEqual(['text', 'mermaid', 'code']);
  });

  it('**只认行首的三反引号** —— 缩进的是代码块内容，不是围栏', () => {
    const parsed = parseFences(['```', '    ```mermaid', '    graph TD;', '```'].join('\n'));
    expect(parsed.filter((p) => p.kind === 'mermaid')).toHaveLength(0);
  });

  it('**未闭合的围栏按代码块处理**，不按它声明的类型渲染（流式输出时很常见）', () => {
    const parsed = parseFences(['```html', '<div>半个'].join('\n'));
    expect(parsed[0]?.kind).toBe('code');
  });
});

describe('SVG 清洗：白名单，不是黑名单', () => {
  it('删掉 script', () => {
    const cleaned = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect/></svg>',
    );
    expect(cleaned).not.toContain('script');
    expect(cleaned).toContain('rect');
  });

  it('**删掉 foreignObject** —— 它能在 SVG 里嵌任意 HTML，不像 script 那样显眼', () => {
    const cleaned = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml">x</body></foreignObject></svg>',
    );
    expect(cleaned).not.toContain('foreignObject');
  });

  it('删掉所有事件属性', () => {
    const cleaned = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><rect onclick="y()" onmouseover="z()"/></svg>',
    );
    expect(cleaned).not.toContain('onload');
    expect(cleaned).not.toContain('onclick');
    expect(cleaned).not.toContain('onmouseover');
  });

  it('删掉危险 URL，保留 # 与 data:image', () => {
    const cleaned = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="javascript:alert(1)"/><use href="#glyph"/></svg>',
    );
    expect(cleaned).not.toContain('javascript');
    expect(cleaned).toContain('#glyph');
  });

  it('根元素不是 svg 时整个丢掉', () => {
    expect(sanitizeSvg('<html><body>x</body></html>')).toBe('');
  });
});

describe('chart spec 校验：非法就拒绝渲染并显示原文', () => {
  const good = JSON.stringify({
    chart: 'bar',
    title: '季度营收',
    categories: ['Q1', 'Q2'],
    series: [{ name: 'A', values: [1, 2] }],
  });

  it('合法 spec 通过', () => {
    expect(validateChartSpec(good).ok).toBe(true);
  });

  it('**不认识的字段直接拒绝** —— 未知键往往是"我以为它会生效"的来源', () => {
    const result = validateChartSpec(JSON.stringify({ ...JSON.parse(good), onClick: 'x' }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('类型收窄');
    expect(result.reason).toContain('onClick');
  });

  it('**函数字符串一律拒绝** —— 那是把任意代码塞进来的入口', () => {
    expect(containsExecutable({ formatter: 'function(v){return v}' })).toBe(true);
    expect(containsExecutable({ formatter: '(v) => v * 2' })).toBe(true);
    expect(containsExecutable({ url: 'javascript:alert(1)' })).toBe(true);
    expect(containsExecutable({ title: '季度营收（万元）' })).toBe(false);
  });

  it('坏 JSON 与坏形状都给出具体原因', () => {
    expect(validateChartSpec('{ bad').ok).toBe(false);
    expect(validateChartSpec(JSON.stringify({ chart: 'radar', series: [] })).ok).toBe(false);
    expect(
      validateChartSpec(JSON.stringify({ chart: 'bar', series: [{ name: 'A', values: ['x'] }] }))
        .ok,
    ).toBe(false);
  });

  it('非法时渲染出原始 JSON 而不是空白', () => {
    render(<Visualizer block={{ kind: 'evowork-chart', source: '{ bad json' }} />);
    expect(screen.getByText(/不是合法 JSON/)).toBeTruthy();
    expect(screen.getByText(/\{ bad json/)).toBeTruthy();
  });
});

describe('**HTML 沙箱：两个参数不能同时给**（R5）', () => {
  it('sandbox 只给 allow-scripts，**绝不给 allow-same-origin**', () => {
    expect(IFRAME_SANDBOX).toBe('allow-scripts');
    // 同时给等于没有沙箱：iframe 里的脚本能访问父页面的同源资源
    expect(IFRAME_SANDBOX).not.toContain('allow-same-origin');
  });

  it('渲染出的 iframe 用的就是那个常量', () => {
    const { container } = render(<Visualizer block={{ kind: 'html', source: '<b>hi</b>' }} />);
    const frame = container.querySelector('iframe');
    expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame?.getAttribute('sandbox')).not.toContain('same-origin');
  });

  it('CSP 禁一切外链', () => {
    expect(IFRAME_CSP).toContain("default-src 'none'");
    expect(IFRAME_CSP).toContain('img-src data:');
    // 不允许任何 http(s) 来源
    expect(IFRAME_CSP).not.toMatch(/https?:/);
  });

  it('注入的文档带 CSP，且**注入 color-scheme 但不覆盖模型自己的样式**', () => {
    const doc = buildSandboxDocument('<div style="color:red">x</div>', true);
    expect(doc).toContain(IFRAME_CSP);
    expect(doc).toContain('color-scheme:dark');
    // 模型写的内联样式原样保留
    expect(doc).toContain('style="color:red"');
  });
});

describe('三类都提供「查看源码」与「保存为文件」（04 §7）', () => {
  const block: FenceBlock = { kind: 'mermaid', source: 'graph TD; A-->B;' };

  it('查看源码切换出原文', () => {
    render(<Visualizer block={block} />);
    fireEvent.click(screen.getByRole('button', { name: '查看源码' }));
    expect(screen.getByText('graph TD; A-->B;')).toBeTruthy();
  });

  it('保存为文件把整块交出去', () => {
    const onSaveAsFile = vi.fn();
    render(<Visualizer block={block} onSaveAsFile={onSaveAsFile} />);
    fireEvent.click(screen.getByLabelText('保存为文件'));
    expect(onSaveAsFile).toHaveBeenCalledWith(block);
  });

  it('没有 mermaid 渲染器时**退化为代码块**，而不是空白', () => {
    render(<Visualizer block={block} />);
    expect(screen.getByText('graph TD; A-->B;')).toBeTruthy();
  });
});
