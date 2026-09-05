/**
 * 资料库（06）。
 *
 * 两条最该被钉住的：**两种删除的语义不同**（写反了用户丢文件）、
 * **所有者列会自动消失**（否则个人版里那是一整列废信息）。
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Library, formatWhen, type LibraryProps } from '../src/renderer/views/library.js';

const NOW = Date.parse('2026-09-05T10:00:00Z');

const rows = [
  {
    id: '1',
    name: 'Q3汇报.pptx',
    source: 'artifact' as const,
    owner: '我',
    location: '/w/weekly',
    accessedAt: NOW - 3600_000,
    artifactType: 'presentation' as const,
    extension: 'pptx',
  },
  {
    id: '2',
    name: '笔记.md',
    source: 'mine' as const,
    owner: '我',
    location: '我的资料',
    accessedAt: NOW - 7200_000,
    artifactType: 'document' as const,
    extension: 'md',
  },
];

function renderLibrary(over: Partial<LibraryProps> = {}) {
  return render(<Library rows={rows} {...over} />);
}

describe('三栏骨架（截图 4 复刻）', () => {
  it('中栏三个导航项 + 两个树分区', () => {
    renderLibrary();
    for (const label of ['搜索', '最近', '本地产物']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    // 「我的资料」既是树分区名，也是行的"位置"列取值 —— 用分区的按钮定位，不用文本
    expect(screen.getByRole('button', { name: '我的资料' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '团队空间' })).toBeTruthy();
  });

  it('「最近」用**浅色**分段控件（决定已装内容怎么看，01 §5.10）', () => {
    const { container } = renderLibrary();
    expect(container.querySelector('.ew-segmented')?.getAttribute('data-variant')).toBe('light');
  });

  it('**「与我共享」不渲染**（Q19：只读订阅，收件箱不做）', () => {
    renderLibrary();
    expect(screen.getByRole('tab', { name: '最近访问' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '我分享的' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: '与我共享' })).toBeNull();
  });

  it('没订阅团队空间时说清它是只读的', () => {
    renderLibrary();
    expect(screen.getByText(/团队空间是只读的/)).toBeTruthy();
  });

  it('「本地产物」只显示产物来源的行', () => {
    renderLibrary();
    fireEvent.click(screen.getByRole('button', { name: '本地产物' }));
    expect(screen.getByText('Q3汇报.pptx')).toBeTruthy();
    expect(screen.queryByText('笔记.md')).toBeNull();
  });
});

describe('**所有者列在全是「我」时自动隐藏**（06 §3.3）', () => {
  it('个人版里不出现这一列', () => {
    renderLibrary();
    expect(screen.queryByRole('columnheader', { name: '所有者' })).toBeNull();
  });

  it('有团队内容时出现', () => {
    renderLibrary({
      rows: [...rows, { ...rows[0]!, id: '3', owner: '产品组', source: 'team' as const }],
    });
    expect(screen.getByRole('columnheader', { name: '所有者' })).toBeTruthy();
  });
});

describe('**两种删除的语义不同**（写反了用户会丢文件）', () => {
  it('「我的资料」= 真删磁盘文件，且说清不进回收站、不给"同时删文件"选项', () => {
    renderLibrary();
    fireEvent.click(screen.getByLabelText('删除 笔记.md'));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('不进回收站');
    expect(screen.queryByText('同时删除磁盘上的文件')).toBeNull();
    expect(screen.getByRole('button', { name: '删除文件' })).toBeTruthy();
  });

  it('「本地产物」= 只移除索引，**磁盘文件默认保留**，且勾选框不预勾', () => {
    const onDelete = vi.fn();
    renderLibrary({ onDelete });
    fireEvent.click(screen.getByLabelText('删除 Q3汇报.pptx'));

    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('磁盘上的文件会保留');

    const checkbox = screen.getByLabelText('同时删除磁盘上的文件') as HTMLInputElement;
    expect(checkbox.checked, '默认不勾 —— 勾上等于把"移除索引"悄悄变成"删文件"').toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '从资料库移除' }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }), false);
  });

  it('勾了"同时删文件"才把 true 传上去', () => {
    const onDelete = vi.fn();
    renderLibrary({ onDelete });
    fireEvent.click(screen.getByLabelText('删除 Q3汇报.pptx'));
    fireEvent.click(screen.getByLabelText('同时删除磁盘上的文件'));
    fireEvent.click(screen.getByRole('button', { name: '从资料库移除' }));
    expect(onDelete).toHaveBeenCalledWith(expect.anything(), true);
  });
});

describe('分享列表（08 §7.2）', () => {
  it('显示有效期与访问次数，且可撤销', () => {
    const onRevokeShare = vi.fn();
    renderLibrary({
      onRevokeShare,
      shares: [
        {
          id: 'sh_1',
          name: 'Q3汇报.pptx',
          url: 'https://s/x',
          expiresLabel: '还有 3 小时',
          expiringSoon: true,
          accessCount: 4,
        },
      ],
    });
    fireEvent.click(screen.getByRole('tab', { name: '我分享的' }));

    expect(screen.getByText('还有 3 小时')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '撤销分享' }));
    expect(onRevokeShare).toHaveBeenCalledWith('sh_1');
  });

  it('没分享过时的空态解释这个功能怎么用', () => {
    renderLibrary({ shares: [] });
    fireEvent.click(screen.getByRole('tab', { name: '我分享的' }));
    expect(screen.getByText(/先问你一次授权/)).toBeTruthy();
  });
});

describe('本机磁盘占用（Q17：不是云配额）', () => {
  it('文案是「本机占用」+「清理」，**没有「升级」**', () => {
    renderLibrary({
      diskUsage: {
        artifactsBytes: 2e9,
        parseCacheBytes: 1e9,
        indexBytes: 1e8,
        diskFreeBytes: 50e9,
      },
    });
    expect(screen.getByText(/本机占用/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '清理' })).toBeTruthy();
    expect(screen.queryByText(/升级/)).toBeNull();
    expect(screen.getByText(/产物文件本身不会被删除/)).toBeTruthy();
  });
});

describe('筛选与搜索', () => {
  it('类型筛选按 artifact_type 与扩展名', () => {
    renderLibrary();
    fireEvent.click(screen.getByRole('button', { name: '类型筛选' }));
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: /Markdown/ }));
    expect(screen.getByText('笔记.md')).toBeTruthy();
    expect(screen.queryByText('Q3汇报.pptx')).toBeNull();
  });

  it('搜索没结果时的空态给出下一步', () => {
    renderLibrary();
    fireEvent.click(screen.getByRole('button', { name: '搜索' }));
    fireEvent.change(screen.getByLabelText('搜索资料'), { target: { value: 'zzz' } });
    expect(screen.getByText('没有匹配的资料')).toBeTruthy();
    expect(screen.queryByText(/暂无/)).toBeNull();
  });
});

describe('相对时间', () => {
  it('资料库里「3 天前」比时间戳有用', () => {
    expect(formatWhen(NOW - 30_000, NOW)).toBe('刚刚');
    expect(formatWhen(NOW - 5 * 60_000, NOW)).toBe('5 分钟前');
    expect(formatWhen(NOW - 3 * 3600_000, NOW)).toBe('3 小时前');
    expect(formatWhen(NOW - 3 * 86400_000, NOW)).toBe('3 天前');
    expect(formatWhen(Date.parse('2025-01-02T00:00:00Z'), NOW)).toBe('2025-01-02');
  });
});
