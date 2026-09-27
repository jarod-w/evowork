/**
 * WEB 账号页与管理端（11 §13.1）。
 *
 * 密码只出现在这里的表单里。没有任务 / 产物 —— 数据属于机器（D10）。
 *
 * **分享页不在这个应用里。** `/s/<id>` 是独立入口（`share.html` + `src/share/`），
 * 因为它要渲染不可信来源的元数据，旁边不该放着一把令牌（11 §13.10 C 第 1 条）。
 * 这个应用里**不许**多出一个 `/s/` 路由 —— `test/share-isolation.test.ts` 守着。
 *
 * ## 会话过期为什么在这一层
 *
 * `api.ts` 续期失败时广播一次，这里接住并弹「登录已过期」。
 * 让二十处调用点各判断一次 `code === 'session-expired'`，漏掉一处就又回到
 * 静默的「请求失败」—— 而那正是这一页以前 15 分钟之后的样子。
 */
import { useEffect, useState } from 'react';

import { clearSession, onSessionExpired, readSession } from './api.js';
import { Dialog } from './components.js';
import {
  AccountDeletePage,
  InviteAcceptPage,
  PasswordChangePage,
  ResetPage,
  SignInPage,
  SignUpPage,
  VerifyPage,
} from './screens/auth.js';
import { AccountHome } from './screens/account.js';
import { AdminPage } from './screens/admin.js';
import type { AdminSection } from './screens/admin-shell.js';

export interface AppProps {
  readonly initialPath?: string;
  readonly initialSearch?: string;
}

export function routeOf(path: string): string {
  const clean = path.replace(/\/+$/, '') || '/';
  return clean;
}

const ADMIN_ROUTES: Record<string, AdminSection> = {
  '/admin': 'overview',
  '/admin/members': 'members',
  '/admin/models': 'models',
  '/admin/usage': 'usage',
  '/admin/policy': 'policy',
};

export function App(props: AppProps = {}) {
  const [path, setPath] = useState(() => routeOf(props.initialPath ?? window.location.pathname));
  const [sessionRev, setSessionRev] = useState(0);
  const [expired, setExpired] = useState(false);
  const search = props.initialSearch ?? window.location.search;

  useEffect(() => {
    const onPop = () => setPath(routeOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => onSessionExpired(() => setExpired(true)), []);

  function go(next: string) {
    const url = next.startsWith('/') ? next : `/${next}`;
    window.history.pushState({}, '', url);
    setPath(routeOf(url.split('?')[0] ?? url));
    setSessionRev((n) => n + 1);
  }

  function signOut() {
    clearSession();
    go('/signin');
  }

  const adminSection = ADMIN_ROUTES[path];
  const body =
    adminSection !== undefined ? (
      <AdminPage
        key={sessionRev}
        section={adminSection}
        onGo={go}
        onSignOut={signOut}
        onSessionChanged={() => setSessionRev((n) => n + 1)}
      />
    ) : path === '/signup' ? (
      <SignUpPage onGo={go} />
    ) : path === '/verify' ? (
      <VerifyPage search={search} onGo={go} />
    ) : path === '/reset' ? (
      <ResetPage search={search} onGo={go} />
    ) : path === '/invite' ? (
      <InviteAcceptPage search={search} onGo={go} />
    ) : path === '/account/password' ? (
      <PasswordChangePage
        onChanged={() => {
          setSessionRev((n) => n + 1);
          const next = readSession();
          go(next?.role === 'admin' ? '/admin' : '/account');
        }}
      />
    ) : path === '/account/delete' ? (
      <AccountDeletePage onDone={() => go('/signin')} />
    ) : path === '/account' ? (
      <AccountHome key={sessionRev} onGo={go} onSignOut={signOut} />
    ) : (
      <SignInPage
        search={search}
        onGo={go}
        onSignedIn={() => {
          const next = readSession();
          go(next?.role === 'admin' ? '/admin' : '/account');
        }}
      />
    );

  return (
    <div className="ew-web">
      {body}
      {expired ? (
        <Dialog
          title="登录已过期"
          confirmLabel="重新登录"
          cancelLabel="稍后"
          onCancel={() => setExpired(false)}
          onConfirm={() => {
            setExpired(false);
            go('/signin');
          }}
        >
          <p className="ew-muted">
            为了安全，登录会定期过期。我们已经先自动续过一次，这次没能续上 ——
            重新登录后会回到这一页。
          </p>
        </Dialog>
      ) : null}
    </div>
  );
}
