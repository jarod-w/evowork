/**
 * Responses 请求 → Chat Completions 请求（国内三家都只提供 Chat Completions）。
 *
 * ## 这个方向的四个坑
 *
 * 1. **`function_call_output` 必须变成 `role: "tool"` 消息，且 `tool_call_id` 要对得上**。
 *    对不上的表现不是报错，而是模型"看不见工具结果"于是重复调用同一个工具 ——
 *    在真实任务里表现为 agent 卡在一个循环里，很难归因到这一层。
 * 2. **`instructions` 要变成 system 消息并放在最前**。Responses 把它独立成字段，
 *    Chat 没有对应物；丢了它等于丢掉 developer instructions，Ask 模式会失效（D8）。
 * 3. **图片输入不能静默丢**。上游不支持时必须**拒绝请求**并说明（D2「降级必须显式」）；
 *    静默丢图会让模型答"我没有看到图片"，用户以为是模型笨。
 * 4. **thinking 模式必须把历史思维链挂回对应 assistant 的 `reasoning_content`**。
 *    Codex 会把 Responses 的 `reasoning` item 放进下一轮 `input`（这是对的）；
 *    DeepSeek / Kimi / GLM 的 Chat 接口要求把它写在 assistant 消息上，丢掉会 400：
 *    `The reasoning_content in the thinking mode must be passed back to the API.`
 *    仍然**不得**塞进 `content`（会让模型把思维链当成自己说过的话）。
 */
import type { ContentItem, ResponseItem, ResponsesRequest, ResponsesTool } from '../protocol.js';
import type { DegradeReason, ModelCapabilities } from '../capabilities.js';
import { chatToolName } from './tool-names.js';

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content?: string | readonly ChatContentPart[] | null;
  readonly tool_calls?: readonly ChatToolCall[];
  readonly tool_call_id?: string;
  readonly name?: string;
  /** DeepSeek / Kimi / GLM thinking：必须原样回传，不能塞进 content */
  readonly reasoning_content?: string;
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

function toolToChat(tool: ResponsesTool, name = tool.name ?? 'unnamed') {
  return {
    type: 'function' as const,
    function: {
      name,
      ...(tool.description ? { description: tool.description } : {}),
      ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
    },
  };
}

function reasoningTextFrom(item: Extract<ResponseItem, { type: 'reasoning' }>): string {
  const fromContent = (item.content ?? []).map((part) => part.text).join('');
  if (fromContent.length > 0) return fromContent;
  return item.summary.map((part) => part.text).join('');
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
  /**
   * 当前模型回合尚未挂到 assistant 上的思维链。一直保留到 user / tool 边界，
   * 这样「reasoning → 正文 → function_call」会写到同一条 assistant 上（坑 4）。
   */
  let pendingReasoning = '';
  // Chat 的 tool 消息只承载文本；图片放到这一组工具结果之后的 user 视觉消息。
  // 不能在并行调用的两个 tool 结果之间插入 user，否则会破坏调用/结果配对。
  let pendingToolImages: ChatContentPart[] = [];
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return;
    messages.push({ role: 'user', content: pendingToolImages });
    pendingToolImages = [];
  };

  const reasoningField = (): { readonly reasoning_content: string } | Record<string, never> => {
    if (!capabilities.reasoning || pendingReasoning.length === 0) return {};
    return { reasoning_content: pendingReasoning };
  };

  const pushAssistant = (msg: ChatMessage): void => {
    messages.push({ ...msg, ...reasoningField() });
  };

  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant' && last.tool_calls === undefined) {
      messages[messages.length - 1] = {
        ...last,
        tool_calls: pendingToolCalls,
        ...reasoningField(),
      };
    } else {
      pushAssistant({ role: 'assistant', content: null, tool_calls: pendingToolCalls });
    }
    pendingToolCalls = [];
  };

  const flushReasoningAtBoundary = (): void => {
    flushToolCalls();
    if (!capabilities.reasoning || pendingReasoning.length === 0) return;
    const last = messages[messages.length - 1];
    if (last?.role !== 'assistant') {
      pushAssistant({ role: 'assistant', content: null });
    } else if (last.reasoning_content === undefined) {
      messages[messages.length - 1] = { ...last, ...reasoningField() };
    }
    pendingReasoning = '';
  };

  for (const item of request.input) {
    if (item.type !== 'function_call_output') flushToolImages();
    switch (item.type) {
      case 'message': {
        const msg = item as Extract<ResponseItem, { type: 'message' }>;
        const role =
          msg.role === 'assistant' ? 'assistant' : msg.role === 'system' ? 'system' : 'user';
        if (role === 'assistant') {
          flushToolCalls();
          pushAssistant({ role, content: contentToChat(msg.content, capabilities) });
        } else {
          flushReasoningAtBoundary();
          messages.push({ role, content: contentToChat(msg.content, capabilities) });
        }
        break;
      }
      case 'function_call': {
        const call = item as Extract<ResponseItem, { type: 'function_call' }>;
        pendingToolCalls.push({
          id: call.call_id,
          type: 'function',
          // 历史里的调用也要用 Chat 那边的名字，否则模型看到的是一个没声明过的工具
          function: { name: chatToolName(call.name, call.namespace), arguments: call.arguments },
        });
        break;
      }
      case 'function_call_output': {
        // 坑 1：tool 消息的 tool_call_id 必须与之前的 call_id 一致
        flushToolCalls();
        pendingReasoning = '';
        const out = item as Extract<ResponseItem, { type: 'function_call_output' }>;
        let content: string;
        if (
          Array.isArray(out.output) &&
          out.output.every(
            (part: unknown) =>
              typeof part === 'object' &&
              part !== null &&
              'type' in part &&
              ['input_text', 'output_text', 'input_image', 'input_audio'].includes(
                String(part.type),
              ),
          )
        ) {
          // 内核 view_image / MCP 的 output 是内容块数组。JSON.stringify 会把
          // 数 MB 的 Base64 当成文字 token，导致出图成功后的下一次请求超上下文。
          const parts = out.output as readonly ContentItem[];
          content = parts
            .flatMap((part) =>
              part.type === 'input_text' || part.type === 'output_text' ? [part.text] : [],
            )
            .join('\n');
          const media = contentToChat(
            parts.filter((part) => part.type !== 'input_text' && part.type !== 'output_text'),
            capabilities,
          );
          if (Array.isArray(media)) {
            pendingToolImages.push(
              { type: 'text', text: `工具 ${out.call_id} 返回的图片：` },
              ...media,
            );
          }
        } else {
          content = typeof out.output === 'string' ? out.output : JSON.stringify(out.output);
        }
        messages.push({
          role: 'tool',
          tool_call_id: out.call_id,
          content,
        });
        break;
      }
      case 'reasoning': {
        /*
         * 与本文件其它 case 一样要显式窄化：`ResponseItem` 末尾有一个兜底成员
         * （`{ type: string; [key: string]: unknown }`，R2 —— 上游会不断新增条目类型），
         * 所以 `case 'reasoning'` narrow 出来的是「reasoning 变体 | 兜底成员」而不是前者。
         * 少了这一步在 `exactOptionalPropertyTypes` 下过不了类型检查。
         */
        const reasoning = item as Extract<ResponseItem, { type: 'reasoning' }>;
        if (capabilities.reasoning) {
          pendingReasoning += reasoningTextFrom(reasoning);
        }
        break;
      }
      case 'agent_message': {
        /*
         * 代理之间的消息。可见的只有一段头部（`Message Type: NEW_TASK / Task name / Sender /
         * Payload:`），**正文在 `encrypted_content` 块里**：内核把模型写在工具参数里的原文放进去
         * （`multi_agents_v2.rs` 的 `agent_message_from_tool`），只有 OpenAI 自家的上游才会是真密文。
         * 经网关的上游从不加密 —— 那些工具参数就是网关自己从 Chat 的 tool_calls 拼出来的明文 ——
         * 所以按正文还原，作为发给这个代理的一条 user 消息。
         *
         * 跳过它的后果不报错：子代理收不到派给它的任务、收不到兄弟发来的消息、收不到转交，
         * 只看得到继承来的用户原话 —— 于是照着原话再派一遍子代理，层层撞满线程上限
         * （2026-10-05 MiMo 实测，子代理原话：「I don't see a NEW_TASK payload」）。
         */
        const agent = item as Extract<ResponseItem, { type: 'agent_message' }>;
        const text = (agent.content ?? [])
          .map((part) =>
            part.type === 'input_text'
              ? part.text
              : part.type === 'encrypted_content'
                ? part.encrypted_content
                : '',
          )
          .join('');
        if (text.trim().length > 0) {
          flushReasoningAtBoundary();
          messages.push({ role: 'user', content: text });
        }
        break;
      }
      default:
        // 未知条目类型：跳过而不是抛错 —— 上游内核会不断新增条目类型（R2），
        // 网关不该因为看到一个新类型就让整个回合失败
        break;
    }
  }
  flushToolImages();
  flushReasoningAtBoundary();

  const wantsParallel = request.parallel_tool_calls ?? false;
  if (wantsParallel && !capabilities.parallelToolCalls) {
    degradations.add('PARALLEL_TOOLS_SERIALIZED');
  }
  if (!capabilities.reasoning) degradations.add('NO_REASONING');
  if (!capabilities.promptCache) degradations.add('NO_PROMPT_CACHE');

  // 命名空间摊平成一组扁平函数（tool-names.ts）；整个命名空间当成一个工具发出去，模型就看不到里面那些
  const tools = request.tools?.flatMap((tool) =>
    tool.type === 'namespace'
      ? (tool.tools ?? []).flatMap((inner) =>
          inner.name ? [toolToChat(inner, chatToolName(inner.name, tool.name))] : [],
        )
      : tool.type === 'function' || tool.name
        ? [toolToChat(tool)]
        : [],
  );

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
