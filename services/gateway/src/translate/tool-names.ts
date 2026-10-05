/**
 * 命名空间工具 ↔ Chat 的扁平函数名。
 *
 * 内核把一组工具挂在命名空间下声明（`{ type: "namespace", name, tools: [...] }`），模型调用时
 * 要回 `{ name, namespace }`。多代理的六个协作动作就在 `collaboration` 下（内核
 * `core/src/config/mod.rs` 的 `DEFAULT_MULTI_AGENT_V2_TOOL_NAMESPACE`；自定义 provider 的
 * `namespace_tools` 能力恒为真，配置关不掉）。Chat Completions 没有命名空间，只有一层函数名，
 * 所以去程摊平成 `<namespace>__<name>`，回程查表还原。
 *
 * 回程**查表、不拆字符串**：扁平工具名里本来就有 `__`（MCP 工具形如 `mcp__server__tool`）。
 *
 * 漏了这一层的后果不报错：整个命名空间被当成一个没有参数的工具发给上游，模型永远看不到里面那几个。
 * 2026-10-05 多代理的 UI 测试就是这么发现的 —— 经网关的模型（全部国内模型）一个子代理都派不出来，
 * 内核那边只会对一个叫 `spawn_agent` 却没带命名空间的调用回「unsupported call」。
 */
import type { ResponsesTool } from '../protocol.js';

export interface KernelToolName {
  readonly name: string;
  readonly namespace: string;
}

/** Chat 函数名的上限（OpenAI 兼容实现普遍照抄这个限制：`^[A-Za-z0-9_-]{1,64}$`） */
const CHAT_NAME_MAX = 64;

/** 32 位 FNV-1a。只用来给超长名字加个不撞的尾巴，不是安全用途 */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 一个工具在 Chat 那边叫什么。没有命名空间的原名不动 */
export function chatToolName(name: string, namespace?: string): string {
  if (!namespace) return name;
  const joined = `${namespace}__${name}`.replace(/[^A-Za-z0-9_-]/g, '_');
  if (joined.length <= CHAT_NAME_MAX) return joined;
  return `${joined.slice(0, CHAT_NAME_MAX - 9)}_${fnv1a(`${namespace}\0${name}`)}`;
}

/** 请求里声明的命名空间工具：Chat 名 → 内核名。扁平工具不进表（原名进、原名出） */
export function namespacedToolNames(
  tools: readonly ResponsesTool[] | undefined,
): ReadonlyMap<string, KernelToolName> {
  const names = new Map<string, KernelToolName>();
  for (const tool of tools ?? []) {
    if (tool.type !== 'namespace' || !tool.name) continue;
    for (const inner of tool.tools ?? []) {
      if (inner.name) {
        names.set(chatToolName(inner.name, tool.name), {
          name: inner.name,
          namespace: tool.name,
        });
      }
    }
  }
  return names;
}
