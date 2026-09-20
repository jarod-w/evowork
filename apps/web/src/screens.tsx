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
  syncSessionFromMe,
  writeSession,
  type AdminMember,
  type AdminUsage,
  type DeviceRow,
  type IdentityAuditView,
  type PolicyPackView,
  type PublicModel,
  type QuotaClassView,
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

function formatUnixMs(at: number): string {
  const ms = at < 1_000_000_000_000 ? at * 1000 : at;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function who(row: { email?: string | undefined; phone?: string | undefined }): string {
  return row.email ?? row.phone ?? '—';
}

function packActor(pack: PolicyPackView): string {
  return pack.actorEmail ?? pack.actorPhone ?? '—';
}

function auditActionLabel(action: string): string {
  switch (action) {
    case 'grant-admin':
      return '授予管理员';
    case 'revoke-admin':
      return '收回管理员';
    case 'update-model-key':
      return '更新默认模型密钥';
    case 'issue-policy-pack':
      return '签发策略包';
    case 'revoke-policy-pack':
      return '撤销策略包';
    default:
      return action;
  }
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
        <Field
          label="密码"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
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
          <Field
            label="新密码"
            name="password"
            type="password"
            autoComplete="new-password"
            required
          />
        ) : (
          <Field label="邮箱" name="email" type="email" autoComplete="email" required />
        )}
        {error ? <p className="ew-error">{error}</p> : null}
        {ok ? (
          <p className="ew-ok">{token ? '密码已更新。' : '如果该邮箱存在，我们已发出重置邮件。'}</p>
        ) : null}
        <div className="ew-actions">
          <button type="submit">{token ? '更新密码' : '发送重置邮件'}</button>
        </div>
      </form>
    </section>
  );
}

export function ChangePasswordForm(props: { readonly onChanged?: () => void }) {
  const [error, setError] = useState<string | undefined>();
  const [ok, setOk] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    const out = await api('/v1/password', {
      method: 'POST',
      body: JSON.stringify({ current: body.current, next: body.next }),
    });
    if (!out.ok) {
      setError(out.error.message);
      setOk(false);
      return;
    }
    const session = await syncSessionFromMe();
    if (!session || session.mustChangePassword) {
      setError('改密已提交，但账号服务仍要求修改密码。请刷新后再试。');
      return;
    }
    setError(undefined);
    setOk(true);
    props.onChanged?.();
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)}>
      <Field
        label="当前密码"
        name="current"
        type="password"
        autoComplete="current-password"
        required
      />
      <Field label="新密码" name="next" type="password" autoComplete="new-password" required />
      {error ? <p className="ew-error">{error}</p> : null}
      {ok ? <p className="ew-ok">密码已更新。</p> : null}
      <div className="ew-actions">
        <button type="submit">更新密码</button>
      </div>
    </form>
  );
}

export function PasswordChangePage(props: { readonly onChanged?: () => void }) {
  const session = readSession();
  if (!session) {
    return (
      <section>
        <h1>修改密码</h1>
        <p>请先登录。</p>
      </section>
    );
  }
  return (
    <section>
      <h1>修改密码</h1>
      <p>引导账号第一次登录必须改密。改完之前不能做管理动作。</p>
      <ChangePasswordForm {...(props.onChanged ? { onChanged: props.onChanged } : {})} />
    </section>
  );
}

export function AccountHome(props: {
  readonly onDelete: () => void;
  readonly onPassword: () => void;
}) {
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
      {session.mustChangePassword ? (
        <p className="ew-error">
          请先修改引导密码后再使用管理端。{' '}
          <button type="button" data-tone="ghost" onClick={props.onPassword}>
            去改密
          </button>
        </p>
      ) : null}
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
        <button type="button" data-tone="ghost" onClick={props.onPassword}>
          修改密码
        </button>
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
        <Field
          label="再输入一次密码"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        {error ? <p className="ew-error">{error}</p> : null}
        <div className="ew-actions">
          <button type="submit">确认注销</button>
        </div>
      </form>
    </section>
  );
}

function PolicyPackReadable(props: { readonly pack: PolicyPackView }) {
  const pack = props.pack;
  return (
    <ul>
      <li>停用模型：{pack.disabledModels.length > 0 ? pack.disabledModels.join('、') : '无'}</li>
      <li>
        停用权限档：{pack.disabledProfiles.length > 0 ? pack.disabledProfiles.join('、') : '无'}
      </li>
      <li>自定义模型：{pack.allowCustom ? '允许' : '已锁定'}</li>
      <li>有效期至 {formatUnixMs(pack.expiresAt)}</li>
      {pack.graceUntil !== undefined ? <li>宽限至 {formatUnixMs(pack.graceUntil)}</li> : null}
      {pack.reason ? <li>原因：{pack.reason}</li> : null}
      <li>只允许管理员 hooks：{pack.allowManagedHooksOnly ? '是' : '否'}</li>
      <li>禁用分享：{pack.disableShare ? '是' : '否'}</li>
      <li>禁用运营位：{pack.disableSlots ? '是' : '否'}</li>
      <li>强制审计：{pack.forceAudit ? '是' : '否'}</li>
    </ul>
  );
}

export function AdminPage(props: { readonly onSessionChanged?: () => void }) {
  const [session, setSession] = useState(readSession);
  const [members, setMembers] = useState<readonly AdminMember[]>([]);
  const [models, setModels] = useState<readonly PublicModel[]>([]);
  const [classes, setClasses] = useState<readonly QuotaClassView[]>([]);
  const [currentPack, setCurrentPack] = useState<PolicyPackView | null>(null);
  const [packHistory, setPackHistory] = useState<readonly PolicyPackView[]>([]);
  const [audit, setAudit] = useState<readonly IdentityAuditView[]>([]);
  const [usage, setUsage] = useState<AdminUsage | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [ok, setOk] = useState<string | undefined>();

  async function reload() {
    const m = await api<{ members: AdminMember[] }>('/v1/admin/members');
    if (m.ok) setMembers(m.data.members);
    else setError(m.error.message);
    const modelsOut = await api<{ models: PublicModel[] }>('/v1/admin/models');
    if (modelsOut.ok) setModels(modelsOut.data.models);
    const classesOut = await api<{ classes: QuotaClassView[] }>('/v1/admin/quota-classes');
    if (classesOut.ok) setClasses(classesOut.data.classes);
    const packOut = await api<{
      current: PolicyPackView | null;
      history: PolicyPackView[];
    }>('/v1/admin/policy-pack');
    if (packOut.ok) {
      setCurrentPack(packOut.data.current);
      setPackHistory(packOut.data.history);
    }
    const auditOut = await api<{ events: IdentityAuditView[] }>('/v1/admin/audit');
    if (auditOut.ok) setAudit(auditOut.data.events);
    const usageOut = await api<AdminUsage>('/v1/admin/usage');
    if (usageOut.ok) setUsage(usageOut.data);
  }

  useEffect(() => {
    if (!session || session.role !== 'admin' || session.mustChangePassword) return;
    void reload();
  }, [session]);

  if (!session || session.role !== 'admin') {
    return (
      <section>
        <h1>管理端</h1>
        <p>需要租户管理员。</p>
      </section>
    );
  }

  if (session.mustChangePassword) {
    return (
      <section>
        <h1>租户管理</h1>
        <p>引导账号必须先改密。改完之前不能配模型、加成员、改额度或签发策略包。</p>
        <ChangePasswordForm
          onChanged={() => {
            setSession(readSession());
            props.onSessionChanged?.();
          }}
        />
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
      body: JSON.stringify({ email: body.email }),
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

  async function setQuota(e: FormEvent<HTMLFormElement>, userId: string) {
    e.preventDefault();
    const body = formData(e);
    const out = await api('/v1/admin/quota', {
      method: 'POST',
      body: JSON.stringify({ userId, limit: Number(body.limit) }),
    });
    if (!out.ok) setError(out.error.message);
    else {
      setOk('已更新额度上限');
      await reload();
    }
  }

  async function saveClass(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    const out = await api('/v1/admin/quota-classes', {
      method: 'POST',
      body: JSON.stringify({ name: body.name, tokensLimit: Number(body.tokensLimit) }),
    });
    if (!out.ok) setError(out.error.message);
    else {
      setOk('已保存配额班级');
      e.currentTarget.reset();
      await reload();
    }
  }

  async function assignClass(e: FormEvent<HTMLFormElement>, userId: string) {
    e.preventDefault();
    const body = formData(e);
    const out = await api('/v1/admin/quota-class', {
      method: 'POST',
      body: JSON.stringify({ userId, quotaClass: body.quotaClass }),
    });
    if (!out.ok) setError(out.error.message);
    else {
      setOk('已分配配额班级');
      await reload();
    }
  }

  async function issuePack(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    const disabledModels = (body.disabledModels ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const disabledProfiles = (body.disabledProfiles ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    const out = await api('/v1/admin/policy-pack', {
      method: 'POST',
      body: JSON.stringify({
        expiresInDays: Number(body.expiresInDays),
        ...(body.graceInDays ? { graceInDays: Number(body.graceInDays) } : {}),
        disabledModels,
        allowCustom: body.lockCustom !== 'on',
        ...(body.reason ? { reason: body.reason } : {}),
        allowManagedHooksOnly: body.allowManagedHooksOnly === 'on',
        disableShare: body.disableShare === 'on',
        disableSlots: body.disableSlots === 'on',
        forceAudit: body.forceAudit === 'on',
        disabledProfiles,
      }),
    });
    if (!out.ok) setError(out.error.message);
    else {
      setOk('已签发策略包。设备下次启动或登录时会拉取。');
      await reload();
    }
  }

  async function revokePack() {
    const out = await api('/v1/admin/policy-pack/revoke', { method: 'POST', body: '{}' });
    if (!out.ok) setError(out.error.message);
    else {
      setOk('已撤销当前策略包。');
      await reload();
    }
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
            <th>配额班级</th>
            <th>动作</th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.id}>
              <td>{who(member)}</td>
              <td>{member.role}</td>
              <td>{member.quotaClass}</td>
              <td>
                <div className="ew-row-actions">
                  {member.role === 'admin' ? (
                    <button
                      type="button"
                      data-tone="ghost"
                      onClick={() => void grant(member.id, 'revoke')}
                    >
                      收回管理员
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-tone="ghost"
                      onClick={() => void grant(member.id, 'grant')}
                    >
                      授予管理员
                    </button>
                  )}
                  <form onSubmit={(e) => void setQuota(e, member.id)}>
                    <input
                      name="limit"
                      inputMode="numeric"
                      aria-label={`${who(member)} 的额度上限`}
                    />
                    <button type="submit">设额度</button>
                  </form>
                  <form onSubmit={(e) => void assignClass(e, member.id)}>
                    <select
                      name="quotaClass"
                      defaultValue={member.quotaClass}
                      aria-label={`${who(member)} 的配额班级`}
                    >
                      {classes.map((cls) => (
                        <option key={cls.name} value={cls.name}>
                          {cls.name}
                        </option>
                      ))}
                    </select>
                    <button type="submit">分配班级</button>
                  </form>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={(e) => void addMember(e)}>
        <Field label="已注册用户的邮箱" name="email" type="email" required />
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

      <h2>配额班级</h2>
      <p>
        JWT 的 quotaClass 来自班级。default 上限 0 =
        不限。每人覆盖在成员表行内设置，只配上限，不收款。没有充值。
      </p>
      <ul>
        {classes.map((cls) => (
          <li key={cls.name}>
            {cls.name} · {cls.tokensLimit <= 0 ? '不限' : `${cls.tokensLimit} tokens`}
          </li>
        ))}
      </ul>
      <form onSubmit={(e) => void saveClass(e)}>
        <Field label="班级名" name="name" required />
        <Field label="token 上限（0 = 不限）" name="tokensLimit" required />
        <div className="ew-actions">
          <button type="submit">保存班级</button>
        </div>
      </form>

      <h2>用量</h2>
      <p>当期租户总量：{usage ? `${usage.tenantUsed} tokens` : '—'}。按人当期累计如下。</p>
      <table>
        <thead>
          <tr>
            <th>用户</th>
            <th>当期累计</th>
            <th>上限</th>
            <th>班级</th>
            <th>是否耗尽</th>
          </tr>
        </thead>
        <tbody>
          {(usage?.members ?? []).map((row) => (
            <tr key={row.id}>
              <td>{who(row)}</td>
              <td>{row.used}</td>
              <td>{row.limit <= 0 ? '不限' : row.limit}</td>
              <td>{row.quotaClass}</td>
              <td>{row.exhausted ? '已耗尽' : '未耗尽'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>签名策略包</h2>
      <p>下发到每台设备，写入 requirements.toml。模型锁定复用第②层，不另开通道。超期后设备只读。</p>
      {currentPack ? (
        <>
          <p>
            当前生效包由 {packActor(currentPack)} 签发。kid={currentPack.kid}。
          </p>
          <PolicyPackReadable pack={currentPack} />
          <div className="ew-actions">
            <button type="button" data-tone="ghost" onClick={() => void revokePack()}>
              撤销当前策略包
            </button>
          </div>
        </>
      ) : (
        <p>还没有生效中的策略包。</p>
      )}
      <h3>签发历史</h3>
      {packHistory.length === 0 ? (
        <p>没有签发记录。</p>
      ) : (
        <ul>
          {packHistory.map((pack) => (
            <li key={pack.id}>
              {formatUnixMs(pack.issuedAt)} · {packActor(pack)} · {pack.revoked ? '已撤销' : '有效'}{' '}
              · 自定义模型{pack.allowCustom ? '允许' : '已锁定'} · 停用模型{' '}
              {pack.disabledModels.length > 0 ? pack.disabledModels.join('、') : '无'}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => void issuePack(e)}>
        <Field label="有效天数" name="expiresInDays" required />
        <Field label="宽限天数（可空）" name="graceInDays" />
        <Field label="停用的模型 id（逗号分隔）" name="disabledModels" />
        <Field label="停用的权限档 id（逗号分隔）" name="disabledProfiles" />
        <Field label="锁定原因（给用户看）" name="reason" />
        <label className="ew-field">
          <input type="checkbox" name="lockCustom" />
          锁定自定义模型
        </label>
        <label className="ew-field">
          <input type="checkbox" name="allowManagedHooksOnly" />
          只允许管理员配置的 hooks
        </label>
        <label className="ew-field">
          <input type="checkbox" name="disableShare" />
          禁用分享
        </label>
        <label className="ew-field">
          <input type="checkbox" name="disableSlots" />
          禁用运营位
        </label>
        <label className="ew-field">
          <input type="checkbox" name="forceAudit" />
          强制审计
        </label>
        <div className="ew-actions">
          <button type="submit">签发策略包</button>
        </div>
      </form>

      <h2>管理动作审计</h2>
      <p>谁在何时授予或收回了管理员、改了默认模型密钥、签发或撤销了策略包。这里没有任务或产物。</p>
      <table>
        <thead>
          <tr>
            <th>时间</th>
            <th>动作</th>
            <th>操作人</th>
            <th>对象</th>
          </tr>
        </thead>
        <tbody>
          {audit.map((row) => (
            <tr key={`${row.at}-${row.action}-${row.targetRef ?? row.targetEmail ?? ''}`}>
              <td>{formatUnixMs(row.at)}</td>
              <td>{auditActionLabel(row.action)}</td>
              <td>{who({ email: row.actorEmail, phone: row.actorPhone })}</td>
              <td>
                {who({ email: row.targetEmail, phone: row.targetPhone })}
                {row.targetRef ? ` · ${row.targetRef}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
