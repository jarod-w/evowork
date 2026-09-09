# packages/account —— 账号协议（无网络、无存储、无 Electron）

设计：[11 §5.3](../../docs/design/11-account-and-models.md)

三个消费者共用这一份类型与密码学帮助函数：

| 消费者                | 用它做什么                          |
| --------------------- | ----------------------------------- |
| `services/identity`   | 签发 access JWT、授权码与**策略包** |
| `services/gateway`    | 验签（托管形态的 `authenticate`）   |
| `apps/desktop` 主进程 | PKCE challenge / 校验 loopback 回调 / **验策略包签名** |

**为什么在 `packages/` 而不是任何一层**：CLAUDE.md §3 —— 被两层以上使用、复制会造成语义分裂。此前模型目录端点是 server.ts 里的内联字面量，消费侧只能照抄一份类型，两边各自都能编译，改一个字段名就在运行时静默断掉。JWT claims 是同一条缝。

## 这一包明确没有什么

- 没有 `fetch` / `node:http` / 任何存储
- 类型里没有能装内容的字段（11 §5.2 / §6.1）：没有 `threadId`、没有 `password`、没有任务 / 产物 / prompt
- 不注册 `userId`（那是 `packages/logging` 的纪律；本包的 `sub` 是 JWT 的标准键，日志侧只用它的摘要）
