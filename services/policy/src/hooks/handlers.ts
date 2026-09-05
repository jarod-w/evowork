/**
 * 四个 hook 的决策逻辑（10 §2.3 / §6）。
 *
 * 这里是**纯函数**：输入是 hook 的 stdin JSON，输出是 stdout JSON + 要写的审计记录。
 * `plugins/hooks/evowork-policy/bin/*.mjs` 只负责读 stdin、调这里、写 stdout ——
 * 把决策放进脚本里就没法测了，而这几条决策恰恰是"错了不报错"的类型。
 *
 * ## 一条贯穿的判定顺序
 *
 * 硬拦截 → 工作空间 → 需审批。**硬拦截必须最先**，而且不看 `permission_mode` ——
 * 10 §2.3：这条对 `evowork-full` 同样生效。看了 permission_mode 就等于给了绕过的口子。
 */

import { analyzeCommand, type CommandRisk } from '../execpolicy.js';
import { pathDigest, summarizeCommand, type AuditRecord } from '../audit.js';
import { classifyPath, type PathContext } from '../paths.js';
import {
  allow,
  deny,
  permissionDecision,
  PASS_THROUGH,
  type HookOutput,
  type PermissionRequestInput,
  type PostToolUseInput,
  type PreToolUseInput,
  type SessionEndInput,
} from './contract.js';

export interface HookResult {
  readonly output: HookOutput;
  readonly audit: readonly AuditRecord[];
}

export interface HookEnvironment {
  readonly home: string;
  readonly now: () => number;
  /** 额外被视为工作空间内的目录（`runtimeWorkspaceRoots`） */
  readonly extraRoots?: readonly string[] | undefined;
}

/**
 * 从 `tool_input` 里挖出路径。
 *
 * 各工具的入参字段名不同（`path` / `file_path` / `paths` / `cwd`），而漏挖一个字段
 * 等于那条路径不受策略约束。所以这里**宁可多认**：任何看起来像路径的字符串都过一遍判定。
 */
export function extractPaths(toolInput: Record<string, unknown>): readonly string[] {
  const found: string[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 4) return;
    if (typeof value === 'string') {
      if (looksLikePath(value)) found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  visit(toolInput);
  return [...new Set(found)];
}

function looksLikePath(value: string): boolean {
  if (value.length > 4096) return false;
  return value.startsWith('/') || value.startsWith('~/') || /^[a-zA-Z]:[\\/]/.test(value);
}

/** 命令类工具的入参字段（内核用 `command`）。 */
export function extractCommand(toolInput: Record<string, unknown>): string | undefined {
  const command = toolInput.command;
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.filter((c) => typeof c === 'string').join(' ');
  return undefined;
}

export function handlePreToolUse(input: PreToolUseInput, env: HookEnvironment): HookResult {
  const context: PathContext = {
    workspaceRoot: input.cwd,
    home: env.home,
    ...(env.extraRoots ? { extraRoots: env.extraRoots } : {}),
  };
  const audit: AuditRecord[] = [];

  // ① 硬拦截：**不看 permission_mode**
  for (const raw of extractPaths(input.tool_input)) {
    const decision = classifyPath(raw, context);
    if (decision.verdict === 'hard-block') {
      audit.push({
        occurredAt: env.now(),
        action: 'path.blocked',
        threadId: input.session_id,
        turnId: input.turn_id,
        itemId: input.tool_use_id,
        toolName: input.tool_name,
        actionSummary: `已阻止访问受保护位置（规则 ${decision.rule}）`,
        pathKind: decision.rule,
        pathDigest: pathDigest(raw),
        decidedBy: 'policy',
      });
      return { output: deny('PreToolUse', decision.reason ?? '这是受保护的位置'), audit };
    }
  }

  // ② 命令风险：不拦，只记 —— 拦不拦是内核审批流的事，
  //    这里的价值是给审批卡提供「为什么需要确认」（10 §3.2 必填）
  const command = extractCommand(input.tool_input);
  let risk: CommandRisk | undefined;
  if (command !== undefined) {
    risk = analyzeCommand(command);
    audit.push({
      occurredAt: env.now(),
      action: 'tool.pre',
      threadId: input.session_id,
      turnId: input.turn_id,
      itemId: input.tool_use_id,
      toolName: input.tool_name,
      actionSummary: summarizeCommand(command),
      decidedBy: 'policy',
    });
  }

  /*
   * 把风险说明作为 additionalContext 交回内核。
   *
   * 注意这里**不能**用 `permissionDecision: "ask"` —— 内核不支持（contract.ts 的实测表）。
   * 所以策略层能做的是：放行 + 把理由带上去，让审批卡有话可说。
   */
  return {
    output:
      risk && risk.dimensions.length > 0
        ? allow('PreToolUse', {
            additionalContext: `为什么需要确认：${risk.reason}。影响范围：${risk.impact}。`,
          })
        : PASS_THROUGH,
    audit,
  };
}

export function handlePermissionRequest(
  input: PermissionRequestInput,
  env: HookEnvironment,
): HookResult {
  const context: PathContext = {
    workspaceRoot: input.cwd,
    home: env.home,
    ...(env.extraRoots ? { extraRoots: env.extraRoots } : {}),
  };
  const audit: AuditRecord[] = [];

  for (const raw of extractPaths(input.tool_input ?? {})) {
    const decision = classifyPath(raw, context);
    if (decision.verdict === 'hard-block') {
      audit.push({
        occurredAt: env.now(),
        action: 'permission.decided',
        threadId: input.session_id,
        turnId: input.turn_id,
        toolName: input.tool_name,
        actionSummary: '拒绝提权到受保护位置',
        pathKind: decision.rule,
        pathDigest: pathDigest(raw),
        approvalResult: 'decline',
        decidedBy: 'policy',
      });
      // 提权请求指向受保护位置时**直接拒绝**，不给用户点"允许"的机会：
      // 这条路径的存在本身就说明有东西在试图绕过硬拦截
      return { output: permissionDecision('deny', decision.reason ?? '这是受保护的位置'), audit };
    }
  }

  audit.push({
    occurredAt: env.now(),
    action: 'permission.request',
    threadId: input.session_id,
    turnId: input.turn_id,
    toolName: input.tool_name,
    decidedBy: 'policy',
  });
  // 其余交给用户（审批卡）——策略层不替用户做"允许"的决定
  return { output: PASS_THROUGH, audit };
}

export function handlePostToolUse(input: PostToolUseInput, env: HookEnvironment): HookResult {
  const response = input.tool_response ?? {};
  const exitCode = typeof response.exit_code === 'number' ? response.exit_code : undefined;
  return {
    output: PASS_THROUGH,
    audit: [
      {
        occurredAt: env.now(),
        action: 'tool.post',
        threadId: input.session_id,
        turnId: input.turn_id,
        itemId: input.tool_use_id,
        toolName: input.tool_name,
        // **只记退出码，不记输出** —— 命令的完整输出是正文（10 §6 / Q14 同口径）
        ...(exitCode !== undefined ? { exitCode } : {}),
        decidedBy: 'policy',
      },
    ],
  };
}

export function handleSessionEnd(input: SessionEndInput, env: HookEnvironment): HookResult {
  return {
    output: PASS_THROUGH,
    audit: [
      {
        occurredAt: env.now(),
        action: 'session.end',
        threadId: input.session_id,
        actionSummary: input.reason ?? 'ended',
        decidedBy: 'policy',
      },
    ],
  };
}
