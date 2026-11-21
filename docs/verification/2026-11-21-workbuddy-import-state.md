# 2026-11-21 · WorkBuddy 导入终态与诊断（#26）

修复 [issue #26](https://github.com/jarod-w/evowork/issues/26)：文本导入结束后历史只显示 `unknown`，无法区分是否保存与失败原因。

## 问题与改动

原逻辑只在“匹配可信 PostToolUse 回执且最终模型回合 completed”同时成立时返回 `saved`；回执只留在内存中，其他情况全部记成没有原因的 `unknown`。因此保存后的最终回复失败、超时或应用退出都可能丢失已经取得的保存证据。

- 匹配的可信回执到达即持久化 `saved`；最后的回复、断线和超时不再覆盖已确认的原生保存。
- 没有可信回执而回合已经终止时记为 `failed`，区分回合失败、中断、缺少回执和文件名/正文回执不匹配。创建会话失败也有明确失败原因。
- 无法确定是否仍在执行的超时、断线和请求响应不明仍为 `unknown`，保留固定诊断原因；重开应用发现 `pending` 时持久化 `app_restarted`。结果和历史均显示原因，旧未知记录仍保守展示。
- 所有已登记结果继续参与去重，可能仍在执行的超时写入继续阻止后续写操作；不自动重试或重启内核，不保存模型错误原文，不读取原生记忆文件来伪造成功。
- 实模型用例在原有凭据扫描保护下补充公开 `turn/completed` 的状态和错误，避免下次只留下 `unknown` 而没有回合诊断。

## 验证

修复前的指定 MiMo 原始窗口用例已在 `state === saved` 断言处复现 `unknown`；该现场没有原生 note，不能据此宣称只是成功记录误判：[原始失败](assets/2026-11-21-workbuddy-import-state/mimo-original-red.txt)、[现场](assets/2026-11-21-workbuddy-import-state/mimo-original-red.json)。随后独立诊断运行的三份导入均获得回执，完整旅程 1/1（8.3 分钟）通过，说明失败并非每次发生：[基线通过日志](assets/2026-11-21-workbuddy-import-state/mimo-baseline-passed.txt)、[基线证据](assets/2026-11-21-workbuddy-import-state/mimo-baseline-passed.json)。

- 单元回归先红（9 项失败），确定性覆盖了可信保存被最终回合失败否决及失败结果缺少原因的问题；最终定向 **25/25**，包含可信回执早于最终回复落盘、回复失败、超时仍保留保存且隔离未停止回合、断线、启动失败、重开应用、旧记录及去重：[先红日志](assets/2026-11-21-workbuddy-import-state/unit-red.txt)、[定向日志](assets/2026-11-21-workbuddy-import-state/unit.txt)。
- 完整构建退出 0：[构建日志](assets/2026-11-21-workbuddy-import-state/build.txt)。最终完整 `pnpm run check` 退出 0，**3635 项通过 / 6 项既有跳过**，格式、lint、全部类型、补丁预算、54 请求协议与许可证检查均通过：[完整检查](assets/2026-11-21-workbuddy-import-state/check.txt)。
- 修复后真 Electron + 发货内核 + 本机确定性网关 **8/8（17.1 秒，单 worker、零重试）**。包括保存后故意让最终回复失败，仍显示已保存，刷新与重复提交不重放；模型只声称成功则显示 `failed / receipt_missing`，模型请求失败显示 `failed / turn_failed`；主动中断内核则明确显示连接断开与未确认，并保留去重。还覆盖个人/项目保存、取消、原生后台整理及 503 重试、新任务使用和禁读：[窗口日志](assets/2026-11-21-workbuddy-import-state/playwright-fake.txt)、[保存后回复失败截图](assets/2026-11-21-workbuddy-import-state/workbuddy-saved-after-failure.png)、[480px 失败说明](assets/2026-11-21-workbuddy-import-state/workbuddy-failed-480.png)。两张截图已查看，无裁切及横向溢出。
- 修复后的第一次独立 MiMo 复验仍未取得保存回执，原生 note 不存在，但不再停在无原因的 `unknown`：结果为 **`failed / receipt_missing`**，公开回合为 completed；因此保留为实际失败，不记成保存成功：[失败日志](assets/2026-11-21-workbuddy-import-state/mimo-missing-receipt.txt)、[失败证据](assets/2026-11-21-workbuddy-import-state/mimo-missing-receipt.json)。随后增加公开最终回复与工具元数据观测，继续核验同一旅程。
- 最终 `mimo-v2.6-flash` / `https://api.xiaomimimo.com/v1` 完整原始旅程 **1/1（7.3 分钟，单 worker、零重试/零跳过）**。个人/Alpha/Beta 三份原文、scope 与可信回执均核对为 `saved`；原生后台整理为 done；七个后续场景全部 completed，覆盖两个项目实际使用、未导入项目、任务禁读、全局禁读和显式跨项目请求。32 次请求均为指定模型、响应均为 HTTP 200，内核一次启动、零退出、零重启：[完整日志](assets/2026-11-21-workbuddy-import-state/playwright-mimo.txt)、[完整证据](assets/2026-11-21-workbuddy-import-state/mimo-evidence.json)、[仅工具元数据](assets/2026-11-21-workbuddy-import-state/mimo-tool-metadata.jsonl)、[生命周期](assets/2026-11-21-workbuddy-import-state/mimo-lifecycle.json)。未改原生作业时间、预置摘要或自动重放失败批次；每次实模型运行均为新的隔离测试目录。前一次无回执失败仍说明模型导入可能失败，不能把单轮通过写成每次都能保存。

## 环境与边界

使用现有 pnpm 10.30.3、工具运行时 Node 和仓库随包 Python 办公运行时，不重新安装依赖。第一次仓检误用系统 Python，办公依赖缺失导致 83 项失败；改用既有完整运行时后重新检查。开始时两次模型变量名写错，夹具回到默认 DeepSeek，携带了现有测试密钥，均失败，不计入 MiMo 验证；随后使用正确的 `EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash`，逐份证据核对实际模型及请求。真实模型只接触隔离临时目录中的合成文本和正常测试上下文；使用既有本机测试凭据，凭据不写入代码或证据。

最终对全部修改及新增的 30 个源码/文档/证据文件执行现有测试密钥的精确字节扫描：零命中、零读取错误；同时核对最终上游 32 个响应均为 HTTP 200：[扫描记录](assets/2026-11-21-workbuddy-import-state/credential-scan.json)。

保存成功仍不等于原生后台整理就绪；项目标签不构成严格项目 ACL。旧的未知批次没有新增证据时不能事后改为成功。仅 macOS arm64；未升级版本、替换安装或发布。
