/**
 * identity HTTP 客户端。密码只在这里的请求体里出现，不进 sessionStorage 的字段名以外的地方。
 *
 * 类型里没有任务 / 产物 / prompt（11 §12 第 15 条）。
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
  readonly revoked: boolean;
  readonly actorEmail?: string;
  readonly actorPhone?: string;
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

export interface ApiError {
  readonly message: string;
  readonly code: string;
}

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

export async function syncSessionFromMe(): Promise<Session | undefined> {
  const session = readSession();
  if (!session) return undefined;
  const out = await api<{
    role: Role;
    mustChangePassword: boolean;
  }>('/v1/me');
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

export async function api<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; data: T } | { ok: false; error: ApiError; status: number }> {
  const session = readSession();
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
