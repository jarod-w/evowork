/**
 * 技能 · 连接器页（05）。断的是用户看见的东西：Tab、空态、文案，不是中间字段。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { CatalogDataView } from '../src/shared/ipc.js';
import { CatalogPage } from '../src/renderer/views/catalog.js';

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

function renderPage(over: Partial<CatalogDataView> = {}) {
  const data = { ...EMPTY, ...over };
  render(
    <CatalogPage
      data={data}
      tab="skills"
      onTab={() => undefined}
      onInstallSkill={async () => ({ ok: true, catalog: data })}
      onUninstallSkill={async () => ({ ok: true, catalog: data })}
      onAddConnector={async () => ({ ok: true, catalog: data })}
      onTrustConnector={async () => ({ ok: true, catalog: data })}
      onRemoveConnector={async () => ({ ok: true, catalog: data })}
      onCreateExpert={async () => ({ ok: true, catalog: data })}
      onRemoveExpert={async () => ({ ok: true, catalog: data })}
      onPickDirectory={async () => undefined}
      onUsePrompt={vi.fn()}
      onWriteSkill={vi.fn()}
    />,
  );
}

describe('CatalogPage', () => {
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
        onAddConnector={async () => ({ ok: true, catalog: EMPTY })}
        onTrustConnector={async () => ({ ok: true, catalog: EMPTY })}
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

  it('专家 Tab 空态不预置角色包', () => {
    render(
      <CatalogPage
        data={EMPTY}
        tab="experts"
        onTab={() => undefined}
        onInstallSkill={async () => ({ ok: true, catalog: EMPTY })}
        onUninstallSkill={async () => ({ ok: true, catalog: EMPTY })}
        onAddConnector={async () => ({ ok: true, catalog: EMPTY })}
        onTrustConnector={async () => ({ ok: true, catalog: EMPTY })}
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
    expect(screen.getByRole('menuitem', { name: '从文件/目录安装' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '从 Git 安装' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: '让 EvoWork 帮我写一个' })).toBeTruthy();
  });
});
