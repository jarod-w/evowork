/**
 * 账号页有密码框；管理端类型没有任务 / 产物；没有分享页（Q41 不进本段）。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { App, routeOf } from '../src/app.js';
import { parsePkce, readSession, writeSession } from '../src/api.js';

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

  it('mustChangePassword 为真时只渲染改密，不渲染管理表单（11 §12 第 23 条）', () => {
    writeSession({
      accessToken: 't',
      refreshToken: 'r',
      role: 'admin',
      mustChangePassword: true,
    });
    render(<App initialPath="/admin" />);
    expect(screen.getByLabelText('当前密码')).toBeTruthy();
    expect(screen.getByLabelText('新密码')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '成员' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '默认模型' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '每人额度' })).toBeNull();
    expect(screen.queryByRole('heading', { name: '签名策略包' })).toBeNull();
    expect(screen.queryByText('保存默认模型')).toBeNull();
    expect(screen.queryByText('签发策略包')).toBeNull();
  });

  it('成员加入只按邮箱，不要求手粘 userId', () => {
    writeSession({
      accessToken: 't',
      refreshToken: 'r',
      role: 'admin',
      mustChangePassword: false,
    });
    render(<App initialPath="/admin" />);
    expect(screen.getByLabelText('已注册用户的邮箱')).toBeTruthy();
    expect(screen.queryByLabelText('已注册用户 id')).toBeNull();
    expect(screen.queryByLabelText('用户 id')).toBeNull();
  });

  it('用量视图只有当期聚合，没有按天曲线或 CSV（Q43=A / 11 §12 第 24 条）', () => {
    writeSession({
      accessToken: 't',
      refreshToken: 'r',
      role: 'admin',
      mustChangePassword: false,
    });
    render(<App initialPath="/admin" />);
    expect(screen.getByRole('heading', { name: '用量' })).toBeTruthy();
    expect(screen.getByText(/当期租户总量/)).toBeTruthy();
    expect(screen.getByText(/按人当期累计/)).toBeTruthy();
    expect(screen.queryByText(/按天/)).toBeNull();
    expect(screen.queryByText(/CSV/i)).toBeNull();
    expect(screen.queryByText(/导出明细/)).toBeNull();
  });
});

describe('改密', () => {
  it('/account/password 有当前密码和新密码（11 §12 第 23 条）', () => {
    writeSession({
      accessToken: 't',
      refreshToken: 'r',
      role: 'admin',
      mustChangePassword: true,
    });
    render(<App initialPath="/account/password" />);
    expect(screen.getByRole('heading', { name: '修改密码' })).toBeTruthy();
    expect(screen.getByLabelText('当前密码')).toBeTruthy();
    expect(screen.getByLabelText('新密码')).toBeTruthy();
  });

  it('改密成功后用 /v1/me 翻掉 mustChangePassword，不靠前端自记', async () => {
    writeSession({
      accessToken: 't',
      refreshToken: 'r',
      role: 'admin',
      mustChangePassword: true,
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/password') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/v1/me')) {
        return new Response(
          JSON.stringify({
            id: 'usr_admin',
            role: 'admin',
            mustChangePassword: false,
            tenantId: 'ten_1',
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({ members: [], models: [], devices: [], used: 0, limit: 0 }),
        {
          status: 200,
        },
      );
    });
    render(<App initialPath="/account/password" />);
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'change-me' } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-pass-1' } });
    fireEvent.submit(screen.getByLabelText('当前密码').closest('form')!);
    await waitFor(() => {
      expect(readSession()?.mustChangePassword).toBe(false);
    });
    const meCalls = fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/v1/me'));
    expect(meCalls.length).toBeGreaterThan(0);
  });

  it('管理端改密成功后才出现管理表单', async () => {
    writeSession({
      accessToken: 't',
      refreshToken: 'r',
      role: 'admin',
      mustChangePassword: true,
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/password') && init?.method === 'POST') {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.endsWith('/v1/me')) {
        return new Response(
          JSON.stringify({
            id: 'usr_admin',
            role: 'admin',
            mustChangePassword: false,
            tenantId: 'ten_1',
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          members: [],
          models: [],
          classes: [],
          current: null,
          history: [],
          events: [],
          tenantUsed: 0,
          devices: [],
          used: 0,
          limit: 0,
        }),
        { status: 200 },
      );
    });
    render(<App initialPath="/admin" />);
    expect(screen.queryByRole('heading', { name: '成员' })).toBeNull();
    fireEvent.change(screen.getByLabelText('当前密码'), { target: { value: 'change-me' } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'new-pass-1' } });
    fireEvent.submit(screen.getByLabelText('当前密码').closest('form')!);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: '成员' })).toBeTruthy();
    });
    expect(screen.getByRole('heading', { name: '默认模型' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '用量' })).toBeTruthy();
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
