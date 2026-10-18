# 发送回执与本机队列重启恢复验收（2026-10-18）

## 实现与范围

真实 Electron 主进程退出或被 SIGKILL 后，用同一个本机数据目录再次启动；Electron PID、内核 PID 都必须变化。界面操作、preload、IPC、宿主权威数据库与发货内核均走实际链路，使用确定性模型网关控制在途窗口及故障，不直接读取或修改内核内部存储。

权威迁移 v6 新增四张表：`follow_up_receipt` 保存提交指纹、路由及接受/未知结果；`follow_up_queue` 保存待发输入、引用、顺序与独立派发身份；`follow_up_control` 保存暂停意图；`follow_up_composer` 保存未获界面确认的草稿恢复信息。迁移前备份，失败回滚并拒绝启动；投影重建不删除这些表。待发或待确认内容仅留在本机，执行确认或界面确认后清理，不新增出网路径。

- RPC 写入前先落发送意图。已接受的回执跨进程复用；未确认的意图只按客户端身份核对公开队列/历史，查不到也不盲目重发。
- 停止意图先落库，再中断；原生待发项先复制到本机，再删除原生副本。启动和加载任务前补完接管；中途崩溃按原生 id 去重，接管失败不恢复任务。
- 恢复的本机队列默认暂停，明确点击“继续队列”才启动。出队也有独立持久身份；已接受但回执丢失时核对历史后移除，不再启动第二个回合。
- 主进程在投递前保存待确认草稿/附件与原始提交身份，界面收到结果并确认后才删除。浏览器缓存不充当崩溃恢复真源；恢复读取失败时保持发送暂停，防止换新身份绕过未知结果。

## 七项整进程重启测试

| 场景 | 退出方式 | 验证标准 |
|---|---|---|
| 追问已接受、IPC 回执丢失 | SIGKILL | 原身份和草稿恢复，重试不产生新的投递 RPC；暂停队列仍在，界面确认后清除待确认草稿记录 |
| 首轮已接受、IPC 回执丢失 | SIGKILL | 不创建第二个任务或回合，用户输入仅一条，界面确认后清理待确认记录 |
| 原生队列已接受、写回执与核对读取均故障，停止接管未完成 | SIGKILL | 启动时先接管再加载任务，不自动执行；重试只确认本机副本，明确继续后仅执行一次 |
| 插话未能确认是否到达 | 正常退出 | 草稿、真实附件和原身份恢复，再次发送只核对，未新增投递 RPC |
| 本机队列编辑、调序、删除后意外退出 | SIGKILL | 恢复顺序 B→A，保留编辑内容、C 不复活；不自动执行，明确继续后各执行一次 |
| 本机队列编辑、调序、删除后停止并退出 | 正常退出 | 同上，暂停状态跨进程保留 |
| 本机出队已接受、回执丢失 | SIGKILL | 恢复后先核对派发身份，移除已接受项；真实历史仅两个回合，重启后没有新的投递 RPC |

投递 RPC 包括 thread/start、turn/start、turn/steer、thread/queue/add、thread/queue/start；暂停队列接管期间允许删除已经保存本机副本的原生队列项。

每项保存退出前/恢复后截图、两次进程身份、公开历史、故障计数及宿主状态行数。非自动执行检查包含 2.2 秒观察窗口；明确继续后检查真实历史中的用户消息次数、回合数量及顺序，不能仅靠按钮或返回值判断成功。

## 过程发现与修复

1. 修复前回归复现：重建宿主后同一提交身份再次触发投递。现回执不依赖进程内 Map。
2. 强制退出暴露 Chromium `localStorage` 的物理落盘延迟：同步写入返回后，仍可能丢失发送身份。已将待确认草稿及身份改为主进程权威落盘，加入界面确认清理协议；保留原模型及审批档显示。
3. 接受但丢回执的本机出队项已经被正确核对，界面却仍显示排队。发现原有 `queue-changed` 事件在翻译层被当成无落点事件丢弃；现贯通到渲染层并重新读取队列。
4. 初轮完整窗口合并复验 29/30：原“刷新失败”夹具的一次故障被新事件读取提前消耗。改成同时拒绝事件读取与发送后刷新，原成功/失败文案断言不变。
5. 一轮窗口复验的流式输出用例在 Electron 启动阶段超时，尚未进入页面断言；原测试单独复验 1/1（9.1 秒）通过，未改代码或放宽超时，随后重跑全组。
6. 完整检查曾出现两项既有界面用例及工作进程超时；两项原断言单独复验通过，随后使用防休眠条件串行重跑，未放宽断言或延长测试超时。构建期间的两处错误码数组类型及新测试查询类型错误已修正。

## 执行命令

```bash
node scripts/build.mjs
pnpm --filter @evowork/desktop run build
caffeinate -i pnpm run check
node node_modules/@playwright/test/cli.js test queue-steer-restart.spec.mjs queue-steer-faults.spec.mjs queue-steer.spec.mjs composer.spec.mjs output-stream.spec.mjs --project=fake --retries=0
```

## 最终结果与证据

最终全组真实 Electron 验证 **30/30 通过（1.8 分钟，零重试、零跳过）**：7 项整进程重启、23 项既有交互与故障回归。重启包含 5 次 SIGKILL、2 次正常退出；每项均使用原本机数据目录，并核对 Electron 与内核 PID 变化。全组合计 37 次独立内核启动，其中重启场景 14 次。已接受消息的确认重试没有新增投递 RPC；停止或意外退出后的本机队列保持暂停，明确继续后顺序正确、各执行一次。

完整桌面构建通过；最终串行 `pnpm run check` 退出 0，**2968 项通过、2 项既有跳过**，182 个测试文件通过、1 个既有文件跳过。格式、lint、类型、K1 补丁预算、52 项出站协议形状及第三方许可检查均通过。此后只补充文档与验收证据，未再修改业务代码。

- [结果汇总、进程身份与状态快照索引](assets/2026-10-18-follow-up-restart/summary.json)
- [最终 30 项 Electron 日志](assets/2026-10-18-follow-up-restart/electron-final.txt)、[完整检查日志](assets/2026-10-18-follow-up-restart/full-check.txt)
- [修复前回执重投回归](assets/2026-10-18-follow-up-restart/receipt-before.txt)、[既有界面超时复验](assets/2026-10-18-follow-up-restart/ui-timeouts-recheck.txt)、[Electron 启动超时复验](assets/2026-10-18-follow-up-restart/electron-launch-recheck.txt)
- [已接受追问回执恢复截图](assets/2026-10-18-follow-up-restart/replay-followup/accepted-receipt-restored.png)、[首轮回执恢复截图](assets/2026-10-18-follow-up-restart/replay-first/accepted-receipt-restored.png)
- [原生队列接管后仍暂停](assets/2026-10-18-follow-up-restart/native-unknown/unknown-native-reconciled.png)、[未知插话保留草稿附件](assets/2026-10-18-follow-up-restart/steer-unknown/unknown-steer-no-replay.png)
- [停止重启后的队列顺序](assets/2026-10-18-follow-up-restart/local-stop/local-restored-paused.png)、[意外退出后的队列顺序](assets/2026-10-18-follow-up-restart/local-crash/local-restored-paused.png)、[出队未知结果核对后清理](assets/2026-10-18-follow-up-restart/dispatch-unknown/dispatch-reconciled-after-crash.png)

以上各场景同目录保留退出前截图及相应 JSON（公开历史、故障计数、宿主队列/暂停/待确认草稿/回执行数）；恢复截图已实际查看。此前 MiMo 实模型结果见[上一轮故障验收](2026-10-18-follow-up-delivery-faults.md)，本轮重启结论来自确定性网关，不将历史实模型结果计作本轮新调用。

## 边界

只验 macOS arm64，本轮未调用厂商模型或发布安装包。这里保证同一提交身份在保留本机权威数据的重启中不被盲目重投；SQLite 与内核不共享事务，无法证明接受的请求继续标为未知，优先避免重复，而不是承诺自动补发或工具副作用恰好一次。用户显式修改内容另发属于新提交；删除任务或清空应用数据不属于本机状态恢复范围；升级前从未持久化的内存队列无法事后恢复。原生接管正文只经公开队列接口取得；内核源码及内部数据库均未直接读取或修改。

## 后续实模型补验

同日新增用户指定 MiMo 的四项整进程重启验证，最终 4/4（3.0 分钟）通过，覆盖首轮/追问已接受但丢 IPC 回执及停止本机队列的正常退出、强退。业务恢复实现不变；实模型时序、启动崩溃诊断、观测夹具修正及最终 2971 项完整检查见[MiMo 重启补验](2026-10-18-follow-up-restart-mimo.md)。
