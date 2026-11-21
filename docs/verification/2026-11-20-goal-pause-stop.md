# 2026-11-20 · 用户暂停目标停止在途执行（#25）

修复 [issue #25](https://github.com/jarod-w/evowork/issues/25)：用户暂停目标后，当前回合和后台命令仍可继续推进到第二阶段。

## 根因与改动

内核 `thread/goal/set(status=paused)` 只修改目标与后续续跑条件，不提交回合中断。现场核对 `../codex/codex-rs/ext/goal/src/api.rs:188` 起的目标状态写入流程，以及 `../codex/codex-rs/ext/goal/src/runtime.rs:164` 的 `prepare_external_goal_mutation`：该准备步骤处理目标计量，不是回合停止。宿主此前把用户暂停直接映射到这条状态更新。

- 新增适配层语义动作 `pauseGoal`，用户 `/goal pause` 和面板暂停统一调用：先持久化 paused，再调用官方 `turn/interrupt`，枚举/终止/复查后台命令并暂停待发队列；全部确认后返回成功。
- 与 #24 的预算停止共用串行清理。恢复和新回合等待旧清理；暂停意图拦截迟到回合；停止后校正与在途目标更新竞争的状态，校正也包含在恢复等待内。停止失败向用户报错，不伪造回合终态。
- 内部创建/替换目标仍使用 `setGoal` 暂存 paused，不误停首轮；清除目标仍只停止目标续跑。
- 原真实模型用例让模型转写包含 Python 字符串换行、shell 引号和 JS 转义的长命令。改为由夹具在新临时项目中准备合成脚本，模型只执行脚本路径；检查点以二进制写入固定十六进制字节，确保只有一行 LF。暂停前明确断言第二阶段文件不存在且 Composer running；暂停后检查权威回合终态、刷新/内核重启无新增回合，恢复后再核验精确文件内容。

## 验证

- 修复前构建的真实 Electron 用例先红：目标已暂停，Composer 在 20 秒断言窗口内始终 running。原用例由夹具手动放行模型，掩盖了产品没有中断的事实；本次移除放行动作：[失败日志](assets/2026-11-20-goal-pause-stop/red.txt)、[窗口上下文](assets/2026-11-20-goal-pause-stop/red-window-context.txt)。
- 定向适配层与宿主测试 **304/304**（适配 144、宿主桥 160），新增六项覆盖用户暂停、内部目标准备、空闲清理、停止失败、恢复等待/迟到回合，以及入口接线：[单元日志](assets/2026-11-20-goal-pause-stop/unit.txt)。
- 完整构建退出 0：[构建日志](assets/2026-11-20-goal-pause-stop/build.txt)。完整 `pnpm run check` 退出 0：**3627 项通过 / 6 项既有跳过**，格式、lint、全部类型、内核补丁预算、54 请求协议与许可证检查均通过：[完整仓检](assets/2026-11-20-goal-pause-stop/check.txt)。修改前基线同样退出 0（3621 通过 / 6 项既有跳过）。
- 真 Electron + 发货内核 + 本机确定性网关，单 worker、零重试：**6/6，30.3 秒**。新增用例在命令写入 `saved-once` 加 LF 后从面板暂停；命令本应在八秒后写第二阶段文件，等待九秒确认没有落盘。刷新、内核重启后仍 paused 且无新增回合；恢复后完成，检查点保持单行，结果严格为 `resumed-done` 加 LF：[窗口日志](assets/2026-11-20-goal-pause-stop/playwright-fake.txt)、[暂停历史](assets/2026-11-20-goal-pause-stop/fake-paused-history.json)、[暂停截图](assets/2026-11-20-goal-pause-stop/fake-paused-window.png)、[恢复完成历史](assets/2026-11-20-goal-pause-stop/fake-complete-history.json)。同套件保留 #24 的预算停止回归。
- 指定 `mimo-v2.6-flash` / `https://api.xiaomimimo.com/v1`，单 worker、零重试：**2/2，1.3 分钟**。暂停旅程 43.7 秒：暂停快照是 paused + 唯一 interrupted 回合；刷新/内核重启保持暂停且无第二阶段文件；显式 resume 后完成，最终历史为 interrupted + completed，检查点仍严格为单行 `saved-once` 加 LF，结果严格为 `resumed-done` 加 LF。预算回归 33.2 秒同样通过：[模型窗口日志](assets/2026-11-20-goal-pause-stop/playwright-mimo.txt)、[暂停历史](assets/2026-11-20-goal-pause-stop/mimo-paused-history.json)、[暂停截图](assets/2026-11-20-goal-pause-stop/mimo-paused-window.png)、[恢复历史](assets/2026-11-20-goal-pause-stop/mimo-complete-history.json)、[恢复截图](assets/2026-11-20-goal-pause-stop/mimo-complete-window.png)、[预算回归历史](assets/2026-11-20-goal-pause-stop/mimo-budget-history.json)。暂停与恢复截图均已查看。

## 边界

用户暂停请求生效前已经发生的文件改动不会回滚。模型必须按正常审批与工具链路执行，修改夹具的命令表达不是绕过产品停止控制；确定性用例主动让命令继续第二阶段，验证宿主确实将其停止。

本轮使用全新临时 home/workspace，真实模型只能接触合成需求、随包指令与测试文件/工具结果；凭据经隐藏 stdin 注入环境，并从内核环境移除，不写入代码、配置或证据。只验 macOS arm64；正常内核退出/自动重启已覆盖，强杀整个应用、断电及其它平台未验。未升级版本、替换安装或发布。
