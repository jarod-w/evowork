/**
 * Composer（01 §5.13 结构 + 03 §4 行为）。首页与对话区**共用同一个组件** ——
 * 03 §4.6 要求发送后"输入框留在原地、周围长出了对话"，两处各写一个就做不到。
 *
 * ## 这个组件里有五条不能松的规则
 *
 * 1. **`/` 必须在行首才触发**（03 §4.3）。不加这条，`~/work/a.md` 里的斜杠会弹菜单。
 * 2. **解析中禁止发送**（03 §4.4），且文案要说清"在本机解析" —— 这是 K6/Q3 的对外表达点，
 *    而它必须为真：08 §4 保证没有云端兜底路径。
 * 3. **完全访问必须二次确认**（10 §2.4）。不确认就不改档、也不发送。
 * 4. **`allowed:false` 的档位渲染为禁用并显示原因，不隐藏**（10 §2 / F4）。
 * 5. **模型不可用时不静默降级**（03 §8）：插 danger 提示条 + 禁用发送，而不是换一个模型继续。
 *
 * ## 为什么不用 contentEditable
 *
 * `@` token 在截图里是"不可分割的块"，contentEditable 是最直观的实现。但它带来
 * 选区、输入法、撤销栈三处需要自己重做的行为，而 03 §4.2 真正要的只是
 * "底层同时维护 text + textElements"。所以这里用 `<textarea>` 存文本、
 * 用 `mentions` 数组存结构，渲染时叠一层 token 显示层。
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { renderIcon } from './icons.js';
import { Menu, InlineSelect, ModelSelect, Popover, type ModelOption } from './menu.js';
import { Badge, Banner, Dialog, GhostButton, PillButton } from './primitives.js';

export const COMPOSER_PLACEHOLDER = '输入需求，或描述你想完成的工作';

/** 03 §4.4：K6/Q3 的对外表达点。**这句话必须为真**，改它之前先改 08 §4。 */
export const LOCAL_PARSE_PROMISE = '文件在本机解析，原始文件不上传。';

export type AttachmentKind = 'image' | 'document' | 'code' | 'archive';
export type AttachmentState = 'parsing' | 'ready' | 'failed';

export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly sizeLabel: string;
  readonly state: AttachmentState;
  /** 0–100，仅 `parsing` 时有意义 */
  readonly progress?: number | undefined;
  readonly error?: string | undefined;
  /** 已选择"以原始文件引用"（解析失败后的备选出路，03 §4.4） */
  readonly rawReference?: boolean | undefined;
}

export type MentionCategory = 'file' | 'upload' | 'skill' | 'library';

export interface MentionCandidate {
  readonly id: string;
  readonly label: string;
  /** 技能的协议内部名；非技能候选可省略。 */
  readonly name?: string | undefined;
  readonly category: MentionCategory;
  /** 插入到 `UserInput` 时的形态：技能是 `Skill`，其余是 `Mention`（03 §4.2） */
  readonly insertAs: 'mention' | 'skill';
  readonly path?: string | undefined;
}

const CATEGORY_LABEL: Readonly<Record<MentionCategory, string>> = {
  file: '工作空间文件',
  upload: '已上传附件',
  skill: '技能',
  library: '资料库',
};

export interface SlashCommand {
  readonly id: string;
  readonly label: string;
  /**
   * `skill` = 插入技能并发给模型；`local` = 前端/服务层直接执行，**不发给模型**。
   * 两类在菜单里必须能区分（03 §4.3），否则用户会以为 `/清空` 被当成提示词发出去了。
   */
  readonly kind: 'skill' | 'local';
}

export interface SelectOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  /** F4：`permissionProfile/list` 返回的 `allowed`。false 时禁用并给原因，不隐藏 */
  readonly allowed?: boolean | undefined;
  readonly disabledReason?: string | undefined;
  /** 完全访问用危险色，不包装成"更强模式"（10 §2.4） */
  readonly danger?: boolean | undefined;
}

export type ComposerRunState = 'idle' | 'running' | 'over-budget';
export type ModeId = 'request-approval' | 'approve-for-me' | 'full-access';

export const AUTO_REVIEW_UNAVAILABLE_REASON = '安全自动审查还没接通';

/** 10 §2.4 三项。一句话原样显示。 */
export const MODE_OPTIONS: readonly SelectOption[] = [
  {
    id: 'request-approval',
    label: '请求批准',
    description: '编辑工作空间外的文件或使用互联网时询问你',
  },
  {
    id: 'approve-for-me',
    label: '帮我批准',
    description: '仅对检测到的风险操作请求批准',
  },
  {
    id: 'full-access',
    label: '完全访问',
    description: '可以读写这台电脑上的文件并联网',
    danger: true,
  },
];

export const FULL_ACCESS_CONFIRM = {
  title: '开启完全访问？',
  confirmLabel: '仅当前任务使用完全访问',
  writes: '读写这台电脑上的文件（工作空间内外）',
  network: '使用互联网',
  hardBlock: '系统目录、密钥与凭据、EvoWork 自身配置仍会被拦截，完全访问也不能绕过。',
  scope: '这次确认只对当前任务生效，不会改掉默认档。',
} as const;

/**
 * Composer 审批三档。帮我批准 / 完全访问可按能力置灰，禁用项仍出现在菜单里。
 */
export function composerModeOptions(
  input: {
    readonly approvalsReviewerAvailable?: boolean | undefined;
    readonly fullAccessAllowed?: boolean | undefined;
    readonly fullAccessDisabledReason?: string | undefined;
  } = {},
): readonly SelectOption[] {
  const reviewerOk = input.approvalsReviewerAvailable !== false;
  const fullOk = input.fullAccessAllowed !== false;
  return MODE_OPTIONS.map((option) => {
    if (option.id === 'approve-for-me' && !reviewerOk) {
      return { ...option, allowed: false, disabledReason: AUTO_REVIEW_UNAVAILABLE_REASON };
    }
    if (option.id === 'full-access' && !fullOk) {
      return {
        ...option,
        allowed: false,
        disabledReason: input.fullAccessDisabledReason ?? '当前系统的隔离能力有限，已停用完全访问',
      };
    }
    return { ...option, allowed: true };
  });
}

/** 05 §6：选择器只消费已经能用的插件，不负责安装。 */
export interface ComposerPlugin {
  readonly id: string;
  readonly kind: 'skill' | 'connector';
  readonly displayName: string;
  readonly description: string;
  readonly category: string;
  readonly defaultPrompt?: string | undefined;
}

export interface ComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;

  readonly attachments?: readonly Attachment[] | undefined;
  readonly onRemoveAttachment?: ((id: string) => void) | undefined;
  readonly onReferAsRaw?: ((id: string) => void) | undefined;

  readonly mentionCandidates?: readonly MentionCandidate[] | undefined;
  readonly onSearchMentions?: ((query: string) => Promise<readonly MentionCandidate[]>) | undefined;
  readonly slashCommands?: readonly SlashCommand[] | undefined;
  readonly onRunLocalCommand?: ((id: string) => void) | undefined;
  readonly onInsertReference?: ((candidate: MentionCandidate) => void) | undefined;
  readonly onRunSkillCommand?: ((id: string) => void) | undefined;

  readonly workspaces?: readonly SelectOption[] | undefined;
  readonly workspaceId?: string | undefined;
  readonly onWorkspaceChange?: ((id: string) => void) | undefined;

  readonly permissions?: readonly SelectOption[] | undefined;
  readonly permissionId?: string | undefined;
  readonly onPermissionChange?: ((id: string) => void) | undefined;

  readonly mode?: ModeId | undefined;
  readonly onModeChange?: ((mode: ModeId) => void) | undefined;
  /**
   * 审批三档。不传时用 `composerModeOptions()` 的默认三项。
   * 调用方把「帮我批准未接通 / Windows 停用完全访问」编进 `allowed:false`。
   */
  readonly modeOptions?: readonly SelectOption[] | undefined;

  /** 当前任务是否会贡献新的本地记忆。未创建任务时不显示。 */
  readonly memoryEnabled?: boolean | undefined;
  readonly onMemoryEnabledChange?: ((enabled: boolean) => void) | undefined;

  readonly models?: readonly ModelOption[] | undefined;
  readonly modelId?: string | undefined;
  readonly onModelChange?: ((id: string) => void) | undefined;
  /** 哪些控件被用户显式改过（03 §2.5 的圆点） */
  readonly overrides?:
    Readonly<Partial<Record<'model' | 'permission' | 'mode', boolean>>> | undefined;
  readonly onResetOverride?: ((key: 'model' | 'permission' | 'mode') => void) | undefined;

  readonly runState?: ComposerRunState | undefined;
  readonly onInterrupt?: (() => void) | undefined;
  readonly onAddBudget?: (() => void) | undefined;

  /** 模型不可用（网关不通 / 未登录 / 没配模型）。**不静默降级**（03 §8） */
  readonly modelUnavailable?:
    | {
        readonly text: string;
        readonly reason?: string | undefined;
        readonly onFix?: () => void;
        /** 缺省是「检查模型接入」。没配模型时改成「去设置添加模型」 */
        readonly fixLabel?: string | undefined;
      }
    | undefined;
  /** 网关声明模型不支持音频输入时隐藏麦克风，而不是点了报错（03 §4.7） */
  readonly micAvailable?: boolean | undefined;
  readonly onMic?: (() => void) | undefined;

  /** 04 §5.4 排队追问 */
  readonly queued?: readonly { readonly id: string; readonly text: string }[] | undefined;
  readonly onQueueRemove?: ((id: string) => void) | undefined;
  readonly onQueueUpdate?: ((id: string, text: string) => void) | undefined;
  readonly onQueueMove?: ((id: string, direction: -1 | 1) => void) | undefined;
  /** 04 §5.5「立即插话」：开启时走 `turn/steer` 而非入队。**默认排队** */
  readonly steer?: boolean | undefined;
  readonly onSteerChange?: ((steer: boolean) => void) | undefined;

  /** 本机并发已满（Q11：3）→ 发送按钮变「排队中（前面 N 个）」 */
  readonly queuePosition?: number | undefined;
  readonly onAttach?: (() => void) | undefined;
  readonly onFilesAdded?: ((files: readonly File[]) => void) | undefined;
  /** `+` 菜单中的已接通入口；未提供的动作不会显示。 */
  readonly onOpenLibrary?: (() => void) | undefined;
  readonly onOpenPlugins?: (() => void) | undefined;
  readonly onManagePlugins?: (() => void) | undefined;
  /**
   * 已安装、可信、当前可用的插件。`undefined` 表示目录还在读；
   * 空数组表示读完了但没有可选项（05 §6）。
   */
  readonly plugins?: readonly ComposerPlugin[] | undefined;
  /** 选中后把精确插件引用与默认提示交给外层，不发送。 */
  readonly onUsePlugin?: ((plugin: ComposerPlugin, prompt: string) => void) | undefined;
  /**
   * 策略包超期只读（R11 / 11 §8）。有值时禁用发送并显示这句话。
   * 与 `modelUnavailable` 分开：那条是「检查模型接入」，这条是连企业网更新策略。
   */
  readonly sendLockedReason?: string | undefined;
}

/** 触发中的补全菜单：`@` 统一发现、`$` 显式技能、行首 `/` 本地命令。 */
interface Trigger {
  readonly kind: '@' | '$' | '/';
  /** 触发字符在 `value` 中的下标 */
  readonly start: number;
  readonly query: string;
}

/**
 * 从光标位置反推当前是否处于一个补全触发里。
 *
 * 导出是为了单独测：`/` 的行首约束（03 §4.3）是这里唯一容易写错的地方，
 * 而通过 UI 测它要先造出正确的光标状态，噪音比信号多。
 */
export function detectTrigger(value: string, caret: number): Trigger | null {
  for (let i = caret - 1; i >= 0; i -= 1) {
    const ch = value[i] as string;
    if (ch === '\n' || ch === ' ') break;
    if (ch === '@' || ch === '$' || ch === '/') {
      // `/` 必须在行首（前面只能是字符串开头或换行）。否则 `~/work/a.md` 会误触发
      if (ch === '/' && i !== 0 && value[i - 1] !== '\n') break;
      return { kind: ch, start: i, query: value.slice(i + 1, caret) };
    }
  }
  return null;
}

/** 03 §4.4：解析中的附件数量决定发送是否可用与提示文案。 */
export function parsingCount(attachments: readonly Attachment[]): number {
  return attachments.filter((a) => a.state === 'parsing').length;
}

const MIN_ROWS = 3;
const MAX_ROWS = 12;

export function Composer(props: ComposerProps) {
  const attachments = props.attachments ?? [];
  const runState = props.runState ?? 'idle';
  const mode = props.mode ?? 'request-approval';
  const modeOptions = props.modeOptions ?? composerModeOptions();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const completionListId = useId();
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [addOpen, setAddOpen] = useState(false);
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [confirmFullAccess, setConfirmFullAccess] = useState(false);
  const [searchedMentions, setSearchedMentions] = useState<readonly MentionCandidate[]>([]);

  useEffect(() => {
    if (trigger?.kind !== '@' || trigger.query.trim() === '' || !props.onSearchMentions) {
      setSearchedMentions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void props
        .onSearchMentions?.(trigger.query)
        .then((items) => {
          if (!cancelled) setSearchedMentions(items);
        })
        .catch(() => {
          if (!cancelled) setSearchedMentions([]);
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [props.onSearchMentions, trigger]);

  const parsing = parsingCount(attachments);
  // 解析失败的附件还没有可发送内容；用户选择「以原始文件引用」后才会变成 ready。
  // 否则按钮看似可用，App 层却会因为没有文本或结构化引用而什么都不做。
  const empty =
    props.value.trim() === '' && !attachments.some((attachment) => attachment.state === 'ready');
  const blockedByModel = props.modelUnavailable !== undefined;
  const sendDisabled =
    empty ||
    parsing > 0 ||
    blockedByModel ||
    props.sendLockedReason !== undefined ||
    confirmFullAccess;

  const candidates = useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    if (trigger.kind === '@') {
      const byId = new Map(
        [...(props.mentionCandidates ?? []), ...searchedMentions].map((candidate) => [
          candidate.id,
          candidate,
        ]),
      );
      return [...byId.values()]
        .filter((c) => c.label.toLowerCase().includes(q))
        .map((candidate, order) => ({
          candidate,
          order,
          prefix: candidate.label.toLowerCase().startsWith(q),
        }))
        .sort(
          (left, right) => Number(right.prefix) - Number(left.prefix) || left.order - right.order,
        )
        .map(({ candidate }) => candidate)
        .slice(0, 8);
    }
    if (trigger.kind === '$') {
      return (props.mentionCandidates ?? [])
        .filter((c) => c.category === 'skill' && c.label.toLowerCase().includes(q))
        .slice(0, 8);
    }
    return (props.slashCommands ?? [])
      .filter((c) => c.kind === 'local' && c.label.toLowerCase().includes(q))
      .slice(0, 8);
  }, [trigger, props.mentionCandidates, props.slashCommands, searchedMentions]);

  useEffect(() => {
    setActiveIndex((index) => (index < candidates.length ? index : 0));
  }, [candidates.length]);

  const syncTrigger = useCallback((value: string, caret: number) => {
    setTrigger(detectTrigger(value, caret));
    setActiveIndex(0);
  }, []);

  const insertCompletion = useCallback(
    (label: string, prefix?: '@' | '$' | '/') => {
      if (!trigger) return;
      const before = props.value.slice(0, trigger.start);
      const after = props.value.slice(trigger.start + 1 + trigger.query.length);
      props.onChange(`${before}${prefix ?? trigger.kind}${label} ${after}`);
      setTrigger(null);
    },
    [trigger, props],
  );

  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, props.value.split('\n').length));

  return (
    <section className="ew-composer" aria-label="输入区" data-run-state={runState}>
      {/* 03 §8：模型不可用 → danger 条 + 禁用发送。**不换一个模型继续** */}
      {props.sendLockedReason ? (
        <Banner tone="danger">{props.sendLockedReason}</Banner>
      ) : props.modelUnavailable ? (
        <Banner
          tone="danger"
          action={
            props.modelUnavailable.onFix ? (
              <PillButton onClick={props.modelUnavailable.onFix}>
                {props.modelUnavailable.fixLabel ?? '检查模型接入'}
              </PillButton>
            ) : undefined
          }
        >
          {props.modelUnavailable.text}
        </Banner>
      ) : null}

      {/* 04 §5.4 排队区 */}
      {(props.queued ?? []).length > 0 ? (
        <div className="ew-queue" aria-label="排队中的追问">
          <p className="ew-queue-title">排队中 ({(props.queued ?? []).length})</p>
          <ul className="ew-queue-list">
            {(props.queued ?? []).map((q, index, queued) => (
              <li key={q.id}>
                <span className="ew-queue-text">{q.text}</span>
                {props.onQueueMove ? (
                  <>
                    <button
                      type="button"
                      className="ew-queue-remove"
                      aria-label={`上移排队项：${q.text}`}
                      disabled={index === 0}
                      onClick={() => props.onQueueMove?.(q.id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="ew-queue-remove"
                      aria-label={`下移排队项：${q.text}`}
                      disabled={index === queued.length - 1}
                      onClick={() => props.onQueueMove?.(q.id, 1)}
                    >
                      ↓
                    </button>
                  </>
                ) : null}
                {props.onQueueUpdate ? (
                  <button
                    type="button"
                    className="ew-queue-remove"
                    aria-label={`编辑排队项：${q.text}`}
                    onClick={() => {
                      const next = window.prompt('编辑排队中的输入', q.text);
                      if (next?.trim()) props.onQueueUpdate?.(q.id, next.trim());
                    }}
                  >
                    ✎
                  </button>
                ) : null}
                <button
                  type="button"
                  className="ew-queue-remove"
                  aria-label={`删除排队项：${q.text}`}
                  onClick={() => props.onQueueRemove?.(q.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div
        className="ew-composer-shell"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          const files = [...event.dataTransfer.files];
          if (files.length === 0) return;
          event.preventDefault();
          props.onFilesAdded?.(files);
        }}
      >
        <div className="ew-composer-input-card">
          {attachments.length > 0 ? (
            <>
              <ul className="ew-attachments">
                {attachments.map((a) => (
                  <li key={a.id} className="ew-attachment" data-state={a.state} data-kind={a.kind}>
                    <span className="ew-attachment-name">{a.name}</span>
                    <span className="ew-attachment-size">{a.sizeLabel}</span>
                    {a.state === 'parsing' ? (
                      <span className="ew-attachment-progress">解析中 {a.progress ?? 0}%</span>
                    ) : null}
                    {a.state === 'failed' ? (
                      <>
                        <Badge variant="danger">解析失败</Badge>
                        {/* 失败不是死路：让 agent 自己用 shell 试（03 §4.4） */}
                        <button
                          type="button"
                          className="ew-attachment-fallback"
                          onClick={() => props.onReferAsRaw?.(a.id)}
                        >
                          以原始文件引用
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="ew-attachment-remove"
                      aria-label={`移除附件：${a.name}`}
                      onClick={() => props.onRemoveAttachment?.(a.id)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
              <p className="ew-privacy-note">{LOCAL_PARSE_PROMISE}</p>
            </>
          ) : null}

          <textarea
            ref={textareaRef}
            className="ew-composer-textarea"
            aria-label="需求输入"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={Boolean(trigger && candidates.length > 0)}
            aria-controls={trigger && candidates.length > 0 ? completionListId : undefined}
            aria-activedescendant={
              trigger && candidates[activeIndex]
                ? `${completionListId}-option-${activeIndex}`
                : undefined
            }
            placeholder={COMPOSER_PLACEHOLDER}
            rows={rows}
            value={props.value}
            onChange={(event) => {
              props.onChange(event.target.value);
              syncTrigger(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length,
              );
            }}
            onPaste={(event) => {
              const files = [...event.clipboardData.files];
              if (files.length === 0) return;
              event.preventDefault();
              props.onFilesAdded?.(files);
            }}
            onKeyDown={(event) => {
              if (trigger && candidates.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setActiveIndex((i) => (i + 1) % candidates.length);
                  return;
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveIndex((i) => (i - 1 + candidates.length) % candidates.length);
                  return;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault();
                  const chosen = candidates[activeIndex];
                  if (chosen) applyCandidate(chosen);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setTrigger(null);
                  return;
                }
              }
              // ⏎ 发送，⇧⏎ 换行（截图与常规一致）
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (!sendDisabled) props.onSend();
              }
              // 04 §5.5：⌘. / Esc 中断
              if (
                runState === 'running' &&
                (event.key === 'Escape' || (event.metaKey && event.key === '.'))
              ) {
                event.preventDefault();
                props.onInterrupt?.();
              }
            }}
          />

          {trigger && candidates.length > 0 ? (
            <div className="ew-completion" data-kind={trigger.kind === '@' ? 'mention' : 'command'}>
              <Menu
                id={completionListId}
                semanticRole="listbox"
                itemId={(_item, index) => `${completionListId}-option-${index}`}
                ariaLabel={
                  trigger.kind === '@' ? '引用候选' : trigger.kind === '$' ? '技能候选' : '本地指令'
                }
                activeId={candidates[activeIndex]?.id}
                items={candidates.map((c) =>
                  'category' in c
                    ? {
                        id: c.id,
                        label: c.label,
                        group: CATEGORY_LABEL[c.category],
                        description: CATEGORY_LABEL[c.category],
                      }
                    : {
                        id: c.id,
                        label: c.label,
                        group: c.kind,
                        // 本地指令必须与技能可区分：不加这个标注，用户会以为 `/清空` 发给了模型
                        description: c.kind === 'local' ? '本地指令 · 不发送给模型' : '技能',
                      },
                )}
                onSelect={(id) => {
                  const chosen = candidates.find((c) => c.id === id);
                  if (chosen) applyCandidate(chosen);
                }}
              />
            </div>
          ) : null}

          <div className="ew-composer-tool-row">
            <span className="ew-composer-add-anchor">
              <button
                type="button"
                className="ew-composer-attach"
                aria-label="添加内容"
                aria-expanded={addOpen || pluginsOpen}
                onClick={() => {
                  setPluginsOpen(false);
                  setAddOpen((value) => !value);
                }}
              >
                {renderIcon('plus')}
              </button>
              <Popover open={addOpen} onClose={() => setAddOpen(false)}>
                {/*
                 * 「更多选项 / 权限」暂不进菜单：`bridge.send` 还不传
                 * permissionId，选了也不会进 turn/start。接上后再加回来。
                 */}
                <Menu
                  ariaLabel="添加内容"
                  items={[
                    ...(props.onAttach
                      ? [
                          {
                            id: 'attach',
                            label: '添加本地文件',
                            description: LOCAL_PARSE_PROMISE,
                            group: 'content',
                          },
                        ]
                      : []),
                    ...(props.onOpenLibrary
                      ? [
                          {
                            id: 'library',
                            label: '打开资料库',
                            description: '查找本机资料与产物',
                            group: 'content',
                          },
                        ]
                      : []),
                    ...(props.onOpenPlugins
                      ? [
                          {
                            id: 'use-plugins',
                            label: '使用插件',
                            description: '选择已安装的技能、连接器或专家',
                            group: 'plugins',
                          },
                        ]
                      : []),
                    ...(props.onManagePlugins
                      ? [
                          {
                            id: 'manage-plugins',
                            label: '管理插件',
                            group: 'plugins',
                          },
                        ]
                      : []),
                  ]}
                  onSelect={(id) => {
                    setAddOpen(false);
                    if (id === 'attach') props.onAttach?.();
                    if (id === 'library') props.onOpenLibrary?.();
                    if (id === 'use-plugins') {
                      setPluginsOpen(true);
                      props.onOpenPlugins?.();
                    }
                    if (id === 'manage-plugins') props.onManagePlugins?.();
                  }}
                />
              </Popover>
              {/*
               * 05 §6：锚在「+」上的轻量选择器。以前是贴着固定侧栏宽度的整屏抽屉，
               * 里面又套了三列项目卡，卡片会被抽屉裁掉，下面还空出一整列白。
               */}
              <Popover open={pluginsOpen} onClose={() => setPluginsOpen(false)}>
                <PluginPicker
                  plugins={props.plugins}
                  onClose={() => setPluginsOpen(false)}
                  onUse={(plugin, prompt) => {
                    setPluginsOpen(false);
                    props.onUsePlugin?.(plugin, prompt);
                  }}
                  onManage={
                    props.onManagePlugins
                      ? () => {
                          setPluginsOpen(false);
                          props.onManagePlugins?.();
                        }
                      : undefined
                  }
                />
              </Popover>
            </span>

            <InlineSelect
              ariaLabel="审批档"
              icon={renderIcon('sparkle')}
              placeholder="请求批准"
              value={mode}
              options={modeOptions.map((option) => ({
                id: option.id,
                label: option.label,
                description: option.description,
                disabled: option.allowed === false,
                disabledReason: option.disabledReason,
                danger: option.danger,
              }))}
              overridden={props.overrides?.mode}
              onResetOverride={() => props.onResetOverride?.('mode')}
              onChange={(id) => {
                if (id === 'full-access') {
                  setConfirmFullAccess(true);
                  return;
                }
                props.onModeChange?.(id as ModeId);
              }}
            />

            <InlineSelect
              ariaLabel="选择项目"
              icon={renderIcon('folder')}
              placeholder="选择项目"
              value={props.workspaceId}
              options={props.workspaces ?? []}
              emptyHint="还没有项目。任务会在默认目录里运行，也可以先从侧栏创建项目。"
              onChange={(id) => props.onWorkspaceChange?.(id)}
            />

            {props.memoryEnabled !== undefined ? (
              <InlineSelect
                ariaLabel="任务记忆"
                icon={renderIcon('sparkle')}
                placeholder="贡献记忆"
                value={props.memoryEnabled ? 'enabled' : 'disabled'}
                options={[
                  { id: 'enabled', label: '贡献记忆', description: '任务结束后可提取可复用上下文' },
                  { id: 'disabled', label: '不贡献记忆', description: '只对当前任务生效' },
                ]}
                onChange={(id) => props.onMemoryEnabledChange?.(id === 'enabled')}
              />
            ) : null}

            <span className="ew-composer-tool-spacer" />

            {props.models ? (
              <ModelSelect
                models={props.models}
                value={props.modelId}
                onChange={(id) => props.onModelChange?.(id)}
                overridden={props.overrides?.model}
                onResetOverride={() => props.onResetOverride?.('model')}
              />
            ) : null}

            {/* 03 §4.7：provider 不支持音频时**隐藏**麦克风，而不是点了报错 */}
            {props.micAvailable ? (
              <button
                type="button"
                className="ew-composer-mic"
                aria-label="语音输入"
                onClick={props.onMic}
              >
                {renderIcon('mic')}
              </button>
            ) : null}

            <SendButton
              runState={runState}
              disabled={sendDisabled}
              parsing={parsing}
              queuePosition={props.queuePosition}
              onSend={props.onSend}
              onInterrupt={props.onInterrupt}
              onAddBudget={props.onAddBudget}
            />
          </div>
        </div>
      </div>

      {/* 04 §5.5：两者的差别必须在 UI 上说清，不能只靠开关名字 */}
      {runState === 'running' ? (
        <label className="ew-steer-toggle" title="插话会打断当前思路；排队会等它做完。默认排队。">
          <input
            type="checkbox"
            checked={props.steer ?? false}
            onChange={(event) => props.onSteerChange?.(event.target.checked)}
          />
          立即插话
        </label>
      ) : null}

      {confirmFullAccess ? (
        <Dialog
          title={FULL_ACCESS_CONFIRM.title}
          variant="danger"
          confirmLabel={FULL_ACCESS_CONFIRM.confirmLabel}
          onCancel={() => setConfirmFullAccess(false)}
          onConfirm={() => {
            setConfirmFullAccess(false);
            props.onModeChange?.('full-access');
          }}
        >
          <p className="ew-danger-confirm-scope">{FULL_ACCESS_CONFIRM.scope}</p>
          <ul className="ew-danger-confirm-list">
            <li>{FULL_ACCESS_CONFIRM.writes}</li>
            <li>{FULL_ACCESS_CONFIRM.network}</li>
          </ul>
          <p className="ew-danger-confirm-scope">{FULL_ACCESS_CONFIRM.hardBlock}</p>
        </Dialog>
      ) : null}
    </section>
  );

  function applyCandidate(chosen: MentionCandidate | SlashCommand): void {
    if ('kind' in chosen && chosen.kind === 'local') {
      // 本地指令不进输入框，直接执行（03 §4.3）
      if (trigger) {
        const before = props.value.slice(0, trigger.start);
        const after = props.value.slice(trigger.start + 1 + trigger.query.length);
        props.onChange(`${before}${after}`);
      }
      setTrigger(null);
      props.onRunLocalCommand?.(chosen.id);
      return;
    }
    if ('category' in chosen) props.onInsertReference?.(chosen);
    else props.onRunSkillCommand?.(chosen.id);
    insertCompletion(
      chosen.label,
      'category' in chosen && chosen.category === 'skill' ? '$' : undefined,
    );
  }
}

function SendButton({
  runState,
  disabled,
  parsing,
  queuePosition,
  onSend,
  onInterrupt,
  onAddBudget,
}: {
  readonly runState: ComposerRunState;
  readonly disabled: boolean;
  readonly parsing: number;
  readonly queuePosition?: number | undefined;
  readonly onSend: () => void;
  readonly onInterrupt?: (() => void) | undefined;
  readonly onAddBudget?: (() => void) | undefined;
}): ReactNode {
  if (runState === 'running') {
    // 03 §4.6：执行中变 danger 方形 = 中断
    return (
      <button
        type="button"
        className="ew-send-button"
        data-state="running"
        aria-label="中断"
        onClick={onInterrupt}
      >
        {renderIcon('stop')}
      </button>
    );
  }
  if (runState === 'over-budget') {
    return (
      <button
        type="button"
        className="ew-send-button"
        data-state="over-budget"
        aria-label="追加预算继续"
        onClick={onAddBudget}
      >
        追加预算继续
      </button>
    );
  }
  if (queuePosition !== undefined && queuePosition > 0) {
    // Q11：本机并发满了不阻塞输入，按钮告诉用户排在第几个
    return (
      <button
        type="button"
        className="ew-send-button"
        data-state="queued"
        aria-label={`排队中（前面 ${queuePosition} 个）`}
        onClick={onSend}
      >
        排队中（前面 {queuePosition} 个）
      </button>
    );
  }
  return (
    <button
      type="button"
      className="ew-send-button"
      data-state={disabled ? 'disabled' : 'ready'}
      aria-label={parsing > 0 ? `正在本地解析 ${parsing} 个文件…` : '发送'}
      title={parsing > 0 ? `正在本地解析 ${parsing} 个文件…` : undefined}
      disabled={disabled}
      onClick={onSend}
    >
      {parsing > 0 ? `正在本地解析 ${parsing} 个文件…` : renderIcon('arrow-up')}
    </button>
  );
}

const PLUGIN_PICKER_EMPTY = '还没有可用的插件。安装技能、信任连接器或创建专家后，就能从这里使用。';

function pluginPrompt(plugin: ComposerPlugin): string {
  return plugin.defaultPrompt ?? `使用「${plugin.displayName}」协助接下来的任务。`;
}

/** 05 §6：列出可直接使用的插件。定位由外层 Popover 负责，这里只画内容。 */
function PluginPicker(props: {
  readonly plugins: readonly ComposerPlugin[] | undefined;
  readonly onClose: () => void;
  readonly onUse: (plugin: ComposerPlugin, prompt: string) => void;
  readonly onManage?: (() => void) | undefined;
}) {
  return (
    <div className="ew-plugin-picker" role="dialog" aria-label="使用插件">
      <div className="ew-plugin-picker-bar">
        <p className="ew-plugin-picker-title">使用插件</p>
        <GhostButton label="关闭" onClick={props.onClose} />
      </div>
      {props.plugins === undefined ? (
        <p className="ew-menu-empty">正在读取…</p>
      ) : (
        <Menu
          ariaLabel="可用插件"
          emptyHint={PLUGIN_PICKER_EMPTY}
          items={props.plugins.map((plugin) => ({
            id: plugin.id,
            label: plugin.displayName,
            description: `${plugin.category} · ${plugin.description}`,
          }))}
          onSelect={(id) => {
            const plugin = props.plugins?.find((item) => item.id === id);
            if (plugin) props.onUse(plugin, pluginPrompt(plugin));
          }}
        />
      )}
      {props.onManage ? (
        <button type="button" className="ew-plugin-picker-manage" onClick={props.onManage}>
          管理插件 →
        </button>
      ) : null}
    </div>
  );
}
