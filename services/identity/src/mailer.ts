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
export type MailTemplate = 'verify' | 'reset' | 'invite' | 'quota-warn' | 'quota-exhausted';

interface MailBase {
  readonly to: string;
}

export interface TokenMail extends MailBase {
  readonly template: 'verify' | 'reset' | 'invite';
  readonly token: string;
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
          `[identity] ${message.template} ${message.to} ${publicOrigin}${path}?token=${message.token}\n`,
        );
        return;
      }
      process.stderr.write(
        `[identity] ${message.template} ${message.to} ${message.used}/${message.limit}\n`,
      );
    },
  };
}
