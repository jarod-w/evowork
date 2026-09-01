# 06 · daemon / UI 协议

> B 类第一条：**真 IPC，不能是函数调用。** 这条是红线 1 的正面形态。
>
> 契约层是 `packages/protocol`，TS 类型从 Rust 侧用 `ts-rs` 生成，不手写两遍（4.10⑤）。

---

## 一、两条通道

| 通道 | 用途 | 传输 |
|---|---|---|
| **事件流** | UI 订阅 Run Log，做投影渲染 | WebSocket，服务端推送 |
| **命令** | UI 下命令 | HTTP + 极薄手写 JSON-RPC |

**UI 不轮询。** 内核是事件溯源的，UI 天然是事件流的一个投影——这不是性能优化，是架构的直接推论（4.10①）。轮询意味着 UI 自己在维护一份状态，那份状态迟早会和 Log 对不上。

不上 tRPC / gRPC-web：daemon 是 Rust，前端是 TS，手写一层薄 JSON-RPC 比引入跨语言 RPC 框架更省事，也不会绑死（4.10④）。

---

## 二、事件流

```
ws://<daemon>/v1/events?token=<token>

→ { "op": "subscribe", "run_id": "r-...", "from_seq": 0 }
← { "op": "event", "run_id": "r-...", "seq": 0,  "kind": "run.created", ... }
← { "op": "event", "run_id": "r-...", "seq": 1,  "kind": "intent.declared", ... }
← { "op": "caught_up", "run_id": "r-...", "at_seq": 42 }
← ...（此后实时推送）
```

- `from_seq` 让重连不丢事件：UI 记住收到的最后一个 seq，重连时续订。**这是「跨设备接管」在协议上的形态**——两个设备各自从自己的 seq 续订同一条 Log
- 也可以订阅全局流（`{"op":"subscribe_all"}`）供 Inbox 与成本面板用
- 事件体与 [01](01-run-log.md) 的定义**逐字段一致**。UI 收到的就是 Log 里存的，不做另一套 DTO——否则又是两套数据

> **反模式**：为 UI 方便而在推送时把几个事件合并成一条「便于渲染的消息」。那一刻 UI 就不再是 Log 的投影，而是另一套语义，回放与实时会开始分叉。要合并请在前端合并。

---

## 三、命令集

```
POST /v1/rpc     { "id": 1, "method": "run.create", "params": {...} }
```

| 方法 | 说明 | 对应 POC 项 |
|---|---|---|
| `run.create` | 声明意图，起一个 run。带 `mode: live \| dry_run` | A-1 / A-4 |
| `run.cancel` / `run.pause` / `run.resume` | | A-3 |
| `run.fork` | 从某个 seq 分叉重跑 | [P2] / eval 重放 |
| `run.list` / `run.get` | 执行历史 | A-6 |
| `run.events` | 拉取事件区间（回放用） | A-6 |
| `approval.decide` | 批准 / 驳回 | A-5 |
| `clarification.answer` | 回答澄清追问 | A-12 |
| `budget.amend` | 人提额。`budget` 是完整 `BudgetSpec`（整体替换，与 `budget.amended` 同形）。挂在预算上的 run 提额后由 daemon 续跑 | A-7 |
| `artifact.list` / `artifact.download` | 产物必须可导出 | A-3 |
| `blob.get` | 按 content hash 取回 blob 正文（澄清选项文案、意图原文、产物预览）。事件 payload 里只有 `BlobRef`，UI 要渲染这些就得有一条只读取回通道 | A-3 / A-12 |
| `cost.query` | 按维度聚合 | A-7 |
| `trigger.create` / `list` / `delete` / `dryrun` | 定时与 webhook | A-8 |
| `tool.list` / `tool.manifest` | 工具与其治理声明 | A-4 |
| `policy.get` | 当前生效策略（放权分级的展示） | A-10 |
| `eval.run` | 跑评测集 | 4.7 / 出场判据 7.1-4 |

`eval.run` 放进产品协议而不是一个独立脚本，是有理由的：**4.7 要求「POC 验收当天客户问准确率多少时，能当场跑一遍给客户看」**。它在 UI 里有一个按钮，比 SSH 上去敲命令有说服力得多，且成本几乎为零（runner 本来就要写）。

---

## 四、认证

POC 期：内网 + 共享 token，`Authorization: Bearer <token>`。

**但认证必须是接口的一部分，不能「内网就不认证」**（4.8）。将来换 SSO 只换校验实现，调用点不动。

**Q-22 已定。** token 分发：daemon 首次启动生成。

> **同机部署下有一个会绊一下的细节**（4.8）：daemon 是 LaunchDaemon，跑在专用服务账户下；桌面客户端是财务登录账户下的一个 `.app`。**token 若只写在服务账户的家目录里，财务账户读不到，装完就是打不开。** 因此 token 落在两个账户都可读的位置——`/Library/Application Support/evowork/client.toml`，权限 `644`，只放 token 与 daemon 地址，不放任何别的东西。浏览器入口同理。

企业微信推送的审批链接里带一个**一次性短期 token**：只对该 approval 有效、**24 小时过期、用一次即失效**。这样手机点开就能批，不必在手机上存长期凭据；链接被转发出去也只能批那一件事，且批完即废。

---

## 五、版本协商

```
← { "op": "hello", "protocol_ver": "1.3", "daemon_ver": "0.4.2", "runlog_schema_ver": 1 }
```

UI 与 daemon 版本不匹配时的处理，现在就要定，因为 POC 期 daemon 与 UI 虽然同机（4.8），**更新节奏仍然天然不同步**：刷新页面或重开客户端就换了 UI 版本，daemon 却没重启；而桌面外壳还多一条路径——`.app` 是单独分发的，可能停在一个旧版本上。

**Q-23 已定**：主版本不匹配 → UI 显示「请刷新 / 请联系管理员升级」并**只允许只读操作**；次版本不匹配 → 正常工作。

选「降级为只读」而不是「直接拒绝」，是因为 POC 期最可能的不匹配场景是财务浏览器里挂着一个旧页面——此时能看历史与成本比整页报错有用得多，而只读保证了旧 UI 不会用过时的语义去下命令。

---

## 六、UI 侧的两个调用点（4.10① 的落点）

跨平台成本不在框架，在调用点。UI 里只有两类代码会被平台绑死：

| 调用点 | 错位写法 | 正确写法 |
|---|---|---|
| 读状态 | 直接读 SQLite、或用 Tauri `invoke` 拿业务数据 | 只有一个 `daemonClient` 模块，全部状态经本协议 |
| 用原生能力 | 组件里散落 `@tauri-apps/api` | 一个 `platform` 接口，**方法不超过 5 个**：选文件、打开外链、系统通知、托盘/自启、退出 |

守住这两条，套 Tauri 外壳 = 只写那一个适配器。

**POC 期就要出 macOS 外壳（4.10②，客户的验收条件），因此这条从「将来注意」变成当期防线：**`@tauri-apps/api` 只许出现在 `apps/ui/src/platform/` 一个目录，已进 CI（[00 第四节](00-index.md)检查 9）。

浏览器入口同时保留，不是二选一——手机点企业微信审批链接走的就是它。于是 `platform` 有两个实现：外壳实现调原生 API，浏览器实现基本是空的（选文件退回 `<input type=file>`，系统通知退回 Web Notification，托盘/自启直接不支持）。**接口相同，能力可缺，调用点只有一处。**

---

## 七、待确认

**本文无待确认项，以下为已定决策备查。**

| # | 决策 | 结论 |
|:-:|---|---|
| ~~Q-22~~ | ~~token 分发方式；审批链接 token 有效期~~ | **审批 token 24 小时 + 单次使用**，见第四节 |
| ~~Q-23~~ | ~~协议版本不匹配的处理~~ | **主版本不匹配降级为只读**，见第五节 |
