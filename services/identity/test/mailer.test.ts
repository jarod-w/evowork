import nodemailer from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import {
  configuredMailer,
  desktopContinuation,
  MailDeliveryError,
  sendMail,
  withMailDelivery,
} from '../src/mailer.js';

const continuation = new URLSearchParams({
  code_challenge: 'a'.repeat(43),
  redirect_uri: 'http://127.0.0.1:4390/callback',
  state: 'state',
  device_id: 'device',
  ignored: 'do-not-forward',
}).toString();

describe('事务邮件与桌面继续登录', () => {
  it('验证邮件含原始公开 PKCE 参数，外部回调和多余参数不能进入邮件', () => {
    expect(desktopContinuation(continuation)).not.toContain('ignored');
    for (const redirect of [
      'https://evil.example/callback',
      'http://127.0.0.1:4390@evil.example/callback',
      'http://127.0.0.1:4390/other',
    ]) {
      const q = new URLSearchParams(continuation);
      q.set('redirect_uri', redirect);
      expect(desktopContinuation(q.toString())).toBeUndefined();
    }
  });

  it('API 确认接受邮件后操作才成功；只传身份链接和固定文案', async () => {
    let complete!: (response: Response) => void;
    const fetchFn = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    const mailer = configuredMailer(
      {
        EVOWORK_MAIL_TRANSPORT: 'api',
        EVOWORK_MAIL_API_KEY: 'secret-api-key',
        EVOWORK_MAIL_FROM: 'account@example.com',
      },
      'https://account.example.com',
      fetchFn as typeof fetch,
    );
    let finished = false;
    const result = withMailDelivery(() => {
      sendMail(mailer, {
        to: 'user@example.com',
        template: 'verify',
        token: 'single-use',
        continuation: desktopContinuation(continuation)!,
      });
      return 'created';
    }).then((value) => {
      finished = true;
      return value;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    const init = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    const body = JSON.parse(String(init[1].body)) as { text: string; to: string[] };
    expect(body.to).toEqual(['user@example.com']);
    expect(body.text).toContain('https://account.example.com/verify?token=single-use&');
    expect(body.text).not.toContain('secret-api-key');
    expect(body.text).not.toContain('ignored');
    complete(Response.json({ id: 'delivery-receipt' }));
    expect(await result).toBe('created');
  });

  it.each([401, 429, 500])('供应商 %s 不得伪装已发送，也不回显错误正文', async (status) => {
    const mailer = configuredMailer(
      {
        EVOWORK_MAIL_TRANSPORT: 'api',
        EVOWORK_MAIL_API_KEY: 'secret',
        EVOWORK_MAIL_FROM: 'a@example.com',
      },
      'https://account.example.com',
      (async () => new Response('secret provider error', { status })) as typeof fetch,
    );
    await expect(
      withMailDelivery(() =>
        sendMail(mailer, { to: 'u@example.com', template: 'reset', token: 't' }),
      ),
    ).rejects.toThrow(MailDeliveryError);
  });

  it('未配置通道明确失败；两个并发操作的结果独立', async () => {
    const missing = configuredMailer({}, 'https://account.example.com');
    const results = await Promise.allSettled([
      withMailDelivery(() =>
        sendMail(missing, { to: 'a@example.com', template: 'verify', token: 'a' }),
      ),
      withMailDelivery(() => {
        sendMail({ send() {} }, { to: 'b@example.com', template: 'verify', token: 'b' });
        return 'ok';
      }),
    ]);
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]).toEqual({ status: 'fulfilled', value: 'ok' });
  });
});

it.each([465, 587])('SMTP %s 强制加密并等待服务器接受收件人', async (port) => {
  const send = vi.fn(async () => ({ accepted: ['user@example.com'], rejected: [] }));
  const factory = vi
    .spyOn(nodemailer, 'createTransport')
    .mockReturnValue({ sendMail: send } as unknown as ReturnType<
      typeof nodemailer.createTransport
    >);
  try {
    const mailer = configuredMailer(
      {
        EVOWORK_MAIL_TRANSPORT: 'smtp',
        EVOWORK_SMTP_HOST: 'smtp.example.com',
        EVOWORK_SMTP_PORT: String(port),
        EVOWORK_SMTP_USER: 'sender@example.com',
        EVOWORK_SMTP_PASSWORD: 'smtp-secret',
      },
      'https://account.example.com',
    );
    await withMailDelivery(() =>
      sendMail(mailer, { to: 'user@example.com', template: 'verify', token: 'verification' }),
    );
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        secure: port === 465,
        requireTLS: port === 587,
        tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
        logger: false,
        debug: false,
      }),
    );
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'sender@example.com',
        to: 'user@example.com',
        text: expect.stringContaining('/verify?token=verification'),
      }),
    );
  } finally {
    factory.mockRestore();
  }
});
