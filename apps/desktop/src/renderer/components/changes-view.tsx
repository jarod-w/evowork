/**
 * 结果区「变更」视图（04 §6.3）。
 *
 * 数据来自 `turn/diff/updated`（聚合 diff 字符串）+ 各 `FileChange` item。
 *
 * ## 撤销与回滚的二次确认必须说清"会不会动磁盘上的文件"
 *
 * 04 §6.3 对 `thread/revert` / `thread/rollback` 只写了"二次确认并说清影响范围"，
 * 而在 Q1=A（纯本地）下这句话有一个具体答案，且两个动作的答案不一样：
 *
 *   · **撤销某次变更** = 把那次文件改动从磁盘上退回去 → **会动磁盘**
 *   · **回滚到某个回合** = 把对话退回那一刻 → **只动对话，不碰磁盘**
 *
 * 把这两句写死在组件里而不是交给调用方传文案，是因为这正是用户不敢点的地方：
 * 文案一旦由调用方拼，早晚会有一处拼反，而拼反的代价是用户丢文件。
 */
import { useMemo, useState } from 'react';

import { EmptyState, PillButton, SegmentedControl } from './primitives.js';

export interface ChangedFile {
  readonly path: string;
  readonly added: number;
  readonly removed: number;
  /** 统一 diff 文本（`turn/diff/updated` 的片段） */
  readonly diff: string;
  readonly outsideWorkspace?: boolean | undefined;
}

export type DiffScope = 'turn' | 'thread';
export type DiffLayout = 'unified' | 'split';

/** 撤销 = 动磁盘；回滚 = 只动对话。文案与这个映射绑死。 */
export const REVERT_COPY = {
  revert: {
    title: '撤销这次文件变更？',
    body: '这会把磁盘上的文件改回变更之前的内容。',
    touchesDisk: true,
  },
  rollback: {
    title: '回滚到这个回合？',
    body: '这只把对话退回到那一刻，磁盘上的文件保持现在的样子。',
    touchesDisk: false,
  },
} as const;

export type RevertKind = keyof typeof REVERT_COPY;

export interface ChangesViewProps {
  readonly files: readonly ChangedFile[];
  readonly scope: DiffScope;
  readonly onScopeChange: (scope: DiffScope) => void;
  readonly onRevert?: ((path: string) => void) | undefined;
  readonly onRollback?: ((path: string) => void) | undefined;
}

export function ChangesView(props: ChangesViewProps) {
  const [selected, setSelected] = useState<string | null>(props.files[0]?.path ?? null);
  const [layout, setLayout] = useState<DiffLayout>('unified');
  const [confirm, setConfirm] = useState<{ kind: RevertKind; path: string } | null>(null);

  const current = useMemo(
    () => props.files.find((f) => f.path === selected) ?? props.files[0],
    [props.files, selected],
  );

  if (props.files.length === 0) {
    return (
      <EmptyState
        title="这个任务还没有改动文件"
        hint="agent 写入或修改文件后，这里会列出每个文件的改动并可以逐项撤销。"
      />
    );
  }

  return (
    <div className="ew-changes-view">
      <div className="ew-changes-toolbar">
        <SegmentedControl
          variant="light"
          ariaLabel="变更范围"
          value={props.scope}
          items={[
            { id: 'turn', label: '本回合' },
            { id: 'thread', label: '本任务全部' },
          ]}
          onChange={(id) => props.onScopeChange(id as DiffScope)}
        />
        <SegmentedControl
          variant="light"
          ariaLabel="diff 视图"
          value={layout}
          items={[
            { id: 'unified', label: '统一' },
            { id: 'split', label: '并排' },
          ]}
          onChange={(id) => setLayout(id as DiffLayout)}
        />
      </div>

      <ul className="ew-changed-files">
        {props.files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="ew-changed-file"
              data-selected={file.path === current?.path ? 'true' : undefined}
              data-outside={file.outsideWorkspace ? 'true' : undefined}
              onClick={() => setSelected(file.path)}
            >
              <span className="ew-changed-file-path">{file.path}</span>
              {file.outsideWorkspace ? (
                <span className="ew-changed-file-outside">工作空间之外</span>
              ) : null}
              <span className="ew-diff-added">+{file.added}</span>
              <span className="ew-diff-removed">-{file.removed}</span>
            </button>
          </li>
        ))}
      </ul>

      {current ? (
        <div className="ew-diff" data-layout={layout}>
          <pre className="ew-diff-body">{current.diff}</pre>
          <div className="ew-diff-actions">
            <PillButton onClick={() => setConfirm({ kind: 'revert', path: current.path })}>
              撤销这次变更
            </PillButton>
            <PillButton onClick={() => setConfirm({ kind: 'rollback', path: current.path })}>
              回滚到这个回合
            </PillButton>
          </div>
        </div>
      ) : null}

      {confirm ? (
        <div
          className="ew-revert-confirm"
          role="alertdialog"
          aria-label={REVERT_COPY[confirm.kind].title}
        >
          <p className="ew-revert-confirm-title">{REVERT_COPY[confirm.kind].title}</p>
          <p
            className="ew-revert-confirm-body"
            data-touches-disk={REVERT_COPY[confirm.kind].touchesDisk ? 'true' : 'false'}
          >
            {REVERT_COPY[confirm.kind].body}
          </p>
          <PillButton onClick={() => setConfirm(null)}>取消</PillButton>
          <PillButton
            variant="accent"
            onClick={() => {
              if (confirm.kind === 'revert') props.onRevert?.(confirm.path);
              else props.onRollback?.(confirm.path);
              setConfirm(null);
            }}
          >
            确认
          </PillButton>
        </div>
      ) : null}
    </div>
  );
}
