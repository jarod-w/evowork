/**
 * Menu / Popover（01 §5.19）。
 *
 * 这组测试守的是窗口边界，而不是某一个 Composer 下拉：审批档、项目、模型、插件、
 * 侧栏行操作都复用 Popover。只在 Composer 上写特例，会让同一个裁剪问题在别处重现。
 */
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Menu, Popover } from '../src/renderer/components/menu.js';

function rect({
  top,
  left,
  width,
  height,
}: {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}): DOMRect {
  return {
    x: left,
    y: top,
    top,
    left,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function renderOpenPopover() {
  const view = render(
    <span data-testid="anchor">
      <button type="button">触发器</button>
      <Popover open onClose={() => {}}>
        <Menu
          ariaLabel="审批档"
          items={[
            { id: 'ask', label: '请求批准', description: '遇到风险操作时询问你' },
            { id: 'auto', label: '帮我批准', description: '仅对风险操作请求批准' },
            { id: 'full', label: '完全访问', description: '可以访问整台电脑' },
          ]}
          onSelect={() => {}}
        />
      </Popover>
    </span>,
  );
  return {
    ...view,
    anchor: view.getByTestId('anchor'),
    popover: view.container.querySelector('.ew-popover') as HTMLDivElement,
  };
}

describe('Popover 窗口边界', () => {
  it('触发器靠近窗口下沿时向上展开，审批档的最后一项仍留在可视区域内', () => {
    const { anchor, popover } = renderOpenPopover();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
    anchor.getBoundingClientRect = () => rect({ top: 520, left: 260, width: 120, height: 32 });
    popover.getBoundingClientRect = () => rect({ top: 0, left: 0, width: 240, height: 180 });

    fireEvent(window, new Event('resize'));

    expect(popover.getAttribute('data-side')).toBe('top');
    expect(popover.getAttribute('data-positioned')).toBe('true');
  });

  it('窗口尺寸变化后重新选择展开方向，同一修复覆盖所有复用 Popover 的菜单', () => {
    const { anchor, popover } = renderOpenPopover();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
    let anchorTop = 520;
    anchor.getBoundingClientRect = () =>
      rect({ top: anchorTop, left: 260, width: 120, height: 32 });
    popover.getBoundingClientRect = () => rect({ top: 0, left: 0, width: 240, height: 180 });

    fireEvent(window, new Event('resize'));
    expect(popover.getAttribute('data-side')).toBe('top');

    anchorTop = 80;
    fireEvent(window, new Event('resize'));
    expect(popover.getAttribute('data-side')).toBe('bottom');
  });
});
