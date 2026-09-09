/** 邮件通道。生产接事务邮件；测试用内存实现。identity **不发送短信**（11 §12 第 19 条）。 */
export interface MailMessage {
  readonly to: string;
  readonly template: 'verify' | 'reset';
  readonly token: string;
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

/** 开发期：把验证 / 重置链接打到 stderr。生产换成事务邮件，仍然不发短信。 */
export function devMailer(publicOrigin: string): Mailer {
  return {
    send(message) {
      const path = message.template === 'verify' ? '/verify' : '/reset';
      process.stderr.write(
        `[identity] ${message.template} ${message.to} ${publicOrigin}${path}?token=${message.token}\n`,
      );
    },
  };
}
