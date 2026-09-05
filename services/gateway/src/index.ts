/**
 * @evowork/gateway —— Responses API 网关（M1，云端）。
 *
 * **全项目最容易被低估的工作量**（R1，8 人周，关键路径最长的单项）。它不是薄转发：
 * `wire_api = "chat"` 已被上游移除，内核**只认 Responses API**，所以流式语义、工具调用、
 * reasoning 段、prompt cache 口径全都得由网关补齐（D2）。
 *
 * 文件分工：
 *   · `protocol.ts`            内核与网关之间的线上契约，含**三条会让整条流失败的硬约束**
 *   · `capabilities.ts`        能力声明（D2 语义矩阵 + Q16 三家），含"未验证"如实标注
 *   · `translate/to-chat.ts`   Responses → Chat（instructions / tool 结果 / 图片拒绝）
 *   · `translate/from-chat.ts` Chat 流 → Responses 事件（编号 / 工具参数重组 / reasoning）
 *   · `translate/usage.ts`     用量规范化（cache 如实报 0、缺数据宁可省略）
 *   · `providers/registry.ts`  三家的发送与**错误码映射**（映射不上会被内核当可重试）
 *   · `pipeline.ts`            一次请求的完整链路（可脱离 HTTP 层测试）
 *   · `server.ts`              三个端点，零框架依赖
 */
export {
  CAPABILITY_COPY,
  createModelRegistry,
  DEGRADE_COPY,
  P0_MODELS,
  type CapabilityLookup,
  type DegradeReason,
  type ModelCapabilities,
  type ModelEntry,
  type ModelRegistryEntry,
  type ProviderId,
} from './capabilities.js';
export {
  capabilityNotices,
  degradeNotices,
  ModelNotConfiguredError,
  parseSseData,
  runPipeline,
  type PipelineDeps,
  type PipelineRequestContext,
} from './pipeline.js';
export {
  EVENT,
  toSseData,
  type ContentItem,
  type ResponseItem,
  type ResponsesEvent,
  type ResponsesRequest,
  type ResponsesTool,
  type ResponsesUsage,
} from './protocol.js';
export {
  DEEPSEEK,
  DEFAULT_BASE_URL,
  extractError,
  mapCommonError,
  MOONSHOT,
  PRIVATE,
  PROVIDERS,
  ZHIPU,
} from './providers/registry.js';
export {
  isRetryableStatus,
  KERNEL_ERROR,
  type Provider,
  type ProviderConfig,
  type UpstreamResponse,
} from './providers/types.js';
export { createGatewayServer, type ServerOptions } from './server.js';
export {
  chunksFromCompletion,
  createTranslator,
  type ChatChunk,
  type Translator,
  type TranslatorOptions,
} from './translate/from-chat.js';
export {
  toChatRequest,
  UnsupportedInputError,
  type ChatContentPart,
  type ChatMessage,
  type ChatRequest,
  type ChatToolCall,
  type ToChatResult,
} from './translate/to-chat.js';
export { normalizeUsage, type ChatUsage, type NormalizedUsage } from './translate/usage.js';
