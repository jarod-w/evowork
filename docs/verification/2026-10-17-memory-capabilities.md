# 2026-10-17 · 记忆接口核实与接入验收

## 发货基线与接口结论

macOS arm64 `build/kernel/mac-arm64/codex-app-server`，来源证明 `d583e73c4d1204f1e9f654ef87065e9f0dd07ac7`，二进制 SHA-256 `d4e0b99dd4622f5f32b45f5f92a5b20c7bbdff7c31c3e817f9956a09842f375d`，保留 P6，无新增补丁。核对 build/.kernel-src（构建时导出源码）及 provenance，并以隔离 HOME 的实际二进制 RPC 探针确认；没有把官方桌面私有能力当成公共接口。

| 能力 | 实际协议与边界 | 本次接入 |
| --- | --- | --- |
| 记忆引用 | AgentMessage.memoryCitation.entries 的 path / lineStart / lineEnd / note，另有 threadIds；item/completed 与 thread/read 均可取到 | 回复下折叠“记忆引用”，展示路径、行号和说明；只作来源元数据，不自动打开任意文件，也不证明完整检索审计 |
| 整理状态 | memory/status，参数可选 minConsolidatedThreads；返回 v2ConsolidatedThreads / v2Ready，默认门槛 20；与 V1、单批整理进度无关 | 导入结果可刷新/跟进整体状态；V1 明示无进度，V2 未就绪不称为作业正在运行；沿用设置页读取接口 |
| 同步原语 | externalAgentConfig/detect、import、import/readHistories；import/progress、import/completed 通知描述迁移，不描述后台记忆整理 | 使用原生变化检测和同步复制，不解析或复制来源文件；按历史确认结果 |
| 自动调度 | 发货协议无独立同步配置/调度方法，实测 externalAgentConfig/sync 返回不支持 | 适配层实现默认关闭的一分钟调度，范围只含开启时确认的 Claude Code 已导入项目；没有冒充原生同步开关 |
| 配置与禁读 | config/read、config/batchWrite；thread/memoryMode/set 只控制贡献，读取仍按新任务配置 | 保持原读取、贡献、模型配置，不通过开启同步顺带改这些配置 |
| 清空 | memory/reset 仅整体清空 | 先撤销自动同步，与在途导入/同步互斥；不包装成项目遗忘 |
| 缺失接口 | 无单批整理进度/错误/重试、按项目遗忘、衍生知识撤销、严格 scope 过滤接口 | 不实现虚假状态/按钮；独立方案见 [21](../design/21-project-memory-isolation-and-forgetting.md) |

源码定位：build/.kernel-src/codex-rs/app-server-protocol/src/protocol/common.rs:701、1397、1979；v2/item.rs:153、258；v2/memory.rs:11；v2/config.rs:879、904、1004；app-server/src/request_processors/memory_status.rs:10。这些是本轮当场核实的位置，后续升级需重新核对。

## 状态与恢复约束

授权和同步操作状态只写宿主 meta。只读检测中退出保留开关；写请求前先持久化暂停标记，若进程在写入时退出则下次不会自动提交。返回 importId 后持久化待核对批次，历史确认后才记录最近完成时间。超时、断线、部分失败暂停；不知道结果时不自动重放。关闭后不再提交新操作；已经提交的原生操作可能完成。新增来源和后导入项目不自动扩大范围。

原生增量同步可以删除副本中被来源删除的文件，但不证明此前提取的知识已经遗忘。来源项目整体消失可能不再作为候选返回，因此不提供自动项目遗忘承诺。引用由模型标注并由内核解析，无引用不代表模型一定没用记忆，有引用也不是权限审计。

## 验证记录

- `node scripts/verify-memory-import.mjs`：实际 memory/status 返回零任务未就绪；非法门槛被拒绝；独立 sync 方法被拒绝。真实原生导入、去重、后台整理、后续新任务注入及禁读通过。合成模型返回内核引用标记，原生事件和历史恢复均获得结构化引用。
- 专项单元验证：手动/自动互斥、范围冻结、重开、关闭及迟到响应、写前暂停、超时/部分失败不重放、清空互斥；引用无 HTML 执行和路径动作，状态错误可重试与保存失败回滚。
- 最终生产代码 `pnpm run check` 退出 0：180 个文件 / 2898 项通过，2 项既有运行时安装条件跳过。格式、lint、类型、补丁预算、协议形状和许可清单全部通过；完整构建通过。
- MiMo `mimo-v2.6-flash` 完整 Playwright **1/1（6.0 分钟、重试关闭）**：初始双项目为一个批次，再经生产同步开关更新 Alpha 来源为新标记（总计两批）。真实后台整理完成、无错误；6 个独立新任务正确使用更新后的约定，单任务/全局禁读不注入记忆且回答 UNKNOWN，未导入 Gamma 未借用其他项目约定。24 次指定模型请求，其中 15 次为任务请求、9 次为后台；Alpha/Beta 的原生消息分别返回 1 / 3 条记忆引用；Gamma 虽回答 UNKNOWN，仍返回 1 条共享索引引用，再次说明读取共享索引与使用本项目约定是不同事实，当前不能承诺严格隔离。两种禁读任务均无记忆引用。生命周期仅一次启动、零退出。证据见 [JSON](assets/2026-10-17-memory-capabilities/memory-real-evidence.json) 及 [生命周期](assets/2026-10-17-memory-capabilities/memory-real-kernel-lifecycle.json)。
- 最终真实 Electron + 发货内核 + 本机确定性网关 Playwright **19/19（4.7 分钟，零重试、零跳过）**。覆盖默认关闭、范围冻结、实际一分钟定时更新/文件删减、关闭后的完整周期零写入、原生复制失败暂停、响应丢失后暂停及核对恢复、读取开关保留、V1/V2 状态、引用实时/刷新恢复和整个应用三次启动。19 份生命周期记录中共 24 次启动、3 次明确故障注入退出、**零次意外退出**；正常整 App 关闭在记录后显式执行。详见[生命周期汇总](assets/2026-10-17-memory-capabilities/memory-ui-kernel-lifecycle.json)。
- 截图已人工查看：[自动同步](assets/2026-10-17-memory-capabilities/memory-auto-sync.png)、[引用历史](assets/2026-10-17-memory-capabilities/memory-citation-history.png)、[丢响应后的历史核对](assets/2026-10-17-memory-capabilities/memory-sync-unknown.png)、[整 App 重开](assets/2026-10-17-memory-capabilities/import-whole-app-restarted.png)、[MiMo 新任务](assets/2026-10-17-memory-capabilities/memory-real-alpha.png)。
- 通过隐藏 stdin 进行精确凭据扫描：本轮实模型失败/成功日志、证据、当时生成的桌面证据及修改文件共 78 个，**0 命中**。后续新增文件仅包含无凭据的确定性夹具和生命周期数据；密钥未写入配置或源码。

实际执行命令（macOS arm64，需要桌面和回环监听权限）：

```bash
node scripts/verify-memory-import.mjs
node scripts/build.mjs
pnpm run check
node node_modules/@playwright/test/cli.js test memories.spec.mjs memory-import.spec.mjs memory-import-restart.spec.mjs --project=fake --retries=0 --output=/private/tmp/evowork-memory-ui-final
# 凭据由隐藏 stdin 进入启动器环境，未写入命令参数或文件
EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash node node_modules/@playwright/test/cli.js test memory-import.real.spec.mjs --project=real --retries=0 --output=/private/tmp/evowork-memory-real-final-2
```

只验 macOS arm64 和一个真实模型的一轮结果，未发布安装包。共享记忆可见性、非 ACL 的禁读边界保持不变。


本轮使用独立合成来源与工作区；生产不读取内核 sqlite/rollout/记忆文件。白盒断言仅在适配层 test-support 和隔离夹具中。真实模型证据与确定性网关证据分别记录，不用后者证明模型质量或严格隔离。


## 内核重启专项检查

用户提醒测试期间出现内核重启后，复核上一轮日志：3 组 exited/restarted 分别对应向导历史恢复、确认前进程丢失和 V2 配置恢复这 3 条明确调用 killKernel 的用例。终止只调用本夹具 spawn 返回的 ChildProcess.kill，不按名称检索/杀全机进程。

新增测试专用生命周期记录：内核每次启动的 PID、时间，显式故障注入标记，以及每次退出的 code/signal。夹具正常收尾前保存 kernel-lifecycle.json；任何未标记为主动故障注入的退出，即使随后自动恢复且内容断言成功，也令用例失败并保留现场。整应用重开旅程逐次记录关闭前状态，只有显式 app.close 允许正常生命周期结束。实模型旅程没有故障注入，必须无意外内核退出。

这项证据仅覆盖本次 EvoWork 测试进程，不能据此判断其他应用或当前 Codex 会话是否发生重启。


验证中修正的接线/时序问题：同步开关等待 IPC 时的回弹；只读检测退出误暂停；前台先确认批次后，一秒结果轮询误变为来源扫描。关闭同步后的前台查询也会继续核对已提交批次，避免留下永久“正在核对”的显示。最终增加对应单元与真实窗口回归。实模型首轮前置检查将同一导入批次内的两个项目误计成两条历史，故在发起模型任务前失败；修正为初始一批加自动更新一批，保留原内容断言及零重试要求。该失败轮的生命周期只有一次启动、无退出。
