import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { App } from '../src/app.js';
import { buildPath, parseRoute } from '../src/router.js';

describe('路由与双语解析', () => {
  it('正确解析中英文路径与文档 slug', () => {
    expect(parseRoute('/zh/', 'zh')).toEqual({ locale: 'zh', page: 'home' });
    expect(parseRoute('/en/download', 'zh')).toEqual({ locale: 'en', page: 'download' });
    expect(parseRoute('/zh/docs/api-key-setup', 'en')).toEqual({
      locale: 'zh',
      page: 'docs',
      docSlug: 'api-key-setup',
    });
    expect(buildPath({ locale: 'en', page: 'enterprise' })).toBe('/en/enterprise');
  });
});

describe('EvoWork 官网核心旅程', () => {
  it('首页渲染核心卖点、支持交互切换演示场景与中英双语切换', () => {
    render(<App initialRoute={{ locale: 'zh', page: 'home' }} platformOverride="macos" />);

    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
      '一句话交代工作，拿回能直接用的文件',
    );

    // 切换 Hero 场景到扫描合同审查
    fireEvent.click(screen.getByRole('tab', { name: '扫描件合同审查 → 风险表' }));
    expect(screen.getByText('合同核心风险点与修改建议')).toBeTruthy();

    // 切换办公成品三件套到 PPT
    fireEvent.click(screen.getByRole('tab', { name: /PPT 演示文稿/ }));
    expect(screen.getByText('2026_产品路线与业务汇报.pptx')).toBeTruthy();

    // 切换英文
    fireEvent.click(screen.getByRole('button', { name: /Switch language to EN/i }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
      'Describe the job in one sentence. Get back ready-to-use files.',
    );
    expect(document.documentElement.lang).toBe('en');
  });

  it('下载页支持可配置开关隐藏 macOS 未签名 xattr 引导卡', () => {
    const { rerender } = render(
      <App
        initialRoute={{ locale: 'zh', page: 'download' }}
        platformOverride="macos"
        showMacUnsignedGuide={true}
      />,
    );

    expect(screen.getByTestId('mac-unsigned-guide')).toBeTruthy();
    expect(screen.getByText('xattr -cr /Applications/EvoWork.app')).toBeTruthy();

    rerender(
      <App
        initialRoute={{ locale: 'zh', page: 'download' }}
        platformOverride="macos"
        showMacUnsignedGuide={false}
      />,
    );
    expect(screen.queryByTestId('mac-unsigned-guide')).toBeNull();
  });

  it('文档中心支持搜索与切换文档章节', () => {
    render(<App initialRoute={{ locale: 'zh', page: 'docs' }} platformOverride="windows" />);

    expect(screen.getByRole('heading', { level: 2, name: '3 分钟安装与首次使用' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '接入模型密钥（DeepSeek / Kimi / GLM）' }));
    expect(
      screen.getByRole('heading', { level: 2, name: '接入模型密钥（DeepSeek / Kimi / GLM）' }),
    ).toBeTruthy();

    const searchInput = screen.getByRole('searchbox');
    fireEvent.change(searchInput, { target: { value: 'OCR' } });
    expect(screen.getByRole('button', { name: '本地资料库、截图粘贴与扫描件 OCR' })).toBeTruthy();
  });

  it('企业版预约表单校验必填项，支持无后端预览回执与配置端点提交', async () => {
    const first = render(
      <App initialRoute={{ locale: 'zh', page: 'enterprise' }} leadEndpoint="" />,
    );

    // 空表单拦截
    fireEvent.click(screen.getByRole('button', { name: '提交预约申请' }));
    expect(screen.getByRole('alert').textContent).toContain('请填写你的姓名');

    // 填写有效信息并在预览模式下提交
    fireEvent.change(screen.getByLabelText(/你的姓名/), { target: { value: '林明' } });
    fireEvent.change(screen.getByLabelText(/工作邮箱/), { target: { value: 'lin@example.com' } });
    fireEvent.change(screen.getByLabelText(/公司或团队名称/), { target: { value: '星河科技' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '提交预约申请' }));

    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('预约信息已收到');
    });
    first.unmount();

    // 验证配置在线端点时真实 POST
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    render(
      <App
        initialRoute={{ locale: 'en', page: 'enterprise' }}
        leadEndpoint="https://hooks.example.com/lead"
      />,
    );
    fireEvent.change(screen.getByLabelText(/Your name/), { target: { value: 'Alex' } });
    fireEvent.change(screen.getByLabelText(/Work email/), { target: { value: 'alex@acme.io' } });
    fireEvent.change(screen.getByLabelText(/Company or team/), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Request a Demo' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'https://hooks.example.com/lead',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });
});
