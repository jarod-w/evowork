/**
 * 结果区「变更」视图（04 §6.3）。
 *
 * 核心是一条：**撤销动磁盘、回滚不动磁盘**，两句文案不能拼反。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  ChangesView,
  REVERT_COPY,
  type ChangedFile,
} from '../src/renderer/components/changes-view.js';

const FILES: ChangedFile[] = [
  { path: 'src/report.md', added: 12, removed: 3, diff: '@@ -1 +1 @@\n-旧\n+新' },
  { path: '/etc/hosts', added: 1, removed: 0, diff: '@@\n+1.2.3.4', outsideWorkspace: true },
];

function renderView(over: Partial<Parameters<typeof ChangesView>[0]> = {}) {
  return render(<ChangesView files={FILES} scope="turn" onScopeChange={() => {}} {...over} />);
}

describe('文件列表与 diff', () => {
  it('列出每个文件的 +n/-m，工作空间之外的标注出来', () => {
    renderView();
    expect(screen.getByText('+12')).toBeTruthy();
    expect(screen.getByText('-3')).toBeTruthy();
    expect(screen.getByText('工作空间之外')).toBeTruthy();
  });

  it('切换文件换 diff', () => {
    renderView();
    expect(screen.getByText(/\+新/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /\/etc\/hosts/ }));
    expect(screen.getByText(/1\.2\.3\.4/)).toBeTruthy();
  });

  it('范围与视图两个切换都用**浅色**分段控件（决定已装内容怎么看）', () => {
    renderView();
    const variants = [...document.querySelectorAll('.ew-segmented')].map((n) =>
      n.getAttribute('data-variant'),
    );
    expect(variants).toEqual(['light', 'light']);
    expect(screen.getByRole('tab', { name: '本任务全部' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '并排' })).toBeTruthy();
  });

  it('空态解释这里会出现什么，而不是「暂无数据」', () => {
    renderView({ files: [] });
    expect(screen.getByText('这个任务还没有改动文件')).toBeTruthy();
    expect(screen.queryByText(/暂无/)).toBeNull();
  });
});

describe('撤销与回滚的二次确认（04 §6.3）', () => {
  it('**撤销说清会动磁盘**', () => {
    const onRevert = vi.fn();
    renderView({ onRevert });
    fireEvent.click(screen.getByRole('button', { name: '撤销这次变更' }));

    const dialog = screen.getByRole('alertdialog', { name: REVERT_COPY.revert.title });
    expect(dialog.textContent).toContain('磁盘上的文件改回变更之前');
    expect(
      document.querySelector('.ew-revert-confirm-body')?.getAttribute('data-touches-disk'),
    ).toBe('true');

    expect(onRevert).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(onRevert).toHaveBeenCalledWith('src/report.md');
  });

  it('**回滚说清不动磁盘** —— 这两句拼反的代价是用户丢文件', () => {
    const onRollback = vi.fn();
    renderView({ onRollback });
    fireEvent.click(screen.getByRole('button', { name: '回滚到这个回合' }));

    expect(screen.getByText(/磁盘上的文件保持现在的样子/)).toBeTruthy();
    expect(
      document.querySelector('.ew-revert-confirm-body')?.getAttribute('data-touches-disk'),
    ).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(onRollback).toHaveBeenCalledWith('src/report.md');
  });

  it('两条文案的 touchesDisk 标记与文字互相对得上（钉住这个映射本身）', () => {
    expect(REVERT_COPY.revert.touchesDisk).toBe(true);
    expect(REVERT_COPY.revert.body).toContain('磁盘');
    expect(REVERT_COPY.rollback.touchesDisk).toBe(false);
    expect(REVERT_COPY.rollback.body).toContain('保持现在的样子');
  });

  it('取消就什么都不做', () => {
    const onRevert = vi.fn();
    renderView({ onRevert });
    fireEvent.click(screen.getByRole('button', { name: '撤销这次变更' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onRevert).not.toHaveBeenCalled();
  });
});
