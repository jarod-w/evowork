/**
 * Responses 请求 → Chat Completions 请求（国内三家都只提供 Chat Completions）。
 *
 * ## 这个方向的三个坑
 *
 * 1. **`function_call_output` 必须变成 `role: "tool"` 消息，且 `tool_call_id` 要对得上**。
 *    对不上的表现不是报错，而是模型"看不见工具结果"于是重复调用同一个工具 ——
 *    在真实任务里表现为 agent 卡在一个循环里，很难归因到这一层。
 * 2. **`instructions` 要变成 system 消息并放在最前**。Responses 把它独立成字段，
 *    Chat 没有对应物；丢了它等于丢掉 developer instructions，Ask 模式会失效（D8）。
 * 3. **图片输入不能静默丢**。上游不支持时必须**拒绝请求**并说明（D2「降级必须显式」）；
 *    静默丢图会让模型答"我没有看到图片"，用户以为是模型笨。
 */
import type { ContentItem, ResponseItem, ResponsesRequest, ResponsesTool } from '../protocol.js';
import type { DegradeReason, ModelCapabilities } from '../capabilities.js';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: string | readonly ChatContentPart[] | null;
  readonly tool_calls?: readonly ChatToolCall[];
  readonly tool_call_id?: string;
  readonly name?: string;
}

export type ChatContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image_url'; readonly image_url: { readonly url: string } };

export interface ChatToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly tools?: readonly {
    readonly type: 'function';
    readonly function: {
      readonly name: string;
      readonly description?: string;
      readonly parameters?: unknown;
    };
  }[];
  readonly tool_choice?: string;
  readonly parallel_tool_calls?: boolean;
  readonly stream: boolean;
  readonly stream_options?: { readonly include_usage: boolean };
  readonly temperature?: number;
  readonly max_tokens?: number;
}

export class UnsupportedInputError extends Error {
  override readonly name = 'UnsupportedInputError';
  constructor(
    readonly reason: DegradeReason,
    readonly userMessage: string,
  ) {
    // message 里**不含**任何请求正文（Q14）
    super(`请求包含上游不支持的输入：${reason}`);
  }
}

export interface ToChatResult {
  readonly request: ChatRequest;
  readonly degradations: readonly DegradeReason[];
}

function contentToChat(
  content: readonly ContentItem[],
  capabilities: ModelCapabilities,
): string | ChatContentPart[] {
  const parts: ChatContentPart[] = [];
  let textOnly = true;

  for (const item of content) {
    switch (item.type) {
      case 'input_text':
      case 'output_text':
        parts.push({ type: 'text', text: item.text });
        break;
      case 'input_image': {
        if (!capabilities.imageInput) {
          // **拒绝而不是丢弃**（D2）：静默丢图会让模型说"我没看到图片"，用户会以为模型笨
          throw new UnsupportedInputError(
            'IMAGE_INPUT_UNSUPPORTED',
            '当前模型不支持图片输入，可切换模型后重试。',
          );
        }
        textOnly = false;
        parts.push({ type: 'image_url', image_url: { url: item.image_url } });
        break;
      }
      case 'input_audio':
        throw new UnsupportedInputError(
          'IMAGE_INPUT_UNSUPPORTED',
          '当前模型不支持音频输入，可切换模型后重试。',
        );
      default:
        break;
    }
  }

  // 纯文本时用字符串形式：部分国内实现对 content 数组的支持不如字符串稳
  if (textOnly) {
    return parts
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('')
      .trim();
  }
  return parts;
}

function toolToChat(tool: ResponsesTool) {
  return {
    type: 'function' as const,
    function: {
      name: tool.name ?? 'unnamed',
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
    },
  };
}

export function toChatRequest(
  request: ResponsesRequest,
  upstreamModel: string,
  capabilities: ModelCapabilities,
): ToChatResult {
  const messages: ChatMessage[] = [];
  const degradations = new Set<DegradeReason>();

  // 坑 2：instructions 必须变成 system 且在最前
  if (request.instructions && request.instructions.trim().length > 0) {
    messages.push({ role: 'system', content: request.instructions });
  }

  /** 待合并的 assistant tool_calls：Chat 要求它们挂在同一条 assistant 消息上 */
  let pendingToolCalls: ChatToolCall[] = [];

  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    messages.push({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
    pendingToolCalls = [];
  };

  for (const item of request.input) {
    switch (item.type) {
      case 'message': {
        flushToolCalls();
        const msg = item as Extract<ResponseItem, { type: 'message' }>;
        const role =
          msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user';
        messages.push({ role, content: contentToChat(msg.content, capabilities) });
        break;
      }
      case 'function_call': {
        const call = item as Extract<ResponseItem, { type: 'function_call' }>;
        pendingToolCalls.push({
          id: call.call_id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        });
        break;
      }
      case 'function_call_output': {
        // 坑 1：tool 消息的 tool_call_id 必须与之前的 call_id 一致
        flushToolCalls();
        const out = item as Extract<ResponseItem, { type: 'function_call_output' }>;
        messages.push({
          role: 'tool',
          tool_call_id: out.call_id,
          content: typeof out.output === 'string' ? out.output : JSON.stringify(out.output),
        });
        break;
      }
      case 'reasoning': {
        // 历史 reasoning 不回传给上游：Chat 没有对应字段，而把思维链塞进 assistant content
        // 会让模型把它当成自己说过的话。丢弃是正确的（内核也不依赖它被回传）。
        break;
      }
      default:
        // 未知条目类型：跳过而不是抛错 —— 上游内核会不断新增条目类型（R2），
        // 网关不该因为看到一个新类型就让整个回合失败
        break;
    }
  }
  flushToolCalls();

  const wantsParallel = request.parallel_tool_calls ?? false;
  if (wantsParallel && !capabilities.parallelToolCalls) {
    degradations.add('PARALLEL_TOOLS_SERIALIZED');
  }
  if (!capabilities.reasoning) degradations.add('NO_REASONING');
  if (!capabilities.promptCache) degradations.add('NO_PROMPT_CACHE');

  const tools = request.tools?.filter((t) => t.type === 'function' || t.name).map(toolToChat);

  return {
    request: {
      model: upstreamModel,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(request.tool_choice && request.tool_choice !== 'auto'
        ? { tool_choice: request.tool_choice }
        : {}),
      // 上游不支持并行时**显式传 false**，而不是不传：不传等于让上游自己决定，
      // 而"上游自己决定"在不支持并行的实现上可能表现为返回一个畸形的多 call 结构
      ...(capabilities.toolCalls
        ? { parallel_tool_calls: wantsParallel && capabilities.parallelToolCalls }
        : {}),
      stream: capabilities.streaming,
      ...(capabilities.streaming ? { stream_options: { include_usage: true } } : {}),
    },
    degradations: [...degradations],
  };
}
