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
  it('首页突出专业技能、持续交付与操作电脑三大板块，且不含开发者/GitHub/账号登录文案', () => {
    const { container } = render(
      <App initialRoute={{ locale: 'zh', page: 'home' }} platformOverride="macos" />,
    );

    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
      '一句话交代工作，拿回能直接用的文件',
    );

    // 不包含技术人员措辞、版本号、GitHub 或账号登录链接；导航页签为「下载」
    const bodyText = container.textContent ?? '';
    expect(bodyText).not.toContain('MIT');
    expect(bodyText).not.toContain('GitHub');
    expect(bodyText).not.toContain('账号登录');
    expect(bodyText).not.toContain('0.6.5');
    expect(bodyText).not.toContain('下载上手');
    expect(bodyText).not.toContain('随包自带办公环境与中文字体');
    expect(screen.getAllByRole('link', { name: '下载' }).length).toBeGreaterThanOrEqual(2);

    // 板块 1：专业技能切换（金融热点 -> 学术文献精读）
    expect(
      screen.getByRole('heading', { level: 2, name: '专业技能，让复杂工作更简单' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /文献精读/ }));
    expect(screen.getByText('8篇核心论文精读笔记与方法对比表.docx')).toBeTruthy();

    // 板块 2：从复杂任务，到持续交付（Office 工具 / 深入调研分析 / 定时任务）
    expect(screen.getByRole('heading', { level: 2, name: '从复杂任务，到持续交付' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /深入调研分析/ }));
    expect(screen.getByText('多源信息检索 + 本地资料交叉印证')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /定时任务/ }));
    expect(screen.getByText('每周一 09:00 自动汇总周报与关键指标')).toBeTruthy();

    // 板块 3：操作电脑，完成复杂任务
    expect(screen.getByRole('heading', { level: 2, name: '操作电脑，完成复杂任务' })).toBeTruthy();

    // 切换英文
    fireEvent.click(screen.getByRole('button', { name: /Switch language to EN/i }));
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(
      'Describe the job in one sentence. Get back ready-to-use files.',
    );
    expect(document.documentElement.lang).toBe('en');
  });

  it('下载页支持可配置开关隐藏 macOS 未签名引导卡，且不包含更新记录与 GitHub 链接', () => {
    const { rerender, container } = render(
      <App
        initialRoute={{ locale: 'zh', page: 'download' }}
        platformOverride="macos"
        showMacUnsignedGuide={true}
      />,
    );

    expect(screen.getByTestId('mac-unsigned-guide')).toBeTruthy();
    expect(screen.getByText('xattr -cr /Applications/EvoWork.app')).toBeTruthy();
    expect(container.textContent).not.toContain('近期版本更新记录');
    expect(container.textContent).not.toContain('GitHub');
    expect(container.textContent).not.toContain('0.6.5');

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
    fireEvent.change(searchInput, { target: { value: '扫描件' } });
    expect(screen.getByRole('button', { name: '本地文件、截图粘贴与扫描件识别' })).toBeTruthy();
  });

  it('企业版直接展示日志审计与敏感信息仿真脱敏为核心能力，并支持预约表单提交', async () => {
    const first = render(
      <App initialRoute={{ locale: 'zh', page: 'enterprise' }} leadEndpoint="" />,
    );

    expect(first.container.textContent).not.toContain('下一企业版本');
    expect(screen.getByRole('heading', { level: 2, name: '企业核心安全与审计能力' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 3, name: '全量操作日志与企业审计' })).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 3, name: '敏感信息检测与数据仿真脱敏' }),
    ).toBeTruthy();

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

    // 验证配置在线端点时真实 POST + 英文版核心能力展示
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const second = render(
      <App
        initialRoute={{ locale: 'en', page: 'enterprise' }}
        leadEndpoint="https://hooks.example.com/lead"
      />,
    );
    expect(second.container.textContent).not.toContain('Next Release');
    expect(
      screen.getByRole('heading', {
        level: 2,
        name: 'Core Enterprise Security & Audit Capabilities',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', {
        level: 3,
        name: 'Sensitive Data Detection & Synthetic Masking',
      }),
    ).toBeTruthy();

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
