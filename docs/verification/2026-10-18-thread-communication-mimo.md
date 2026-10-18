# 对话式会话通信 · MiMo 实模型验收

2026-10-18，macOS arm64。真实 Electron、发货内核及来源校验、随包通信 MCP、产品宿主网关和 `mimo-v2.6-flash` 参与，地址为 `https://api.xiaomimimo.com/v1`。没有脚本化模型回复或强制工具调用。

最终完整套件 **2/2 通过（2.2 分钟，零重试、零跳过）**。已查看成功页面截图；两项各启动一次内核，运行中退出均为 0。机器可读记录见 [summary.json](assets/2026-10-18-thread-communication-mimo/summary.json)。

| 旅程 | 结果与证据 |
| --- | --- |
| 自然语言发起并拒绝授权 | 用户只描述发送目标、完整请求及回传要求，没有指定工具名。MiMo 实际调用 `thread_communication.send_request`；授权卡展示目标和完整正文，确认前记录为空。点击拒绝后通信记录仍为空，目标仅有初始化一个回合，没有收到请求。 |
| 自然语言发起并批准授权 | 同样通过真实授权卡批准，目标计算 `17 + 25`，返回唯一标记及 `42`。只有一个通信请求、状态 `completed`；来源共三个回合，目标两个回合，来源最终文本包含真实答案，没有自动回复循环。 |
| 共享范围与刷新 | 目标历史不含来源独有的私有测试标记。结果在正常对话中可见，刷新后答案和同一个完成请求仍在；页面没有独立“会话通信”表单。 |

本轮调整了工具说明，明确发送/读取调用会自动弹出应用授权卡，批准后才执行。宿主身份校验、权限与逐次审批逻辑未修改；完整 `pnpm run check` 退出 0，**2928 项通过、2 项既有跳过**。最后一次测试提示修改另通过格式、lint、语法及 diff 检查。

## 过程与适用边界

用户更新密钥前的轮次已中断，不计验收通过。更新密钥后，原测试提示要求“发送前交给我确认目标和正文”，MiMo 在对话中展示了目标、正文并询问“请确认是否发送”，没有调用工具或投递请求，授权卡等待断言超时。现场保留在 `assets/2026-10-18-thread-communication-mimo-before-description-fix/`。仅明确工具说明后，仍观察到相同文字确认，轮次停止，现场保留在 `assets/2026-10-18-thread-communication-mimo-text-confirmation/`。

最终测试去掉额外的“先确认”提示，使用普通自然语言发送需求；授权卡、确认前零投递、拒绝零投递及真实回传的断言均未放宽。MiMo 自主调用工具，完成上述两项验收。这不能证明用户明确要求先进行文字确认时也会直接弹卡。

测试提供了明确的目标会话 ID，没有验证只凭重名标题消歧、跨机器、Windows/Linux 或所有模型的行为。没有修改执行内核、发布安装包或重启用户当前应用；测试只启动隔离的验收应用。

密钥通过隐藏 stdin 注入启动器，再以环境变量传入测试进程，没有写入源码、配置或验收文件。精确凭据扫描见 [credential-scan.json](assets/2026-10-18-thread-communication-mimo/credential-scan.json)。

## 复现命令

密钥通过隐藏输入或安全环境注入 `EVOWORK_UI_MODEL_KEY`，命令中不包含密钥值：

```bash
EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash node node_modules/@playwright/test/cli.js test thread-communication.real.spec.mjs --project=real --retries=0
```
