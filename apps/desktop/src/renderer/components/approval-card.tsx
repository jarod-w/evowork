/**
 * 审批卡（10 §3 的四种子类型）+ 待确认吸顶条（10 §3.5）。
 *
 * ## 六条设计原则里最吃劲的两条（10 §1）
 *
 * 1. **每个审批都要能在 3 秒内判断** —— 所以「为什么需要确认」是必填的，
 *    它来自 `execpolicy` 的判定理由。**没有理由的审批等于让用户瞎点**（10 §3.2 原话）。
 * 2. **说清最坏后果，不说机制名** —— 不写「将使用 `SandboxPolicy::DangerFullAccess`」，
 *    写「可以读写这台电脑上的任何文件」。
 *
 * ## 三个不可放宽的细节
 *
 * · **命令超长时单行截断 + 「查看完整命令」，绝不省略中间部分**（10 §3.2）——
 *   中间省略号是注入攻击的最佳藏身处。
 * · **「本次任务内都允许」对批量变更不提供**（10 §3.3），由适配层的
 *   `allowsAcceptForSession` 判定，前端不自己判断。
 * · **Cancel 与 Decline 要分清**：前者结束整个动作，后者只拒绝这一次、agent 可换路。
 */
import { useState } from 'react';

import { Badge, PillButton } from './primitives.js';

export type ApprovalKind = 'command' | 'fileChange' | 'permissions' | 'userInput';
export type ApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface ApprovalViewModel {
  readonly id: string;
  readonly kind: ApprovalKind;
  readonly threadId: string;
  /** 「为什么需要确认」——必填（10 §3.2）。缺它时组件会显式说明缺失，而不是留空 */
  readonly reason?: string | undefined;
  readonly command?: string | undefined;
  readonly cwd?: string | undefined;
  readonly changes?: readonly {
    readonly path: string;
    readonly kind?: string | undefined;
    readonly outsideWorkspace?: boolean | undefined;
  }[];
  readonly paths?: readonly { readonly path: string; readonly access: string }[] | undefined;
  readonly networkTargets?: readonly string[] | undefined;
  readonly purpose?: string | undefined;
  readonly question?: string | undefined;
  readonly options?: readonly { readonly id: string; readonly label?: string }[] | undefined;
  /** 由适配层决定是否提供「本次任务内都允许」（10 §3.3） */
  readonly allowAcceptForSession: boolean;
  /** 已等待时长（10 §3.6：30 分钟后在列表里置顶并显示等待时间） */
  readonly waitedMs?: number | undefined;
  /** 无人值守（定时任务）：会在 10 分钟后自动拒绝，卡上要说清楚 */
  readonly unattended?: boolean | undefined;
}

/** 命令超长时的截断长度。**只截尾部，不省略中间**。 */
const COMMAND_PREVIEW_LIMIT = 160;

function CommandBody({ approval }: { readonly approval: ApprovalViewModel }) {
  const [full, setFull] = useState(false);
  const command = approval.command ?? '';
  const tooLong = command.length > COMMAND_PREVIEW_LIMIT;
  // 只截尾部：中间省略号是注入攻击的最佳藏身处（10 §3.2）
  const shown = full || !tooLong ? command : `${command.slice(0, COMMAND_PREVIEW_LIMIT)}…`;
  return (
    <>
      <pre className="ew-approval-command">$ {shown}</pre>
      {approval.cwd ? <p className="ew-approval-cwd">在 {approval.cwd}</p> : null}
      {tooLong ? (
        <button type="button" className="ew-item-action" onClick={() => setFull((v) => !v)}>
          {full ? '收起' : '查看完整命令'}
        </button>
      ) : null}
    </>
  );
}

function FileChangeBody({ approval }: { readonly approval: ApprovalViewModel }) {
  // 工作空间外的文件用 --warning 标注并**排在最前**（10 §3.3）
  const changes = [...(approval.changes ?? [])].sort(
    (a, b) => Number(b.outsideWorkspace ?? false) - Number(a.outsideWorkspace ?? false),
  );
  return (
    <ul className="ew-approval-changes">
      {changes.map((change, index) => (
        <li
          key={index}
          data-outside={change.outsideWorkspace ? 'true' : undefined}
          data-kind={change.kind}
        >
          <span className="ew-change-path">{change.path}</span>
          {change.kind === 'delete' ? <Badge variant="danger">删除</Badge> : null}
          {change.outsideWorkspace ? <Badge variant="warning">工作空间之外</Badge> : null}
        </li>
      ))}
    </ul>
  );
}

export function ApprovalCard({
  approval,
  onDecide,
  onAnswer,
}: {
  readonly approval: ApprovalViewModel;
  readonly onDecide: (decision: ApprovalDecision) => void;
  readonly onAnswer?: (answer: {
    readonly optionId?: string;
    readonly text?: string;
  }) => void | undefined;
}) {
  const [draft, setDraft] = useState('');
  const isQuestion = approval.kind === 'userInput';
  const dangerous = (approval.changes ?? []).some((c) => c.kind === 'delete');

  return (
    <section
      className="ew-approval-card"
      // 10 §8.1：审批卡用 role="alertdialog" 且焦点自动落到卡上
      role="alertdialog"
      aria-label={isQuestion ? '需要你回答' : '需要你确认'}
      data-kind={approval.kind}
      data-tone={dangerous ? 'danger' : 'warning'}
    >
      <header className="ew-approval-header">
        <strong>{isQuestion ? '需要你回答' : '需要你确认'}</strong>
        {approval.unattended ? (
          // 定时任务的审批超时 10 分钟自动拒绝（10 §3.6）——必须在卡上说清楚
          <Badge variant="warning">无人值守 · 10 分钟后自动取消</Badge>
        ) : null}
        {approval.waitedMs !== undefined && approval.waitedMs >= 30 * 60_000 ? (
          <Badge variant="neutral">已等待 {Math.floor(approval.waitedMs / 60_000)} 分钟</Badge>
        ) : null}
      </header>

      {approval.kind === 'command' ? <CommandBody approval={approval} /> : null}
      {approval.kind === 'fileChange' ? <FileChangeBody approval={approval} /> : null}

      {approval.kind === 'permissions' ? (
        <div className="ew-approval-permissions">
          <ul>
            {(approval.paths ?? []).map((entry, index) => (
              <li key={`p${index}`}>
                {entry.path} · {entry.access}
              </li>
            ))}
            {(approval.networkTargets ?? []).map((target, index) => (
              <li key={`n${index}`}>{target} · HTTPS</li>
            ))}
          </ul>
          {approval.purpose ? (
            <p className="ew-approval-purpose">用途：{approval.purpose}</p>
          ) : null}
        </div>
      ) : null}

      {isQuestion ? (
        <div className="ew-approval-question">
          <p>{approval.question}</p>
          {(approval.options ?? []).length > 0 ? (
            <div className="ew-approval-options">
              {(approval.options ?? []).map((option) => (
                <PillButton key={option.id} onClick={() => onAnswer?.({ optionId: option.id })}>
                  {option.label ?? option.id}
                </PillButton>
              ))}
            </div>
          ) : (
            <>
              <textarea
                className="ew-approval-answer"
                aria-label="回答"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              <PillButton variant="accent" onClick={() => onAnswer?.({ text: draft })}>
                回答
              </PillButton>
            </>
          )}
        </div>
      ) : (
        <>
          {/* 「为什么需要确认」是必填的（10 §3.2）。缺失时**显式说明缺失** ——
              留空会让用户以为这次审批没有理由，那正是"让用户瞎点"的开始 */}
          <p className="ew-approval-reason">
            为什么需要确认：
            {approval.reason ?? '（执行内核没有给出理由 —— 这本身值得警惕，建议先拒绝）'}
          </p>
          <footer className="ew-approval-actions">
            {/* 范围最小化：默认按钮是"允许这一次"（10 §3.4） */}
            <PillButton variant="accent" onClick={() => onDecide('accept')}>
              允许这一次
            </PillButton>
            {approval.allowAcceptForSession ? (
              <PillButton onClick={() => onDecide('acceptForSession')}>本次任务内都允许</PillButton>
            ) : null}
            <PillButton onClick={() => onDecide('decline')}>拒绝</PillButton>
            {/* Cancel 与 Decline 要分清：前者结束整个动作（10 §3.1） */}
            <PillButton variant="ghost" onClick={() => onDecide('cancel')}>
              结束这个动作
            </PillButton>
          </footer>
        </>
      )}
    </section>
  );
}

/**
 * 待确认吸顶条（10 §3.5）。
 *
 * 审批卡内联在时间线上，但用户可能在别的页面 —— 所以对话区顶部要有 `z-400` 的吸顶条。
 * **多个待审批按到达顺序逐个处理，不做"全部允许"**（10 §3.5 最后一句）。
 */
export function PendingApprovalBar({
  count,
  onJump,
}: {
  readonly count: number;
  readonly onJump: () => void;
}) {
  if (count === 0) return null;
  return (
    <div className="ew-approval-bar" role="status">
      <span>有 {count} 项待你确认</span>
      <PillButton onClick={onJump}>跳到第一项 ↓</PillButton>
      {/* 这里刻意没有"全部允许" —— 10 §3.5 明确不做 */}
    </div>
  );
}
