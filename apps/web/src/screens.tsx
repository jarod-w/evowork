/**
 * 账号与管理端页面。密码只在这些表单的 input[type=password] 里。
 */
import { useEffect, useState, type FormEvent } from 'react';

import {
  api,
  clearSession,
  finishDesktopPkce,
  parsePkce,
  readSession,
  writeSession,
  type AdminMember,
  type DeviceRow,
  type PublicModel,
  type QuotaView,
  type Session,
} from './api.js';

function Field(props: {
  readonly label: string;
  readonly type?: string;
  readonly name: string;
  readonly autoComplete?: string;
  readonly required?: boolean;
}) {
  return (
    <label className="ew-field">
      {props.label}
      <input
        name={props.name}
        type={props.type ?? 'text'}
        autoComplete={props.autoComplete}
        required={props.required === true}
      />
    </label>
  );
}

function formData(e: FormEvent<HTMLFormElement>): Record<string, string> {
  const data = new FormData(e.currentTarget);
  const out: Record<string, string> = {};
  for (const [key, value] of data.entries()) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

export function SignInPage(props: { readonly search: string; readonly onSignedIn: () => void }) {
  const [error, setError] = useState<string | undefined>();
  const pkce = parsePkce(props.search);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    const out = await api<{
      accessToken: string;
      refreshToken: string;
      role: Session['role'];
      mustChangePassword: boolean;
    }>('/v1/login', {
      method: 'POST',
      body: JSON.stringify({
        identifier: body.identifier,
        password: body.password,
        deviceId: pkce?.deviceId ?? 'web',
        deviceName: '浏览器',
        platform: 'web',
      }),
    });
    if (!out.ok) {
      setError(out.error.message);
      return;
    }
    writeSession({
      accessToken: out.data.accessToken,
      refreshToken: out.data.refreshToken,
      role: out.data.role,
      mustChangePassword: out.data.mustChangePassword,
    });
    if (pkce) {
      const refused = await finishDesktopPkce(pkce);
      if (refused) setError(refused);
      return;
    }
    props.onSignedIn();
  }

  return (
    <section>
      <h1>登录 EvoWork</h1>
      <p>密码只在这个页面输入。客户端进程里没有密码框。</p>
      <form onSubmit={(e) => void onSubmit(e)}>
        <Field label="邮箱或手机号" name="identifier" autoComplete="username" required />
        <Field label="密码" name="password" type="password" autoComplete="current-password" required />
        {error ? <p className="ew-error">{error}</p> : null}
        <div className="ew-actions">
          <button type="submit">登录</button>
        </div>
      </form>
    </section>
  );
}

export function SignUpPage() {
  const [error, setError] = useState<string | undefined>();
  const [ok, setOk] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    const out = await api('/v1/signup', {
      method: 'POST',
      body: JSON.stringify({ email: body.email, password: body.password }),
    });
    if (!out.ok) {
      setError(out.error.message);
      return;
    }
    setOk(true);
  }

  return (
    <section>
      <h1>注册</h1>
      <p>用邮箱注册。我们会发一封验证邮件，不发短信。</p>
      {ok ? <p className="ew-ok">请查收验证邮件。</p> : null}
      <form onSubmit={(e) => void onSubmit(e)}>
        <Field label="邮箱" name="email" type="email" autoComplete="email" required />
        <Field label="密码" name="password" type="password" autoComplete="new-password" required />
        {error ? <p className="ew-error">{error}</p> : null}
        <div className="ew-actions">
          <button type="submit">注册</button>
        </div>
      </form>
    </section>
  );
}

export function VerifyPage(props: { readonly search: string }) {
  const [message, setMessage] = useState('正在验证…');
  useEffect(() => {
    const token = new URLSearchParams(props.search).get('token') ?? '';
    if (!token) {
      setMessage('缺少验证令牌。');
      return;
    }
    void api('/v1/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }).then((out) => {
      if (out.ok) setMessage('邮箱已验证，可以登录了。');
      else setMessage(out.error.message);
    });
  }, [props.search]);
  return (
    <section>
      <h1>验证邮箱</h1>
      <p>{message}</p>
    </section>
  );
}

export function ResetPage(props: { readonly search: string }) {
  const token = new URLSearchParams(props.search).get('token') ?? '';
  const [error, setError] = useState<string | undefined>();
  const [ok, setOk] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    if (!token) {
      const out = await api('/v1/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: body.email }),
      });
      if (!out.ok) setError(out.error.message);
      else setOk(true);
      return;
    }
    const out = await api('/v1/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password: body.password }),
    });
    if (!out.ok) setError(out.error.message);
    else setOk(true);
  }

  return (
    <section>
      <h1>重置密码</h1>
      <form onSubmit={(e) => void onSubmit(e)}>
        {token ? (
          <Field label="新密码" name="password" type="password" autoComplete="new-password" required />
        ) : (
          <Field label="邮箱" name="email" type="email" autoComplete="email" required />
        )}
        {error ? <p className="ew-error">{error}</p> : null}
        {ok ? <p className="ew-ok">{token ? '密码已更新。' : '如果该邮箱存在，我们已发出重置邮件。'}</p> : null}
        <div className="ew-actions">
          <button type="submit">{token ? '更新密码' : '发送重置邮件'}</button>
        </div>
      </form>
    </section>
  );
}

export function AccountHome(props: { readonly onDelete: () => void }) {
  const session = readSession();
  const [quota, setQuota] = useState<QuotaView | undefined>();
  const [devices, setDevices] = useState<readonly DeviceRow[]>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    void (async () => {
      const q = await api<QuotaView>('/v1/quota');
      if (q.ok) setQuota(q.data);
      const d = await api<{ devices: DeviceRow[] }>('/v1/devices');
      if (d.ok) setDevices(d.data.devices);
    })();
  }, []);

  if (!session) {
    return (
      <section>
        <h1>账号</h1>
        <p>请先登录。</p>
      </section>
    );
  }

  async function revoke(id: string) {
    const out = await api('/v1/devices/revoke', {
      method: 'POST',
      body: JSON.stringify({ deviceId: id }),
    });
    if (!out.ok) setError(out.error.message);
    else setDevices((list) => list.map((row) => (row.id === id ? { ...row, revoked: true } : row)));
  }

  return (
    <section>
      <h1>账号</h1>
      <p>任务和产物在你的电脑上。这里只管理登录凭据和托管额度。</p>
      {quota ? (
        <p>
          本月托管额度：已用 {quota.used} / {quota.limit} tokens。额度用尽后不会自动换成其他模型。
        </p>
      ) : null}
      <p>没有充值或升级入口。</p>
      {session.mustChangePassword ? <p className="ew-error">请先修改引导密码后再使用管理端。</p> : null}
      <h2>已登录的设备</h2>
      <ul>
        {devices.map((device) => (
          <li key={device.id}>
            {device.name} · {device.platform}
            {device.revoked ? '（已吊销）' : null}{' '}
            {!device.revoked ? (
              <button type="button" data-tone="ghost" onClick={() => void revoke(device.id)}>
                吊销
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <p className="ew-error">{error}</p> : null}
      <div className="ew-actions">
        <button type="button" data-tone="ghost" onClick={props.onDelete}>
          注销账号
        </button>
      </div>
    </section>
  );
}

export function AccountDeletePage(props: { readonly onDone: () => void }) {
  const [error, setError] = useState<string | undefined>();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    const out = await api('/v1/account/delete', {
      method: 'POST',
      body: JSON.stringify({ password: body.password }),
    });
    if (!out.ok) {
      setError(out.error.message);
      return;
    }
    clearSession();
    props.onDone();
  }

  return (
    <section>
      <h1>注销账号</h1>
      <p>注销只删除云端登录凭据。你电脑上的任务和产物不会被删。</p>
      <form onSubmit={(e) => void onSubmit(e)}>
        <Field label="再输入一次密码" name="password" type="password" autoComplete="current-password" required />
        {error ? <p className="ew-error">{error}</p> : null}
        <div className="ew-actions">
          <button type="submit">确认注销</button>
        </div>
      </form>
    </section>
  );
}

export function AdminPage() {
  const session = readSession();
  const [members, setMembers] = useState<readonly AdminMember[]>([]);
  const [models, setModels] = useState<readonly PublicModel[]>([]);
  const [error, setError] = useState<string | undefined>();
  const [ok, setOk] = useState<string | undefined>();

  async function reload() {
    const m = await api<{ members: AdminMember[] }>('/v1/admin/members');
    if (m.ok) setMembers(m.data.members);
    else setError(m.error.message);
    const modelsOut = await api<{ models: PublicModel[] }>('/v1/admin/models');
    if (modelsOut.ok) setModels(modelsOut.data.models);
  }

  useEffect(() => {
    void reload();
  }, []);

  if (!session || session.role !== 'admin') {
    return (
      <section>
        <h1>管理端</h1>
        <p>需要租户管理员。</p>
      </section>
    );
  }

  async function grant(userId: string, action: 'grant' | 'revoke') {
    const out = await api(`/v1/admin/${action}`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
    if (!out.ok) setError(out.error.message);
    else {
      setOk(action === 'grant' ? '已授予管理员' : '已收回管理员');
      await reload();
    }
  }

  async function addMember(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    const out = await api('/v1/admin/members', {
      method: 'POST',
      body: JSON.stringify({ userId: body.userId }),
    });
    if (!out.ok) setError(out.error.message);
    else {
      setOk('已加入成员');
      e.currentTarget.reset();
      await reload();
    }
  }

  async function saveModel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    const out = await api('/v1/admin/models', {
      method: 'POST',
      body: JSON.stringify({
        modelId: body.modelId,
        displayName: body.displayName,
        provider: body.provider,
        upstreamModel: body.upstreamModel,
        adapter: body.adapter || body.provider,
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
      }),
    });
    if (!out.ok) setError(out.error.message);
    else {
      setOk('已保存默认模型');
      e.currentTarget.reset();
      await reload();
    }
  }

  async function setQuota(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    const out = await api('/v1/admin/quota', {
      method: 'POST',
      body: JSON.stringify({ userId: body.userId, limit: Number(body.limit) }),
    });
    if (!out.ok) setError(out.error.message);
    else setOk('已更新额度上限');
  }

  return (
    <section>
      <h1>租户管理</h1>
      <p>管理端看不到任务、产物或 prompt。密钥只写不读。</p>
      {error ? <p className="ew-error">{error}</p> : null}
      {ok ? <p className="ew-ok">{ok}</p> : null}

      <h2>成员</h2>
      <table>
        <thead>
          <tr>
            <th>用户</th>
            <th>角色</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.id}>
              <td>{member.email ?? member.phone ?? member.id}</td>
              <td>{member.role}</td>
              <td>
                {member.role === 'admin' ? (
                  <button type="button" data-tone="ghost" onClick={() => void grant(member.id, 'revoke')}>
                    收回管理员
                  </button>
                ) : (
                  <button type="button" data-tone="ghost" onClick={() => void grant(member.id, 'grant')}>
                    授予管理员
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={(e) => void addMember(e)}>
        <Field label="已注册用户 id" name="userId" required />
        <div className="ew-actions">
          <button type="submit">加入租户</button>
        </div>
      </form>

      <h2>默认模型</h2>
      <ul>
        {models.map((model) => (
          <li key={model.id}>
            {model.displayName} · {model.provider} · {model.upstreamModel}
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void saveModel(e)}>
        <Field label="模型 id" name="modelId" required />
        <Field label="显示名" name="displayName" required />
        <label className="ew-field">
          协议适配类型
          <select name="provider" required defaultValue="deepseek">
            <option value="deepseek">deepseek</option>
            <option value="moonshot">moonshot</option>
            <option value="zhipu">zhipu</option>
            <option value="private">private</option>
          </select>
        </label>
        <Field label="上游型号" name="upstreamModel" required />
        <Field label="适配器（可留空）" name="adapter" />
        <Field label="上游 base_url" name="baseUrl" required />
        <Field label="上游 API 密钥" name="apiKey" type="password" required />
        <div className="ew-actions">
          <button type="submit">保存默认模型</button>
        </div>
      </form>

      <h2>每人额度</h2>
      <p>只配上限，不收款。没有充值。</p>
      <form onSubmit={(e) => void setQuota(e)}>
        <Field label="用户 id" name="userId" required />
        <Field label="token 上限（0 = 不限）" name="limit" required />
        <div className="ew-actions">
          <button type="submit">保存额度</button>
        </div>
      </form>
    </section>
  );
}
