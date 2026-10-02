/**
 * identity HTTP 客户端。密码只在这里的请求体里出现。
 *
 * 类型里没有任务 / 产物 / prompt（11 §12 第 15 条）。
 *
 * ## 这一层为什么要管 refresh
 *
 * access JWT 只有 15 分钟（`ACCESS_TTL_SEC`）。在补上 `withRefresh` 之前，
 * 管理端开着超过 15 分钟之后**每一个按钮都会变成「请求失败」**，
 * 而页面上没有一句话说要重新登录 —— 这是这一页最要紧的那个缺陷。
 *
 * 现在的顺序是：401 → 用 refresh_token 换一对新令牌 → **重放原请求一次**；
 * 换不到才让调用方看到 `session-expired`，由 `App` 弹「登录已过期」。
 */

export const SESSION_KEY = 'ew.web.session';

export type Role = 'member' | 'admin';

export interface Session {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly role: Role;
  readonly mustChangePassword: boolean;
}

export interface PkceQuery {
  readonly codeChallenge: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly deviceId: string;
}

export interface PublicModel {
  readonly id: string;
  readonly displayName: string;
  readonly provider: string;
  readonly upstreamModel: string;
  readonly adapter: string;
  readonly credentialSource: 'hosted';
}

export interface AdminMember {
  readonly id: string;
  readonly email?: string;
  readonly phone?: string;
  readonly role: Role;
  readonly quotaClass: string;
}

export interface AdminInvite {
  readonly id: string;
  readonly email: string;
  readonly role: Role;
  readonly quotaClass: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly invitedByEmail?: string;
}

export interface DeviceRow {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly lastSeenAt: number;
  readonly revoked: boolean;
}

export interface QuotaView {
  readonly used: number;
  readonly limit: number;
  readonly quotaClass?: string;
}

export interface QuotaClassView {
  readonly name: string;
  readonly tokensLimit: number;
}

export interface PolicyPackView {
  readonly id: string;
  readonly kid: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly graceUntil?: number;
  readonly disabledModels: readonly string[];
  readonly disabledProfiles: readonly string[];
  readonly allowCustom: boolean;
  readonly reason?: string;
  readonly allowManagedHooksOnly: boolean;
  readonly disableShare: boolean;
  readonly disableSlots: boolean;
  readonly forceAudit: boolean;
  /** 13 §4.7 ①：成员客户端不再向 EvoWork 精选源发请求，已装的精选条目停用。 */
  readonly disableOfficialHub: boolean;
  readonly revoked: boolean;
  readonly actorEmail?: string;
  readonly actorPhone?: string;
}

export interface StaleDeviceView {
  readonly deviceId: string;
  readonly name: string;
  readonly platform: string;
  readonly lastSeenAt: number;
  readonly ownerEmail?: string;
  readonly pulledAt?: number;
}

export interface PolicyReachView {
  readonly packId?: string;
  readonly total: number;
  readonly pulled: number;
  readonly stale: readonly StaleDeviceView[];
}

export interface TenantSettingsView {
  readonly warnMember: boolean;
  readonly warnPercent: number;
  readonly warnAdmin: boolean;
}

export interface IdentityAuditView {
  readonly at: number;
  readonly action: string;
  readonly actorEmail?: string;
  readonly actorPhone?: string;
  readonly targetEmail?: string;
  readonly targetPhone?: string;
  readonly targetRef?: string;
}

export interface AdminUsageMember {
  readonly id: string;
  readonly email?: string;
  readonly phone?: string;
  readonly used: number;
  readonly limit: number;
  readonly quotaClass: string;
  readonly exhausted: boolean;
}

export interface AdminUsage {
  readonly tenantUsed: number;
  readonly members: readonly AdminUsageMember[];
}

export interface InviteInfo {
  readonly email: string;
  readonly tenantName: string;
  readonly registered: boolean;
  readonly expiresAt: number;
}

export interface ApiError {
  readonly message: string;
  readonly code: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError; status: number };

export function identityOrigin(): string {
  const fromEnv = import.meta.env.VITE_IDENTITY_ORIGIN;
  return (fromEnv && fromEnv.trim() !== '' ? fromEnv : 'http://127.0.0.1:8788').replace(/\/$/, '');
}

export function readSession(): Session | undefined {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Session;
    if (typeof parsed.accessToken !== 'string') return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeSession(session: Session): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  sessionStorage.removeItem(SESSION_KEY);
}

/**
 * 会话失效的订阅点。`App` 挂上去，收到就弹「登录已过期」。
 *
 * 用订阅而不是让每个调用方自己判断：`session-expired` 会从任意一个请求里冒出来，
 * 让二十处调用点各写一遍"如果是这个码就弹窗"，漏掉一处就又回到静默失败。
 */
type ExpiryListener = () => void;
const expiryListeners = new Set<ExpiryListener>();

export function onSessionExpired(listener: ExpiryListener): () => void {
  expiryListeners.add(listener);
  return () => expiryListeners.delete(listener);
}

function announceExpiry(): void {
  for (const listener of [...expiryListeners]) listener();
}

export function parsePkce(search: string): PkceQuery | undefined {
  const q = new URLSearchParams(search);
  const codeChallenge = q.get('code_challenge') ?? '';
  const redirectUri = q.get('redirect_uri') ?? '';
  const state = q.get('state') ?? '';
  const deviceId = q.get('device_id') ?? '';
  if (!codeChallenge || !redirectUri || !deviceId) return undefined;
  if (!redirectUri.startsWith('http://127.0.0.1:')) return undefined;
  return { codeChallenge, redirectUri, state, deviceId };
}

/** 同一时刻只跑一次续期：六个面板并发打 401 时，不该换六次令牌。 */
let refreshing: Promise<boolean> | undefined;

async function refreshSession(): Promise<boolean> {
  const session = readSession();
  if (!session?.refreshToken) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${identityOrigin()}/v1/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: session.refreshToken,
        }),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { accessToken?: string; refreshToken?: string };
      if (!body.accessToken || !body.refreshToken) return false;
      const current = readSession();
      writeSession({
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
        role: current?.role ?? session.role,
        mustChangePassword: current?.mustChangePassword ?? session.mustChangePassword,
      });
      return true;
    } catch {
      return false;
    } finally {
      // 下一次 401 要能再试：不清掉就永远拿着这一次的结果
      queueMicrotask(() => {
        refreshing = undefined;
      });
    }
  })();
  return refreshing;
}

async function send<T>(path: string, init: RequestInit, withAuth: boolean): Promise<ApiResult<T>> {
  const session = withAuth ? readSession() : undefined;
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) headers.set('content-type', 'application/json');
  if (session && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${session.accessToken}`);
  }
  let res: Response;
  try {
    res = await fetch(`${identityOrigin()}${path}`, { ...init, headers });
  } catch {
    return { ok: false, error: { message: '连不上账号服务', code: 'network' }, status: 0 };
  }
  const text = await res.text();
  let body: unknown = {};
  if (text !== '') {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = {};
    }
  }
  if (!res.ok) {
    const err =
      body && typeof body === 'object' && 'error' in body
        ? (body as { error: ApiError }).error
        : { message: '请求失败', code: 'http' };
    return { ok: false, error: err, status: res.status };
  }
  return { ok: true, data: body as T };
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const first = await send<T>(path, init, true);
  if (first.ok || first.status !== 401 || !readSession()) return first;

  // 401 有两种：令牌过期（能续）和真的没权限（续不了）。只有前者值得重放。
  if (await refreshSession()) return send<T>(path, init, true);

  clearSession();
  announceExpiry();
  return {
    ok: false,
    error: { message: '登录已过期，请重新登录。', code: 'session-expired' },
    status: 401,
  };
}

/** 邀请页**不带 authorization**：收件人还没登录，旁边也不该放着一把令牌。 */
export function publicApi<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  return send<T>(path, init, false);
}

export async function syncSessionFromMe(): Promise<Session | undefined> {
  const session = readSession();
  if (!session) return undefined;
  const out = await api<{ role: Role; mustChangePassword: boolean }>('/v1/me');
  if (!out.ok) return session;
  const next: Session = {
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    role: out.data.role,
    mustChangePassword: out.data.mustChangePassword,
  };
  writeSession(next);
  return next;
}

export async function finishDesktopPkce(pkce: PkceQuery): Promise<string | undefined> {
  const out = await api<{ code: string }>('/v1/oauth/authorize', {
    method: 'POST',
    body: JSON.stringify({
      code_challenge: pkce.codeChallenge,
      redirect_uri: pkce.redirectUri,
      device_id: pkce.deviceId,
    }),
  });
  if (!out.ok) return out.error.message;
  const next = new URL(pkce.redirectUri);
  next.searchParams.set('code', out.data.code);
  if (pkce.state) next.searchParams.set('state', pkce.state);
  window.location.assign(next.toString());
  return undefined;
}

/* ───────────────────────────── 展示用的小工具 ───────────────────────────── */

/**
 * 时间按**本地时区**显示。
 *
 * 之前整页是 UTC —— 一个中文产品的审计表写着 `2026-09-26 06:32 UTC`，
 * 管理员得自己做减法才知道"这是不是我刚才那一下"。
 */
export function formatTime(at: number): string {
  const ms = at < 1_000_000_000_000 ? at * 1000 : at;
  const date = new Date(ms);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (sameDay) return `今天 ${hh}:${mm}`;
  const sameYear = date.getFullYear() === now.getFullYear();
  const head = sameYear
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  return `${head} ${hh}:${mm}`;
}

export function formatDay(at: number): string {
  const ms = at < 1_000_000_000_000 ? at * 1000 : at;
  const date = new Date(ms);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 「还有几天」。过去的时间返回负数，调用方自己决定怎么说。 */
export function daysUntil(at: number, from = Date.now()): number {
  const ms = at < 1_000_000_000_000 ? at * 1000 : at;
  return Math.ceil((ms - from) / 86_400_000);
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/** `limit <= 0` 是「不限」，不是「上限为 0」。两处显示过口径不一致，这里收成一个函数。 */
export function formatQuota(used: number, limit: number): string {
  if (limit <= 0) return `${used.toLocaleString('zh-CN')} tokens · 不设上限`;
  return `${used.toLocaleString('zh-CN')} / ${limit.toLocaleString('zh-CN')} tokens`;
}

export function quotaPercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function who(row: { email?: string | undefined; phone?: string | undefined }): string {
  return row.email ?? row.phone ?? '—';
}

const AUDIT_LABELS: Record<string, string> = {
  'grant-admin': '授予管理员',
  'revoke-admin': '收回管理员',
  'update-model-key': '更新默认模型密钥',
  'delete-model': '删除默认模型',
  'issue-policy-pack': '签发策略包',
  'revoke-policy-pack': '撤销策略包',
  'invite-member': '邀请成员',
  'revoke-invite': '撤回邀请',
  'add-member': '加入成员',
  'set-quota': '设置额度上限',
  'assign-quota-class': '分配配额班级',
};

export function auditActionLabel(action: string): string {
  return AUDIT_LABELS[action] ?? action;
}

/**
 * 身份面审计导出。
 *
 * **只有这一张表能导出**：它记的是"谁在什么时候动了权限"，本来就是给审计看的。
 * 用量明细不给导出（Q43=A）—— 那是另一类数据，导出来就能拼出一条
 * 「谁什么时候在用产品」的时间线。
 */
export function auditToCsv(rows: readonly IdentityAuditView[]): string {
  const head = ['时间', '动作', '操作人', '对象', '备注'];
  const body = rows.map((row) => [
    formatTime(row.at),
    auditActionLabel(row.action),
    who({ email: row.actorEmail, phone: row.actorPhone }),
    who({ email: row.targetEmail, phone: row.targetPhone }),
    row.targetRef ?? '',
  ]);
  return [head, ...body]
    .map((cells) => cells.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

/** 密码强度：0–4。规则写在这里，注册 / 重置 / 改密三处共用一份。 */
export function passwordStrength(value: string): { score: number; hint: string } {
  if (value === '') return { score: 0, hint: '至少 12 位，含字母与数字' };
  let score = 0;
  if (value.length >= 12) score += 2;
  else if (value.length >= 8) score += 1;
  if (/[a-zA-Z]/.test(value) && /\d/.test(value)) score += 1;
  if (/[^a-zA-Z0-9]/.test(value)) score += 1;
  const hint =
    value.length < 12
      ? '太短了，至少 12 位'
      : (['很弱', '弱', '一般', '强', '很强'][score] ?? '强');
  return { score: Math.min(4, score), hint };
}
