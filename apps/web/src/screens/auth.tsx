/**
 * 账号面的表单页。**密码只在这些页面的 input[type=password] 里**（Q32=B / Q33=A）。
 *
 * 登录页是这个产品唯一的对外品牌面（K5）：左栏那三句话原先全藏在登录之后，
 * 而"文件不上云 / 管理员结构上看不到 / 不登录也能用"恰恰是企业第一个问的三件事。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import {
  api,
  clearSession,
  finishDesktopPkce,
  formatDay,
  parsePkce,
  passwordStrength,
  publicApi,
  readSession,
  syncSessionFromMe,
  writeSession,
  type InviteInfo,
  type Session,
} from '../api.js';
import { Banner, BrandMark, Button, Field, Icon, StrengthMeter } from '../components.js';
import { useAction } from '../use-async.js';

function formData(e: FormEvent<HTMLFormElement>): Record<string, string> {
  const data = new FormData(e.currentTarget);
  const out: Record<string, string> = {};
  for (const [key, value] of data.entries()) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/** 单卡页外壳：注册 / 验证 / 重置 / 改密 / 注销 / 邀请共用。 */
export function AuthCard(props: {
  readonly title: string;
  readonly lede?: ReactNode | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="ew-auth-single">
      <section className="ew-auth-form">
        <div className="ew-cell-stack">
          <h1>{props.title}</h1>
          {props.lede ? <p className="ew-muted">{props.lede}</p> : null}
        </div>
        {props.children}
      </section>
    </div>
  );
}

/** 两个密码框 + 强度条。注册 / 重置 / 改密三处共用，规则只有一份。 */
export function NewPasswordFields(props: {
  readonly name: string;
  readonly label: string;
  readonly confirmLabel: string;
  readonly value: string;
  readonly confirm: string;
  readonly onValue: (v: string) => void;
  readonly onConfirm: (v: string) => void;
}) {
  const strength = passwordStrength(props.value);
  const mismatch = props.confirm !== '' && props.confirm !== props.value;
  return (
    <>
      <div className="ew-field">
        <label className="ew-label" htmlFor={`${props.name}-pw`}>
          {props.label}
        </label>
        <input
          id={`${props.name}-pw`}
          className="ew-input"
          name={props.name}
          type="password"
          autoComplete="new-password"
          required
          value={props.value}
          onChange={(e) => props.onValue(e.target.value)}
        />
        <StrengthMeter score={strength.score} hint={strength.hint} />
      </div>
      <div className="ew-field">
        <label className="ew-label" htmlFor={`${props.name}-confirm`}>
          {props.confirmLabel}
        </label>
        <input
          id={`${props.name}-confirm`}
          className="ew-input"
          name={`${props.name}Confirm`}
          type="password"
          autoComplete="new-password"
          required
          value={props.confirm}
          onChange={(e) => props.onConfirm(e.target.value)}
        />
        {mismatch ? <span className="ew-error ew-muted">两次输入的密码不一样。</span> : null}
      </div>
    </>
  );
}

export function SignInPage(props: {
  readonly search: string;
  readonly onSignedIn: () => void;
  readonly onGo: (path: string) => void;
}) {
  const action = useAction();
  const [returning, setReturning] = useState(false);
  const pkce = parsePkce(props.search);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    await action.run(
      async () => {
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
        if (out.ok) {
          writeSession({
            accessToken: out.data.accessToken,
            refreshToken: out.data.refreshToken,
            role: out.data.role,
            mustChangePassword: out.data.mustChangePassword,
          });
        }
        return out;
      },
      () => {
        if (pkce) {
          setReturning(true);
          void finishDesktopPkce(pkce);
          return;
        }
        props.onSignedIn();
      },
    );
  }

  return (
    <div className="ew-auth-split">
      <aside className="ew-auth-brand">
        <span className="ew-brandmark">
          <BrandMark />
          EvoWork
        </span>
        <div className="ew-cell-stack">
          <p className="ew-brandline">EvoWork，我帮你</p>
          <p className="ew-lede">一句话下达需求，自主规划执行，交付可验收的产物。</p>
          <ul className="ew-auth-claims">
            <li>
              <Icon name="check" size="sm" />
              <span>
                <b>任务和产物在你的电脑上。</b>文件从不上云，登录只是一把凭据。
              </span>
            </li>
            <li>
              <Icon name="check" size="sm" />
              <span>
                <b>管理员看不到你的任务 —— 结构上看不到。</b>管理端的接口类型里没有能装内容的字段。
              </span>
            </li>
            <li>
              <Icon name="check" size="sm" />
              <span>
                <b>不登录也能用。</b>配自己的模型密钥即可，拔掉网线照常干活。
              </span>
            </li>
          </ul>
        </div>
        <p className="ew-auth-foot">本地优先 · 这一页是唯一会出现密码框的地方</p>
      </aside>

      <main className="ew-auth-panel">
        <section className="ew-auth-form">
          {pkce ? (
            <Banner tone="info">
              正在为 <b>EvoWork 桌面版</b> 登录，完成后会自动返回 App。
            </Banner>
          ) : null}
          {returning ? <Banner tone="success">正在返回 EvoWork 桌面版…</Banner> : null}

          <div className="ew-cell-stack">
            <h1>登录 EvoWork</h1>
            <p className="ew-muted">用邮箱或手机号登录。我们不发短信，也没有验证码登录。</p>
          </div>

          <form onSubmit={(e) => void onSubmit(e)}>
            <Field label="邮箱或手机号" name="identifier" autoComplete="username" required />
            <Field
              label="密码"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              aside={
                <a
                  href="/reset"
                  onClick={(e) => {
                    e.preventDefault();
                    props.onGo('/reset');
                  }}
                >
                  忘记密码？
                </a>
              }
            />
            {action.error ? <p className="ew-error ew-muted">{action.error}</p> : null}
            <div className="ew-actions">
              <Button
                type="submit"
                variant="primary"
                size="lg"
                block
                busy={action.busy}
                busyLabel="登录中…"
              >
                登录
              </Button>
            </div>
          </form>

          <span className="ew-divider">还没有账号</span>
          <Button size="lg" block onClick={() => props.onGo('/signup')}>
            用邮箱注册
          </Button>
          <p className="ew-muted">
            注册只创建一个账号，不会自动加入任何租户。没被管理员加入之前，你仍然可以用自己的模型密钥使用
            EvoWork。
          </p>
        </section>
      </main>
    </div>
  );
}

export function SignUpPage(props: { readonly onGo: (path: string) => void }) {
  const action = useAction();
  const [ok, setOk] = useState(false);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    if (pw !== confirm) return;
    await action.run(
      () =>
        api('/v1/signup', {
          method: 'POST',
          body: JSON.stringify({ email: body.email, password: pw }),
        }),
      () => setOk(true),
    );
  }

  if (ok) {
    return (
      <AuthCard title="请查收验证邮件">
        <Banner tone="success">验证邮件已经发出。点开里面的链接就能登录了 —— 我们不发短信。</Banner>
        <Button variant="primary" size="lg" block onClick={() => props.onGo('/signin')}>
          去登录
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="注册" lede="用邮箱注册。我们会发一封验证邮件，不发短信。">
      <form onSubmit={(e) => void onSubmit(e)}>
        <Field label="邮箱" name="email" type="email" autoComplete="email" required />
        <NewPasswordFields
          name="password"
          label="密码"
          confirmLabel="确认密码"
          value={pw}
          confirm={confirm}
          onValue={setPw}
          onConfirm={setConfirm}
        />
        {action.error ? <p className="ew-error ew-muted">{action.error}</p> : null}
        <div className="ew-actions">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            busy={action.busy}
            busyLabel="注册中…"
            disabled={pw === '' || pw !== confirm}
            disabledReason="两次输入的密码要一致"
          >
            注册
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}

export function VerifyPage(props: {
  readonly search: string;
  readonly onGo: (path: string) => void;
}) {
  const [state, setState] = useState<'pending' | 'ok' | 'fail'>('pending');
  const [message, setMessage] = useState('正在验证…');

  useEffect(() => {
    const token = new URLSearchParams(props.search).get('token') ?? '';
    if (!token) {
      setState('fail');
      setMessage('这个链接里没有验证令牌。');
      return;
    }
    void api('/v1/verify-email', { method: 'POST', body: JSON.stringify({ token }) }).then(
      (out) => {
        setState(out.ok ? 'ok' : 'fail');
        setMessage(out.ok ? '邮箱已验证，可以登录了。' : out.error.message);
      },
    );
  }, [props.search]);

  return (
    <AuthCard title="验证邮箱">
      {state === 'pending' ? <p className="ew-muted">{message}</p> : null}
      {state === 'ok' ? (
        <>
          <Banner tone="success">{message}</Banner>
          <p className="ew-muted">
            你还没有加入任何租户 —— 在被管理员加入之前，用自己的模型密钥也能使用 EvoWork。
          </p>
          <Button variant="primary" size="lg" block onClick={() => props.onGo('/signin')}>
            去登录
          </Button>
        </>
      ) : null}
      {state === 'fail' ? (
        <>
          <Banner tone="danger">{message}</Banner>
          <p className="ew-muted">
            链接失效了？
            <a
              href="/signup"
              onClick={(e) => {
                e.preventDefault();
                props.onGo('/signup');
              }}
            >
              重新注册
            </a>
            会再发一封。
          </p>
        </>
      ) : null}
    </AuthCard>
  );
}

const RESEND_SECONDS = 60;

export function ResetPage(props: {
  readonly search: string;
  readonly onGo: (path: string) => void;
}) {
  const token = new URLSearchParams(props.search).get('token') ?? '';
  const action = useAction();
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const [left, setLeft] = useState(0);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');

  useEffect(() => {
    if (left <= 0) return undefined;
    const timer = setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);

  async function requestMail(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    await action.run(
      () =>
        api('/v1/forgot-password', { method: 'POST', body: JSON.stringify({ email: body.email }) }),
      () => {
        setSent(true);
        setLeft(RESEND_SECONDS);
      },
    );
  }

  async function setNewPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pw !== confirm) return;
    await action.run(
      () =>
        api('/v1/reset-password', {
          method: 'POST',
          body: JSON.stringify({ token, password: pw }),
        }),
      () => setDone(true),
    );
  }

  if (done) {
    return (
      <AuthCard title="密码已更新">
        <Banner tone="success">其他设备上的登录已全部作废，请重新登录。</Banner>
        <Button variant="primary" size="lg" block onClick={() => props.onGo('/signin')}>
          去登录
        </Button>
      </AuthCard>
    );
  }

  if (token) {
    return (
      <AuthCard title="设置新密码" lede="链接用过即失效。更新后其他设备上的登录全部作废。">
        <form onSubmit={(e) => void setNewPassword(e)}>
          <NewPasswordFields
            name="reset"
            label="新密码"
            confirmLabel="确认新密码"
            value={pw}
            confirm={confirm}
            onValue={setPw}
            onConfirm={setConfirm}
          />
          {action.error ? <p className="ew-error ew-muted">{action.error}</p> : null}
          <div className="ew-actions">
            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              busy={action.busy}
              disabled={pw === '' || pw !== confirm}
              disabledReason="两次输入的密码要一致"
            >
              更新密码
            </Button>
          </div>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="重置密码" lede="填邮箱，我们发一封带链接的邮件。">
      {sent ? (
        <Banner tone="info">
          如果这个邮箱存在，重置邮件已经发出。为了不泄露哪些邮箱注册过，这句话无论账号在不在都一样。
        </Banner>
      ) : null}
      <form onSubmit={(e) => void requestMail(e)}>
        <Field label="邮箱" name="email" type="email" autoComplete="email" required />
        {action.error ? <p className="ew-error ew-muted">{action.error}</p> : null}
        <div className="ew-actions">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            block
            busy={action.busy}
            disabled={left > 0}
            disabledReason="防止把重置邮件刷成骚扰"
          >
            {left > 0 ? `重新发送（${left} 秒后可用）` : sent ? '重新发送' : '发送重置邮件'}
          </Button>
        </div>
      </form>
    </AuthCard>
  );
}

export function ChangePasswordForm(props: { readonly onChanged?: (() => void) | undefined }) {
  const action = useAction();
  const [ok, setOk] = useState(false);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    if (pw !== confirm) return;
    const changed = await action.run(() =>
      api('/v1/password', {
        method: 'POST',
        body: JSON.stringify({ current: body.current, next: pw }),
      }),
    );
    if (!changed) return;
    const session = await syncSessionFromMe();
    if (!session || session.mustChangePassword) return;
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
      <NewPasswordFields
        name="next"
        label="新密码"
        confirmLabel="确认新密码"
        value={pw}
        confirm={confirm}
        onValue={setPw}
        onConfirm={setConfirm}
      />
      {action.error ? <p className="ew-error ew-muted">{action.error}</p> : null}
      {ok ? <p className="ew-ok ew-muted">密码已更新。</p> : null}
      <div className="ew-actions">
        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          busy={action.busy}
          disabled={pw === '' || pw !== confirm}
          disabledReason="两次输入的密码要一致"
        >
          更新密码
        </Button>
      </div>
    </form>
  );
}

export function PasswordChangePage(props: { readonly onChanged?: (() => void) | undefined }) {
  const session = readSession();
  if (!session) {
    return (
      <AuthCard title="修改密码">
        <Banner tone="warning">请先登录。</Banner>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="修改密码">
      {session.mustChangePassword ? (
        <Banner tone="warning">
          引导账号必须先改密。改完之前<b>不能配模型、加成员、改额度或签发策略包</b>。
        </Banner>
      ) : null}
      <ChangePasswordForm {...(props.onChanged ? { onChanged: props.onChanged } : {})} />
    </AuthCard>
  );
}

export function AccountDeletePage(props: { readonly onDone: () => void }) {
  const action = useAction();

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = formData(e);
    await action.run(
      () =>
        api('/v1/account/delete', {
          method: 'POST',
          body: JSON.stringify({ password: body.password }),
        }),
      () => {
        clearSession();
        props.onDone();
      },
    );
  }

  return (
    <AuthCard title="注销账号">
      <div className="ew-cols">
        <div className="ew-card ew-col-main" data-tone="danger">
          <span className="ew-micro">会被清掉</span>
          <span className="ew-muted">
            账号 · 全部设备的登录 · 租户成员关系 · 托管额度账 · 你创建的分享链接
          </span>
        </div>
        <div className="ew-card ew-col-main" data-tone="sunken">
          <span className="ew-micro">一行都不动</span>
          <span className="ew-muted">
            本机的任务与产物 · 工作空间文件 · 自定义模型密钥 · 自动化定义
          </span>
        </div>
      </div>
      <form onSubmit={(e) => void onSubmit(e)}>
        <Field
          label="再输入一次密码"
          name="password"
          type="password"
          autoComplete="current-password"
          required
        />
        {action.error ? <p className="ew-error ew-muted">{action.error}</p> : null}
        <div className="ew-actions">
          <Button type="submit" variant="danger" size="lg" block busy={action.busy}>
            确认注销
          </Button>
        </div>
      </form>
      <p className="ew-muted">你是本租户最后一名管理员时，这个动作会被拒绝并说明原因。</p>
    </AuthCard>
  );
}

/**
 * 接受邀请。
 *
 * 这一页**不带 authorization、不读 session** —— 收件人还没登录，
 * 旁边也不该放着一把令牌（与分享页同一条理由，11 §13.10 C 第 1 条）。
 */
export function InviteAcceptPage(props: {
  readonly search: string;
  readonly onGo: (path: string) => void;
}) {
  const token = new URLSearchParams(props.search).get('token') ?? '';
  const action = useAction();
  const [info, setInfo] = useState<InviteInfo | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [done, setDone] = useState(false);
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');

  useEffect(() => {
    if (!token) {
      setFailed('这个链接里没有邀请令牌。');
      return;
    }
    void publicApi<InviteInfo>(`/v1/invite?token=${encodeURIComponent(token)}`).then((out) => {
      if (out.ok) setInfo(out.data);
      else setFailed(out.error.message);
    });
  }, [token]);

  async function accept() {
    if (info && !info.registered && pw !== confirm) return;
    await action.run(
      () =>
        publicApi('/v1/invite/accept', {
          method: 'POST',
          body: JSON.stringify({ token, ...(info?.registered ? {} : { password: pw }) }),
        }),
      () => setDone(true),
    );
  }

  if (failed) {
    return (
      <AuthCard title="邀请无效">
        <Banner tone="danger">{failed}</Banner>
        <p className="ew-muted">链接有有效期，过期之后要让管理员重发一封。</p>
      </AuthCard>
    );
  }

  if (done) {
    return (
      <AuthCard title="已加入">
        <Banner tone="success">
          你已经是「{info?.tenantName}」的成员，登录后就能用管理员配置的默认模型。
        </Banner>
        <Button variant="primary" size="lg" block onClick={() => props.onGo('/signin')}>
          去登录
        </Button>
      </AuthCard>
    );
  }

  if (!info) {
    return (
      <AuthCard title="邀请">
        <p className="ew-muted">正在确认邀请…</p>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={`加入「${info.tenantName}」`}
      lede={`这封邀请发给 ${info.email}，${formatDay(info.expiresAt)}前有效。`}
    >
      {info.registered ? (
        <p className="ew-muted">
          这个邮箱已经注册过。接受邀请<b>不会改你的密码</b>，只是把你加进这个租户。
        </p>
      ) : (
        <>
          <p className="ew-muted">
            这个邮箱还没有账号。设一个密码就能同时建号并加入 —— 能点开这封信本身就证明了邮箱是你的，
            所以不必再发一封验证信。
          </p>
          <NewPasswordFields
            name="invite"
            label="设置密码"
            confirmLabel="确认密码"
            value={pw}
            confirm={confirm}
            onValue={setPw}
            onConfirm={setConfirm}
          />
        </>
      )}
      {action.error ? <p className="ew-error ew-muted">{action.error}</p> : null}
      <Button
        variant="primary"
        size="lg"
        block
        busy={action.busy}
        disabled={!info.registered && (pw === '' || pw !== confirm)}
        disabledReason="两次输入的密码要一致"
        onClick={() => void accept()}
      >
        接受邀请
      </Button>
      <p className="ew-muted">
        加入之后，管理员能看到你的邮箱、角色与当期 token 用量 ——{' '}
        <b>看不到你的任务、产物或 prompt</b>。
      </p>
    </AuthCard>
  );
}
