/**
 * @evowork/logging —— 结构化日志。
 *
 * 它守的是 Q14 那条**对外可审计的承诺**：「网关不落盘 prompt 与响应体，只记 token 计数、
 * 时延与错误码」。09 §8 要求本机日志同口径（便于用户自查），10 §6 要求审计留痕同口径
 * （不记 prompt 正文、文件内容、命令完整输出）。三处是同一件事，所以只有一份实现。
 *
 * 三层防线：
 *   ① **接口形状** —— 没有接受自由字符串的日志入口（`logger.ts`）
 *   ② **字段注册表** —— 只有注册过的字段名 + 符合形状的值能进（`fields.ts`）
 *   ③ **泄露检测** —— 对输出做 8 字滑窗断言，用于测试与 M0 的可审计手段（`leak-detector.ts`）
 *
 * 三个"正确做法比错误做法更省事"的出口（`redact.ts`）：
 *   `pathFields()` 记路径 · `errorFields()` 记错误 · `digest()` 记同一性
 */
export {
  BUILTIN_FIELDS,
  createFieldRegistry,
  FieldPolicyViolation,
  isValidValue,
  type FieldKind,
  type FieldRegistry,
  type FieldValue,
} from './fields.js';

export {
  BodyFreeError,
  digest,
  errorFields,
  pathFields,
  type ErrorFields,
  type PathClassification,
  type PathKind,
} from './redact.js';

export {
  assertNoLeak,
  findLeaks,
  LeakDetected,
  type Leak,
  type LeakOptions,
} from './leak-detector.js';

export {
  createLogger,
  formatJsonLine,
  jsonLinesSink,
  LEVELS,
  memorySink,
  type Fields,
  type Level,
  type Logger,
  type LoggerOptions,
  type LogRecord,
  type Sink,
} from './logger.js';
