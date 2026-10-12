import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuditFindings } from '../src/renderer/components/audit-findings.js';
import { SkillInstallDialog } from '../src/renderer/components/skill-install-dialog.js';

const findings = Array.from(
  { length: 40 },
  (_, i) => `scripts/vendor/file-${i}.py 会执行命令或脚本。`,
);

describe('长安装审计', () => {
  it('汇总重复能力，域名、组件安装和高风险提示保留；原始文件明细可展开', () => {
    const extra = [
      '会访问 www.kimi.com',
      '需要安装办公组件（约 200 MB）',
      '存在工作空间外目录访问',
    ];
    render(<AuditFindings findings={[...findings, ...extra]} />);
    expect(screen.getByText('发现 40 项命令或脚本执行提示。')).toBeTruthy();
    for (const text of extra) expect(screen.getAllByText(text)).toHaveLength(2);
    const details = screen.getByText('查看完整审计明细（43 项）').closest('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelectorAll('li')).toHaveLength(43);
    fireEvent.click(details.querySelector('summary')!);
    expect(details.open).toBe(true);
    expect(details.textContent).toContain(findings[39]);
  });

  it('附件安装仍需明确确认，高风险仍需输入准确技能名', () => {
    const confirm = vi.fn();
    render(
      <SkillInstallDialog
        audit={{
          skillId: 'deck',
          level: 'p2',
          findings,
          worstCase: '可以访问工作空间之外的文件。',
        }}
        onCancel={vi.fn()}
        onConfirm={confirm}
      />,
    );
    expect(screen.getByText('可以访问工作空间之外的文件。')).toBeTruthy();
    const button = screen.getByRole('button', { name: '安装为全局技能' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'deck' } });
    fireEvent.click(button);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
