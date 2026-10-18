# MiMo 实模型重启恢复补验（2026-10-18）

## 链路与断言

使用用户指定的 `mimo-v2.6-flash`、`https://api.xiaomimimo.com/v1`，通过真实 Electron、宿主网关及带来源校验的发货内核。每项重开原隔离本机数据目录，核对 Electron 与内核 PID 均变化。测试仅控制本机准备脚本的数据就绪时机、IPC 回执及公开原生队列接口故障；模型决策、命令调用、计算、文件追加和最终答复全部由实模型完成。

| 场景 | 退出方式 | 后果断言 |
|---|---|---|
| 首轮已接受、IPC 回执丢失 | SIGKILL | 原始提交和正文恢复，原身份重试不新增投递 RPC、任务、回合或用户消息，界面确认后清理待确认草稿 |
| 排队追问已接受、IPC 回执丢失，停止后退出 | SIGKILL | 原身份重试复用回执，恢复队列保持暂停；明确继续后实模型计算 42，追加一行且公开历史只有一次追问 |
| 原生队列不可用，本机降级队列停止后退出 | 正常退出 | 本机待发内容恢复、不自动执行；明确继续后实模型执行一次 |
| 原生队列不可用，本机降级队列停止后退出 | SIGKILL | 与正常退出同样核对恢复、暂停及单次执行 |

每项重启后释放原任务准备条件，并观察 5 秒：MiMo 请求数不增加、追问标记未进入上游、结果文件不存在，公开历史仍只有一个 interrupted 回合；确认回执时 `thread/start`、`turn/start`、`turn/steer`、`thread/queue/add`、`thread/queue/start` 均无新调用。只有明确点击“继续队列”后，追问标记才进入实模型请求；检查第二回合 completed、公开用户消息一次及 `queued.txt` 一行结果。

密钥仅从隐藏 stdin 进入测试进程环境，不写入模型配置、源码或验收证据。上游观测仅保存请求时间、模型、端点、测试标记和 HTTP 状态，不保存请求头或模型正文。每次请求以网关进程 PID 和序号配对到 HTTP 结果或脱敏传输异常；异常继续由产品网关原有策略处理，观测夹具不重试或替换结果。消息去重以提交身份、投递 RPC 和公开用户消息/回合为准；同一回合内的工具往返或正常网络恢复可以产生多次模型 HTTP 请求。

## 启动问题与过程

最初在受限沙箱内启动 Electron 时，窗口未创建即失败。用户报告的 PID 4757 与该轮测试启动进程对应；系统诊断报告为 `EXC_CRASH (SIGABRT)`，触发线程经过 `___RegisterApplication_block_invoke`、`_RegisterApplication`、`_NSInitializeAppContext` 和 `NSApplication` 初始化。它与测试主动注入的 SIGKILL 不同，不能计作已完成重启或产品恢复通过。

随后在允许图形窗口和本机端口的沙箱外入口运行，Electron 可正常打开。该轮又发现测试错误地期待友好模型显示名，而实际控件显示 `private/mimo-v2.6-flash`；已改为检查实际模型 ID，并继续从上游模型/端点记录确认身份。该断言修正不改变恢复、零投递或执行次数标准。

第二轮 3/4 通过：三条队列恢复旅程均通过，首轮丢回执用例错误地期待页面已经进入新任务的 running 状态。IPC 结果被故意扣留时页面尚未导航，应以公开历史的 inProgress 回合及真实准备脚本为准；已修正这一前置断言，再重跑全部四项。新增主进程退出码/信号记录，主动强退必须为 SIGKILL，正常关闭必须为退出码 0。退出前等齐在途请求的 HTTP 头观测，避免任务命名请求的正常取消被误算为缺回执。

完整检查首轮出现一项既有资料库更新后立即搜索的失败（2967 通过、1 失败、2 既有跳过）；原文件独立复验 8/8（1.66 秒）通过，未修改资料库实现、断言或等待期限，随后重跑正式完整检查。

第三轮首轮与追问回执恢复通过，两条本机队列用例的恢复、暂停、继续与单次追加断言也均通过，但最后的观测完整性检查失败：请求数比 HTTP 回执数多。旧夹具在 `fetch` 抛错时没有记录终态，因此无法从旧证据判定具体网络错误。已补充按网关 PID/序号配对的脱敏传输异常观测，仍要求每个请求恰有一个终态、返回的 HTTP 状态均为 200；不把缺失记录当成功，也未放宽恢复行为断言。

## 执行命令

从隐藏 stdin 安全注入 `EVOWORK_UI_MODEL_KEY` 后运行：

```bash
EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash caffeinate -i node node_modules/@playwright/test/cli.js test queue-steer-restart.real.spec.mjs --project=real --retries=0
caffeinate -i pnpm run check
```

## 最终结果与证据

最终真实 Electron + 发货内核 + MiMo **4/4 通过（3.0 分钟，零重试、零跳过）**，含 3 次 SIGKILL 与 1 次正常退出的整进程重启，8 次内核启动。每项均核对两个 Electron PID 和两个内核 PID 不同；主进程退出记录仅有预期的 SIGKILL 与退出码 0，**最终轮次意外退出 0**。四项重启后的 5 秒观察均无新投递 RPC 或模型请求；三个队列场景明确继续后仅一个新回合、一次用户追问及一行 `:42` 文件追加。恢复与执行截图已查看。

最终 **20 次上游请求 / 20 个 HTTP 200**，全部为 `mimo-v2.6-flash` 和指定端点；每个请求按网关 PID/序号配到唯一终态，最终轮次传输异常 0。此前观测缺口的具体异常类型不能追溯，保留原失败日志；新增三项观测回归验证成功请求配对、原样抛出传输错误且不私自重试，以及凭据/正文/任意错误字段均不落盘。

最终在实模型测试结束后独占运行原版 `pnpm run check`，**退出 0，2971 项通过、2 项既有跳过**，183 个测试文件通过、1 个既有文件跳过。格式、lint、类型、补丁预算、52 项出站协议形状与许可检查通过。并行负载下资料库用例出现过第二次同样失败，中间一轮全仓 2968 项通过；最终独占完整检查与观测回归均通过，未修改资料库实现或断言。这是既有时序波动记录，不将其宣称为本轮已修复的产品缺陷。

本轮新增四项实模型 Playwright 与三项观测回归，修正测试前置断言、补齐脱敏观测，没有更改业务投递、恢复逻辑或内核。最终验收证据及新增源码共 **53 个文件凭据精确扫描 0 命中**。

- [模型、进程身份、退出信号及逐项结果汇总](assets/2026-10-18-follow-up-restart-mimo/summary.json)
- [最终实模型 Playwright 日志](assets/2026-10-18-follow-up-restart-mimo/electron-final.txt)、[最终完整检查日志](assets/2026-10-18-follow-up-restart-mimo/full-check.txt)
- [首轮原身份确认后的截图](assets/2026-10-18-follow-up-restart-mimo/first-receipt/accepted-first-reconciled.png)、[已接受追问恢复后保持暂停](assets/2026-10-18-follow-up-restart-mimo/followup-receipt/accepted-followup-paused.png)
- [正常退出后的本机暂停队列](assets/2026-10-18-follow-up-restart-mimo/local-graceful/stopped-local-paused.png)、[强退后明确继续的真实结果](assets/2026-10-18-follow-up-restart-mimo/local-forced/continued-once.png)
- [用户报告的启动崩溃脱敏摘要](assets/2026-10-18-follow-up-restart-mimo/startup-crash-summary.json)、[受限启动失败](assets/2026-10-18-follow-up-restart-mimo/restricted-launch-failed.txt)、[模型标签断言失败](assets/2026-10-18-follow-up-restart-mimo/model-label-failed.txt)、[首轮页面前置断言失败](assets/2026-10-18-follow-up-restart-mimo/first-pending-ui-failed.txt)、[观测终态缺口失败](assets/2026-10-18-follow-up-restart-mimo/observer-incomplete-failed.txt)
- [首次完整检查失败](assets/2026-10-18-follow-up-restart-mimo/check-initial-failed.txt)、[资料库单独复验](assets/2026-10-18-follow-up-restart-mimo/library-recheck.txt)、[并行检查再次失败](assets/2026-10-18-follow-up-restart-mimo/check-concurrent-failed.txt)

四个场景同目录的 `final-evidence.json`、`process-lifecycle.json` 保存公开历史、投递计数、上游时间、结果文件、IPC 恢复信息及真实进程退出记录。

## 范围

仅 macOS arm64 和指定模型、本机权威数据保留时的四条旅程；不代表所有厂商、平台或任意工具副作用恰好一次。5 秒的禁止自动执行窗口还结合暂停状态、投递 RPC、公开历史及之后的明确继续行为核对。测试不直接读取或修改内核内部数据库，不修改内核或发布安装包。确定性故障矩阵及权威存储实现见[重启恢复验收](2026-10-18-follow-up-restart.md)。
