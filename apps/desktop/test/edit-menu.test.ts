import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  applicationMenuTemplate,
  bindEditContextMenu,
  editContextMenuTemplate,
  menuBarName,
  type EditFlags,
} from '../src/main/edit-menu.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');

const labels = (entries: readonly { type?: string; label?: string }[]) =>
  entries.flatMap((entry) => (entry.label ? [entry.label] : []));

describe('中文编辑菜单', () => {
  it('开发时的包名和 Electron 都显示成 EvoWork', () => {
    expect(menuBarName('EvoWork')).toBe('EvoWork');
    expect(menuBarName('Electron')).toBe('EvoWork');
    expect(menuBarName('@evowork/desktop')).toBe('EvoWork');
    expect(menuBarName(undefined)).toBe('EvoWork');
  });

  it('macOS 菜单栏是中文的，编辑里有复制和粘贴', () => {
    const menu = applicationMenuTemplate({ appName: 'EvoWork', platform: 'darwin' });
    expect(labels(menu)).toEqual(['EvoWork', '编辑', '窗口']);
    const edit = menu.find((entry) => entry.label === '编辑');
    expect(labels(edit?.submenu ?? [])).toEqual([
      '撤销',
      '重做',
      '剪切',
      '复制',
      '粘贴',
      '删除',
      '全选',
    ]);
    expect(labels(menu)).not.toContain('Edit');
  });

  it('右键按系统编辑状态启用复制和粘贴', () => {
    const flags: EditFlags = {
      canUndo: false,
      canRedo: false,
      canCut: false,
      canCopy: true,
      canPaste: true,
      canDelete: false,
      canSelectAll: true,
    };
    const menu = editContextMenuTemplate(flags);
    expect(labels(menu)).toEqual(['撤销', '重做', '剪切', '复制', '粘贴', '删除', '全选']);
    expect(menu.find((entry) => 'role' in entry && entry.role === 'copy')).toMatchObject({
      enabled: true,
    });
    expect(menu.find((entry) => 'role' in entry && entry.role === 'paste')).toMatchObject({
      label: '粘贴',
      enabled: true,
    });
    expect(menu.find((entry) => 'role' in entry && entry.role === 'cut')).toMatchObject({
      enabled: false,
    });
  });

  it('右键事件弹出的就是这套菜单', () => {
    let handler:
      | ((event: { preventDefault(): void }, params: { editFlags?: Partial<EditFlags> }) => void)
      | undefined;
    const popped: string[] = [];
    bindEditContextMenu(
      {
        on(_event, next) {
          handler = next;
        },
      },
      (template) => {
        popped.push(...labels(template));
      },
    );
    const event = { preventDefault: vi.fn() };
    handler!(event, { editFlags: { canCopy: true, canPaste: true } });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(popped).toContain('复制');
    expect(popped).toContain('粘贴');
  });

  it('真入口和 E2E 启动都装上应用菜单和右键菜单', () => {
    const entry = readFileSync(join(APP, 'src/main/electron-entry.mjs'), 'utf8');
    const boot = readFileSync(join(APP, 'test/e2e/harness/boot.mjs'), 'utf8');
    for (const source of [entry, boot]) {
      expect(source).toContain('setApplicationMenu');
      expect(source).toContain('bindEditContextMenu');
    }
  });
});
