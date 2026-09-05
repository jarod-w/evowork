/**
 * cron 解析与下次触发时刻（07 §3.3 的第 ③ 档 + 「未来 5 次触发时间」预览）。
 *
 * ## 为什么自己写而不是拉库
 *
 * 需要的是**带命名时区**的下次触发时刻，而这正是大多数 cron 库处理得最含糊的地方：
 * 它们要么只按 UTC 算，要么依赖进程的本地时区。而 07 §3.2 明确要求
 * **时区显式存储、不依赖运行时系统设置**（跨时区出差不改变触发时刻）。
 *
 * 加上 DST 的两个边界（下面单独说），这件事的规格比"解析五个字段"复杂得多，
 * 而复杂的部分恰恰是库不会替我们决定的。
 *
 * ## DST 的两个边界 —— 这是本文件最需要被读到的部分
 *
 * 一个「每天 02:30」的任务，在实行夏令时的时区里：
 *
 * | 情况 | 现象 | 我们的选择 |
 * |---|---|---|
 * | 春季跳过（02:00 → 03:00） | 那天**没有** 02:30 | 在**跳变后的第一个瞬间**触发（03:00），而不是跳过这一天 |
 * | 秋季重复（02:00 出现两次） | 那天有**两个** 02:30 | **只触发一次**（第一个），靠幂等键 `automation_id + fire_time` 保证 |
 *
 * 两个选择的共同原则：**宁可早一点，不可漏一天**。用户设每天跑，就该每天跑到。
 */

export interface CronFields {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: readonly number[];
  readonly months: readonly number[];
  readonly daysOfWeek: readonly number[];
  /** 日与周同时被限定时的语义（见 `matchesDay`） */
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

const RANGES = {
  minutes: [0, 59],
  hours: [0, 23],
  daysOfMonth: [1, 31],
  months: [1, 12],
  daysOfWeek: [0, 6],
} as const;

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseField(raw: string, kind: keyof typeof RANGES): number[] {
  const [min, max] = RANGES[kind];
  const values = new Set<number>();

  for (const part of raw.split(',')) {
    const [spec, stepRaw] = part.split('/');
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) {
      throw new CronParseError(`步长必须是正整数，收到 "${stepRaw}"`);
    }

    let from: number;
    let to: number;
    if (spec === '*' || spec === '?') {
      from = min;
      to = max;
    } else if (spec !== undefined && spec.includes('-')) {
      const [a, b] = spec.split('-');
      from = named(a ?? '', kind);
      to = named(b ?? '', kind);
    } else {
      from = named(spec ?? '', kind);
      to = stepRaw === undefined ? from : max;
    }

    if (from < min || to > max || from > to) {
      throw new CronParseError(`"${part}" 超出 ${kind} 的取值范围 ${min}-${max}`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }

  return [...values].sort((a, b) => a - b);
}

function named(token: string, kind: keyof typeof RANGES): number {
  const lower = token.toLowerCase();
  if (kind === 'months') {
    const index = MONTH_NAMES.indexOf(lower);
    if (index >= 0) return index + 1;
  }
  if (kind === 'daysOfWeek') {
    const index = DOW_NAMES.indexOf(lower);
    if (index >= 0) return index;
    // 7 与 0 都表示周日（两种写法都很常见，认错的表现是"周日不跑"）
    if (lower === '7') return 0;
  }
  const value = Number(lower);
  if (!Number.isInteger(value)) throw new CronParseError(`认不出 "${token}"`);
  return value;
}

export function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      `cron 需要 5 个字段（分 时 日 月 周），收到 ${parts.length} 个。例如 "0 9 * * 1-5" = 工作日早 9 点。`,
    );
  }
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  return {
    minutes: parseField(minute, 'minutes'),
    hours: parseField(hour, 'hours'),
    daysOfMonth: parseField(dom, 'daysOfMonth'),
    months: parseField(month, 'months'),
    daysOfWeek: parseField(dow, 'daysOfWeek'),
    domRestricted: dom !== '*' && dom !== '?',
    dowRestricted: dow !== '*' && dow !== '?',
  };
}

/**
 * 日与周同时被限定时是 **OR** 而不是 AND。
 *
 * `0 0 1 * 1` 的标准语义是"每月 1 号**或**每周一"，不是"是 1 号且是周一"。
 * 这条几乎所有人第一次都会写错，而写错的表现是任务几乎不触发。
 */
function matchesDay(fields: CronFields, day: number, weekday: number): boolean {
  const domHit = fields.daysOfMonth.includes(day);
  const dowHit = fields.daysOfWeek.includes(weekday);
  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

/** 某个时刻在某个时区的本地字段。 */
export function toLocalParts(instant: number, timeZone: string): LocalParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl 在午夜会给出 "24"（en-US + hour12:false 的已知行为）
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: DOW_NAMES.indexOf(String(parts.weekday).toLowerCase()),
  };
}

/**
 * 本地字段 → UTC 时刻。
 *
 * 没有库的话只能用"猜 + 用真实偏移修正"这一招，迭代两次足以收敛
 * （偏移量本身依赖时刻，但第二次迭代已经落在正确的偏移区间里）。
 */
export function fromLocalParts(
  parts: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number {
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  let instant = asUtc;
  for (let round = 0; round < 2; round += 1) {
    const local = toLocalParts(instant, timeZone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    instant = asUtc + (instant - localAsUtc);
  }
  return instant;
}

const MINUTE = 60_000;
/** 搜索上界：四年（覆盖闰日）。超过它说明这个 cron 永远不会触发（如 2 月 30 日）。 */
const SEARCH_LIMIT_DAYS = 366 * 4;

/**
 * 严格晚于 `after` 的下一次触发时刻。
 *
 * ## 为什么按**本地日**迭代，而不是按 UTC 分钟推进
 *
 * 第一版是"UTC 游标每次 +1 分钟，读它的本地字段看匹不匹配"。它在两个 DST 边界上都错了，
 * 而且是被测试抓出来的：
 *
 *   · **春季跳过**：本地时间从 01:59 直接跳到 03:00，`02:30` 这组本地字段
 *     在那一天**根本不会出现** → 整天被跳过，用户设的"每天"少跑一天。
 *   · **秋季重复**：本地 01:30 出现两次（回拨前一次、回拨后一次），游标两次都匹配
 *     → 那天**跑了两次**。
 *
 * 改成按本地日历日迭代之后，每个「日 + 时 + 分」组合只产生**一个**候选时刻，
 * 秋季重复自然消失；春季跳过由下面的"往返校验"识别并处理。
 */
export function nextFireTime(
  fields: CronFields,
  after: number,
  timeZone: string,
): number | undefined {
  const start = toLocalParts(after, timeZone);
  let cursor = Date.UTC(start.year, start.month - 1, start.day);

  for (let day = 0; day < SEARCH_LIMIT_DAYS; day += 1) {
    const date = new Date(cursor);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const dayOfMonth = date.getUTCDate();
    const weekday = date.getUTCDay();

    if (fields.months.includes(month) && matchesDay(fields, dayOfMonth, weekday)) {
      for (const hour of fields.hours) {
        for (const minute of fields.minutes) {
          const instant = fromLocalParts({ year, month, day: dayOfMonth, hour, minute }, timeZone);
          if (instant <= after) continue;

          /*
           * 往返校验：把算出来的时刻再转回本地字段。
           *
           * 对得上 → 这个本地时刻真实存在，就是它。
           * 对不上 → 这个本地时刻**在这一天不存在**（春季跳过）。
           *   此时改用 `firstInstantAtOrAfterLocal` 找跳变之后的第一个瞬间（02:30 → 03:00）：
           *   **宁可早半小时，也不能少跑一天**。
           *   （不能直接用 fromLocalParts 的返回值 —— 见那个函数的头注释：
           *   固定点迭代会收敛到跳变**之前**的 01:30，比原定时刻还早一小时。）
           */
          const roundTrip = toLocalParts(instant, timeZone);
          if (roundTrip.hour === hour && roundTrip.minute === minute) return instant;

          // 这个本地时刻在这一天不存在（春季跳过）。找跳变之后的第一个可用时刻
          const afterGap = firstInstantAtOrAfterLocal(
            { year, month, day: dayOfMonth },
            hour * 60 + minute,
            timeZone,
          );
          if (afterGap !== undefined && afterGap > after) return afterGap;
        }
      }
    }
    cursor += 24 * 60 * MINUTE;
  }
  return undefined;
}

/**
 * 某个本地日期里，第一个「本地时刻 >= 目标分钟数」的瞬间。
 *
 * 只在**春季跳过**那条分支上用得到，所以逐分钟扫也无所谓（最多 26 小时 = 1560 次）。
 * 用固定点迭代算不出来的原因是：不存在的本地时刻没有对应的瞬间，
 * 迭代会收敛到跳变**之前**（02:30 → 01:30），而那比原定时刻还早。
 */
function firstInstantAtOrAfterLocal(
  date: { year: number; month: number; day: number },
  targetMinutes: number,
  timeZone: string,
): number | undefined {
  let cursor = fromLocalParts({ ...date, hour: 0, minute: 0 }, timeZone);
  for (let step = 0; step <= 26 * 60; step += 1) {
    const local = toLocalParts(cursor, timeZone);
    if (local.day === date.day && local.hour * 60 + local.minute >= targetMinutes) return cursor;
    // 已经跨到下一天还没满足 → 这一天没有可用时刻
    if (local.day !== date.day && step > 0) return undefined;
    cursor += MINUTE;
  }
  return undefined;
}

/** 「未来 N 次触发时间」预览（07 §3.3：三档共有，且必须显示时区）。 */
export function upcomingFireTimes(
  fields: CronFields,
  after: number,
  timeZone: string,
  count = 5,
): readonly number[] {
  const times: number[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    const next = nextFireTime(fields, cursor, timeZone);
    if (next === undefined) break;
    times.push(next);
    cursor = next;
  }
  return times;
}

/** `once@<epoch ms>` 形式的一次性触发。 */
export const ONCE_PREFIX = 'once@';

export function parseSchedule(
  schedule: string,
):
  | { readonly kind: 'cron'; readonly fields: CronFields }
  | { readonly kind: 'once'; readonly at: number } {
  if (schedule.startsWith(ONCE_PREFIX)) {
    const at = Number(schedule.slice(ONCE_PREFIX.length));
    if (!Number.isFinite(at)) throw new CronParseError(`一次性触发的时间戳不合法：${schedule}`);
    return { kind: 'once', at };
  }
  return { kind: 'cron', fields: parseCron(schedule) };
}

/** 一次性与 cron 统一的下次触发接口。 */
export function nextFire(schedule: string, after: number, timeZone: string): number | undefined {
  const parsed = parseSchedule(schedule);
  if (parsed.kind === 'once') return parsed.at > after ? parsed.at : undefined;
  return nextFireTime(parsed.fields, after, timeZone);
}
