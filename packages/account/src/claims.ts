/**
 * access JWT 的 claims（11 §5.2）。
 *
 * **类型层面就不能装内容**：只有 `sub` / `tenant` / `exp` / `iat` / `scope` /
 * `quotaClass` / `deviceId` / `role`。想记任务标题或 prompt 得先改这个类型，
 * 而改它会被 review 看见 —— 与 `packages/logging` 的字段注册表是同一条纪律。
 *
 * `role` **只用于决定客户端是否显示「管理端」入口，不授权任何客户端能力**
 * （11 §13.6）。授权在服务端。
 */

export const ROLES = ['member', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const QUOTA_CLASSES = ['default'] as const;
export type QuotaClass = (typeof QUOTA_CLASSES)[number] | (string & {});

/** access JWT 允许出现的键。扫描测试对着这张表，多一个键就是一次内容面泄漏。 */
export const ACCESS_CLAIM_KEYS = [
  'sub',
  'tenant',
  'exp',
  'iat',
  'scope',
  'quotaClass',
  'deviceId',
  'role',
] as const;

export type AccessClaimKey = (typeof ACCESS_CLAIM_KEYS)[number];

export interface AccessClaims {
  /** 账号 id。日志里只用它的摘要，不把原值当 `userId` 注册（D10） */
  readonly sub: string;
  readonly tenant: string;
  /** unix 秒 */
  readonly exp: number;
  readonly iat: number;
  /** 空格分隔。v1 只有 `gateway` */
  readonly scope: string;
  readonly quotaClass: QuotaClass;
  readonly deviceId: string;
  readonly role: Role;
}

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_SEC = 30 * 24 * 60 * 60;
/** 验签时允许的时钟偏移（秒） */
export const CLOCK_SKEW_SEC = 60;

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/**
 * 从未知 JSON 收成 `AccessClaims`。多出来的键**丢掉**，缺任何一个必填键就失败。
 *
 * 丢掉而不是拒绝：旧版 identity 加了一个我们还不认识的 optional 键时，
 * 网关不该因此把所有请求打成 401。反方向（缺键）必须失败 —— 缺 `tenant`
 * 的 token 会让计量与目录落到错误的租户上。
 */
export function parseAccessClaims(input: unknown): AccessClaims | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const rec = input as Record<string, unknown>;
  const sub = asId(rec.sub);
  const tenant = asId(rec.tenant);
  const exp = asUnix(rec.exp);
  const iat = asUnix(rec.iat);
  const scope = asToken(rec.scope);
  const quotaClass = asToken(rec.quotaClass);
  const deviceId = asId(rec.deviceId);
  const role = typeof rec.role === 'string' && isRole(rec.role) ? rec.role : undefined;
  if (
    sub === undefined ||
    tenant === undefined ||
    exp === undefined ||
    iat === undefined ||
    scope === undefined ||
    quotaClass === undefined ||
    deviceId === undefined ||
    role === undefined
  ) {
    return undefined;
  }
  return { sub, tenant, exp, iat, scope, quotaClass, deviceId, role };
}

function asId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_:.@-]{1,128}$/.test(value) ? value : undefined;
}

function asToken(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_./: -]{0,63}$/.test(value)
    ? value
    : undefined;
}

function asUnix(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}
