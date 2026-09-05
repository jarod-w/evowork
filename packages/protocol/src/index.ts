/**
 * @evowork/protocol —— app-server JSON-RPC v2 的类型与传输。
 *
 * **K2 的技术落点**：唯一边界是这个协议。前端与服务层只说它，不链接 Rust、不调 SDK 内部、
 * 不读内核的 sqlite / rollout 文件。
 *
 * 三个文件的分工：
 *   · `jsonrpc.ts` —— 帧与双向分发。不知道任何 EvoWork 概念，也不知道任何具体方法
 *   · `methods.ts` —— 我们调用的方法清单（= 依赖面的声明），并区分稳定与实验
 *   · `types.ts`   —— 协议形状的手写子集，带 F 编号指回实测记录
 */
export {
  ERROR_CODE,
  JSONRPC_VERSION,
  JsonRpcCallError,
  JsonRpcPeer,
  LineFramer,
  TransportClosedError,
  type JsonRpcErrorMessage,
  type JsonRpcErrorPayload,
  type JsonRpcMessage,
  type JsonRpcNotificationMessage,
  type JsonRpcPeerOptions,
  type JsonRpcRequestMessage,
  type JsonRpcResponseMessage,
  type JsonRpcTransport,
  type NotificationHandler,
  type RequestId,
  type ServerRequestHandler,
} from './jsonrpc.js';

export {
  EXPERIMENTAL_METHOD,
  METHOD,
  NOTIFICATION,
  SERVER_REQUEST,
  isExperimentalMethod,
  type ExperimentalMethod,
  type Method,
  type NotificationMethod,
  type ServerRequestMethod,
  type StableMethod,
} from './methods.js';

export * from './types.js';
