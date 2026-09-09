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
