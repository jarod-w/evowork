/**
 * 首页（03）。
 *
 * 三条硬规则：chip / 案例卡**写入不发送**、场景切换保留用户显式改过的控件、
 * 运营插槽默认关闭且不接任何回传。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  applyScenarioDefaults,
  DEFAULT_SLOTS,
  Home,
  toPermissionOptions,
  type HomeProps,
  type Scenario,
} from '../src/renderer/views/home.js';

const OFFICE: Scenario = {
  id: 'office',
  name: '日常办公',
  chips: [
    { label: '文档处理', prompt: '帮我处理这些文档：', requiresFile: true },
    { label: '数据分析及可视化', prompt: '分析这份数据并给出可视化：' },
  ],
  defaults: { modelId: 'evowork/deepseek-chat', permissionId: ':workspace', mode: 'craft' },
};

const CODE: Scenario = {
  id: 'code',
  name: '代码开发',
  chips: [{ label: '读一个仓库', prompt: '读一下这个仓库：' }],
  defaults: { modelId: 'evowork/glm-flash', permissionId: ':read-only', mode: 'plan' },
};

function Harness({ over }: { over?: Partial<HomeProps> }) {
  const [value, setValue] = useState('');
  const [scenarioId, setScenarioId] = useState('office');
  return (
    <Home
      heroLine="EvoWork，我帮你"
      scenarios={[OFFICE, CODE]}
      scenarioId={scenarioId}
      onScenarioChange={setScenarioId}
      composer={{ onSend: () => {} }}
      value={value}
      onChange={setValue}
      {...over}
    />
  );
}

describe('Hero 与场景（03 §2 / §3）', () => {
  it('场景用**深色**分段控件（决定页面装什么，01 §5.10 硬规则）', () => {
    render(<Harness />);
    const segmented = document.querySelector('.ew-segmented');
    expect(segmented?.getAttribute('data-variant')).toBe('dark');
    expect(screen.getByRole('tab', { name: '日常办公' })).toBeTruthy();
  });

  it('切换场景整行替换 chips', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: /文档处理/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: '代码开发' }));
    expect(screen.queryByRole('button', { name: /文档处理/ })).toBeNull();
    expect(screen.getByRole('button', { name: /读一个仓库/ })).toBeTruthy();
  });

  it('**chip 只写入 Composer，不发送**（03 §3.2）', () => {
    const onSend = vi.fn();
    render(<Harness over={{ composer: { onSend } }} />);
    fireEvent.click(screen.getByRole('button', { name: /数据分析及可视化/ }));
    expect((screen.getByLabelText('需求输入') as HTMLTextAreaElement).value).toBe(
      '分析这份数据并给出可视化：',
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('声明 `requiresFile` 的 chip 同时打开文件选择器', () => {
    const onPickFile = vi.fn();
    render(<Harness over={{ onPickFile }} />);
    fireEvent.click(screen.getByRole('button', { name: /文档处理/ }));
    expect(onPickFile).toHaveBeenCalled();
  });

  it('⌥1–⌥8 对应前 8 个 chip（03 §3.2）', () => {
    render(<Harness />);
    fireEvent.keyDown(window, { key: '2', altKey: true });
    expect((screen.getByLabelText('需求输入') as HTMLTextAreaElement).value).toBe(
      '分析这份数据并给出可视化：',
    );
  });
});

describe('场景切换时的取值（03 §2.5）', () => {
  it('**用户改过的控件保留用户的值**，其余回落新场景默认值', () => {
    const next = applyScenarioDefaults(
      CODE,
      { modelId: 'evowork/kimi', permissionId: ':workspace', mode: 'ask' },
      { model: true },
    );
    // 模型是用户改过的 → 保留
    expect(next.modelId).toBe('evowork/kimi');
    // 权限和模式没改过 → 跟着新场景走
    expect(next.permissionId).toBe(':read-only');
    expect(next.mode).toBe('plan');
  });

  it('一个都没改过时整组回落', () => {
    const next = applyScenarioDefaults(
      CODE,
      { modelId: 'x', permissionId: 'y', mode: 'craft' },
      {},
    );
    expect(next).toEqual({
      modelId: 'evowork/glm-flash',
      permissionId: ':read-only',
      mode: 'plan',
    });
  });
});

describe('案例位（03 §5）', () => {
  const cases = [
    { id: 'c1', title: '一句话做季度汇报', prompt: '做一份季度汇报 PPT' },
    { id: 'c2', title: '只在代码场景出现', prompt: '读仓库', scenarioId: 'code' },
  ];

  it('按场景过滤，且点击**写入不发送**', () => {
    const onSend = vi.fn();
    render(<Harness over={{ cases, composer: { onSend } }} />);
    expect(screen.queryByText('只在代码场景出现')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /一句话做季度汇报/ }));
    expect((screen.getByLabelText('需求输入') as HTMLTextAreaElement).value).toBe(
      '做一份季度汇报 PPT',
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it('可以关掉整个案例区', () => {
    render(<Harness over={{ cases }} />);
    fireEvent.click(screen.getByRole('button', { name: '关闭案例区' }));
    expect(screen.queryByText('不知道做什么，试试最佳实践案例')).toBeNull();
  });

  it('无封面时降级为图标卡而不是留白（R10：封面总量被限死在 1MB）', () => {
    render(<Harness over={{ cases }} />);
    expect(document.querySelector('.ew-case-cover')?.getAttribute('data-empty')).toBe('true');
  });
});

describe('运营插槽（Q18）', () => {
  it('**只有 showcase 默认开**，其余三个默认关', () => {
    expect(DEFAULT_SLOTS).toEqual({
      titlebarPromo: false,
      activityPopover: false,
      sidebarPromo: false,
      showcase: true,
    });
  });

  it('默认不渲染标题栏运营位', () => {
    render(<Harness />);
    expect(document.querySelector('[data-slot="titlebar-promo"]')).toBeNull();
  });

  it('开启后也只是一个静态容器 —— **没有任何回传埋点**（Q18）', () => {
    render(<Harness over={{ slots: { titlebarPromo: true } }} />);
    const slot = document.querySelector('[data-slot="titlebar-promo"]');
    expect(slot).not.toBeNull();
    // 插槽上不挂事件：挂了就等于开了行为回传通道，而 Q18 明确不做
    expect(slot?.getAttribute('onclick')).toBeNull();
    expect(slot?.children.length).toBe(0);
  });
});

describe('权限档位映射（F4 / 10 §2）', () => {
  it('`allowed:false` 保留并带原因，不被过滤掉', () => {
    const options = toPermissionOptions(
      [
        { id: ':workspace', allowed: true, description: '可写工作空间' },
        { id: ':danger-full-access', allowed: false },
      ],
      (id) => (id === ':workspace' ? '默认可写' : '完全访问'),
    );
    expect(options).toHaveLength(2);
    expect(options[1]?.allowed).toBe(false);
    expect(options[1]?.disabledReason).toBe('已被企业策略锁定');
  });
});

describe('配置损坏（03 §8）', () => {
  it('回落场景时给提示而不是白屏', () => {
    render(<Harness over={{ configNotice: '场景配置读不出来，已回落到「日常办公」。' }} />);
    expect(screen.getByText(/已回落到「日常办公」/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: '日常办公' })).toBeTruthy();
  });
});
