/**
 * Logger 本体。
 *
 * 接口形状是刻意的：`log.info(event, fields)` —— **没有** `log.info(message)` 这种重载。
 * 只要存在一个接受自由字符串的入口，它就会被用来记正文（"就这一次，为了排查那个 bug"），
 * 然后那行代码会留在仓库里。所以自由文本在类型层面就传不进来（09 §8：
 * 「把'不记正文'做成代码层面的不可能而不是约定」）。
 */
import {
  createFieldRegistry,
  FieldPolicyViolation,
  isValidValue,
  type FieldKind,
  type FieldRegistry,
  type FieldValue,
} from './fields.js';

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** 事件名：点分小写，如 `gateway.request.completed`、`scheduler.misfire.detected`。 */
const EVENT_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

export type Fields = Readonly<Record<string, FieldValue>>;

export interface LogRecord {
  readonly ts: string;
  readonly level: Level;
  readonly event: string;
  readonly service: string;
  readonly fields: Readonly<Record<string, FieldValue>>;
}

export type Sink = (record: LogRecord) => void;

export interface LoggerOptions {
  /** 谁在写：`gateway` / `scheduler` / `adapter` / `desktop`… */
  readonly service: string;
  readonly level?: Level;
  readonly sink?: Sink;
  /**
   * 违规字段的处理方式。
   * - `throw`（默认，开发与测试）：立刻炸，让写代码的人当场发现
   * - `drop`（生产）：丢掉该字段并记一个 `droppedFields` 计数
   *
   * 生产不 throw 是因为**日志不该让业务失败**；但丢弃的方向永远是"少写"而不是"照写"。
   */
  readonly onViolation?: 'throw' | 'drop';
  /** 追加字段表（如某个服务自己的计量字段） */
  readonly extraFields?: Readonly<Record<string, FieldKind>>;
  /** 每条记录都带上的字段（appVersion / deviceId 之类），同样要过校验 */
  readonly base?: Fields;
  readonly now?: () => Date;
}

export interface Logger {
  debug(event: string, fields?: Fields): void;
  info(event: string, fields?: Fields): void;
  warn(event: string, fields?: Fields): void;
  error(event: string, fields?: Fields): void;
  /** 派生一个带附加基础字段的子 logger（如按 requestId 绑定） */
  child(base: Fields): Logger;
  readonly registry: FieldRegistry;
}

/** 把 LogRecord 写成一行 JSON。字段顺序固定，便于 diff 与人眼扫读。 */
export function formatJsonLine(record: LogRecord): string {
  return JSON.stringify({
    ts: record.ts,
    level: record.level,
    event: record.event,
    service: record.service,
    ...record.fields,
  });
}

/** 写到一个 `write(line)` 上（文件、stdout、内存缓冲都行）。 */
export function jsonLinesSink(write: (line: string) => void): Sink {
  return (record) => write(formatJsonLine(record));
}

/** 测试与自审用：把记录留在内存里，可整体做泄露断言。 */
export function memorySink(): Sink & { records: LogRecord[]; text(): string } {
  const records: LogRecord[] = [];
  const sink = ((record: LogRecord) => {
    records.push(record);
  }) as Sink & { records: LogRecord[]; text(): string };
  sink.records = records;
  sink.text = () => records.map(formatJsonLine).join('\n');
  return sink;
}

export function createLogger(options: LoggerOptions): Logger {
  const registry = createFieldRegistry(options.extraFields ?? {});
  const minLevel = LEVEL_ORDER[options.level ?? 'info'];
  const sink = options.sink ?? jsonLinesSink((line) => process.stdout.write(`${line}\n`));
  const onViolation = options.onViolation ?? 'throw';
  const now = options.now ?? (() => new Date());

  function sanitize(fields: Fields): { clean: Record<string, FieldValue>; dropped: number } {
    const clean: Record<string, FieldValue> = {};
    let dropped = 0;
    for (const [key, value] of Object.entries(fields)) {
      if (value === null || value === undefined) continue;
      const kind = registry.kindOf(key);
      if (!kind) {
        if (onViolation === 'throw') throw new FieldPolicyViolation(key, 'unregistered');
        dropped += 1;
        continue;
      }
      if (!isValidValue(kind, value)) {
        if (onViolation === 'throw') throw new FieldPolicyViolation(key, 'bad-shape', kind);
        dropped += 1;
        continue;
      }
      clean[key] = value;
    }
    return { clean, dropped };
  }

  function make(base: Fields): Logger {
    const emit = (level: Level, event: string, fields: Fields = {}): void => {
      if (LEVEL_ORDER[level] < minLevel) return;
      if (!EVENT_RE.test(event)) {
        // 事件名是维度不是内容：允许它畸形就等于开了一个自由文本入口
        if (onViolation === 'throw') {
          throw new FieldPolicyViolation(`event:${event}`, 'bad-shape', 'token');
        }
        return;
      }
      const merged = sanitize({ ...base, ...fields });
      const withDrops =
        merged.dropped > 0
          ? {
              ...merged.clean,
              droppedFields: (Number(merged.clean.droppedFields) || 0) + merged.dropped,
            }
          : merged.clean;
      sink({
        ts: now().toISOString(),
        level,
        event,
        service: options.service,
        fields: withDrops,
      });
    };

    return {
      debug: (event, fields) => emit('debug', event, fields),
      info: (event, fields) => emit('info', event, fields),
      warn: (event, fields) => emit('warn', event, fields),
      error: (event, fields) => emit('error', event, fields),
      child: (extra) => make({ ...base, ...extra }),
      registry,
    };
  }

  return make(options.base ?? {});
}
