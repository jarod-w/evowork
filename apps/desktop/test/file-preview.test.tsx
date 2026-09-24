import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  FilePreview,
  normalizeAnnotationRegion,
  sandboxedHtml,
} from '../src/renderer/components/file-preview.js';

describe('本地文件预览', () => {
  it('HTML 预览用无脚本 sandbox，并用 CSP 阻止内容自行出网', () => {
    render(
      <FilePreview
        preview={{
          name: 'report.html',
          kind: 'html',
          content: '<img src="https://tracker.example/pixel">',
        }}
      />,
    );

    const frame = screen.getByTitle('网页预览：report.html');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
  });

  it('CSP 位于用户 HTML 之前，远程资源在解析正文前就被禁止', () => {
    const html = sandboxedHtml('<script src="https://example.test/a.js"></script>');
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script'));
  });

  it('Office/Markdown 预览渲染结构，批注可回填修改请求', () => {
    const onAnnotate = vi.fn();
    render(
      <FilePreview
        preview={{ name: 'report.docx', kind: 'markdown', content: '# 季度报告' }}
        onAnnotate={onAnnotate}
      />,
    );
    expect(screen.getByRole('heading', { name: '季度报告' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '添加批注' }));
    fireEvent.change(screen.getByLabelText('批注内容'), { target: { value: '补充同比数据' } });
    fireEvent.click(screen.getByRole('button', { name: '加入修改请求' }));
    expect(onAnnotate).toHaveBeenCalledWith({
      fileName: 'report.docx',
      comment: '补充同比数据',
    });
  });

  it('图片/PDF 区域坐标按百分比归一化，拖动方向不影响结果', () => {
    expect(normalizeAnnotationRegion({ x: 80, y: 60 }, { x: 20, y: 10 }, 2)).toEqual({
      x: 20,
      y: 10,
      width: 60,
      height: 50,
      page: 2,
    });
  });

  it('图片批注携带选区坐标', () => {
    const onAnnotate = vi.fn();
    render(
      <FilePreview
        preview={{ name: 'chart.png', kind: 'image', content: 'data:image/png;base64,' }}
        onAnnotate={onAnnotate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '添加批注' }));
    const layer = screen.getByRole('application', { name: '选择批注区域' });
    vi.spyOn(layer, 'getBoundingClientRect').mockReturnValue({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 210,
      bottom: 120,
      width: 200,
      height: 100,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(layer, { clientX: 30, clientY: 30 });
    fireEvent.pointerMove(layer, { clientX: 130, clientY: 80 });
    fireEvent.pointerUp(layer, { clientX: 130, clientY: 80 });
    fireEvent.change(screen.getByLabelText('批注内容'), { target: { value: '强调这个峰值' } });
    fireEvent.click(screen.getByRole('button', { name: '加入修改请求' }));
    expect(onAnnotate).toHaveBeenCalledWith({
      fileName: 'chart.png',
      region: { x: 10, y: 10, width: 50, height: 50 },
      comment: '强调这个峰值',
    });
  });
});
