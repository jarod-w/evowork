# services/identity —— 账号 · 租户 · 默认模型 · 计量 · 策略包（**云端**）

设计：[11](../../docs/design/11-account-and-models.md) · D9 · D10 · Q32=B · Q37=B · Q38–Q40 · R11

数据面**只有身份与计量，无内容**（D9）。管理端 API 的返回类型里没有任务 / 产物 / prompt
（11 §12 第 15 条）—— 这是「管理员能不能看员工的任务」的结构性答案。

## 这一包做什么（M10b + M10c）

| 面                 | 落点                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| 注册 / 登录 / 刷新 | 邮箱密码 + 邮件验证（Q32=B）。短信通道不存在（Q38 的手机号只是登录标识）                              |
| PKCE               | 授权码 + S256，给桌面 loopback 回调（Q33=A）                                                          |
| 租户               | 一个种子租户。自助注册**不**开租户（Q38=B）                                                           |
| 种子管理员         | 配置 / 环境变量，**只在库里 0 个 admin 时消费一次明文密码**（Q38）                                    |
| 授予 / 收回 admin  | 已注册用户；不能收回最后一名；跨租户拒绝。WEB 按邮箱加人，不靠手粘 userId                             |
| 注销               | 只清云端（Q39）。最后一名 admin 不能注销自己                                                          |
| 设备吊销           | refresh 绑 `device_id`；吊销后立刻不能换 access（Q40）                                                |
| 默认模型           | key 只存在这里，目录端点类型里没有 `apiKey` / 上游 `baseUrl`                                          |
| 计量               | 按天按模型聚合，类型里没有 `threadId`                                                                 |
| 配额班级           | `quota_classes` + JWT `quotaClass`。每人覆盖仍走 `quota_accounts`。用尽不自动换模型                   |
| 策略包             | ES256 签 payload 原文 → `GET /v1/policy-pack`。密钥落库，重启仍能验旧包。管理端可读回显 + 历史 + 撤销 |
| 身份面审计         | 授予/收回 admin · 改默认模型 key · 签发/撤销策略包。类型里没有任务 / 产物 / prompt                    |
| 管理端用量         | 租户当期总量 + 按人当期累计（Q43=A）。**不按天分组、不查 metering 拼时间线**                          |

## 配置在哪

这段配置属于 **identity 进程**，不是桌面的 `~/.evowork/app.toml`。写进客户端等于把管理员密码发到每一台电脑上。

```
EVOWORK_BOOTSTRAP_ADMIN_EMAIL
EVOWORK_BOOTSTRAP_ADMIN_PASSWORD
EVOWORK_BOOTSTRAP_TENANT_NAME
EVOWORK_IDENTITY_MASTER_KEY   # 32 字节 hex，加密托管模型的上游 key **以及** 签发私钥
EVOWORK_IDENTITY_DB           # 文件库。不设则 :memory:，密钥与策略包重启即丢
```

签发密钥必须落库：进程一重启就换钥匙，已经下发的包会全部验不过。

## 明确不做

支付 / 充值（Q42）· 分享页（Q41）· 第二个客户租户 · 短信 · 企业 OIDC SSO（等客户 IdP，不在 1.5 周里程碑表里）。

## 真实发信（2026-10-31）

账号服务支持 SMTP 和 Resend 兼容 API。生产不默认把验证链接打进日志。
SMTP 配置保存在服务端环境（例如 root 可读的 `/etc/evowork-web.env`），不随桌面分发：

```ini
EVOWORK_MAIL_TRANSPORT=smtp
EVOWORK_SMTP_HOST=smtp.qq.com
EVOWORK_SMTP_PORT=465
EVOWORK_SMTP_USER=<发信邮箱>
EVOWORK_SMTP_PASSWORD=<邮箱授权码>
EVOWORK_MAIL_FROM=<发信邮箱>
EVOWORK_WEB_ORIGIN=<用户实际打开的账号页地址>
```

生产 `EVOWORK_WEB_ORIGIN=https://account.nucleant.cn`；该配置为 HTTPS 时，浏览器会话 Cookie 增加 `Secure`，保留 `HttpOnly` / `SameSite=Lax`。不依据客户端传入的代理头切换 Cookie 策略。

465 直接 TLS；587 强制 STARTTLS，校验证书。不开 SMTP debug，不记录密码、邮件正文或验证链接。
注册、重发验证、找回密码和邀请接口等待投递服务接受；失败返回 `503 mail-unavailable`，页面不会报已发送。
邮箱验证可限频重发；重置密码同时吊销旧 refresh 和浏览器会话，旧 access 最长保留到自身过期。

API 模式为 `EVOWORK_MAIL_TRANSPORT=api`，配置 `EVOWORK_MAIL_API_KEY`、`EVOWORK_MAIL_FROM`；
可选 `EVOWORK_MAIL_API_URL`，默认 `https://api.resend.com/emails`，只接受 HTTPS。
仅开发时显式设置 `EVOWORK_MAIL_TRANSPORT=log` 才使用旧 stderr 通道；不配置发信时明确不可用。
