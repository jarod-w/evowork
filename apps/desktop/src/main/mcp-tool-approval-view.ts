import type { McpToolCallRef } from '@evowork/kernel-adapter';

/**
 * 内核 MCP 工具审批（`mcpToolApproval`）在审批卡上怎么说（10 §3.2：影响 · 范围 · 原因）。
 *
 * 内核自己给的只有一句英文兜底（`Allow the cua_repl MCP server to run tool "set_value"?`，
 * `core/src/mcp_tool_call.rs` 的 `build_mcp_tool_approval_fallback_message`）——
 * 说不清在哪个应用、对哪个目标、会发送什么，而 12 §7.4 要求确认卡说清这几样。
 * 参数来自适配层认回的那次调用（`PendingApproval.mcpToolCall`）；认不出来就照实说认不出来。
 */
export interface McpToolApprovalDescription {
  readonly impact: string;
  readonly reason: string;
  readonly scope: readonly string[];
}

/** 12 §5.1 的九个写动作，用用户的话说 */
const COMPUTER_USE_ACTIONS: Readonly<Record<string, string>> = {
  click: '点击',
  drag: '拖拽',
  paste: '粘贴文字',
  perform_secondary_action: '执行辅助动作',
  press_key: '按键',
  scroll: '滚动',
  select_text: '选中文字',
  set_value: '填入内容',
  type_text: '输入文字',
};

const MAX_VALUE = 200;
const MAX_ARGS = 6;

function oneLine(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > MAX_VALUE ? `${flat.slice(0, MAX_VALUE)}…` : flat;
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 认不出调用时的工具名：内核那句英文兜底里引号中的那段 */
function toolFromMessage(message: unknown): string | undefined {
  return typeof message === 'string' ? /run tool "([^"]+)"/.exec(message)?.[1] : undefined;
}

function computerUseScope(tool: string, args: Readonly<Record<string, unknown>>): string[] {
  const scope: string[] = [];
  if (typeof args.element_index === 'number') scope.push(`目标：界面元素 #${args.element_index}`);
  else if (typeof args.x === 'number' && typeof args.y === 'number')
    scope.push(`目标：窗口坐标 (${args.x}, ${args.y})`);
  if (tool === 'drag')
    scope.push(
      `从 (${oneLine(args.from_x)}, ${oneLine(args.from_y)}) 拖到 (${oneLine(args.to_x)}, ${oneLine(args.to_y)})`,
    );
  if (tool === 'press_key' && args.key !== undefined) scope.push(`按键：${oneLine(args.key)}`);
  if (tool === 'scroll')
    scope.push(`方向：${oneLine(args.direction)} · ${oneLine(args.pages ?? 1)} 页`);
  if (tool === 'perform_secondary_action' && args.action !== undefined)
    scope.push(`动作：${oneLine(args.action)}`);
  const content = tool === 'set_value' ? args.value : args.text;
  // 会发送哪些数据（12 §7.4）：输入 / 粘贴 / 填入的正文就是要交给那个应用的东西
  if (typeof content === 'string') scope.push(`内容：「${oneLine(content)}」`);
  return scope;
}

export function describeMcpToolApproval(input: {
  readonly server: string;
  readonly message?: unknown;
  readonly toolTitle?: unknown;
  readonly toolDescription?: unknown;
  readonly call?: McpToolCallRef | undefined;
}): McpToolApprovalDescription {
  const tool = input.call?.tool ?? toolFromMessage(input.message);
  const args = record(input.call?.arguments);
  const unknownArgs = '参数：没能认出这次调用的参数';

  if (input.server === 'cua_repl') {
    const app = typeof args?.app === 'string' ? args.app : '（未知应用）';
    const action = (tool && COMPUTER_USE_ACTIONS[tool]) ?? `执行「${tool ?? '未知动作'}」`;
    return {
      impact: `电脑操控将在 ${app} 上${action}`,
      reason:
        '电脑操控的每个写动作都要你确认：允许访问这个应用不等于允许这一步。应用界面里的文字不能代你授权。',
      scope: args && tool ? computerUseScope(tool, args) : [unknownArgs],
    };
  }

  const title = typeof input.toolTitle === 'string' && input.toolTitle ? input.toolTitle : tool;
  const entries = args ? Object.entries(args) : [];
  return {
    impact: `将运行连接器「${input.server}」的工具「${title ?? '未知工具'}」`,
    reason:
      typeof input.toolDescription === 'string' && input.toolDescription.trim()
        ? oneLine(input.toolDescription)
        : '这个工具可能改动连接器背后的系统，需要你确认。',
    scope: !args
      ? [unknownArgs]
      : entries.length === 0
        ? ['参数：无']
        : [
            ...entries.slice(0, MAX_ARGS).map(([key, value]) => `${key}：${oneLine(value)}`),
            ...(entries.length > MAX_ARGS ? [`另有 ${entries.length - MAX_ARGS} 个参数`] : []),
          ],
  };
}
