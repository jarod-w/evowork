# 2026-11-20 · 目标预算耗尽停止执行（#24）

修复 [issue #24](https://github.com/jarod-w/evowork/issues/24)：目标已为 `budgetLimited` 时，Composer 仍 running，内核历史仍有 inProgress 回合。

## 根因与改动

当场核对上游 `../codex/codex-rs/ext/goal/src/extension.rs:496` / `:500` / `:528`：工具完成后的计量使用 `BudgetLimitedGoalDisposition::KeepActive`，达到预算后只调用 `inject_active_turn_steering`。模型可能继续执行工具；原宿主的 `budget-check` 副作用也没有停止实现。

`services/kernel-adapter/src/adapter.ts` 现在在权威目标通知上暂停队列、带准确 turnId 调用官方 `turn/interrupt`，再枚举/终止/复查后台命令。按回合去重；覆盖预算通知先于回合开始、回合先结束的通知竞态；同任务的停止操作串行执行，恢复目标或新回合启动等待全部旧清理结束；停止失败发送可见提示。没有按累计 token 另算预算，没有伪造回合终态，也没有修改只读内核。用户主动暂停/清除目标仍仅停止目标续跑。

## 验证

- 新增单元在旧实现 **2 失败 / 5 通过**：[先红证据](assets/2026-11-20-goal-budget-stop/red.txt)。最终适配测试 **139/139**，含新增十项预算停止、其他目标状态、重复通知、队列暂停、后台命令、失败提示与恢复竞态：[适配日志](assets/2026-11-20-goal-budget-stop/adapter.txt)。
- 完整构建退出 0：[构建日志](assets/2026-11-20-goal-budget-stop/build.txt)。
- 真 Electron + 发货内核 + 本机确定性网关，单 worker、零重试：**5/5，18.4 秒**。新增用例启动本机 Python 命令，命令先写 started、等待八秒后本应写 leaked；工具回传用量后耗尽预算、回合 interrupted、Composer idle，等待九秒仍无 leaked，刷新后回合列表不变：[窗口日志](assets/2026-11-20-goal-budget-stop/playwright-fake.txt)。
- 用户指定的 MiMo 模型与端点，单 worker、零重试：**1/1，13.8 秒**。沿用原 `goal.real.spec.mjs` 极小预算需求，新增权威回合全为终态、两秒后无新增回合断言。实测 `tokenBudget=1`、`tokensUsed=14726`、唯一回合 `interrupted`，刷新保留耗尽状态，结束目标后为 complete：[窗口日志](assets/2026-11-20-goal-budget-stop/playwright-mimo.txt)、[耗尽历史](assets/2026-11-20-goal-budget-stop/goal-budgetLimited-history.json)、[耗尽截图](assets/2026-11-20-goal-budget-stop/goal-budgetLimited-window.png)、[结束历史](assets/2026-11-20-goal-budget-stop/goal-complete-history.json)。截图已查看，输入区无停止按钮。
- 完整 `pnpm run check` 退出 0：格式、lint、全部类型、**3621 项通过 / 6 项既有跳过**、内核补丁预算、54 请求协议形状及许可证清单全部通过：[完整检查](assets/2026-11-20-goal-budget-stop/check.txt)。

## 过程与边界

新增确定性窗口夹具首轮选错工作目录，并误把 Electron evaluate 的首个参数当作业务参数，导致测试命令未启动。修正临时项目选择、参数签名和工具请求匹配后完整 5/5；[失败现场日志](assets/2026-11-20-goal-budget-stop/fake-fixture-failure.txt) 保留，不与最终通过拼接。一次并行窗口启动被主动取消，最终确定性与真实模型结果分别来自完整单 worker 运行。

首次默认 pnpm 触发了不需要的依赖检查，随后使用现有锁定 pnpm 10.30.3；签名 App 自带 Node 不能加载本机原生模块，改用现有工具运行时 Node。沙箱内回环测试报 EPERM、Swift 编译缓存不可写，沙箱外重跑构建与仓检。没有重新安装依赖或修改依赖锁文件。

MiMo 首次自动审批因外部数据范围不明确而拒绝。核对测试创建的全新临时 home/workspace、内核 HOME 隔离与密钥移除、合成 sleep(20) 需求及随包指令后，补充相同调用的数据范围证据，审批放行。密钥仅经隐藏输入进入进程环境，没有写入代码、证据或测试配置。

只验证 macOS arm64。计量仍在内核工具/回合边界发生，可能超过预算，不承诺精确第 N 个 token 截断。本次真实模型只覆盖原预算耗尽用例，不代表全部 goal 真实模型旅程或长期稳定性。未升级版本、替换安装或发布。
