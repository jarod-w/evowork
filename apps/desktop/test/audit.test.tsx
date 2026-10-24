/** 审计页：界面与导出均不包含正文（10 §6）。 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { HARD_BLOCK_RULES } from '@evowork/policy';
import { describe, expect, it, vi } from 'vitest';

import {
  ACTION_LABEL,
  AuditPage,
  PATH_KIND_LABEL,
  toCsv,
  toJsonl,
  type AuditRow,
} from '../src/renderer/views/audit.js';

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

  it('每一条硬拦截规则都有人话分类 —— 以后加规则忘了配，审计页就会露出枚举名', () => {
    const missing = HARD_BLOCK_RULES.map((rule) => rule.name).filter(
      (name) => PATH_KIND_LABEL[name] === undefined,
    );
    expect(missing).toEqual([]);
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
  /*
   * 2026-09-06 改动：页面收的是**校验结论**（`chainVerdict`）而不是原始链。
   *
   * 校验挪去了主进程，两条理由：① `verifyChain` 依赖 `node:crypto`，
   * 渲染进程是浏览器环境、根本跑不起来（这一页被挂进 `app.tsx` 那一刻才暴露）；
   * ② 完整性校验读的是权威表，本来就该由持有权威数据的那一层做。
   *
   * 这条断言仍然守着同一件事：**链对不上要醒目告知**。
   * `dayChainHash` / `verifyChain` 的正确性由 `services/policy` 自己的测试覆盖。
   */
  it('链对不上时**醒目告知**', () => {
    render(<AuditPage records={records} now={NOW} chainVerdict={{ ok: false, brokenDays: 0 }} />);
    expect(screen.getByRole('alert').textContent).toContain('有记录被删改过');
  });

  it('链对得上时不打扰用户', () => {
    render(<AuditPage records={records} now={NOW} chainVerdict={{ ok: true }} />);
    expect(screen.queryByText(/被删改过/)).toBeNull();
  });

  it('没给结论时也不打扰 —— "没校验"不等于"校验失败"', () => {
    render(<AuditPage records={records} now={NOW} />);
    expect(screen.queryByText(/被删改过/)).toBeNull();
  });

  it('**到期前提示**再清理，而不是到点静默删掉', () => {
    render(<AuditPage records={records} now={NOW} oldestAt={NOW - 87 * 86400_000} />);
    expect(screen.getByText(/天到期并被自动清理/)).toBeTruthy();
  });
});
