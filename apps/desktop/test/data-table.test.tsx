import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DataTable } from '../src/renderer/components/panels.js';
import { PillButton } from '../src/renderer/components/primitives.js';

describe('DataTable 的行与控件各自激活', () => {
  it('按钮、链接和输入框不打开行，行本身仍支持点击、Enter 和空格', () => {
    const onOpen = vi.fn();
    const onAction = vi.fn();
    const row = { id: 'one', name: '季度报告' };
    render(
      <DataTable
        ariaLabel="报告"
        rows={[row]}
        onRowClick={onOpen}
        columns={[
          { id: 'name', header: '名称', render: (value) => value.name },
          {
            id: 'controls',
            header: '关联内容',
            render: () => (
              <>
                <a href="#details">详情</a>
                <input aria-label="备注" />
              </>
            ),
          },
        ]}
        rowActions={() => <PillButton onClick={onAction}>分享</PillButton>}
      />,
    );
    const button = screen.getByRole('button', { name: '分享' });
    fireEvent.click(within(button).getByText('分享'));
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.keyDown(button, { key: ' ' });
    fireEvent.click(screen.getByRole('link', { name: '详情' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: ' ' });
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('季度报告'));
    const tr = screen.getByText('季度报告').closest('tr')!;
    fireEvent.keyDown(tr, { key: 'Enter' });
    fireEvent.keyDown(tr, { key: ' ' });
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenLastCalledWith(row);
  });

  it('省略显示的长文本保留完整悬停标题，排序仍使用原始值', () => {
    const path = '/目录/'.repeat(100);
    render(
      <DataTable
        ariaLabel="路径"
        rows={[
          { id: 'b', name: 'B' },
          { id: 'a', name: 'A' },
        ]}
        columns={[
          { id: 'name', header: '名称', render: (row) => row.name, sortValue: (row) => row.name },
          { id: 'path', header: '位置', render: () => path, truncate: true },
        ]}
      />,
    );
    expect(screen.getAllByTitle(path)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '按名称排序' }));
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]?.textContent)).toEqual(['A', 'B']);
  });
});
