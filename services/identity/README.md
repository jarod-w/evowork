# services/identity —— 账号 · 租户 · 默认模型 · 计量（**云端**）

设计：[11](../../docs/design/11-account-and-models.md) · D9 · D10 · Q32=B · Q37=B · Q38–Q40

数据面**只有身份与计量，无内容**（D9）。管理端 API 的返回类型里没有任务 / 产物 / prompt
（11 §12 第 15 条）—— 这是「管理员能不能看员工的任务」的结构性答案。

## 这一包做什么（M10b）

| 面 | 落点 |
| --- | --- |
| 注册 / 登录 / 刷新 | 邮箱密码 + 邮件验证（Q32=B）。短信通道不存在（Q38 的手机号只是登录标识） |
| PKCE | 授权码 + S256，给桌面 loopback 回调（Q33=A） |
| 租户 | 一个种子租户。自助注册**不**开租户（Q38=B） |
| 种子管理员 | 配置 / 环境变量，**只在库里 0 个 admin 时消费一次明文密码**（Q38） |
| 授予 / 收回 admin | 已注册用户；不能收回最后一名；跨租户拒绝 |
| 注销 | 只清云端（Q39）。最后一名 admin 不能注销自己 |
| 设备吊销 | refresh 绑 `device_id`；吊销后立刻不能换 access（Q40） |
| 默认模型 | key 只存在这里，目录端点类型里没有 `apiKey` / 上游 `baseUrl` |
| 计量 | 按天按模型聚合，类型里没有 `threadId` |

## 配置在哪

这段配置属于 **identity 进程**，不是桌面的 `~/.evowork/app.toml`。写进客户端等于把管理员密码发到每一台电脑上。

```
EVOWORK_BOOTSTRAP_ADMIN_EMAIL
EVOWORK_BOOTSTRAP_ADMIN_PASSWORD
EVOWORK_BOOTSTRAP_TENANT_NAME
EVOWORK_IDENTITY_MASTER_KEY   # 32 字节 hex，加密托管模型的上游 key
```

## 明确不做

策略包签名下发（M10c）· 支付 / 充值（Q42）· 分享页（Q41）· 第二个客户租户 · 短信。
