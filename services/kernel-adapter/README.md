# services/kernel-adapter —— app-server 协议适配层（M2a）

设计：[09 §3](../../docs/design/09-service-layer.md)。**这是 K2 边界的唯一实现处。**

四条职责（09 §3.1）：

1. **收敛实验方法** —— `project/*`、`thread/queue/*`、`thread/search*`、`turn/start.collaborationMode`、
   `turn/start.permissions` 等实验面只在这里出现一次（方法清单见 `@evowork/protocol` 的 `EXPERIMENTAL_METHOD`，现 21 个）。上游任一变更只改这里一处。
2. **展开 EvoWork 概念** —— 前端只传 `{scenarioId, modeId, overrides}`，由这里展开成
   `collaborationMode` + `permissions` + `model`（03 §2.4）。场景包必须自建的原因见 F3。
3. **合并数据源** —— 任务列表 = `thread/list`（权威字段）+ 本机投影表（状态/日期筛选）。
4. **降级与兜底** —— 不硬编码"实验方法一定可用"：启动时探测无副作用的方法，其余首次调用失败即降级
   （`capabilities.ts`；`experimentalFeature/list` 返回的是内核功能开关，判断不了方法在不在）；
   缺失时走 09 §3.3 的降级表，且**降级一律显式**（不假装正常）。

**审批是 server→client request，不是通知**（F14）—— 适配层必须实现可回复的请求处理器，
内核在等回复时会一直等。超时/离线语义见 10 §3.6（交互式不自动拒绝，定时任务 10 分钟自动 Decline）。

产品身份（K5）走 `thread/start.baseInstructions` 整段替换内核底稿，并关掉系统技能
`openai-docs`（F25）。`developer_instructions` 只管 Craft/Plan/Ask 怎么干活，盖不住「你是谁」。

记忆配置通过 `config/read` / `config/batchWrite` 管理来源和提取/整理模型。未指定记忆模型时，任务启动与冷恢复配置显式使用任务模型；新任务读取选择保存到宿主 meta，在恢复/分叉时重放。已加载任务不支持读取热切换。生产代码不读写内核记忆存储；真实后台回归及时间夹具在 `test-support`，入口 `node scripts/desktop-skills-e2e.mjs --memory`（仓库根执行）。

**独立会话通信（2026-10-11）**：`thread-communication.ts` 管理权威本机队列、每目标互斥、空闲投递、最终结果回传和断线核对。`Adapter` 校验原生 MCP item、具体范围审批、来源回合及内核代际；投递沿用目标模型/权限/模式，以官方 `thread/read`、`thread/resume`、`turn/start` 完成。不会读取内核数据库或复制 rollout；未知投递不自动重试。设计见 [17](../../docs/design/17-thread-communication.md)。

**外部记忆导入（2026-10-17）**：`memory-import.ts` 只经原生迁移协议发现/导入 Claude Code 项目记忆并读取历史；一次性选择凭据、提交前复核、超时结果未知不重放、明确禁用降级。`enableMemoryReading` 仅启用记忆及读取，不改生成或模型设置。设计见 [20](../../docs/design/20-memory-import.md)，原生探针 `node scripts/verify-memory-import.mjs`（仓库根），真实窗口入口为 `memory-import.spec.mjs`。

**记忆能力复用**：原生消息保留 `memoryCitation`，V2 `memory/status` 仅用于整体就绪状态。自动同步在本适配层每分钟复用原生 detect/import/history，默认关闭，授权项目清单及待核对批次存在宿主 meta，不建立记忆正文副本。写前持久化暂停标记，异常暂停且不重放；退出只在已发写入结果不明时暂停，只读检测不会关闭开关。清空与导入/同步互斥，并先撤销同步授权。隔离/项目遗忘提案见 [21](../../docs/design/21-project-memory-isolation-and-forgetting.md)。

**WorkBuddy 文本快照（2026-10-17）**：`memory-text-import.ts` 在显式确认后以临时会话调用原生 `memories.add_ad_hoc_note`，以受信任同步 PostToolUse 的公开 `hook/completed` 回执校验文件名及正文哈希；同时核对来源文件和 hook 顺序。不开启内部 raw events，不读写原生记忆文件。临时会话以 `threadSource` 标识，在 `thread/started` 提前于启动响应时同样隔离其任务/队列事件。宿主只持久化哈希与状态，未知批次不重放；可能仍在执行的超时写入阻止后续记忆写操作，应用重开后核对。正式能力、用量与整理延迟见 [20](../../docs/design/20-memory-import.md) 和 [WorkBuddy 验收](../../docs/verification/2026-10-17-workbuddy-memory-import.md)。
