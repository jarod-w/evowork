# 排队发送与立即插话 · MiMo 实模型验收

2026-10-18，macOS arm64。使用用户指定的 `mimo-v2.6-flash` 与 `https://api.xiaomimimo.com/v1`，经过真实 Electron、发货内核和产品宿主网关。最终两项 Playwright **2/2 通过，1.4 分钟，零重试、零跳过**，没有失败轮次或放宽行为断言。

记录了 **17 次**真实 MiMo 上游请求，模型均为 `mimo-v2.6-flash`，端点均为 `https://api.xiaomimimo.com/v1/chat/completions`，收到的 HTTP 状态均为 200。两项各启动一次内核，测试运行中退出和意外重启均为 0。机器可读总览见 [summary.json](assets/2026-10-18-follow-up-delivery-mimo/summary.json)。

| 检查 | 实际结果 |
| --- | --- |
| 排队确实等待 | 原任务先运行本机准备步骤，期间用真实按钮发送追加计算。页面显示队列和“等待当前任务完成”；持续观察 3 秒，追加标记没有进入 MiMo 请求，原回合仍 inProgress，历史没有追加用户消息，也没有追加输出文件。 |
| 完成后才处理追加 | 准备步骤返回后，MiMo 完成原任务并生成 original.txt（437）；先收到原回合 completed，再收到下一回合 started。包含追加标记的首次上游请求在原回合完成通知之后。随后生成 queued.txt（42），两个回合均 completed，两条最终答复均正确。 |
| 插话确实转向 | 原计划准备后计算 19×23、写 old-plan.txt；准备步骤执行中点击“立即插话”，要求取消旧计划、改算 17+25。真实上游请求在原回合完成前包含新要求；最终只有原来这一个 completed 回合，生成 redirected.txt（42），没有生成 old-plan.txt，也没有回复旧计划完成标记。 |
| 插话反馈准确 | 内核接收后显示“已发送，正在调整方向”，不出现追问队列，选项恢复“排队发送”；之后的真实模型行动与提示一致。它表示接收并进入调整流程，不表示在途工具立即取消。 |
| 收尾提示 | 两项完成后均回到 idle，旧发送状态提示清除，没有回合失败卡。 |

原始测试证据包含完整合成任务历史、回合事件、最终文件内容与上游请求时间/模型/标记：[排队证据](assets/2026-10-18-follow-up-delivery-mimo/queue-evidence.json)、[插话证据](assets/2026-10-18-follow-up-delivery-mimo/steer-evidence.json)。观测夹具仅保存时间、模型、端点、随机测试标记及 HTTP 状态，不保存请求头、密钥或上游请求/响应正文。

## 截图

以下运行中和完成后的截图均已查看：

- [原回合执行中：排队与等待提示](assets/2026-10-18-follow-up-delivery-mimo/real-queued-waiting.png)
- [原任务完成后：追加计算完成](assets/2026-10-18-follow-up-delivery-mimo/real-queued-completed.png)
- [插话已接收：提示与恢复排队](assets/2026-10-18-follow-up-delivery-mimo/real-steer-accepted.png)
- [同一回合完成：改为新方向](assets/2026-10-18-follow-up-delivery-mimo/real-steer-completed.png)

## 复现与边界

在已安全注入 `EVOWORK_UI_MODEL_KEY` 的终端运行，不把密钥写进命令行、脚本或配置文件：

```bash
EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash node node_modules/@playwright/test/cli.js test queue-steer.real.spec.mjs --project=real --retries=0
```

测试为原任务提供一个真实本机“输入尚未就绪”步骤：模型自行执行 Python 脚本，脚本等待本机就绪文件。测试在实际命令执行期间发送消息，再令输入就绪。只控制工具步骤的数据就绪时机；未伪造模型回复、延迟 MiMo 网络响应、替换工具结果或强制模型工具调用。其后的规划调整、计算、文件写入及最终答复均由真实 MiMo 执行。界面发送动作实际经过 IPC、适配层与原生队列/插话；对上游 fetch 的包装只观测元数据，不修改请求或响应。

密钥仅通过隐藏 stdin 和进程环境传入。测试结束后，对日志及测试产物 **12 个文件**精确扫描，**0 命中**，见 [credential-scan.json](assets/2026-10-18-follow-up-delivery-mimo/credential-scan.json)。日志在本机 `/private/tmp/evowork-follow-up-mimo.log`，完整检查日志为 `/private/tmp/evowork-follow-up-mimo-check.log`。

本轮新增真实模型用例及测试专用观测夹具，没有修改业务执行逻辑、内核或网关适配。最终完整 `pnpm run check` 退出 0，**2952 项通过、2 项既有跳过**；格式、lint、类型、补丁预算、协议形状和许可检查均通过。此前 [确定性验证](2026-10-18-follow-up-delivery.md) 保留。仅验证本机 macOS arm64、这一模型的这两条任务，不能据此承诺任意模型/任务的遵循质量、即时终止在途工具或已发生动作的回滚；未发布安装包或重启用户当前应用。
