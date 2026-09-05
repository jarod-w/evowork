/**
 * 内核 hooks 的输入输出契约（K3 的第三个扩展点）。
 *
 * ## 2026-09-05 实测（基线 89a4eec6da）—— 三条"写错了不报错"的约束
 *
 * 输出形如：
 * ```json
 * {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *   "permissionDecision":"deny","permissionDecisionReason":"..."}}
 * ```
 *
 * | 约束 | 出处 | 写错了会怎样 |
 * |---|---|---|
 * | `deny` **必须**带非空 reason | `hooks/src/engine/output_parser.rs:510` | 整条输出被判无效 → **策略静默失效** |
 * | `permissionDecision: "ask"` 不被支持 | 同上 `:459` | 同上 |
 * | `updatedInput` 只在 `allow` 时有效 | 同上 `:450` | 同上 |
 *
 * 三条的共同点是**失败方式都是"什么都没发生"**，不是报错。所以它们集中在这里一次写对，
 * 并由测试钉住 —— 散在四个 hook 脚本里的话，其中一个写错了没人会发现。
 *
 * `PermissionRequest` 事件的形状不同：用 `decision`（allow/deny）而不是 `permissionDecision`
 * （`output_parser.rs:188-202`）。这个差异也很容易搞混，所以两种输出由不同的函数产出。
 */

export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'PermissionRequest' | 'SessionEnd';

/** `PreToolUse` 的输入（`hooks/src/schema.rs:278-296`）。只声明我们用得到的字段。 */
export interface PreToolUseInput {
  readonly session_id: string;
  readonly turn_id: string;
  readonly cwd: string;
  readonly hook_event_name: string;
  readonly model?: string;
  readonly permission_mode?: string;
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  readonly tool_use_id: string;
}

export interface PostToolUseInput extends PreToolUseInput {
  readonly tool_response?: Record<string, unknown>;
}

export interface PermissionRequestInput {
  readonly session_id: string;
  readonly turn_id: string;
  readonly cwd: string;
  readonly tool_name?: string;
  readonly tool_input?: Record<string, unknown>;
}

export interface SessionEndInput {
  readonly session_id: string;
  readonly reason?: string;
}

export type HookOutput =
  | { readonly hookSpecificOutput: Record<string, unknown> }
  /** 不表态：内核按默认流程走 */
  | null;

export function allow(event: 'PreToolUse', extra: Record<string, unknown> = {}): HookOutput {
  return { hookSpecificOutput: { hookEventName: event, permissionDecision: 'allow', ...extra } };
}

/** `deny` 的 reason 必填且非空 —— 这个函数不接受空字符串。 */
export function deny(event: 'PreToolUse', reason: string): HookOutput {
  const trimmed = reason.trim();
  if (trimmed === '') {
    throw new Error('deny 必须带非空理由：内核会把没有理由的 deny 判为无效输出，策略会静默失效');
  }
  return {
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'deny',
      permissionDecisionReason: trimmed,
    },
  };
}

/** `PermissionRequest` 用 `decision`，不是 `permissionDecision`。 */
export function permissionDecision(decision: 'allow' | 'deny', message?: string): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision,
      ...(message ? { message } : {}),
    },
  };
}

export const PASS_THROUGH: HookOutput = null;

/** 序列化：`null` 表示不表态，写空串。 */
export function serialize(output: HookOutput): string {
  return output === null ? '' : `${JSON.stringify(output)}\n`;
}
