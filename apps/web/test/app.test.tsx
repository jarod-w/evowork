/**
 * 账号页有密码框；管理端类型没有任务 / 产物；没有分享页（Q41 不进本段）。
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App, routeOf } from '../src/app.js';
import { parsePkce, writeSession } from '../src/api.js';

describe('路由', () => {
  it('没有分享页路径（Q41 不进 M10b）', () => {
    expect(routeOf('/s/abc')).toBe('/s/abc');
    render(<App initialPath="/s/abc" />);
    expect(screen.queryByText(/下载/)).toBeNull();
    expect(screen.getByRole('heading', { name: '登录 EvoWork' })).toBeTruthy();
  });
});

describe('登录表单', () => {
  it('密码框在 WEB 上（Q32=B / Q33=A）', () => {
    render(<App initialPath="/signin" />);
    expect(screen.getByLabelText('密码')).toBeTruthy();
    expect((screen.getByLabelText('密码') as HTMLInputElement).type).toBe('password');
  });

  it('PKCE 回调只接受 loopback redirect_uri', () => {
    expect(
      parsePkce('?code_challenge=abc&redirect_uri=http://evil.example/cb&state=s&device_id=dev'),
    ).toBeUndefined();
    expect(
      parsePkce(
        '?code_challenge=abc&redirect_uri=http://127.0.0.1:4390/callback&state=s&device_id=dev',
      ),
    ).toMatchObject({ deviceId: 'dev', redirectUri: 'http://127.0.0.1:4390/callback' });
  });
});

describe('管理端', () => {
  it('管理员入口写明看不到任务，且没有充值', () => {
    writeSession({
      accessToken: 't',
      refreshToken: 'r',
      role: 'admin',
      mustChangePassword: false,
    });
    render(<App initialPath="/admin" />);
    expect(screen.getByText(/看不到任务、产物或 prompt/)).toBeTruthy();
    expect(screen.getByText(/没有充值/)).toBeTruthy();
    expect(screen.queryByText(/升级套餐/)).toBeNull();
  });
});

describe('额度页', () => {
  it('账号页声明没有充值或升级入口（Q42）', () => {
    writeSession({
      accessToken: 't',
      refreshToken: 'r',
      role: 'member',
      mustChangePassword: false,
    });
    render(<App initialPath="/account" />);
    expect(screen.getByText(/没有充值或升级入口/)).toBeTruthy();
  });
});
