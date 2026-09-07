/**
 * 项目列表页（02 §4.3，目录式）。
 *
 * ## 这一页最容易写错的两条
 *
 * ① **「从列表移除」是解绑，不是删除**。确认文案必须说清 —— 写反了用户丢文件，
 *    而这是他在这一页能做的唯一不可逆的事（其实它可逆，正因为可逆才必须说明白）。
 * ② **路径失效不静默处理**。整卡转 warning，菜单里做不了的事禁用**并给原因**：
 *    灰掉一个按钮而不说为什么，用户只会觉得程序坏了。
 *
 * ## 第三条：菜单与对话框不能互相留下孤儿
 *
 * `⋯` 菜单（`Popover`）与 `Dialog` 都能被 Esc 关掉，而且能同时挂载 —— 比如
 * 打开了某张卡的菜单之后，不经过菜单直接点标题栏「新建空间」。如果打开对话框时
 * 不顺手关掉还开着的菜单，`openMenuId` 会一直留着：对话框在视觉上盖住了菜单，
 * 关掉对话框后菜单却"凭空"变回打开状态 —— 这是背后的孤儿状态，不是 Esc 本身的锅。
 * 所以每一处「打开对话框」都经过 `openDialog`，统一先清 `openMenuId` 再设 `pending`。
 */
import { useMemo, useState } from 'react';

import type { ProjectCardView } from '../../shared/ipc.js';
import { Menu, Popover } from '../components/menu.js';
import {
  Dialog,
  EmptyState,
  IconButton,
  ItemCard,
  PillButton,
  SearchInput,
} from '../components/primitives.js';

export interface ProjectsPageProps {
  readonly projects: readonly ProjectCardView[];
  readonly onCreate: (input: { readonly name: string; readonly path: string }) => void;
  readonly onImport: () => void;
  readonly onRename: (input: { readonly id: string; readonly name: string }) => void;
  readonly onRemove: (id: string) => void;
  readonly onOpenFolder: (id: string) => void;
  readonly onNewTaskIn: (id: string) => void;
  readonly onOpenDetail: (id: string) => void;
  /** 新建对话框里的「选择目录」。返回 undefined = 用户取消 */
  readonly onPickDirectory: () => Promise<string | undefined>;
  /** 上一次动作被拒绝的原话（如路径闸门）。**显示出来**，不吞掉 */
  readonly refusal?: string | undefined;
}

const MISSING_REASON = '这个空间的路径已失效，先重新指定再新建任务。';

type Pending =
  | { readonly kind: 'create' }
  | { readonly kind: 'rename'; readonly project: ProjectCardView }
  | { readonly kind: 'remove'; readonly project: ProjectCardView }
  | null;

export function ProjectsPage(props: ProjectsPageProps) {
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<Pending>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftPath, setDraftPath] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return props.projects;
    return props.projects.filter(
      (p) => p.name.toLowerCase().includes(q) || p.rootDisplay.toLowerCase().includes(q),
    );
  }, [props.projects, query]);

  // 打开任何对话框都经过这里：先关掉还开着的行内菜单，再切 pending。
  // 见头注释「第三条」—— 这是唯一能保证两个浮层不会互相留下孤儿的地方。
  const openDialog = (next: Exclude<Pending, null>) => {
    setOpenMenuId(null);
    setPending(next);
  };

  const closeDialog = () => {
    setPending(null);
    setDraftName('');
    setDraftPath('');
  };

  return (
    <div className="ew-page">
      <div className="ew-page-title-bar">
        <span className="ew-page-title">项目</span>
        <SearchInput
          value={query}
          onChange={setQuery}
          placeholder="搜索空间"
          ariaLabel="搜索空间"
        />
        <PillButton onClick={props.onImport}>导入现有文件夹</PillButton>
        <PillButton variant="accent" onClick={() => openDialog({ kind: 'create' })}>
          新建空间
        </PillButton>
      </div>

      <div className="ew-content-column">
        {props.refusal ? <p className="ew-projects-refusal">{props.refusal}</p> : null}

        {props.projects.length === 0 ? (
          <EmptyState
            title="还没有工作空间"
            hint="工作空间是任务实际运行的目录。新建一个，或者把已有的文件夹导进来。"
            action={
              <div className="ew-projects-empty-actions">
                <PillButton variant="accent" onClick={() => openDialog({ kind: 'create' })}>
                  新建空间
                </PillButton>
                <PillButton onClick={props.onImport}>导入现有文件夹</PillButton>
              </div>
            }
          />
        ) : (
          <div className="ew-projects-grid">
            {visible.map((project) => (
              <ItemCard
                key={project.id}
                name={project.name}
                description={project.rootDisplay}
                tone={project.rootMissing ? 'warning' : 'default'}
                badges={
                  project.rootMissing
                    ? ['路径已失效，重新指定']
                    : [
                        `${project.taskCount} 个任务`,
                        `${project.artifactCount} 个产物`,
                        ...(project.recencyLabel !== undefined ? [project.recencyLabel] : []),
                      ]
                }
                onClick={() => props.onOpenDetail(project.id)}
                action={
                  /*
                   * `Popover` **不接触发器**（它只在 open 时渲染 children，定位由外层容器负责，
                   * 见 `menu.tsx` 的头注释）。所以触发器是它的兄弟节点，两者一起包在
                   * 一个定位容器里 —— 照 `task-workspace.tsx` 里行操作菜单的现有写法。
                   */
                  <span className="ew-item-card-menu">
                    <IconButton
                      label={`${project.name} 的更多操作`}
                      icon={<span aria-hidden="true">⋯</span>}
                      onClick={() => setOpenMenuId(project.id)}
                    />
                    <Popover
                      open={openMenuId === project.id}
                      onClose={() => setOpenMenuId(null)}
                      align="end"
                    >
                      <Menu
                        ariaLabel={`${project.name} 的操作`}
                        items={[
                          {
                            id: 'new-task',
                            label: '在此空间新建任务',
                            disabled: project.rootMissing,
                            // `Menu` 在禁用但没给原因时**直接抛错**（`assertDisabledHasReason`），
                            // 所以这两个字段必须成对出现
                            ...(project.rootMissing ? { disabledReason: MISSING_REASON } : {}),
                          },
                          { id: 'open-folder', label: '打开所在文件夹' },
                          { id: 'rename', label: '改名' },
                          { id: 'remove', label: '从列表移除', danger: true },
                        ]}
                        onSelect={(id) => {
                          if (id === 'new-task') {
                            setOpenMenuId(null);
                            props.onNewTaskIn(project.id);
                          }
                          if (id === 'open-folder') {
                            setOpenMenuId(null);
                            props.onOpenFolder(project.id);
                          }
                          if (id === 'rename') {
                            setDraftName(project.name);
                            openDialog({ kind: 'rename', project });
                          }
                          if (id === 'remove') {
                            openDialog({ kind: 'remove', project });
                          }
                        }}
                      />
                    </Popover>
                  </span>
                }
              />
            ))}
          </div>
        )}
      </div>

      {pending?.kind === 'create' ? (
        <Dialog
          title="新建空间"
          confirmLabel="创建"
          confirmDisabled={draftPath === ''}
          onCancel={closeDialog}
          onConfirm={() => {
            props.onCreate({ name: draftName, path: draftPath });
            closeDialog();
          }}
        >
          <label className="ew-dialog-field">
            名称
            <input
              aria-label="名称"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
            />
          </label>
          <label className="ew-dialog-field">
            目录
            <input aria-label="目录" value={draftPath} readOnly />
          </label>
          <PillButton
            onClick={() => {
              void props.onPickDirectory().then((picked) => {
                if (picked === undefined) return;
                setDraftPath(picked);
                // 名字没填过就按目录名预填 —— 绝大多数情况下这就是用户想要的
                if (draftName === '') {
                  setDraftName(picked.slice(picked.lastIndexOf('/') + 1) || picked);
                }
              });
            }}
          >
            选择目录
          </PillButton>
        </Dialog>
      ) : null}

      {pending?.kind === 'rename' ? (
        <Dialog
          title="给空间改名"
          confirmLabel="保存"
          confirmDisabled={draftName.trim() === ''}
          onCancel={closeDialog}
          onConfirm={() => {
            props.onRename({ id: pending.project.id, name: draftName });
            closeDialog();
          }}
        >
          <label className="ew-dialog-field">
            名称
            <input
              aria-label="名称"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
            />
          </label>
        </Dialog>
      ) : null}

      {pending?.kind === 'remove' ? (
        <Dialog
          title="从列表移除"
          variant="danger"
          confirmLabel="移除"
          onCancel={closeDialog}
          onConfirm={() => {
            props.onRemove(pending.project.id);
            closeDialog();
          }}
        >
          {/*
           * 02 §4.3 点名要求这句话：移除**只解绑**。
           * 说反了用户丢文件 —— 而"移除"这个词本身完全可以被理解成删除。
           */}
          「{pending.project.name}」会从这个列表消失，但**不会删除**磁盘上的任何文件。
          这个空间里已经完成的任务与产物索引也都保留。
        </Dialog>
      ) : null}
    </div>
  );
}
