/**
 * 应用菜单和右键编辑菜单。
 *
 * Electron 不设菜单时用一套英文默认菜单，右键则什么都没有。
 * 这里只提供编辑和窗口操作：剪切、复制、粘贴、全选走系统 role，
 * 粘贴因此和 ⌘V 是同一条命令，截图、文件和文字都进现有的 paste 处理。
 * 不在消息上加「复制这条」—— 那是 04 明确不放的产品动作。
 */

export interface EditFlags {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly canCut: boolean;
  readonly canCopy: boolean;
  readonly canPaste: boolean;
  readonly canDelete: boolean;
  readonly canSelectAll: boolean;
}

export type EditMenuEntry =
  | { readonly type: 'separator' }
  | { readonly label: string; readonly role: string; readonly enabled?: boolean };

const NO_EDIT: EditFlags = {
  canUndo: false,
  canRedo: false,
  canCut: false,
  canCopy: false,
  canPaste: false,
  canDelete: false,
  canSelectAll: false,
};

export function normalizeEditFlags(flags: Partial<EditFlags> | undefined): EditFlags {
  return { ...NO_EDIT, ...flags };
}

/** 开发时 `app.getName()` 可能是包名或 Electron，菜单上要显示产品名。 */
export function menuBarName(raw: string | undefined): string {
  if (raw === 'EvoWork') return raw;
  if (!raw || raw === 'Electron' || raw.startsWith('@')) return 'EvoWork';
  return raw;
}

export function editContextMenuTemplate(flags: EditFlags): readonly EditMenuEntry[] {
  return [
    { label: '撤销', role: 'undo', enabled: flags.canUndo },
    { label: '重做', role: 'redo', enabled: flags.canRedo },
    { type: 'separator' },
    { label: '剪切', role: 'cut', enabled: flags.canCut },
    { label: '复制', role: 'copy', enabled: flags.canCopy },
    { label: '粘贴', role: 'paste', enabled: flags.canPaste },
    { label: '删除', role: 'delete', enabled: flags.canDelete },
    { type: 'separator' },
    { label: '全选', role: 'selectAll', enabled: flags.canSelectAll },
  ];
}

export interface EditMenuWindow {
  on(
    event: 'context-menu',
    handler: (
      event: { preventDefault(): void },
      params: { readonly editFlags?: Partial<EditFlags> | undefined },
    ) => void,
  ): void;
}

export function bindEditContextMenu(
  webContents: EditMenuWindow,
  popup: (template: readonly EditMenuEntry[]) => void,
): void {
  webContents.on('context-menu', (event, params) => {
    event.preventDefault();
    popup(editContextMenuTemplate(normalizeEditFlags(params.editFlags)));
  });
}

type AppMenuItem =
  { readonly type: 'separator' } | { readonly label: string; readonly role: string };

export interface AppMenuEntry {
  readonly label: string;
  readonly submenu: readonly AppMenuItem[];
}

export function applicationMenuTemplate(input: {
  readonly appName: string;
  readonly platform: string;
}): readonly AppMenuEntry[] {
  const edit: AppMenuEntry = {
    label: '编辑',
    submenu: [
      { label: '撤销', role: 'undo' },
      { label: '重做', role: 'redo' },
      { type: 'separator' },
      { label: '剪切', role: 'cut' },
      { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' },
      { label: '删除', role: 'delete' },
      { label: '全选', role: 'selectAll' },
    ],
  };
  const windowMenu: AppMenuEntry = {
    label: '窗口',
    submenu: [
      { label: '最小化', role: 'minimize' },
      { label: '关闭', role: 'close' },
      ...(input.platform === 'darwin'
        ? ([{ type: 'separator' }, { label: '前置全部窗口', role: 'front' }] as const)
        : []),
    ],
  };
  if (input.platform === 'darwin') {
    return [
      {
        label: input.appName,
        submenu: [
          { label: `关于 ${input.appName}`, role: 'about' },
          { type: 'separator' },
          { label: '服务', role: 'services' },
          { type: 'separator' },
          { label: `隐藏 ${input.appName}`, role: 'hide' },
          { label: '隐藏其他', role: 'hideOthers' },
          { label: '显示全部', role: 'unhide' },
          { type: 'separator' },
          { label: `退出 ${input.appName}`, role: 'quit' },
        ],
      },
      edit,
      windowMenu,
    ];
  }
  return [{ label: '文件', submenu: [{ label: '退出', role: 'quit' }] }, edit, windowMenu];
}
