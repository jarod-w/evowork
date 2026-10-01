/**
 * 四个 hook 的决策逻辑（10 §2.3 / §6）。
 *
 * 这里是**纯函数**：输入是 hook 的 stdin JSON，输出是 stdout JSON + 要写的审计记录。
 * `plugins/hooks/evowork-policy/bin/*.mjs` 只负责读 stdin、调这里、写 stdout ——
 * 把决策放进脚本里就没法测了，而这几条决策恰恰是"错了不报错"的类型。
 *
 * ## 一条贯穿的判定顺序
 *
 * 硬拦截 → apply_patch 的删除 / 整篇覆盖 → 工作空间 → 需审批。**硬拦截必须最先**，而且不看 `permission_mode` ——
 * 10 §2.3：这条对 `evowork-full` 同样生效。看了 permission_mode 就等于给了绕过的口子。
 */

import { resolve } from 'node:path';

import {
  deletePatchReason,
  overwritePatchReason,
  parseApplyPatch,
  replacesWholeFile,
} from '../apply-patch.js';
import { pathDigest, summarizeCommand, type AuditRecord } from '../audit.js';
import { classifyPath, type PathContext } from '../paths.js';
import { isComputerUseTool } from '../computer-use.js';
import {
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
  readonly computerUseAvailable?: boolean;
  readonly home: string;
  readonly now: () => number;
  /** 额外被视为工作空间内的目录（`runtimeWorkspaceRoots`） */
  readonly extraRoots?: readonly string[] | undefined;
  /**
   * 读一个文件的文本，不存在或读不了返回 `undefined`。apply_patch 的覆盖判定要看原文件
   * （`../apply-patch.ts`）。**必填**：运行器是 `.mjs`、不在类型检查里，漏给它不会报错，
   * 只是覆盖判定静默失效 —— `hooks.test.ts` 用运行器真实的环境跑一遍判定守着这条接缝。
   */
  readonly readFile: (path: string) => string | undefined;
}

/**
 * 从 `tool_input` 里挖出路径。
 *
 * 各工具的入参字段名不同（`path` / `file_path` / `paths` / `cwd`），而漏挖一个字段
 * 等于那条路径不受策略约束。所以这里**宁可多认**：任何看起来像路径的字符串都过一遍判定。
 */
export function extractPaths(toolInput: Record<string, unknown>): readonly string[] {
  const found: string[] = [];
  // `command` 是一整行 shell，不是一条路径 —— 它由 `extractCommandPaths` 按词处理（见那里）
  const { command: _command, ...fields } = toolInput;
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
  visit(fields);
  return [...new Set(found)];
}

/**
 * 从一行 shell 里挑出**看起来像路径的词**（2026-09-28，hook 第一次真正接进内核时补的）。
 *
 * 内核给 shell 工具的 `tool_input` 是 `{"command": "<模型写的整行命令>"}`
 * （`core/src/tools/handlers/unified_exec/exec_command.rs` 的 `pre_tool_use_payload`）。
 * 以前把整行当一条路径判：`cat ~/.ssh/id_rsa` 不以 `/` 开头，**凭据清单一次都没看过 shell**；
 * `/usr/bin/env python3 x.py` 以 `/usr/bin/` 开头，**整条被当成系统目录拒掉**。
 *
 * 这里按空白与 shell 标点切词，`$HOME/` / `${HOME}/` 折成 `~/`。
 * **是启发式，不是边界**：`$(echo ~)/.ssh` 这类拼接认不出来 —— 真正的边界要在沙箱层。
 */
export function extractCommandPaths(command: string): readonly string[] {
  const found = new Set<string>();
  for (const raw of command.split(/[\s;|&()<>`]+/)) {
    const word = raw.replace(/^['"]+|['"]+$/g, '').replace(/^\$\{?HOME\}?\//, '~/');
    if (word !== '' && looksLikePath(word)) found.add(word);
  }
  return [...found];
}

/**
 * shell 命令里的词**不套 `system-dirs`**：执行 `/usr/bin/python3`、读 `/etc/hosts` 都是日常，
 * 系统目录的写保护由系统权限与沙箱负责。凭据与 EvoWork 自身配置照拦 —— 读到就已经出事了。
 */
const COMMAND_EXEMPT_RULES: ReadonlySet<string> = new Set(['system-dirs']);

function hardBlocks(
  toolInput: Record<string, unknown>,
  context: PathContext,
): readonly { readonly raw: string; readonly decision: ReturnType<typeof classifyPath> }[] {
  const hits = [];
  for (const raw of extractPaths(toolInput)) {
    const decision = classifyPath(raw, context);
    if (decision.verdict === 'hard-block') hits.push({ raw, decision });
  }
  const command = extractCommand(toolInput);
  for (const raw of command === undefined ? [] : extractCommandPaths(command)) {
    const decision = classifyPath(raw, context);
    if (decision.verdict === 'hard-block' && !COMMAND_EXEMPT_RULES.has(decision.rule ?? '')) {
      hits.push({ raw, decision });
    }
  }
  return hits;
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
  if (isComputerUseTool(input.tool_name) && !env.computerUseAvailable) {
    return {
      output: deny('PreToolUse', 'POLICY_DENIED：电脑操控的宿主授权链尚未就绪'),
      audit: [
        {
          occurredAt: env.now(),
          action: 'permission.decided',
          threadId: input.session_id,
          turnId: input.turn_id,
          itemId: input.tool_use_id,
          toolName: 'cua_repl',
          approvalResult: 'decline',
          decidedBy: 'policy',
          actionSummary: 'POLICY_DENIED',
        },
      ],
    };
  }
  const context: PathContext = {
    workspaceRoot: input.cwd,
    home: env.home,
    ...(env.extraRoots ? { extraRoots: env.extraRoots } : {}),
  };
  const audit: AuditRecord[] = [];

  // ① 硬拦截：**不看 permission_mode**
  const blocked = hardBlocks(input.tool_input, context)[0];
  if (blocked) {
    const { raw, decision } = blocked;
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

  // ② apply_patch 的删除与整篇覆盖：拒绝并指路到会弹审批的写法（../apply-patch.ts 的头注释）
  const patchDenial = applyPatchDenial(input, env);
  if (patchDenial) {
    audit.push({
      occurredAt: env.now(),
      action: 'permission.decided',
      threadId: input.session_id,
      turnId: input.turn_id,
      itemId: input.tool_use_id,
      toolName: input.tool_name,
      actionSummary: patchDenial.summary,
      pathDigest: pathDigest(patchDenial.path),
      approvalResult: 'decline',
      decidedBy: 'policy',
    });
    return { output: deny('PreToolUse', patchDenial.reason), audit };
  }

  // ③ 命令风险：不拦，只记审计。拦不拦是内核审批流的事；审批卡上的「为什么需要确认」
  //    由主进程按同一套命令判定给出（`commandApprovalRationale`），不经过这里 ——
  //    hook 的 additionalContext 进的是模型上下文，到不了卡片
  const command = extractCommand(input.tool_input);
  if (command !== undefined) {
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

  return { output: PASS_THROUGH, audit };
}

function applyPatchDenial(
  input: PreToolUseInput,
  env: HookEnvironment,
): { readonly reason: string; readonly summary: string; readonly path: string } | undefined {
  const ops = parseApplyPatch(input.tool_name, extractCommand(input.tool_input)) ?? [];
  for (const op of ops) {
    if (op.kind === 'delete') {
      return { reason: deletePatchReason(op.path), summary: 'APPLY_PATCH_DELETE', path: op.path };
    }
    if (op.path === '') continue;
    const original = env.readFile(resolve(input.cwd, op.path));
    if (original === undefined) continue; // 新建文件：照常
    // Add File 写到已有文件上会直接覆盖它（内核 apply-patch 的 AddFile 分支不查是否存在）
    if (op.kind === 'add' || replacesWholeFile(op, original)) {
      return {
        reason: overwritePatchReason(op.path),
        summary: 'APPLY_PATCH_OVERWRITE',
        path: op.path,
      };
    }
  }
  return undefined;
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

  const blocked = hardBlocks(input.tool_input ?? {}, context)[0];
  if (blocked) {
    const { raw, decision } = blocked;
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
