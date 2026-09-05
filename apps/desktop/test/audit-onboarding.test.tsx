/**
 * 审计页（10 §6）与首运行引导（02 §9）。
 *
 * 两页各有一条"写错了后果最重"的：
 *   · 审计页**永远不显示正文**，导出也一样 —— 导出会让内容离开这台电脑；
 *   · 首运行第 ① 屏的隐私措辞**不能夸大成"完全不出网"** —— 模型调用是要出网的。
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { dayChainHash, type AuditRecord } from '@evowork/policy';

import {
  ACTION_LABEL,
  AuditPage,
  PATH_KIND_LABEL,
  toCsv,
  toJsonl,
  type AuditRow,
} from '../src/renderer/views/audit.js';
import {
  blockingReason,
  Onboarding,
  ONBOARDING_STEPS,
  PRIVACY_STATEMENT,
  type OnboardingProps,
  type OnboardingStep,
} from '../src/renderer/views/onboarding.js';

const NOW = Date.parse('2026-09-05T10:00:00Z');

const records: AuditRow[] = [
  {
    id: '1',
    occurredAt: NOW - 3600_000,
    action: 'path.blocked',
    toolName: 'shell',
    actionSummary: '已阻止访问受保护位置（规则 credentials）',
    pathKind: 'credentials',
    pathDigest: 'a1b2c3d4e5f60718',
    decidedBy: 'policy',
  },
  {
    id: '2',
    occurredAt: NOW - 7200_000,
    action: 'tool.pre',
    toolName: 'shell',
    actionSummary: 'pip install openpyxl',
    decidedBy: 'policy',
  },
  {
    id: '3',
    occurredAt: NOW - 10 * 86400_000,
    action: 'permission.decided',
    toolName: 'shell',
    approvalResult: 'accept',
    decidedBy: 'user',
    tokenUsage: 1200,
  },
];

describe('审计页：**永远不显示正文**', () => {
  it('路径以「分类 + 短哈希」呈现，不是路径本身', () => {
    render(<AuditPage records={records} now={NOW} />);
    // 分类是人话，不是枚举名
    expect(PATH_KIND_LABEL.credentials).toBe('密钥与凭据');
    expect(screen.getByText('密钥与凭据')).toBeTruthy();
    expect(screen.getByText('a1b2c3d4')).toBeTruthy();
    // 完整哈希也不显示（一串 64 位对用户没用）
    expect(screen.queryByText('a1b2c3d4e5f60718')).toBeNull();
  });

  it('页面上明说不记正文', () => {
    render(<AuditPage records={records} now={NOW} />);
    expect(screen.getByText(/不记 prompt 正文、文件内容和命令输出/)).toBeTruthy();
  });

  it('**导出的字段与页面上看到的一致，不多给** —— 导出会让内容离开这台电脑', () => {
    const csv = toCsv(records);
    expect(csv).toContain('credentials');
    expect(csv).toContain('a1b2c3d4e5f60718');
    // 表头里没有任何"内容""正文""命令"这类列
    const header = csv.split('\r\n')[0] ?? '';
    for (const forbidden of ['内容', '正文', '输出', 'prompt']) {
      expect(header, `导出表头不该有 ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('CSV 带 BOM —— 没有它 Excel 打开中文会乱码', () => {
    expect(toCsv(records).charCodeAt(0)).toBe(0xfeff);
  });

  it('JSONL 一行一条', () => {
    expect(toJsonl(records).split('\n')).toHaveLength(3);
  });
});

describe('审计页：能被真的用起来（10 §6「用户可见」）', () => {
  it('默认 7 天，切到 30 天能看到更早的记录', () => {
    render(<AuditPage records={records} now={NOW} />);
    expect(screen.queryByText('允许（你）')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '时间范围' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /最近 30 天/ }));
    expect(screen.getByText('允许（你）')).toBeTruthy();
  });

  it('按动作类型筛选', () => {
    render(<AuditPage records={records} now={NOW} />);
    fireEvent.click(screen.getByRole('button', { name: '动作类型' }));
    fireEvent.click(
      within(screen.getByRole('menu')).getByRole('menuitem', {
        name: new RegExp(ACTION_LABEL['path.blocked']),
      }),
    );
    // 筛选后只剩那一条：用行数断言，而不是文本（Badge 与下拉里都有同样的字）
    expect(screen.getAllByRole('row')).toHaveLength(2); // 表头 + 一行
    expect(screen.queryByText('pip install openpyxl')).toBeNull();
  });

  it('导出两种格式都能触发', () => {
    const onExport = vi.fn();
    render(<AuditPage records={records} now={NOW} onExport={onExport} />);
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));
    fireEvent.click(screen.getByRole('button', { name: '导出 JSONL' }));
    expect(onExport.mock.calls.map((c) => c[0])).toEqual(['csv', 'jsonl']);
  });
});

describe('审计页：防篡改与保留期', () => {
  const day = (records_: AuditRecord[]) => ({
    chainHash: dayChainHash({ previousChainHash: '', records: records_ }),
    records: records_,
  });

  it('链对不上时**醒目告知**，并说明导出会带上校验结果', () => {
    const good = day([records[0] as AuditRecord]);
    render(
      <AuditPage
        records={records}
        now={NOW}
        chain={[{ ...good, records: [records[1] as AuditRecord] }]}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('有记录被删改过');
  });

  it('链对得上时不打扰用户', () => {
    render(<AuditPage records={records} now={NOW} chain={[day([records[0] as AuditRecord])]} />);
    expect(screen.queryByText(/被删改过/)).toBeNull();
  });

  it('**到期前提示**再清理，而不是到点静默删掉', () => {
    render(<AuditPage records={records} now={NOW} oldestAt={NOW - 87 * 86400_000} />);
    expect(screen.getByText(/天到期并被自动清理/)).toBeTruthy();
  });
});

/* ─────────────────────────── 首运行引导 ─────────────────────────── */

function OnboardingHarness({ over = {} }: { over?: Partial<OnboardingProps> }) {
  const [step, setStep] = useState<OnboardingStep>(over.step ?? 'welcome');
  return (
    <Onboarding
      step={step}
      onStepChange={setStep}
      workspaces={[]}
      permissionProfiles={[
        { id: 'evowork-workspace', allowed: true },
        { id: 'evowork-ask', allowed: true },
        { id: 'evowork-full', allowed: true },
      ]}
      modelStatus="unchecked"
      runtimeInstalled={false}
      {...over}
    />
  );
}

describe('首运行第 ① 屏：Q3 的对外表达，**措辞不可夸大**', () => {
  it('两件事都讲：执行在本机、模型调用会出网', () => {
    render(<OnboardingHarness />);
    expect(screen.getByText(/都在这台电脑上完成/)).toBeTruthy();
    expect(screen.getByText(/模型调用需要联网/)).toBeTruthy();
  });

  it('**不能写成"完全不出网"** —— 那是骗人，用户从账单就能发现', () => {
    const text = PRIVACY_STATEMENT.join('');
    expect(text).not.toContain('完全不出网');
    expect(text).not.toContain('不联网');
    // 与 Q14 的不落盘承诺口径一致
    expect(text).toContain('不保存');
  });
});

describe('六步引导（02 §9）', () => {
  it('六步齐全，顺序与设计一致', () => {
    expect(ONBOARDING_STEPS).toEqual([
      'welcome',
      'workspace',
      'permissions',
      'model',
      'runtime',
      'done',
    ]);
  });

  it('**没选工作空间时「下一步」禁用并给原因**（01 §6.3）', () => {
    render(<OnboardingHarness over={{ step: 'workspace' }} />);
    const next = screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(next.getAttribute('title')).toContain('先选一个工作空间');
  });

  it('选了之后可以继续', () => {
    render(<OnboardingHarness over={{ step: 'workspace', workspaces: ['/w'] }} />);
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('模型连不上时挡住，并说清**不会自动换一个模型**（03 §8）', () => {
    render(<OnboardingHarness over={{ step: 'model', modelStatus: 'failed' }} />);
    expect(screen.getByRole('alert').textContent).toContain('不会自动换一个模型');
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('权限这一步**不给「完全访问」** —— 它要单独确认且只对当次任务生效', () => {
    render(<OnboardingHarness over={{ step: 'permissions' }} />);
    expect(screen.queryByRole('tab', { name: '完全访问' })).toBeNull();
    expect(screen.getByText(/不在这里设/)).toBeTruthy();
  });
});

describe('**第 ⑤ 步必须可跳过，且说清后果**（R10）', () => {
  it('跳过不被阻塞', () => {
    expect(
      blockingReason({ step: 'runtime', workspaces: ['/w'], modelStatus: 'ok' }),
    ).toBeUndefined();
  });

  it('给两个出路，且说清跳过之后哪类文件用不了', () => {
    const onSkipRuntime = vi.fn();
    render(<OnboardingHarness over={{ step: 'runtime', onSkipRuntime }} />);

    expect(screen.getByRole('button', { name: '现在安装' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '以后再说' }));
    expect(onSkipRuntime).toHaveBeenCalled();

    // 不是"建议安装"，而是"跳过也能用，只有这几类会暂时用不了"
    expect(screen.getByText(/只有 Word \/ Excel \/ PPT \/ PDF 会暂时用不了/)).toBeTruthy();
    expect(screen.getByText(/文本、Markdown、CSV、JSON、压缩包都不需要它/)).toBeTruthy();
  });

  it('已经装了就不再劝', () => {
    render(<OnboardingHarness over={{ step: 'runtime', runtimeInstalled: true }} />);
    expect(screen.getByText('已经装好了。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '以后再说' })).toBeNull();
  });
});
