/**
 * 计量上报的线上形状（11 §6.1 / 验收口径第 3 条）。
 *
 * **类型里没有 `threadId`，也没有任何自由字符串字段。** 计量只需要按天按模型聚合。
 * 带上 `threadId` 看起来无害，但云端就能按任务重建用户的活动时间线 —— 那已经是内容面，
 * D9 承诺的是「无内容」。
 *
 * 自定义模型的调用**完全不上报**（11 §13.4）：花的是用户自己的钱，上报只剩那个副作用。
 */

export const METERING_KEYS = [
  'day',
  'tenant',
  'model',
  'provider',
  'tokensIn',
  'tokensOut',
  'tokensCached',
  'durationMs',
  'errorCode',
] as const;

export type MeteringKey = (typeof METERING_KEYS)[number];

export interface MeteringDay {
  /** `YYYY-MM-DD`，UTC。分钟粒度已够（11 §6.1） */
  readonly day: string;
  readonly tenant: string;
  readonly model: string;
  readonly provider: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensCached: number;
  readonly durationMs: number;
  readonly errorCode?: string | undefined;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9_:.@-]{1,128}$/;
const TOKEN = /^[A-Za-z][A-Za-z0-9_./:-]{0,63}$/;

export function parseMeteringDay(input: unknown): MeteringDay | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  const day = typeof rec.day === 'string' && DAY.test(rec.day) ? rec.day : undefined;
  const tenant = typeof rec.tenant === 'string' && ID.test(rec.tenant) ? rec.tenant : undefined;
  const model = typeof rec.model === 'string' && TOKEN.test(rec.model) ? rec.model : undefined;
  const provider =
    typeof rec.provider === 'string' && TOKEN.test(rec.provider) ? rec.provider : undefined;
  const tokensIn = asCount(rec.tokensIn);
  const tokensOut = asCount(rec.tokensOut);
  const tokensCached = asCount(rec.tokensCached);
  const durationMs = asCount(rec.durationMs);
  if (
    day === undefined ||
    tenant === undefined ||
    model === undefined ||
    provider === undefined ||
    tokensIn === undefined ||
    tokensOut === undefined ||
    tokensCached === undefined ||
    durationMs === undefined
  ) {
    return undefined;
  }
  const errorCode =
    typeof rec.errorCode === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(rec.errorCode)
      ? rec.errorCode
      : undefined;
  return {
    day,
    tenant,
    model,
    provider,
    tokensIn,
    tokensOut,
    tokensCached,
    durationMs,
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/** 把一次调用折进「天 × 模型」桶。自定义模型的调用方根本不该走到这里。 */
export function meteringDayUtc(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}
