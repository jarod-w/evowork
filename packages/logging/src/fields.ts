/**
 * 字段注册表 —— Q14「网关不落盘 prompt 与响应体」的实现机制。
 *
 * 设计判断：**不做黑名单**。黑名单（"过滤掉 prompt / content / body 这些键"）看起来直观，
 * 但它要求每一个未来的字段名都提前被想到；漏一个就是一次泄露，而泄露的证据要等到
 * 客户来问才出现。所以反过来：**只有注册过的字段名能被写进日志，且它的值必须符合该字段
 * 声明的形状**。没注册的字段进不去，形状不对的值也进不去。
 *
 * 这条设计还有一个来自实战的理由（前一代实现踩过）：**字段名安全不代表值安全**。
 * `label`、`path`、`title` 这类字段的名字毫无问题，但值是自然语言 —— 客户名与金额就这么
 * 进了本该只有计量的数据。因此这里的字段类型里**没有任何"短自由文本"档**：
 * 想记路径就记 `pathKind` + `pathDigest` + `extension`（见 `redact.ts` 的 `pathFields`），
 * 想记错误就记 `errorClass` + `errorCode` + `messageDigest`，不记原文。
 */

/** 字段的值形状。每一档都窄到"装不下一句自然语言"。 */
export type FieldKind =
  /** 标识符：thread/turn/item/request id 等。允许 `:` `.` `-` `_`，不允许空白 */
  | 'id'
  /** 枚举/方法名：`thread/list`、`gateway.request.completed`、`deepseek` */
  | 'token'
  /** 计数：非负有限整数 */
  | 'count'
  /** 时长：非负有限数（毫秒） */
  | 'duration'
  /**
   * 错误码 / 原因码：`MACHINE_OFFLINE`、`context_length_exceeded`、`ECONNREFUSED`、`429`。
   *
   * **允许小写**（2026-09-05 修订）：最初只允许大写下划线，理由是"看起来像枚举"，
   * 但内核与三家模型的真实错误码都是小写（`context_length_exceeded` / `insufficient_quota`），
   * 于是合法的错误码全被拦下来 —— 一条把正确用法挡在外面的规则，最后会被绕过而不是被遵守。
   *
   * 真正要守的不变量是**装不下一句自然语言**，所以约束保留在别处：
   * 不允许空白、不允许 CJK、长度 ≤ 64。上游想把中文业务信息塞进 code 仍然进不来。
   */
  | 'code'
  /** 摘要：十六进制，用来在不记原文的前提下做同一性判断 */
  | 'digest'
  /** 布尔 */
  | 'bool';

const PATTERNS: Record<Exclude<FieldKind, 'count' | 'duration' | 'bool'>, RegExp> = {
  id: /^[A-Za-z0-9_:.@-]{1,128}$/,
  token: /^[A-Za-z][A-Za-z0-9_./:-]{0,63}$/,
  code: /^[A-Za-z0-9_.:-]{1,64}$/,
  digest: /^[0-9a-f]{8,64}$/,
};

/**
 * 内置字段。命名规则：**能被这张表装下的东西才配被记**。
 *
 * 每一条都对得上文档里的某个需求：
 * - 网关侧只记 token 数 / 时延 / 错误码（Q14 原话）
 * - 审计记时间、id、工具名、动作摘要、路径类别、审批结果、guardian 判定、退出码、token 用量（10 §6）
 * - 审计**不记** prompt 正文、文件内容、命令完整输出（10 §6 的"不记什么"）
 */
export const BUILTIN_FIELDS: Readonly<Record<string, FieldKind>> = Object.freeze({
  // —— 关联 id ——
  requestId: 'id',
  traceId: 'id',
  spanId: 'id',
  sessionId: 'id',
  threadId: 'id',
  parentThreadId: 'id',
  turnId: 'id',
  itemId: 'id',
  callId: 'id',
  automationId: 'id',
  runId: 'id',
  artifactId: 'id',
  shareId: 'id',
  deviceId: 'id',
  projectId: 'id',
  subscriptionId: 'id',

  // —— 版本与环境 ——
  service: 'token',
  appVersion: 'id',
  kernelCommit: 'id',
  schemaVersion: 'count',
  platform: 'token',

  // —— 协议与模型 ——
  method: 'token',
  provider: 'token',
  model: 'token',
  wireApi: 'token',
  statusCode: 'count',
  streamEventKind: 'token',
  toolName: 'token',
  skill: 'token',
  mode: 'token',
  scenarioId: 'token',
  permissionProfile: 'token',

  // —— 计量（Q14 允许的三样之一：token 数）——
  tokensIn: 'count',
  tokensOut: 'count',
  tokensCached: 'count',
  tokensReasoning: 'count',
  tokenBudget: 'count',
  itemCount: 'count',
  fileCount: 'count',
  rowCount: 'count',
  pageCount: 'count',
  byteSize: 'count',
  retryCount: 'count',
  droppedFields: 'count',
  exitCode: 'count',
  concurrency: 'count',

  // —— 时延（Q14 允许的第二样）——
  durationMs: 'duration',
  latencyMs: 'duration',
  ttfbMs: 'duration',
  waitedMs: 'duration',

  // —— 错误与原因（Q14 允许的第三样：错误码）——
  errorClass: 'token',
  errorCode: 'code',
  failureClass: 'code',
  skipReason: 'code',
  reason: 'code',
  degradeReason: 'code',

  // —— 摘要：不记原文但保留同一性 ——
  messageDigest: 'digest',
  promptDigest: 'digest',
  contentHash: 'digest',
  pathDigest: 'digest',
  configDigest: 'digest',
  signatureFingerprint: 'digest',

  // —— 路径：只记类别、摘要与扩展名（文件名可能含客户名，见本文件头部）——
  pathKind: 'token',
  extension: 'token',

  // —— 判定与开关 ——
  cacheHit: 'bool',
  degraded: 'bool',
  approved: 'bool',
  sandboxed: 'bool',
  networkAccess: 'bool',
  fromCatchup: 'bool',
  interrupted: 'bool',
  guardianRisk: 'token',
  messageLength: 'count',
});

export class FieldPolicyViolation extends Error {
  override readonly name = 'FieldPolicyViolation';
  constructor(
    readonly field: string,
    readonly problem: 'unregistered' | 'bad-shape',
    readonly kind?: FieldKind,
  ) {
    super(
      problem === 'unregistered'
        ? `字段 \`${field}\` 未注册。日志只接受注册过的结构化字段（Q14）。` +
            `想记新东西：先在 packages/logging/src/fields.ts 注册它，并想清楚它的值能不能装下一句自然语言。`
        : `字段 \`${field}\` 的值不符合 \`${kind}\` 的形状。` +
            `自由文本一律不许进日志：路径用 pathFields()，错误用 errorFields()，其余用 digest()。`,
    );
  }
}

export type FieldValue = string | number | boolean | null | undefined;

/** 值是否符合该字段类型。null / undefined 视为"不写"，不算违规。 */
export function isValidValue(kind: FieldKind, value: FieldValue): boolean {
  if (value === null || value === undefined) return true;
  switch (kind) {
    case 'count':
      return (
        typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
      );
    case 'duration':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0;
    case 'bool':
      return typeof value === 'boolean';
    case 'id':
    case 'token':
    case 'code':
    case 'digest':
      return typeof value === 'string' && PATTERNS[kind].test(value);
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** 字段表可扩展，但只能加不能删（删字段等于让历史日志的读法漂移）。 */
export function createFieldRegistry(extra: Readonly<Record<string, FieldKind>> = {}) {
  const table = new Map<string, FieldKind>(Object.entries({ ...BUILTIN_FIELDS, ...extra }));
  return {
    kindOf(field: string): FieldKind | undefined {
      return table.get(field);
    },
    has(field: string): boolean {
      return table.has(field);
    },
    register(field: string, kind: FieldKind): void {
      const existing = table.get(field);
      if (existing && existing !== kind) {
        throw new Error(`字段 \`${field}\` 已注册为 \`${existing}\`，不能改成 \`${kind}\``);
      }
      table.set(field, kind);
    },
    size(): number {
      return table.size;
    },
  };
}

export type FieldRegistry = ReturnType<typeof createFieldRegistry>;
