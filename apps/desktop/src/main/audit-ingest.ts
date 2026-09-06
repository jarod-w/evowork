/**
 * hook 写的审计 JSONL → `audit_log` 表（10 §6）。
 *
 * ## 这条链路此前断在中间
 *
 * hook 进程（`plugins/hooks/evowork-policy/bin/_runner.mjs`）已经在产出记录，
 * 并把它们追加到 `EVOWORK_AUDIT_LOG` 指向的文件。**而没有任何一处设置那个环境变量**，
 * 也没有任何一处读 `audit_log` 表 —— 所以 10 §6 说的"审计对用户可见"
 * （原则 6：Q1=A 之下没有企业后台替用户看）从来没有成立过。
 *
 * ## 为什么中间隔一个文件，而不是让 hook 直接写库
 *
 * hook 是**内核起的短命子进程**，一次工具调用起一次。让它开 sqlite：
 *
 *   · 要把 `node:sqlite` 和一份表结构带进 hook 包（它现在是纯函数 + 一个 40 行的壳）；
 *   · 每次工具调用多一次开库/关库；
 *   · 最要命的是**写锁**：桌面进程一直开着同一个库，hook 并发写会撞上
 *     `SQLITE_BUSY`，而 hook 里"审计写不进去不能挡住工具执行"意味着它只会被吞掉。
 *
 * 追加一行 JSON 是 `appendFileSync` 一次调用，天然并发安全（O_APPEND），
 * 崩溃最多丢最后一行。桌面进程按自己的节奏搬进库里。
 *
 * ## 为什么是"搬"而不是"读文件当数据源"
 *
 * 表是 `authoritative` 类（schema.ts 的分类），有保留期与链式哈希；
 * 文件只是传输媒介。搬完就截断，否则同一条记录会随每次读入库一次。
 */
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';

import { errorFields, type Logger } from '@evowork/logging';
import type { AuditLogInput } from '@evowork/store';

export interface AuditIngestOptions {
  /** JSONL 文件路径。与传给内核的 `EVOWORK_AUDIT_LOG` 是同一个 */
  readonly path: string;
  readonly insert: (records: readonly AuditLogInput[]) => number;
  readonly logger?: Logger | undefined;
}

/**
 * 把文件里攒下的记录搬进库，然后清空文件。返回搬了几条。
 *
 * **不抛。** 审计搬运失败不该影响任何别的东西 —— 但要留一条日志，
 * 否则"审计页为什么是空的"没有任何线索（这正是这条链路之前的处境）。
 */
export function ingestAuditLog(options: AuditIngestOptions): number {
  if (!existsSync(options.path)) return 0;

  let raw: string;
  try {
    raw = readFileSync(options.path, 'utf8');
  } catch (err: unknown) {
    options.logger?.warn('audit.ingest.read_failed', errorFields(err));
    return 0;
  }
  if (raw.trim() === '') return 0;

  const records: AuditLogInput[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const parsed = parseRecord(line);
    if (parsed) records.push(parsed);
    else skipped += 1;
  }

  try {
    const inserted = options.insert(records);
    // 搬进去了才截断。反过来的话一次插入失败就永久丢掉这批记录
    writeFileSync(options.path, '');
    if (skipped > 0) {
      // 认不出来的行要说出来（CLAUDE.md §9.1），但**不记那一行的内容** ——
      // 它可能是半行 JSON，而半行 JSON 里可能有任何东西（Q14）
      options.logger?.warn('audit.ingest.skipped_lines', { count: skipped });
    }
    options.logger?.info('audit.ingest.done', { count: inserted });
    return inserted;
  } catch (err: unknown) {
    options.logger?.warn('audit.ingest.insert_failed', errorFields(err));
    return 0;
  }
}

/**
 * 一行 JSON → 一条记录。
 *
 * **逐字段挑，不整体展开。** `{...parsed}` 会把 hook 那侧新增的任何字段
 * 原样带进 insert 的参数里 —— 而 hook 那侧新增字段是随时可能发生的事，
 * 且 Q14 的红线正是"别让没登记过的东西进到落盘路径上"。
 * 认不出的行返回 undefined，由调用方计数。
 */
export function parseRecord(line: string): AuditLogInput | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const num = (k: string): number | undefined =>
    typeof parsed[k] === 'number' ? (parsed[k] as number) : undefined;
  const str = (k: string): string | undefined =>
    typeof parsed[k] === 'string' ? (parsed[k] as string) : undefined;

  const occurredAt = num('occurredAt');
  const action = str('action');
  // 这两个是一条记录的最小身份：没有时间就排不了序，没有分类就不知道它是什么
  if (occurredAt === undefined || action === undefined) return undefined;

  return {
    occurredAt,
    action,
    ...(str('threadId') !== undefined ? { threadId: str('threadId') } : {}),
    ...(str('turnId') !== undefined ? { turnId: str('turnId') } : {}),
    ...(str('itemId') !== undefined ? { itemId: str('itemId') } : {}),
    ...(str('toolName') !== undefined ? { toolName: str('toolName') } : {}),
    ...(str('actionSummary') !== undefined ? { actionSummary: str('actionSummary') } : {}),
    ...(str('pathKind') !== undefined ? { pathKind: str('pathKind') } : {}),
    ...(str('pathDigest') !== undefined ? { pathDigest: str('pathDigest') } : {}),
    ...(str('networkTarget') !== undefined ? { networkTarget: str('networkTarget') } : {}),
    ...(str('approvalResult') !== undefined ? { approvalResult: str('approvalResult') } : {}),
    ...(str('decidedBy') !== undefined ? { decidedBy: str('decidedBy') } : {}),
    ...(str('guardianRisk') !== undefined ? { guardianRisk: str('guardianRisk') } : {}),
    ...(num('exitCode') !== undefined ? { exitCode: num('exitCode') } : {}),
    ...(num('tokenUsage') !== undefined ? { tokenUsage: num('tokenUsage') } : {}),
  };
}

/** 确保文件存在（hook 用 `appendFileSync`，父目录必须在；文件本身它会建）。 */
export function ensureAuditLog(path: string): void {
  if (existsSync(path)) return;
  try {
    closeSync(openSync(path, 'a'));
  } catch {
    /* 建不出来时 hook 那侧会静默跳过审计写入，不影响工具执行 */
  }
}
