/**
 * 邮件通道。生产接事务邮件；测试用内存实现。identity **不发送短信**（11 §12 第 19 条）。
 *
 * ## 载荷里能装什么
 *
 * 只有**令牌、数字和租户名**。没有任务标题、没有产物名、没有 prompt —— 邮件是一条
 * 出网路径，Q14「不落盘正文」的同一条理由对它成立：一封带正文的提醒邮件，
 * 等于把内容抄到了收件箱、投递商日志和我们的发信队列里三份。
 *
 * 额度提醒（`quota-warn` / `quota-exhausted`）因此只带 used / limit 两个数字。
 * 「他在跑什么任务才用掉的」这个问题，管理端答不了，邮件也答不了。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import nodemailer from 'nodemailer';

export type MailTemplate = 'verify' | 'reset' | 'invite' | 'quota-warn' | 'quota-exhausted';

interface MailBase {
  readonly to: string;
}

export interface TokenMail extends MailBase {
  readonly template: 'verify' | 'reset' | 'invite';
  readonly token: string;
  readonly continuation?: string;
  /** 邀请邮件里显示"谁把你加进了哪个租户"，只有名字。 */
  readonly tenantName?: string;
}

export interface QuotaMail extends MailBase {
  readonly template: 'quota-warn' | 'quota-exhausted';
  readonly used: number;
  readonly limit: number;
  /** 汇总给管理员时带上是谁；给本人时省略。 */
  readonly subject?: string;
}

export type MailMessage = TokenMail | QuotaMail;

export function isTokenMail(message: MailMessage): message is TokenMail {
  return (
    message.template === 'verify' || message.template === 'reset' || message.template === 'invite'
  );
}

export interface Mailer {
  send(message: MailMessage): Promise<void> | void;
}

export function memoryMailer(): Mailer & { readonly sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    send(message) {
      sent.push(message);
    },
  };
}

const TOKEN_PATH: Record<TokenMail['template'], string> = {
  verify: '/verify',
  reset: '/reset',
  invite: '/invite',
};

/** 开发期：把链接与数字打到 stderr。生产换成事务邮件，仍然不发短信。 */
export function devMailer(publicOrigin: string): Mailer {
  return {
    send(message) {
      if (isTokenMail(message)) {
        const path = TOKEN_PATH[message.template];
        process.stderr.write(
          `[identity] ${message.template} ${message.to} ${publicOrigin}${path}?token=${message.token}${message.continuation ? `&${message.continuation}` : ''}\n`,
        );
        return;
      }
      process.stderr.write(
        `[identity] ${message.template} ${message.to} ${message.used}/${message.limit}\n`,
      );
    },
  };
}

export class MailDeliveryError extends Error {
  override readonly name = 'MailDeliveryError';
  constructor() {
    super('邮件服务暂时不可用，请稍后重试或联系管理员。');
  }
}

const deliveries = new AsyncLocalStorage<Promise<void>[]>();

/** 等本次操作的发信结果，不把并发请求的成功/失败混到一起。 */
export async function withMailDelivery<T>(work: () => T): Promise<T> {
  const pending: Promise<void>[] = [];
  return deliveries.run(pending, async () => {
    const result = work();
    await Promise.all(pending);
    return result;
  });
}

export function sendMail(mailer: Mailer, message: MailMessage): void {
  let delivery: Promise<void>;
  try {
    delivery = Promise.resolve(mailer.send(message));
  } catch {
    delivery = Promise.reject(new MailDeliveryError());
  }
  deliveries.getStore()?.push(delivery);
  // 后台额度通知没有 HTTP 调用方，也必须消费拒绝，避免击穿进程。
  void delivery.catch(() => undefined);
}

/** 邮件里继续桌面授权；拒绝伪装 loopback 的用户名、外部主机和任意路径。 */
export function desktopContinuation(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > 4096) return undefined;
  const query = new URLSearchParams(raw);
  const challenge = query.get('code_challenge') ?? '';
  const redirect = query.get('redirect_uri') ?? '';
  const state = query.get('state') ?? '';
  const device = query.get('device_id') ?? '';
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
    !state ||
    !device ||
    state.length > 256 ||
    device.length > 256
  )
    return undefined;
  try {
    const uri = new URL(redirect);
    if (
      uri.protocol !== 'http:' ||
      uri.hostname !== '127.0.0.1' ||
      !uri.port ||
      uri.username ||
      uri.password ||
      uri.pathname !== '/callback' ||
      uri.search ||
      uri.hash
    )
      return undefined;
  } catch {
    return undefined;
  }
  return new URLSearchParams({
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: redirect,
    state,
    device_id: device,
  }).toString();
}

function messageText(message: MailMessage, webOrigin: string): { subject: string; text: string } {
  if (isTokenMail(message)) {
    const url = new URL(TOKEN_PATH[message.template], webOrigin);
    url.searchParams.set('token', message.token);
    for (const [key, value] of new URLSearchParams(message.continuation))
      url.searchParams.set(key, value);
    const title = { verify: '验证邮箱', reset: '重置密码', invite: '加入租户' }[message.template];
    return {
      subject: `EvoWork · ${title}`,
      text: `${title}${message.tenantName ? `：${message.tenantName}` : ''}\n${url.toString()}\n链接用过即失效。如果不是你发起的请求，请忽略。`,
    };
  }
  return {
    subject: 'EvoWork · 额度提醒',
    text: `${message.subject ?? ''}\n已用 ${message.used} / ${message.limit} tokens。`,
  };
}

/** Resend 兼容事务邮件 API；不回显供应商响应体、API key 或验证链接。 */
export function configuredMailer(
  env: NodeJS.ProcessEnv,
  webOrigin: string,
  fetchFn: typeof fetch = fetch,
): Mailer {
  if (env.EVOWORK_MAIL_TRANSPORT === 'log') return devMailer(webOrigin);
  if (env.EVOWORK_MAIL_TRANSPORT === 'smtp') {
    const host = env.EVOWORK_SMTP_HOST?.trim();
    const user = env.EVOWORK_SMTP_USER?.trim();
    const password = env.EVOWORK_SMTP_PASSWORD;
    const from = env.EVOWORK_MAIL_FROM?.trim() || user;
    const port = Number(env.EVOWORK_SMTP_PORT || 465);
    if (!host || !user || !password || !from || ![465, 587].includes(port)) {
      return {
        send() {
          throw new MailDeliveryError();
        },
      };
    }
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: port === 587,
      auth: { user, pass: password },
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
    return {
      async send(message) {
        try {
          const result = await transport.sendMail({
            from,
            to: message.to,
            ...messageText(message, webOrigin),
          });
          if (!result.accepted.length || result.rejected.length) throw new MailDeliveryError();
        } catch {
          throw new MailDeliveryError();
        }
      },
    };
  }
  const key = env.EVOWORK_MAIL_API_KEY?.trim();
  const from = env.EVOWORK_MAIL_FROM?.trim();
  const endpoint = env.EVOWORK_MAIL_API_URL?.trim() || 'https://api.resend.com/emails';
  return {
    async send(message) {
      if (!key || !from || env.EVOWORK_MAIL_TRANSPORT !== 'api') throw new MailDeliveryError();
      try {
        const target = new URL(endpoint);
        if (target.protocol !== 'https:' || target.username || target.password)
          throw new MailDeliveryError();
        const response = await fetchFn(target, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: [message.to], ...messageText(message, webOrigin) }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new MailDeliveryError();
        }
        const receipt = (await response.json()) as { id?: unknown };
        if (typeof receipt.id !== 'string' || !receipt.id) throw new MailDeliveryError();
      } catch {
        throw new MailDeliveryError();
      }
    },
  };
}
