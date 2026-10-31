import { StrictMode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/app.js';

const query = new URLSearchParams({
  code_challenge: 'a'.repeat(43),
  redirect_uri: 'http://127.0.0.1:4390/callback',
  state: 'original-state',
  device_id: 'desktop-device',
}).toString();
afterEach(() => window.history.replaceState({}, '', '/'));
function fillSignup() {
  fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'new@example.com' } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'a-strong-password-123' } });
  fireEvent.change(screen.getByLabelText('确认密码'), {
    target: { value: 'a-strong-password-123' },
  });
  fireEvent.submit(screen.getByLabelText('邮箱').closest('form')!);
}
describe('桌面注册和验证的浏览器衔接', () => {
  it('从登录切到注册、发信和回登录全程保留同一个授权上下文', async () => {
    const fetchMock = vi
      .mocked(fetch)
      .mockResolvedValue(Response.json({ userId: 'new-user' }, { status: 201 }));
    render(<App initialPath="/signin" initialSearch={`?${query}`} />);
    fireEvent.click(screen.getByRole('button', { name: '用邮箱注册' }));
    expect(new URLSearchParams(window.location.search).get('state')).toBe('original-state');
    fillSignup();
    await screen.findByText('请查收验证邮件');
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { continuation: string };
    expect(new URLSearchParams(body.continuation).get('redirect_uri')).toBe(
      'http://127.0.0.1:4390/callback',
    );
    fireEvent.click(screen.getByRole('button', { name: '去登录' }));
    expect(screen.getByText(/正在为/)).toBeTruthy();
    expect(new URLSearchParams(window.location.search).get('device_id')).toBe('desktop-device');
  });

  it('邮件新标签页验证后能继续桌面登录，StrictMode 不重复消费一次性令牌', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(Response.json({ ok: true }));
    render(
      <StrictMode>
        <App initialPath="/verify" initialSearch={`?token=verification-token&${query}`} />
      </StrictMode>,
    );
    await screen.findByText('邮箱已验证，可以登录了。');
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/v1/verify-email')),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '去登录' }));
    expect(new URLSearchParams(window.location.search).get('state')).toBe('original-state');
    expect(new URLSearchParams(window.location.search).has('token')).toBe(false);
  });

  it('发信失败显示原因和重发入口，不显示成功', async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json(
        { error: { message: '邮件服务暂时不可用', code: 'mail-unavailable' } },
        { status: 503 },
      ),
    );
    render(<App initialPath="/signup" initialSearch={`?${query}`} />);
    fillSignup();
    await screen.findByText('邮件服务暂时不可用');
    expect(screen.queryByText('请查收验证邮件')).toBeNull();
    expect(screen.getByRole('button', { name: '重新发送验证邮件' })).toBeTruthy();
  });

  it('找回密码邮件也能继续桌面授权', async () => {
    const fetchMock = vi.mocked(fetch).mockResolvedValue(Response.json({ ok: true }));
    render(<App initialPath="/reset" initialSearch={`?${query}`} />);
    fireEvent.change(screen.getByLabelText('邮箱'), { target: { value: 'new@example.com' } });
    fireEvent.submit(screen.getByLabelText('邮箱').closest('form')!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { continuation: string };
    expect(new URLSearchParams(body.continuation).get('state')).toBe('original-state');
  });
});
