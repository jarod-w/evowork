# `/goal` Playwright 验收（2026-10-07）

模型为用户指定的 `mimo-v2.6-flash`，地址 `https://api.xiaomimimo.com/v1`。沿现有模型预设与自定义模型登记接入，真实模型经宿主本机网关转换 Responses / Chat 协议，再由发货内核执行；Playwright 操作真实 Electron DOM。密钥只从隐藏 stdin 进入进程环境，不写代码、配置或测试日志。

## 用例

`apps/desktop/test/e2e/ui/goal.spec.mjs` 共四例（保留原生命周期例，新增三例），采用真实窗口/内核与可控模型网关：

1. 输入创建目标、运行中暂停、查看面板、恢复、模型完成工具与清除。
2. 未创建目标时查看和控制显示提示，不创建任务。
3. 未完成目标替换先确认，取消保留原目标及草稿；确认后执行新目标，原预算不沿用，历史只增加一次需求。
4. 预算 0 / 负数 / 小数不能保存；极小预算耗尽后原生状态为 `budgetLimited`，刷新后无新增回合；追加预算恢复并完成，最后清除目标。

`apps/desktop/test/e2e/ui/goal.real.spec.mjs` 新增三例，采用真实 MiMo：

1. 首轮只输出阶段说明并结束，系统自动开下一回合；写入动态标记文件、读取核验并由模型完成目标。权威历史至少两条已完成回合，只有一次用户需求；无预算目标仍有 token 计量，刷新保留并可清除，清除不删除交付文件。
2. 第一阶段写检查点后等待，期间用 `/goal pause` 暂停；当前回合可以自然结束，但第二阶段不能执行。renderer 刷新和强制内核重启后目标仍为暂停；`/goal resume` 后检查进度、交付剩余文件并完成，检查点内容不能重复。
3. 通过目标面板设置 1 token 预算；耗尽后回合停止，显示 `budgetLimited` 和实际用量，刷新保留；提供追加预算动作及结束任务，结束后目标为 complete。

共享 `goal-journey.mjs` 只经公开 IPC 读取目标和历史。真实用例把模型元数据、权威目标、任务、回合/条目保存为 `goal-<status>-history.json`，同时保存 `goal-<status>-window.png`；失败诊断最多等待十秒，保留原始断言错误。不读内核持久化文件，不由测试程序代写交付文件或强制模型完成。

## 执行与边界

完整构建已通过。最终确定性套件 **4/4 通过，29.3 秒**，日志 `/private/tmp/evowork-goal-fake-final.log`，窗口输出 `/private/tmp/evowork-goal-fake-final-results`。首次 MiMo 复跑 **3/3 通过，2.3 分钟**，日志 `/private/tmp/evowork-goal-real-green.log`；补充证据文件保存后最终 MiMo 套件 **3/3 通过，1.9 分钟**，日志 `/private/tmp/evowork-goal-real-final.log`，权威历史与截图在 `/private/tmp/evowork-goal-real-final-results`。两轮均关闭 Playwright 重试，没有更换模型。

最终 `pnpm run check` 退出 0：**2716 项通过，2 项原有跳过**；169 个测试文件通过，1 个原有文件跳过。格式、lint、类型检查、内核补丁预算、协议契约和许可清单均通过，日志 `/private/tmp/evowork-goal-check-final.log`；完整构建日志 `/private/tmp/evowork-goal-build.log`。

| 最终真实用例 | 原生回合 | 用户需求次数 | 最终目标状态 | 目标计量 token |
| --- | --- | --- | --- | --- |
| 自动续跑与文件核验 | 2，均 completed | 1 | complete | 7874，无预算 |
| 暂停/刷新/内核重启/恢复 | 2，均 completed | 1 | complete | 8986，无预算 |
| 预算耗尽/结束 | 1，completed | 1 | budgetLimited 后由用户结束为 complete | 5599，预算 1 |

上述数字来自 `goal-<status>-history.json` 的公开 IPC 快照，不是厂商账单；预算例先保存 budgetLimited 快照，结束后再保存 complete 快照。

首次确定性预算例以“从创建起总共一轮”断言失败；核对原生实现后，创建首轮启动时目标仍是 paused，随后才激活。无工具的首轮可能不计入目标，下一轮才耗尽预算。最终断言改为耗尽后回合 ID 集合保持不变，保留预算耗尽事实，不把错误轮数假设写成契约。预算在内核工具/回合边界计量，不承诺精确停在第 N 个 token，也不承诺首轮预付费拦截。

首次 MiMo 套件 **1 通过 / 2 超时**；同一时间完整检查出现四个既有测试超时及两个 worker 超时。`pmset` 证实 09:29:44 空闲睡眠约 593 秒，09:39:45 又睡眠约 373 秒，模型连接因此中断。默认 `caffeinate -i` 当时未阻止睡眠，复跑进程显式使用 `caffeinate -dimsu` 并核对电源断言；没有修改产品超时、模型或关闭失败用例。

这是 macOS arm64 的短目标样本，不能代表长期任务质量、稳定率、实际费用或其它平台。没有修改上游内核、生产网关或产品行为。renderer 刷新与内核重启已纳入；整 App 退出重开、usageLimited / blocked 的 UI、子任务目标禁用未在本轮新增窗口用例中覆盖。

截图复核另发现一个展示问题：目标描述很长时，目标条右侧“已完成”被挤成竖排。功能断言通过不代表布局无缺陷；本轮记录该问题，未改产品样式。

## 复跑

```bash
pnpm run build
caffeinate -dimsu -t 600 pnpm exec playwright test goal.spec.mjs --project=fake --retries=0
read -rs EVOWORK_UI_MODEL_KEY
export EVOWORK_UI_MODEL_KEY
EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash caffeinate -dimsu -t 900 pnpm exec playwright test goal.real.spec.mjs --project=real --retries=0
unset EVOWORK_UI_MODEL_KEY
caffeinate -dimsu -t 900 pnpm run check
```

其它平台移除 macOS 专用的 `caffeinate` 前缀。测试报告与现场位于本机临时目录，不提交到仓库；密钥缺失或发货内核缺失明确失败，不跳过。
