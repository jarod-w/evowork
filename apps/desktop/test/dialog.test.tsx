/**
 * 01 §5.34 Dialog。
 *
 * 它是仓库里**唯一**的模态实现：在此之前 `library.tsx` 私搭过一个，
 * 两个各写一遍会让"删文件还是删索引"的措辞纪律在其中一处慢慢走样。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Dialog } from '../src/renderer/components/primitives.js';

describe('Dialog', () => {
  it('破坏性动作用 alertdialog —— 读屏用户要在焦点进来之前就被打断', () => {
    render(
      <Dialog
        title="从列表移除"
        variant="danger"
        confirmLabel="移除"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        只解绑，不删文件。
      </Dialog>,
    );
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('普通用途是 dialog', () => {
    render(
      <Dialog title="新建空间" confirmLabel="创建" onConfirm={() => {}} onCancel={() => {}}>
        <input aria-label="名称" />
      </Dialog>,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Esc 关闭（§6.2 的逐层关闭链）', () => {
    const onCancel = vi.fn();
    render(
      <Dialog title="改名" confirmLabel="保存" onConfirm={() => {}} onCancel={onCancel}>
        正文
      </Dialog>,
    );
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('confirmDisabled 时主动作点不动 —— 名字为空就不该能提交', () => {
    const onConfirm = vi.fn();
    render(
      <Dialog
        title="新建空间"
        confirmLabel="创建"
        confirmDisabled
        onConfirm={onConfirm}
        onCancel={() => {}}
      >
        正文
      </Dialog>,
    );
    fireEvent.click(screen.getByText('创建'));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('ItemCard（§5.20）', () => {
  it('角标行存在时渲染出来', async () => {
    const { ItemCard } = await import('../src/renderer/components/primitives.js');
    render(<ItemCard name="季度汇报" description="~/w/q3" badges={['12 个任务', '5 个产物']} />);
    expect(screen.getByText('12 个任务')).toBeTruthy();
  });

  it('warning 态由 data 属性表达，不是内联样式 —— 颜色字面量在这个仓库里是被 lint 拦的', async () => {
    const { ItemCard } = await import('../src/renderer/components/primitives.js');
    const { container } = render(<ItemCard name="旧方案" description="~/old" tone="warning" />);
    expect(container.querySelector('[data-tone="warning"]')).toBeTruthy();
  });

  /*
   * 整张卡都可点（打开详情），而 `action` 插槽（项目页放的是 ⋯ 菜单）**嵌在卡片内部**——
   * 点它的按钮天然会向上冒泡到卡片本身的 `onClick`。这条不是假设：Task 13 接线
   * `onOpenDetail` 之后，projects 页面每一次点「⋯」菜单里的任何一项都会**同时**
   * 打开详情页——两个回调各自都对（菜单选中了正确的项、卡片打开了正确的详情），
   * 合起来是错的（用户只想改名，却被顺带跳到了详情页）。
   */
  it('点 action 插槽（⋯ 菜单）不该顺带触发卡片自己的 onClick', async () => {
    const { ItemCard } = await import('../src/renderer/components/primitives.js');
    const onClick = vi.fn();
    render(
      <ItemCard
        name="季度汇报"
        description="~/w/q3"
        onClick={onClick}
        action={<button type="button">⋯</button>}
      />,
    );
    fireEvent.click(screen.getByText('⋯'));
    expect(onClick).not.toHaveBeenCalled();
  });
});
