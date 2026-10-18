# 排队与插话：四组故障及竞态验收（2026-10-18）

范围：真实 Electron 窗口、发货内核、实际 preload/IPC/适配层。确定性网关负责维持可重复的运行窗口；另用用户指定的 `mimo-v2.6-flash`、`https://api.xiaomimimo.com/v1` 补验。密钥经隐藏 stdin 和进程环境传入，不写测试源码、文档或模型请求观测文件。

## 四组验证

| 组 | 可控故障/操作 | 验证依据 |
|---|---|---|
| 拒绝、超时、丢回执 | 原生 RPC 明确拒绝、接受后丢回执、延迟回执、请求未送达、核对接口失败、队列刷新失败 | 草稿/真实附件/插话选择保留；按客户端身份核对队列或历史；未知结果只核对、不重复写入；已接受后的刷新故障单独提示 |
| 发送中交互 | 连续 Enter、发送按钮禁用、切新任务后返回迟到回执、回执等待期间停止 | 实际写 RPC 次数为 1；停止仍可用；不跳回旧任务、不清新草稿；停止后的排队输入不自动执行 |
| 原回合结束竞态 | 扣住排队/插话请求，让原回合真正完成再放行；叠加原生队列不可用 | 原生历史恰好两回合，追加输入恰好一次；明确插话前置条件拒绝可改为排队；本机降级不挂在已结束回合上；原因在输入框下方保留，已开始执行时不继续显示等待 |
| 停止与队列 | 原生队列与本机降级队列各排两条后停止，再明确继续 | 停止后保持两条队列、无追加模型请求；“继续队列”依次执行，历史为 interrupted/completed/completed |

故障夹具仅包裹真实内核的 stdin/stdout RPC，按方法一次性或持续注入；不替换内核、不伪造任务完成事件。夹具只记录方法计数、扣住帧数和丢弃数量，不记录参数正文。队列刷新故障单独注入宿主读动作，投递仍走真实内核。

## 发现并修复

1. 发送没有独立身份，回执丢失后重试存在重复投递风险。现区分草稿环境与 submissionId，以客户端身份写入队列/回合并缓存回执；同一未知请求只核对。身份内容指纹使用 SHA-256，缓存不保留正文。
2. 发送 RPC 原先没有超时。现投递与只读核对各有默认 15 秒预算（窗口故障夹具用 1.5 秒），超时不推断“未送达”；迟到回复不会命中后续请求。
3. 已确认接受后队列刷新失败原先也显示“没能发出去”。现保持成功投递结果，只提示刷新失败。
4. 插话请求在原回合结束后才抵达时原先直接报错。只对明确未提交的无活动回合/回合变化错误改为排队，其余拒绝原样保留草稿。降级原因与等待状态分开维护，跨回合启动仍在输入框下方保留原因；队列已空后清除过时的等待提示。
5. 本机队列原先收到中断完成事件也会自动续跑。现仅自然完成触发自动出队，停止前先暂停；新增“继续队列”贯通 UI、preload、宿主与适配层，原生队列复用公开启动接口。
6. 本机降级发生在原回合已结束之后时原先无人再触发队列。现确认空闲且未暂停后启动下一回合，明确提示已经开始执行。

修复前两条回归均已复现：停止后 `turn/start` 从应有的 1 次变为 2 次；结束后本机降级应有 2 次却只有 1 次。首轮窗口 8/9，发现回合切换会清除原因；修正后 11/11。扩充至 23 项后通过，视觉检查进一步把原因保留到输入框下方，避免顶部提示随自动滚动离开视野。

## 执行命令

```bash
node scripts/build.mjs
pnpm --filter @evowork/desktop run build
node node_modules/@playwright/test/cli.js test queue-steer-faults.spec.mjs queue-steer.spec.mjs composer.spec.mjs output-stream.spec.mjs --project=fake --retries=0
node node_modules/@playwright/test/cli.js test queue-steer.real.spec.mjs --project=real --retries=0
pnpm run check
```

真实模型测试包括正常排队、丢回执排队、同回合调整方向、停止后明确继续队列。只用本机准备脚本的数据就绪门控制插话窗口；计算、工具调用、模型决策、文件与最终回答均来自真实模型链路。

## 最终窗口结果与证据

确定性测试最终 **23/23（1.1 分钟，零重试、零跳过）**：新增四组 13 项，既有发送/停止/队列操作、布局与流式输出 10 项。23 次内核启动、运行中退出 0；[汇总及生命周期](assets/2026-10-18-follow-up-delivery-faults/deterministic-summary.json)、[最终执行日志](assets/2026-10-18-follow-up-delivery-faults/deterministic-run.txt)。完整桌面构建及最终渲染层构建通过。

截图已查看：[未知回执保留草稿和附件](assets/2026-10-18-follow-up-delivery-faults/unknown-no-replay.png)、[回执丢失后核对队列](assets/2026-10-18-follow-up-delivery-faults/drop-response.png)、[回合结束后显示降级原因](assets/2026-10-18-follow-up-delivery-faults/completion-race-steer.png)、[本机降级立即执行](assets/2026-10-18-follow-up-delivery-faults/local-completion-race.png)、[停止后保留本机队列及继续入口](assets/2026-10-18-follow-up-delivery-faults/stopped-local.png)。同名 JSON 保存故障计数与真实内核历史。

第一次完整检查的测试部分 2957 项通过，但协议自检拒绝未登记的队列启动方法；已补齐公开请求形状登记，并核对客户端消息身份字段，协议单独检查通过。最终串行 `pnpm run check` **退出 0**：**2958 项通过、2 项既有跳过**；格式、lint、类型、K1 预算、52 个出站请求形状与许可检查均通过。[完整检查日志](assets/2026-10-18-follow-up-delivery-faults/full-check.txt)。

## MiMo 实模型补验

最终 **4/4（2.7 分钟，零重试、零跳过）**。38 次上游请求与 38 次回执均为指定端点及模型，HTTP 全部 200；内核 4 次启动、运行中退出 0。日志及测试产物 56 个文件的精确凭据扫描为 0 命中。[请求、回合及产物汇总](assets/2026-10-18-follow-up-delivery-faults/mimo-summary.json)、[执行日志](assets/2026-10-18-follow-up-delivery-faults/mimo-run.txt)。

| 路径 | 实际结果 |
|---|---|
| 正常排队 | 原回合完成前追加标记未进入上游；完成后新回合开始。original.txt 为 437，queued.txt 为 42，两个 completed 回合 |
| 接受排队后丢回执 | 原生写入回执由夹具丢弃，产品按客户端身份确认队列；显示“等待当前任务完成 回执丢失，已核对排队记录。”；最终也只有两个 completed 回合，无重复追加 |
| 立即插话 | 同一回合改为计算 17+25，redirected.txt 为 42，old-plan.txt 不存在；一个 completed 回合，提示“已发送，正在调整方向” |
| 停止后继续 | 停止后的观察窗口无追加模型请求或产物，队列仍保留；明确点击“继续队列”后生成 42；两个回合依次 interrupted/completed |

截图已查看：[实模型丢回执等待提示](assets/2026-10-18-follow-up-delivery-faults/mimo/queue-lost-ack/real-queued-waiting.png)、[实模型插话提示](assets/2026-10-18-follow-up-delivery-faults/mimo/steer/real-steer-accepted.png)、[停止后继续入口](assets/2026-10-18-follow-up-delivery-faults/mimo/stop-resume/real-stopped-queue.png)。各目录的 real-follow-up-evidence.json 保存完整回合、产物内容、事件顺序与上游元数据，不含服务商密钥。

## 边界

只验 macOS arm64；未发布安装包。去重回执与本机降级队列属于当前宿主进程内状态，不承诺整应用重启后的去重或本机队列恢复。未知请求修改内容后会获得新发送身份；未修改内容时沿用原请求核对。未承诺立即撤销在途工具或已经发生的文件副作用。四组故障的重复时序由确定性网关覆盖，真实厂商模型补验四条关键路径，不把它写成所有注入组合均实模型通过。

后续：本文的进程内边界已由[发送回执与队列重启恢复](2026-10-18-follow-up-restart.md)补齐；本文保留当轮验收范围。
