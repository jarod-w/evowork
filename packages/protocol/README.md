# @evowork/protocol —— app-server JSON-RPC v2 的类型与传输（M2a）

**K2 的技术落点**：唯一边界是 app-server JSON-RPC v2，协议定义在
`../codex/codex-rs/app-server-protocol/src/protocol/v2/`。这个包提供：

- JSON-RPC 2.0 over stdio 的编解码与请求/通知/**服务端发起请求**三种消息的分发
  （审批是 server→client request，不是通知 —— F14）；
- EvoWork 用到的那部分协议形状的 TypeScript 类型（**手写子集**，不是全量生成）。

**为什么手写子集而不是从内核生成**：内核用 `ts-rs` 能导出全量 TS 类型，但那会把
「我们依赖协议的哪一部分」这条信息丢掉。手写子集的清单本身就是依赖面的声明 ——
上游改了我们没用到的东西，不该让我们的类型检查变红；改了我们用到的，必须变红。
代价是要维护，收益是 R2 的影响面可见。
