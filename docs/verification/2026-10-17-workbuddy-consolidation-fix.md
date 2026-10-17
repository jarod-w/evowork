# 2026-10-17 · WorkBuddy 后台整理故障修复

此记录接续 [首次实模型失败验收](2026-10-17-workbuddy-memory-import.md)，不改写之前的失败结论。用户要求继续定位 failed_agent、done 后漏纳入，并使用指定 MiMo 验证新任务、禁读、项目归属和内核稳定性。

## 根因与修复

1. **failed_agent 是上游 503 后的代理终止，不是内核进程退出。** 保留现场的原生只读日志显示末尾 `Turn error` 含 503 / ServiceUnavailableError；此前虽有 unsupported update_plan，代理仍继续调用 exec，真正终态发生在服务错误后。旧真实模型夹具写死 `stream_max_retries=0`，产品模板为 2，放大了瞬时故障。真实模型夹具现在直接读取产品模板重试预算；确定性故障测试可显式用 2，其他界面失败用例仍默认 0。Playwright 层保持零重试。
2. **首轮 Git 基线吞掉了现存 note 的输入差异。** `prepare_memory_workspace` 调用 git-utils ensure，原实现对缺失/损坏基线执行当前树快照，导入先写入的 note 被当成已处理来源，后续 diff 不含这些文件。模型又使用 maxdepth 3 清单（notes 文件在深度 4），误认为没有 note 并生成空但格式有效的摘要。原生 done 仅验证必需文件/格式，不能证明事实完整。
3. **P7** 将首次/损坏恢复 ensure 的基线改为空树，现存输入作为 added 进入原生 diff；重复 ensure 保留基线，成功整理后的 reset 仍快照当前树。唯一生产调用方是记忆工作区。补丁与原因见 [P7](../../patches/evowork/0002-memory-initial-baseline.md)，由官方构建脚本应用于导出副本；上游签出只读。加既有 P6 总计 4 文件、208 行（上限 5/500）。
4. **网关错误规范化**：HTTP 200 流内的字符串/数字 HTTP 错误码按状态语义映射；503 可重试、401 永久失败，非 HTTP 厂商码如 1113 保持原映射。HTTP 非 2xx 却返回 SSE 信封时提取 error 对象，不把整段 data 包装当作错误文案。无请求/响应正文或密钥日志。

## 先红后绿与测试要求

新增原生回归在旧逻辑上因“现存 note 未出现在 added diff”失败；修复后 git-utils baseline 单测 **8/8**，整个 Git 工具库 **46/46**。错误映射新增回归原先 3 项失败，修复后 providers/pipeline 合计 **39 项通过**，含 HTTP 200 与 HTTP 503 两种 SSE 错误信封。

确定性 WorkBuddy 整理夹具改为从真实 `phase2_workspace_diff.md` 读取并断言 note 来源及标记，不能绕过错误 diff 直接读 notes 来冒充输入正确。另新增一次后台 503 → 同一作业重试成功用例，要求新任务收到记忆、同一内核一启动零退出。真实用例要求所有导入 scope/原文匹配、原生作业完成、正文保留所有标记、模型实际收到含三组来源的 diff、七个独立新任务、两种禁读及显式跨项目请求；生命周期任何退出都使其失败。

本轮 WorkBuddy 和 MiMo 用例不植入摘要、不修改原生作业/线程时间、不重启内核加速、不重新发送结果未知的导入。此次修复不会强制重做已成功标记但错误的历史摘要，也不绕过六小时冷却；尚无严格项目 ACL 或按项目遗忘。

- [旧失败现场的只读结构化诊断](assets/2026-10-17-workbuddy-consolidation-fix/retained-forensics.json)
- [原生回归先红](assets/2026-10-17-workbuddy-consolidation-fix/native-baseline-red.log.txt)及[修复后 8/8](assets/2026-10-17-workbuddy-consolidation-fix/native-baseline-green.log.txt)
- [Git 工具库完整 46/46](assets/2026-10-17-workbuddy-consolidation-fix/native-git-utils-all.log.txt)

## 发货构建与真实模型结果

官方构建脚本在导出副本上应用 P6/P7，发布构建退出 0，耗时 75 分钟；这台 8GB 机器在并行重型编译时出现明显换页，后改为两个重型库分时完成，并把后续验收串行执行。没有操作用户正在运行的应用内核。二进制来源校验通过：上游 `d583e73c4d1204f1e9f654ef87065e9f0dd07ac7`，SHA-256 `b6282c153346fbf4d8f37a595a259d3015c6a31b9c14e452c28c1e2975f561d7`。[构建日志](assets/2026-10-17-workbuddy-consolidation-fix/kernel-build.log.txt)及[来源清单](assets/2026-10-17-workbuddy-consolidation-fix/kernel-provenance.json)。

真实 Electron + 发货内核的 WorkBuddy 确定性窗口回归 **6/6（21.7 秒）**，含新增“后台 503 → 同作业恢复成功”，原生作业最终 done、last_error=null、retry_remaining=3。6 份生命周期共 7 次启动、1 次明确终止测试内核的故障注入、**意外退出 0**。[日志](assets/2026-10-17-workbuddy-consolidation-fix/fake-playwright.log.txt)及[生命周期](assets/2026-10-17-workbuddy-consolidation-fix/fake-lifecycle.json)。

Claude 导入、自动同步、引用、整理状态、整 App 重开及未知写入恢复等既有窗口回归 **19/19（4.6 分钟）**。合计 **25/25** 确定性用例、零重试/零跳过，25 份生命周期共 31 次启动，4 次明确的内核故障注入退出，**意外退出 0**；整 App 重开另按既有用例验证，不能混作意外内核重启。[回归日志](assets/2026-10-17-workbuddy-consolidation-fix/regression-playwright.log.txt)及[完整生命周期](assets/2026-10-17-workbuddy-consolidation-fix/all-fake-lifecycle.json)。

用户指定 MiMo 经产品网关、真实 Electron 和修复版发货内核，完整 Playwright **1/1（7.9 分钟，零重试、零跳过）**。28 次请求全部路由到 `xiaomi/mimo-v2.6-flash`，其中 9 次后台整理请求。三次导入都有精确正文和 scope 回执，原生 diff 的单个工具结果确实包含三组来源，整理正文保留三组随机标记。作业 done、last_error=null、retry_remaining=3；本轮未出现 503 终态错误。有一次 unsupported update_plan 后继续完成整理，进一步排除它是此前 failed_agent 的直接终因。

| 新任务 | 实际结果 |
| --- | --- |
| TRIGGER | READY，普通新任务自然触发整理 |
| ALPHA_ON | 个人标记 + Alpha 独有前缀、YYYY/MM/DD、紫色风险；无 Beta 约定 |
| BETA_ON | 个人标记 + Beta 独有前缀、DD-MM-YYYY、橙色风险；无 Alpha 约定 |
| GAMMA_ON | 个人标记可用，项目字段 UNKNOWN，不借用 Alpha/Beta |
| TASK_OFF | 四字段 UNKNOWN，全部请求无记忆上下文及三组来源标记；工具证据不含原生记忆路径 |
| GLOBAL_OFF | 四字段 UNKNOWN，与单任务禁读相同的无注入/无原生记忆读取断言通过 |
| CROSS_SCOPE | Alpha 中请求 Beta 约定，三项 UNKNOWN，不复述 Beta 事实 |

七个任务实际 cwd 均与对应项目目录一致。整轮 **一次启动、零退出、零意外重启**，没有故障注入或重开；任何运行中退出即使恢复也会判失败。[完整证据](assets/2026-10-17-workbuddy-consolidation-fix/real-evidence.json)、[生命周期](assets/2026-10-17-workbuddy-consolidation-fix/real-lifecycle.json)及[日志](assets/2026-10-17-workbuddy-consolidation-fix/real-playwright.log.txt)。人工核对了 [Alpha](assets/2026-10-17-workbuddy-consolidation-fix/workbuddy-alpha_on.png)、[Gamma](assets/2026-10-17-workbuddy-consolidation-fix/workbuddy-gamma_on.png)、[全局禁读](assets/2026-10-17-workbuddy-consolidation-fix/workbuddy-global_off.png)和[跨项目请求](assets/2026-10-17-workbuddy-consolidation-fix/workbuddy-cross_scope.png)截图。

**范围限制仍成立**：Alpha/Beta/Gamma 的读取上下文仍能看到同时含两个项目事实的共享摘要，本轮“不误用”依赖模型遵守 scope，不是严格 ACL。禁读关闭产品的记忆注入/检索，不等于阻断模型对任意文件的访问。只验本机 macOS arm64 和单一真实模型，没有发布安装包。

## 最终全量检查和凭据扫描

完整桌面/网关构建退出 0；最终原版 `pnpm run check` 退出 0，**2917 项通过、2 项既有跳过，182 个测试文件通过、1 个既有文件跳过**，格式、lint、类型、K1/K2 和许可清单均通过。[完整检查日志](assets/2026-10-17-workbuddy-consolidation-fix/full-check.log.txt)。

此前与重型原生编译同时运行的一轮全量检查有两项既有界面测试超过原有 5 秒限制（2915 通过、2 失败）；没有放宽阈值或改这两项测试。编译及窗口旅程结束后，按原配置串行重跑全部通过。[保留的超时现场](assets/2026-10-17-workbuddy-consolidation-fix/check-during-build-timeouts.log.txt)。首次类型检查还指出新增测试的强制类型转换不成立，已改为结构断言，最终类型及单测均通过。

密钥只通过隐藏 stdin/测试进程环境使用，没有写进配置或源码。对本轮修改、日志及产物进行用户提供密钥的精确扫描：**140 个文件、6,177,742 字节、0 命中**；真实测试成功后按既有夹具清理隔离 HOME，留存结构化证据及截图。[扫描报告](assets/2026-10-17-workbuddy-consolidation-fix/credential-scan.json)及[机器可读汇总](assets/2026-10-17-workbuddy-consolidation-fix/summary.json)。

## 复现命令

```sh
# 发货内核（上游签出只读；8GB 机器建议限制同时编译的 crate）
CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=1 node scripts/build-kernel.mjs
node node_modules/@playwright/test/cli.js test workbuddy-memory.spec.mjs --project=fake --retries=0
# 密钥只经隐藏 stdin 进入启动器，再通过 EVOWORK_UI_MODEL_KEY 传给子进程
EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash node node_modules/@playwright/test/cli.js test workbuddy-memory.real.spec.mjs --project=real --retries=0
node node_modules/@playwright/test/cli.js test memories.spec.mjs memory-import.spec.mjs memory-import-restart.spec.mjs --project=fake --retries=0
pnpm run check
```
