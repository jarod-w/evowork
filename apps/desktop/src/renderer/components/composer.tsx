/**
 * Composer（01 §5.13 结构 + 03 §4 行为）。首页与对话区**共用同一个组件** ——
 * 03 §4.6 要求发送后"输入框留在原地、周围长出了对话"，两处各写一个就做不到。
 *
 * ## 这个组件里有五条不能松的规则
 *
 * 1. **`/` 必须在行首才触发**（03 §4.3）。不加这条，`~/work/a.md` 里的斜杠会弹菜单。
 * 2. **解析中禁止发送**（03 §4.4），且文案要说清"在本机解析" —— 这是 K6/Q3 的对外表达点，
 *    而它必须为真：08 §4 保证没有云端兜底路径。
 * 3. **Ask 模式固定只读**（03 §4.5）。权限选择器被联动锁死并给出原因，
 *    切回 Craft/Plan 时恢复用户上一次的选择 —— 不是回落到默认值，那会让用户重选一遍。
 * 4. **`allowed:false` 的权限档位渲染为禁用并显示原因，不隐藏**（10 §2 / F4）。
 * 5. **模型不可用时不静默降级**（03 §8）：插 danger 提示条 + 禁用发送，而不是换一个模型继续。
 *
 * ## 为什么不用 contentEditable
 *
 * `@` token 在截图里是"不可分割的块"，contentEditable 是最直观的实现。但它带来
 * 选区、输入法、撤销栈三处需要自己重做的行为，而 03 §4.2 真正要的只是
 * "底层同时维护 text + textElements"。所以这里用 `<textarea>` 存文本、
 * 用 `mentions` 数组存结构，渲染时叠一层 token 显示层。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Menu, InlineSelect, ModelSelect, type ModelOption } from './menu.js';
import { Badge, Banner, PillButton } from './primitives.js';

export const COMPOSER_PLACEHOLDER = '今天帮你做些什么？  @ 引用对话文件，/ 调用技能与指令';

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
}

export type ComposerRunState = 'idle' | 'running' | 'over-budget';
export type ModeId = 'craft' | 'plan' | 'ask';

export const MODE_OPTIONS: readonly SelectOption[] = [
  { id: 'craft', label: 'Craft 你说我做' },
  { id: 'plan', label: 'Plan 先想后做' },
  { id: 'ask', label: 'Ask 只谈不做' },
];

/** Ask 模式固定用的权限档位（D8：只读沙箱 + 不审批 + 过滤写工具）。 */
export const READ_ONLY_PROFILE = ':read-only';
export const DANGER_PROFILE = ':danger-full-access';

export interface ComposerProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;

  readonly attachments?: readonly Attachment[] | undefined;
  readonly onRemoveAttachment?: ((id: string) => void) | undefined;
  readonly onReferAsRaw?: ((id: string) => void) | undefined;

  readonly mentionCandidates?: readonly MentionCandidate[] | undefined;
  readonly slashCommands?: readonly SlashCommand[] | undefined;
  readonly onRunLocalCommand?: ((id: string) => void) | undefined;

  readonly workspaces?: readonly SelectOption[] | undefined;
  readonly workspaceId?: string | undefined;
  readonly onWorkspaceChange?: ((id: string) => void) | undefined;

  readonly permissions?: readonly SelectOption[] | undefined;
  readonly permissionId?: string | undefined;
  readonly onPermissionChange?: ((id: string) => void) | undefined;

  readonly mode?: ModeId | undefined;
  readonly onModeChange?: ((mode: ModeId) => void) | undefined;

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

  /** 模型不可用（网关不通 / 未登录）。**不静默降级**（03 §8） */
  readonly modelUnavailable?: { readonly text: string; readonly onFix?: () => void } | undefined;
  /** 网关声明模型不支持音频输入时隐藏麦克风，而不是点了报错（03 §4.7） */
  readonly micAvailable?: boolean | undefined;
  readonly onMic?: (() => void) | undefined;

  /** 04 §5.4 排队追问 */
  readonly queued?: readonly { readonly id: string; readonly text: string }[] | undefined;
  readonly onQueueRemove?: ((id: string) => void) | undefined;
  /** 04 §5.5「立即插话」：开启时走 `turn/steer` 而非入队。**默认排队** */
  readonly steer?: boolean | undefined;
  readonly onSteerChange?: ((steer: boolean) => void) | undefined;

  /** 本机并发已满（Q11：3）→ 发送按钮变「排队中（前面 N 个）」 */
  readonly queuePosition?: number | undefined;
  readonly onAttach?: (() => void) | undefined;
}

/** 触发中的补全菜单：`@` 补全或行首 `/` 命令。 */
interface Trigger {
  readonly kind: '@' | '/';
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
    if (ch === '@' || ch === '/') {
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
  const mode = props.mode ?? 'craft';
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dangerPending, setDangerPending] = useState<string | null>(null);

  /**
   * Ask 模式把权限锁成只读；切回 Craft/Plan 时**恢复用户上一次的选择**（03 §4.5）。
   * 记住的是"进 Ask 之前那个值"，不是场景默认值 —— 回落到默认值等于让用户重选一遍。
   */
  const beforeAskRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (mode === 'ask') {
      if (beforeAskRef.current === undefined) beforeAskRef.current = props.permissionId;
      if (props.permissionId !== READ_ONLY_PROFILE) props.onPermissionChange?.(READ_ONLY_PROFILE);
    } else if (beforeAskRef.current !== undefined) {
      const restore = beforeAskRef.current;
      beforeAskRef.current = undefined;
      if (restore !== undefined && restore !== props.permissionId)
        props.onPermissionChange?.(restore);
    }
    // 依赖里**只有 mode**：这个 effect 只应在模式变化时跑。
    // 把 permissionId 加进去会让"恢复"动作自己触发的变化再跑一遍，
    // 表现是切回 Craft 后权限值抖动一次。
  }, [mode]);

  const parsing = parsingCount(attachments);
  const empty = props.value.trim() === '' && attachments.length === 0;
  const blockedByModel = props.modelUnavailable !== undefined;
  const sendDisabled = empty || parsing > 0 || blockedByModel;

  const candidates = useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    if (trigger.kind === '@') {
      return (props.mentionCandidates ?? [])
        .filter((c) => c.label.toLowerCase().includes(q))
        .slice(0, 8);
    }
    return (props.slashCommands ?? []).filter((c) => c.label.toLowerCase().includes(q)).slice(0, 8);
  }, [trigger, props.mentionCandidates, props.slashCommands]);

  const syncTrigger = useCallback((value: string, caret: number) => {
    setTrigger(detectTrigger(value, caret));
    setActiveIndex(0);
  }, []);

  const insertCompletion = useCallback(
    (label: string) => {
      if (!trigger) return;
      const before = props.value.slice(0, trigger.start);
      const after = props.value.slice(trigger.start + 1 + trigger.query.length);
      props.onChange(`${before}${trigger.kind}${label} ${after}`);
      setTrigger(null);
    },
    [trigger, props],
  );

  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, props.value.split('\n').length));

  const permissionOptions = (props.permissions ?? []).map((p) => ({
    id: p.id,
    label: p.label,
    ...(p.description !== undefined ? { description: p.description } : {}),
    // F4 的 allowed=false：禁用 + 给原因，**不隐藏**
    ...(p.allowed === false
      ? { disabled: true, disabledReason: p.disabledReason ?? '已被企业策略锁定' }
      : {}),
  }));

  return (
    <section className="ew-composer" aria-label="输入区" data-run-state={runState}>
      {/* 03 §8：模型不可用 → danger 条 + 禁用发送。**不换一个模型继续** */}
      {props.modelUnavailable ? (
        <Banner
          tone="danger"
          action={
            props.modelUnavailable.onFix ? (
              <PillButton onClick={props.modelUnavailable.onFix}>检查模型接入</PillButton>
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
            {(props.queued ?? []).map((q) => (
              <li key={q.id}>
                <span className="ew-queue-text">{q.text}</span>
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

      <div className="ew-composer-shell">
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
                ariaLabel={trigger.kind === '@' ? '引用候选' : '技能与指令'}
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
            <button
              type="button"
              className="ew-composer-attach"
              aria-label="添加附件"
              onClick={props.onAttach}
            >
              ＋
            </button>

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
                ●
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

        <div className="ew-composer-footer">
          <InlineSelect
            ariaLabel="选择工作空间"
            placeholder="选择工作空间"
            value={props.workspaceId}
            options={props.workspaces ?? []}
            onChange={(id) => props.onWorkspaceChange?.(id)}
          />
          <InlineSelect
            ariaLabel="权限"
            placeholder="默认权限"
            value={props.permissionId}
            options={permissionOptions}
            disabled={mode === 'ask'}
            disabledReason="Ask 模式固定为只读"
            overridden={props.overrides?.permission}
            onResetOverride={() => props.onResetOverride?.('permission')}
            onChange={(id) => {
              // 10 §2：完全访问必须过一次二次确认，且**只对当前任务生效**
              if (id === DANGER_PROFILE) setDangerPending(id);
              else props.onPermissionChange?.(id);
            }}
          />
          <InlineSelect
            ariaLabel="工作模式"
            placeholder="Craft 你说我做"
            value={mode}
            options={MODE_OPTIONS}
            overridden={props.overrides?.mode}
            onResetOverride={() => props.onResetOverride?.('mode')}
            onChange={(id) => props.onModeChange?.(id as ModeId)}
          />
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

      {dangerPending ? (
        <div className="ew-danger-confirm" role="alertdialog" aria-label="确认使用完全访问">
          <p className="ew-danger-confirm-title">完全访问意味着什么</p>
          <ul className="ew-danger-confirm-list">
            <li>可读写这台电脑上的任意文件，不限于工作空间</li>
            <li>可访问网络，不受域名白名单限制</li>
            <li>命令不再逐条向你确认</li>
          </ul>
          <p className="ew-danger-confirm-scope">仅对当前任务生效，不改变全局默认。</p>
          <PillButton onClick={() => setDangerPending(null)}>取消</PillButton>
          <PillButton
            variant="accent"
            onClick={() => {
              props.onPermissionChange?.(dangerPending);
              setDangerPending(null);
            }}
          >
            我明白，仍然使用
          </PillButton>
        </div>
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
    insertCompletion(chosen.label);
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
        ■
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
      {parsing > 0 ? `正在本地解析 ${parsing} 个文件…` : '↑'}
    </button>
  );
}
