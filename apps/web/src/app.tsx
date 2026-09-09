/**
 * WEB 账号页与管理端（11 §13.1）。
 *
 * 密码只出现在这里的表单里。没有任务 / 产物 / 分享页（Q41 不进 M10b）。
 */
import { useEffect, useState } from 'react';

import {
  AccountDeletePage,
  AccountHome,
  AdminPage,
  ResetPage,
  SignInPage,
  SignUpPage,
  VerifyPage,
} from './screens.js';
import { clearSession, readSession } from './api.js';

export interface AppProps {
  readonly initialPath?: string;
  readonly initialSearch?: string;
}

export function routeOf(path: string): string {
  const clean = path.replace(/\/+$/, '') || '/';
  return clean;
}

export function App(props: AppProps = {}) {
  const [path, setPath] = useState(() => routeOf(props.initialPath ?? window.location.pathname));
  const search = props.initialSearch ?? window.location.search;
  const session = readSession();

  useEffect(() => {
    const onPop = () => setPath(routeOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function go(next: string) {
    const url = next.startsWith('/') ? next : `/${next}`;
    window.history.pushState({}, '', url);
    setPath(routeOf(url.split('?')[0] ?? url));
  }

  return (
    <div className="ew-web">
      <nav className="ew-web-nav" aria-label="账号导航">
        <a
          href="/signin"
          onClick={(e) => {
            e.preventDefault();
            go('/signin');
          }}
        >
          登录
        </a>
        <a
          href="/signup"
          onClick={(e) => {
            e.preventDefault();
            go('/signup');
          }}
        >
          注册
        </a>
        {session ? (
          <>
            <a
              href="/account"
              onClick={(e) => {
                e.preventDefault();
                go('/account');
              }}
            >
              账号
            </a>
            {session.role === 'admin' ? (
              <a
                href="/admin"
                onClick={(e) => {
                  e.preventDefault();
                  go('/admin');
                }}
              >
                管理端
              </a>
            ) : null}
            <button
              type="button"
              data-tone="ghost"
              onClick={() => {
                clearSession();
                go('/signin');
              }}
            >
              退出
            </button>
          </>
        ) : null}
      </nav>
      {path === '/signup' ? (
        <SignUpPage />
      ) : path === '/verify' ? (
        <VerifyPage search={search} />
      ) : path === '/reset' ? (
        <ResetPage search={search} />
      ) : path === '/account/delete' ? (
        <AccountDeletePage onDone={() => go('/signin')} />
      ) : path === '/account' ? (
        <AccountHome onDelete={() => go('/account/delete')} />
      ) : path === '/admin' ? (
        <AdminPage />
      ) : (
        <SignInPage
          search={search}
          onSignedIn={() => {
            const next = readSession();
            go(next?.role === 'admin' ? '/admin' : '/account');
          }}
        />
      )}
    </div>
  );
}
