/**
 * 插件目录页（05 · 13）。断的是用户看见的东西：双视图 Tab、弹层元数据、空态、文案，不是中间字段。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogDataView } from '../src/shared/ipc.js';
import { CatalogPage, type CatalogPageProps } from '../src/renderer/views/catalog.js';

const EMPTY: CatalogDataView = {
  skills: [],
  connectors: [
    {
      id: 'browser',
      name: '浏览器',
      kind: 'official',
      transport: 'stdio',
      trusted: false,
      status: 'untrusted',
      category: 'browser',
      toolPolicy: {},
    },
  ],
  experts: [],
  apps: [],
};

function renderPage(
  over: Partial<CatalogDataView> = {},
  tab: 'experts' | 'skills' | 'connectors' = 'skills',
  props: Partial<CatalogPageProps> = {},
) {
  const data = { ...EMPTY, ...over };
  render(
    <CatalogPage
      data={data}
      tab={tab}
      onTab={() => undefined}
      onInstallSkill={async () => ({ ok: true, catalog: data })}
      onUninstallSkill={async () => ({ ok: true, catalog: data })}
      onSetSkillEnabled={async () => ({ ok: true, catalog: data })}
      onAddConnector={async () => ({ ok: true, catalog: data })}
      onTrustConnector={async () => ({ ok: true, catalog: data })}
      onAuthorizeConnector={async () => ({ ok: true, catalog: data })}
      onSetConnectorToolPolicy={async () => ({ ok: true, catalog: data })}
      onRemoveConnector={async () => ({ ok: true, catalog: data })}
      onCreateExpert={async () => ({ ok: true, catalog: data })}
      onRemoveExpert={async () => ({ ok: true, catalog: data })}
      onPickDirectory={async () => undefined}
      onUsePrompt={vi.fn()}
      onWriteSkill={vi.fn()}
      hubActions={hubActions}
      {...props}
    />,
  );
}

const hubActions = {
  refresh: vi.fn(async () => ({ ok: true, catalog: EMPTY })),
  install: vi.fn(async () => ({ ok: true, catalog: EMPTY })),
  uninstall: vi.fn(async () => ({ ok: true, catalog: EMPTY })),
  rollback: vi.fn(async () => ({ ok: true, catalog: EMPTY })),
};

const HUB_STATUS = {
  configured: true,
  sourceName: 'EvoWork 精选',
  fetchMode: 'manual-only' as const,
  signedIn: false,
  fetchWhenSignedOut: false,
  canRefresh: true,
  expired: false,
  caption: '登录或在设置中开启后，可以获取 EvoWork 精选内容',
};

describe('CatalogPage', () => {
  it('过期签名目录常驻顶部警告条，弹层里展示最近检查、签发与到期时间，并保留网络警告', () => {
    renderPage({
      hub: {
        status: {
          ...HUB_STATUS,
          expired: true,
          fetchedAt: 1_794_044_669,
          issuedAt: 1_791_466_688,
          expiresAt: 1_792_071_488,
          warning: '精选源暂时无法访问，显示的是缓存内容',
        },
        entries: [],
      },
    });
    expect(screen.getByText(/需要维护者更新/)).toBeTruthy();
    expect(screen.getByText(/已安装内容可继续使用/)).toBeTruthy();
    expect(screen.getByText(/精选源暂时无法访问/)).toBeTruthy();
    // 正常时间戳收在右上角弹层里，不平铺在主区
    expect(screen.queryByText(/目录签发/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /目录已过期/ }));
    const popover = screen.getByRole('dialog', { name: '精选目录状态' });
    expect(within(popover).getByText(/最近检查/)).toBeTruthy();
    expect(within(popover).getByText(/目录签发/)).toBeTruthy();
    expect(within(popover).getByText(/目录有效期至/)).toBeTruthy();
  });

  it('有效目录不弹告警条，点开「精选目录」弹层才展示有效期且不提示维护者更新', () => {
    renderPage({
      hub: {
        status: { ...HUB_STATUS, fetchedAt: 1_800_000_000, expiresAt: 1_800_604_800 },
        entries: [],
      },
    });
    expect(screen.queryByText(/需要维护者更新/)).toBeNull();
    expect(screen.queryByText(/目录有效期至/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /精选目录/ }));
    const popover = screen.getByRole('dialog', { name: '精选目录状态' });
    expect(within(popover).getByText(/目录有效期至/)).toBeTruthy();
  });

  it('文件安装独立打开文件选择器，P2 未确认不会提交安装授权', async () => {
    const pickFile = vi.fn(async () => '/downloads/SKILL.MD');
    const pickDirectory = vi.fn(async () => '/directory');
    const install = vi.fn(async () => ({
      ok: false,
      needsConfirm: true,
      catalog: EMPTY,
      audit: { skillId: 'coach', level: 'p2', findings: ['任意网络'] },
    }));
    renderPage({}, 'skills', {
      onPickSkillFile: pickFile,
      onPickDirectory: pickDirectory,
      onInstallSkill: install,
    });
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加技能' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '从 SKILL.md 文件安装' }));
    await waitFor(() =>
      expect(install).toHaveBeenCalledWith({ kind: 'file', path: '/downloads/SKILL.MD' }),
    );
    expect(pickDirectory).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('高风险技能');
    const confirm = screen.getByRole('button', { name: '安装' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/输入技能名/), { target: { value: 'coach' } });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(install).toHaveBeenLastCalledWith({
        kind: 'file',
        path: '/downloads/SKILL.MD',
        acknowledge: true,
        confirmName: 'coach',
      }),
    );
  });

  it('取消技能文件选择不触发安装', async () => {
    const install = vi.fn(async () => ({ ok: true, catalog: EMPTY }));
    renderPage({}, 'skills', { onPickSkillFile: async () => undefined, onInstallSkill: install });
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加技能' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '从 SKILL.md 文件安装' }));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(install).not.toHaveBeenCalled();
  });

  it('技能空态如实说随包目录没装上，不编一套演示技能，也不再渲染邮件摘要试用', () => {
    renderPage();
    expect(screen.getByText('还没有已安装的技能')).toBeTruthy();
    expect(screen.queryByText(/邮件摘要/)).toBeNull();
  });

  it('连接器 Tab 常驻说明官方目录未提供', () => {
    render(
      <CatalogPage
        data={EMPTY}
        tab="connectors"
        onTab={() => undefined}
        onInstallSkill={async () => ({ ok: true, catalog: EMPTY })}
        onUninstallSkill={async () => ({ ok: true, catalog: EMPTY })}
        onSetSkillEnabled={async () => ({ ok: true, catalog: EMPTY })}
        onAddConnector={async () => ({ ok: true, catalog: EMPTY })}
        onTrustConnector={async () => ({ ok: true, catalog: EMPTY })}
        onAuthorizeConnector={async () => ({ ok: true, catalog: EMPTY })}
        onSetConnectorToolPolicy={async () => ({ ok: true, catalog: EMPTY })}
        onRemoveConnector={async () => ({ ok: true, catalog: EMPTY })}
        onCreateExpert={async () => ({ ok: true, catalog: EMPTY })}
        onRemoveExpert={async () => ({ ok: true, catalog: EMPTY })}
        onPickDirectory={async () => undefined}
        onUsePrompt={vi.fn()}
        onWriteSkill={vi.fn()}
      />,
    );
    expect(
      screen.getByText('本版支持通过 MCP 协议接入任意第三方服务。官方连接器目录将在后续版本提供。'),
    ).toBeTruthy();
    expect(screen.getAllByText('浏览器').length).toBeGreaterThan(0);
    expect(screen.getByText('待信任 · 添加后还没有启动')).toBeTruthy();
  });

  it('连接器详情显示 OAuth 状态和逐工具权限', () => {
    renderPage(
      {
        connectors: [
          {
            id: 'calendar',
            name: '日历',
            kind: 'custom',
            transport: 'http',
            url: 'https://mcp.example.test',
            trusted: true,
            status: 'needs-auth',
            category: 'custom',
            authStatus: 'notLoggedIn',
            tools: ['search_events'],
            toolCount: 1,
            toolPolicy: {},
          },
        ],
      },
      'connectors',
    );
    fireEvent.click(screen.getByRole('button', { name: '查看权限 · 日历' }));
    expect(screen.getByText('授权状态：尚未授权')).toBeTruthy();
    expect(screen.getByText('search_events')).toBeTruthy();
    expect(screen.getByRole('button', { name: '去授权' })).toBeTruthy();
  });

  it('浏览器通过具名的查看权限按钮进入详情，确认信任前不启用', async () => {
    const trust = vi.fn(async () => ({ ok: true, catalog: EMPTY }));
    renderPage({}, 'connectors', { onTrustConnector: trust });
    fireEvent.click(screen.getByRole('button', { name: '查看权限 · 浏览器' }));
    expect(screen.getByRole('heading', { name: '浏览器' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '信任并启用' }));
    let dialog = screen.getByRole('alertdialog', { name: '信任「浏览器」' });
    expect(trust).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(trust).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '信任并启用' }));
    dialog = screen.getByRole('alertdialog', { name: '信任「浏览器」' });
    fireEvent.click(within(dialog).getByRole('button', { name: '信任并启用' }));
    await waitFor(() => expect(trust).toHaveBeenCalledExactlyOnceWith('browser'));
  });

  it('专家 Tab 空态不预置角色包', () => {
    render(
      <CatalogPage
        data={EMPTY}
        tab="experts"
        onTab={() => undefined}
        onInstallSkill={async () => ({ ok: true, catalog: EMPTY })}
        onUninstallSkill={async () => ({ ok: true, catalog: EMPTY })}
        onSetSkillEnabled={async () => ({ ok: true, catalog: EMPTY })}
        onAddConnector={async () => ({ ok: true, catalog: EMPTY })}
        onTrustConnector={async () => ({ ok: true, catalog: EMPTY })}
        onAuthorizeConnector={async () => ({ ok: true, catalog: EMPTY })}
        onSetConnectorToolPolicy={async () => ({ ok: true, catalog: EMPTY })}
        onRemoveConnector={async () => ({ ok: true, catalog: EMPTY })}
        onCreateExpert={async () => ({ ok: true, catalog: EMPTY })}
        onRemoveExpert={async () => ({ ok: true, catalog: EMPTY })}
        onPickDirectory={async () => undefined}
        onUsePrompt={vi.fn()}
        onWriteSkill={vi.fn()}
      />,
    );
    expect(screen.getByText('还没有专家')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '＋ 新建专家' })[0]!);
    expect(screen.getByText('新建专家')).toBeTruthy();
  });

  it('清除筛选恢复技能，不再拆成「精选技能」与「推荐」两块重复显示', () => {
    renderPage({
      skills: [
        {
          id: 'report',
          name: '报告整理',
          description: '整理团队周报',
          category: '办公协同',
          source: 'official',
          sourceLabel: '官方内置',
          installed: true,
          featured: true,
          riskLevel: 'p0',
          riskLabel: '低风险',
          findings: [],
        },
      ],
    });
    expect(screen.queryByRole('heading', { name: '精选技能' })).toBeNull();
    const search = screen.getByRole('searchbox', { name: '搜索技能' });
    fireEvent.change(search, { target: { value: '周报' } });
    expect(screen.getAllByRole('button', { name: '管理 · 报告整理' })).toHaveLength(1);
    fireEvent.change(search, { target: { value: '找不到' } });
    fireEvent.click(screen.getByRole('button', { name: '浏览全部技能' }));
    expect((search as HTMLInputElement).value).toBe('');
    expect(screen.getByRole('button', { name: '管理 · 报告整理' })).toBeTruthy();
  });

  it('采用发现 / 我的已装双视图与技能 / 连接器 / 专家三类切换，不渲染套件和 SkillHub Tab', () => {
    renderPage();
    expect(screen.getByRole('tab', { name: '发现' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /我的已装/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '技能' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '连接器' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '专家' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'EvoWork 专家' })).toBeNull();
    expect(screen.queryByRole('tab', { name: '套件' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'SkillHub' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加技能' }));
    expect(screen.getByRole('menuitem', { name: '从目录安装' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '从 Git 安装' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '让 EvoWork 帮我写一个' })).toBeTruthy();
  });

  it('插件 Hub（13 §5.6）：未开启说明与刷新收在右上角弹层；切到「发现」展示精选条目与状态', () => {
    renderPage({
      hub: {
        status: HUB_STATUS,
        entries: [
          {
            kind: 'skill',
            id: 'minutes',
            version: '1.1.0',
            installedVersion: '1.0.0',
            state: 'needs-reconfirm',
            displayName: '会议纪要',
            description: '整理纪要',
            category: '办公',
            riskLevel: 'p0',
            riskLabel: '低风险',
            license: 'MIT',
            promptVisible: true,
            isNew: false,
            canRollback: false,
            reason: '新增访问：collect.example.com',
          },
          {
            kind: 'skill',
            id: 'gone',
            version: '1.0.0',
            installedVersion: '1.0.0',
            state: 'revoked',
            displayName: '被吊销的',
            description: 'x',
            category: '办公',
            riskLevel: 'p0',
            riskLabel: '低风险',
            license: 'MIT',
            promptVisible: false,
            isNew: false,
            canRollback: false,
            reason: '发现诱导安装外部程序的指令',
          },
        ],
      },
    });
    // 未开启说明不直接飘在「我的已装」主区
    expect(screen.queryByText(HUB_STATUS.caption)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /精选未开启/ }));
    const popover = screen.getByRole('dialog', { name: '精选目录状态' });
    expect(within(popover).getByText(HUB_STATUS.caption)).toBeTruthy();
    fireEvent.click(within(popover).getByRole('button', { name: '刷新' }));
    expect(hubActions.refresh).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('tab', { name: '发现' }));
    expect(screen.getByText('有更新，需重新确认')).toBeTruthy();
    expect(screen.getByText(/新增访问：collect\.example\.com/)).toBeTruthy();
    expect(screen.getByText(/发现诱导安装外部程序的指令/)).toBeTruthy();
    expect(screen.getByText(/按需带入/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新确认并更新' })).toBeTruthy();
  });

  it('未开启精选且目录为空时，「发现」展示清晰空态与操作入口', () => {
    const openSettings = vi.fn();
    renderPage(
      {
        hub: {
          status: HUB_STATUS,
          entries: [],
        },
      },
      'skills',
      { onOpenHubSettings: openSettings },
    );
    fireEvent.click(screen.getByRole('tab', { name: '发现' }));
    expect(screen.getByText('尚未开启 EvoWork 精选')).toBeTruthy();
    expect(screen.getByText(HUB_STATUS.caption)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '去设置开启' }));
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it('同名共享技能可分别打开和停用，显示路径且不提供卸载', async () => {
    const paths = ['/shared/first/SKILL.md', '/shared/second/SKILL.md'];
    const skills = paths.map((skillPath, index) => ({
      id: 'coach',
      name: '工作教练',
      description: `共享副本${index + 1}`,
      category: '未分类',
      source: 'local' as const,
      sourceLabel: '用户共享',
      installed: true,
      featured: false,
      riskLevel: 'p0' as const,
      riskLabel: '低风险',
      findings: [],
      enabled: true,
      scope: 'user' as const,
      skillPath,
      uninstallDisabledReason: '此技能由外部目录管理，可在这里停用。',
    }));
    const setEnabled = vi.fn(async () => ({ ok: true, catalog: { ...EMPTY, skills } }));
    renderPage({ skills }, 'skills', { onSetSkillEnabled: setEnabled });
    expect(screen.getByRole('tab', { name: /我的已装 3/ })).toBeTruthy();
    fireEvent.click(
      within(screen.getByText('共享副本2').closest('.ew-item-card')!).getByRole('button', {
        name: '管理 · 工作教练',
      }),
    );
    expect(screen.getByText(`位置：${paths[1]}`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '卸载' })).toBeNull();
    expect(screen.queryByText('官方内置技能不能卸载。')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith({ path: paths[1], name: 'coach', enabled: false }),
    );
    fireEvent.click(screen.getByRole('button', { name: '返回列表' }));
    fireEvent.click(
      within(screen.getByText('共享副本1').closest('.ew-item-card')!).getByRole('button', {
        name: '管理 · 工作教练',
      }),
    );
    expect(screen.getByText(`位置：${paths[0]}`)).toBeTruthy();
  });

  it('同名同描述的共享副本只显示一张卡，详情可分别选择和停用，不隐藏其他来源', async () => {
    const copies = ['/shared/bucket-a/pdf/SKILL.md', '/shared/bucket-b/pdf/SKILL.md'].map(
      (skillPath) => ({
        id: 'pdf',
        name: 'pdf',
        description: '处理 PDF',
        category: '未分类',
        source: 'local' as const,
        sourceLabel: '用户共享',
        installed: true,
        featured: false,
        riskLevel: 'p0' as const,
        riskLabel: '低风险',
        findings: [],
        enabled: true,
        scope: 'user' as const,
        skillPath,
        uninstallDisabledReason: '由外部目录管理。',
      }),
    );
    const official = {
      ...copies[0]!,
      source: 'official' as const,
      sourceLabel: '官方内置',
      skillPath: '/plugins/pdf/SKILL.md',
      uninstallDisabledReason: undefined,
    };
    const skills = [...copies, official];
    const setEnabled = vi.fn(async () => ({ ok: true, catalog: { ...EMPTY, skills } }));
    renderPage({ skills }, 'skills', { onSetSkillEnabled: setEnabled });
    expect(document.querySelectorAll('.ew-item-card')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: '管理 · pdf' })[0]!);
    expect(screen.getByText(/附带文件可能不同/)).toBeTruthy();
    expect(screen.getByText(`位置：${copies[0]!.skillPath}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '副本 2 · 已启用' }));
    expect(screen.getByText(`位置：${copies[1]!.skillPath}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    await waitFor(() =>
      expect(setEnabled).toHaveBeenCalledWith({
        path: copies[1]!.skillPath,
        name: 'pdf',
        enabled: false,
      }),
    );
    expect(screen.queryByRole('button', { name: '卸载' })).toBeNull();
  });

  it('未知模型窗口只显示参考提示，不把固定基线说成当前模型已超限', () => {
    renderPage({
      skillBudget: { used: 4719, budget: 2560, over: true, basis: 'fallback', enabledCount: 32 },
    });
    expect(screen.getByText('技能目录超过参考预算，尚未取得完整的可用模型窗口信息')).toBeTruthy();
    expect(screen.getByText(/不代表当前模型已超限/)).toBeTruthy();
    expect(screen.getByText(/计入 32 个启用副本/)).toBeTruthy();
    expect(screen.queryByText('已启用技能的目录预计超出预算，部分说明可能被缩短或省略')).toBeNull();
  });

  it('启用的技能超过 prompt 预算 → 显示估算值，不断言当前模型已截断', () => {
    renderPage({
      skillBudget: {
        used: 3000,
        budget: 2560,
        over: true,
        basis: 'available-models',
        contextWindow: 128_000,
      },
    });
    expect(screen.getByText('已启用技能的目录预计超出预算，部分说明可能被缩短或省略')).toBeTruthy();
    expect(screen.getByText(/按可用模型的最小窗口 128,000/)).toBeTruthy();
    expect(screen.getByText(/3,000.*2,560/)).toBeTruthy();
  });
});

it('Hub 组件确认后显示准备状态，等待期间不重复安装，失败后可以重试', async () => {
  const data: CatalogDataView = {
    ...EMPTY,
    hub: {
      status: HUB_STATUS,
      entries: [
        {
          kind: 'skill',
          id: 'deck',
          version: '1.0.0',
          state: 'available',
          displayName: '演示',
          description: '说明',
          category: '办公',
          riskLevel: 'p0',
          riskLabel: '低风险',
          license: 'MIT',
          promptVisible: true,
          isNew: false,
          canRollback: false,
        },
      ],
    },
  };
  let complete: (value: { ok: boolean; catalog: CatalogDataView }) => void = () => undefined;
  const install = vi
    .fn<NonNullable<CatalogPageProps['hubActions']>['install']>()
    .mockResolvedValueOnce({
      ok: false,
      needsConfirm: true,
      catalog: data,
      audit: { skillId: 'deck', level: 'p0', findings: ['需要安装办公组件（约 200 MB）'] },
    })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    )
    .mockResolvedValue({ ok: true, catalog: data });
  renderPage(data, 'skills', { hubActions: { ...hubActions, install } });
  fireEvent.click(screen.getByRole('tab', { name: '发现' }));
  fireEvent.click(screen.getByRole('button', { name: '安装' }));
  await screen.findByRole('dialog');
  expect(screen.getByText('需要安装办公组件（约 200 MB）')).toBeTruthy();
  fireEvent.click(screen.getAllByRole('button', { name: '安装' }).at(-1)!);
  await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/正在安装技能并准备所需组件/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '安装' }));
  expect(install).toHaveBeenCalledTimes(2);
  complete({ ok: false, catalog: data });
  await waitFor(() => expect(screen.queryByText(/正在安装技能并准备所需组件/)).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: '安装' }));
  await waitFor(() => expect(install).toHaveBeenCalledTimes(3));
});
