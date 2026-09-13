import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { FilePreview, sandboxedHtml } from '../src/renderer/components/file-preview.js';

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
});
