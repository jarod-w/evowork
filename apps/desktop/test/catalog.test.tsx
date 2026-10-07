/**
 * 技能 · 连接器页（05）。断的是用户看见的东西：Tab、空态、文案，不是中间字段。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      onInstallBundle={async () => ({ ok: true, catalog: data })}
      onUninstallBundle={async () => ({ ok: true, catalog: data })}
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
  it('技能空态如实说随包目录没装上，不编一套演示技能', () => {
    renderPage();
    expect(screen.getByText('还没有可安装的技能')).toBeTruthy();
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
        onInstallBundle={async () => ({ ok: true, catalog: EMPTY })}
        onUninstallBundle={async () => ({ ok: true, catalog: EMPTY })}
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
    fireEvent.click(screen.getByText('日历'));
    expect(screen.getByText('授权状态：尚未授权')).toBeTruthy();
    expect(screen.getByText('search_events')).toBeTruthy();
    expect(screen.getByRole('button', { name: '去授权' })).toBeTruthy();
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
        onInstallBundle={async () => ({ ok: true, catalog: EMPTY })}
        onUninstallBundle={async () => ({ ok: true, catalog: EMPTY })}
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

  it('添加技能有三项入口，没有 SkillHub Tab', () => {
    renderPage();
    expect(screen.getByRole('tab', { name: '推荐' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '套件' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'SkillHub' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加技能' }));
    expect(screen.getByRole('menuitem', { name: '从目录安装' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '从 Git 安装' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '让 EvoWork 帮我写一个' })).toBeTruthy();
  });

  it('插件 Hub（13 §5.6）：caption 常驻说明为什么只有随包内容；来源筛选切到精选后，状态写在卡上', () => {
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
    expect(screen.getByText(HUB_STATUS.caption)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(hubActions.refresh).toHaveBeenCalled();
    fireEvent.click(screen.getByText('EvoWork 精选', { selector: 'button, button *' }));
    expect(screen.getByText('有更新，需重新确认')).toBeTruthy();
    expect(screen.getByText(/新增访问：collect\.example\.com/)).toBeTruthy();
    expect(screen.getByText(/发现诱导安装外部程序的指令/)).toBeTruthy();
    expect(screen.getByText('按需带入')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新确认并更新' })).toBeTruthy();
  });

  it('启用的技能超过 prompt 预算 → 技能页常驻 warning（不静默截断）', () => {
    renderPage({
      skillBudget: {
        used: 3000,
        budget: 2560,
        over: true,
        warning: '已启用的技能太多，模型将看不到部分技能的说明',
      },
    });
    expect(screen.getByText('已启用的技能太多，模型将看不到部分技能的说明')).toBeTruthy();
  });
});
