# services/kernel-adapter —— app-server 协议适配层（M2a）

设计：[09 §3](../../docs/design/09-service-layer.md)。**这是 K2 边界的唯一实现处。**

四条职责（09 §3.1）：

1. **收敛实验方法** —— `project/*`、`thread/queue/*`、`thread/search*`、`turn/start.collaborationMode`、
   `turn/start.permissions` 等 15 个实验方法只在这里出现一次。上游任一变更只改这里一处。
2. **展开 EvoWork 概念** —— 前端只传 `{scenarioId, modeId, overrides}`，由这里展开成
   `collaborationMode` + `permissions` + `model`（03 §2.4）。场景包必须自建的原因见 F3。
3. **合并数据源** —— 任务列表 = `thread/list`（权威字段）+ 本机投影表（状态/日期筛选）。
4. **降级与兜底** —— 用 `experimentalFeature/list` 的**实际返回**决定 UI，不硬编码"实验方法一定可用"；
   缺失时走 09 §3.3 的降级表，且**降级一律显式**（不假装正常）。

**审批是 server→client request，不是通知**（F14）—— 适配层必须实现可回复的请求处理器，
内核在等回复时会一直等。超时/离线语义见 10 §3.6（交互式不自动拒绝，定时任务 10 分钟自动 Decline）。
