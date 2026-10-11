# 独立会话通信验收 · 2026-10-11

对应设计：[17](../design/17-thread-communication.md)。本轮只修改、构建和测试源码；没有发布或替换用户安装的 App，没有修改执行内核。

## 环境与真实模型

macOS arm64，真实 Electron 窗口、发货内核及其 provenance、随包通信 MCP、宿主本机网关参与。真实模型为用户指定的 `mimo-v2.6-flash`，上游 `https://api.xiaomimimo.com/v1`。通过已有自定义模型登记与通用兼容适配接入，没有替换模型回复或脚本化工具调用。

密钥经隐藏 stdin 注入 `EVOWORK_UI_MODEL_KEY`，只在测试进程环境中使用；没有写进源码、配置或验收文件。测试报告和截图使用合成任务内容，实际完成轮次的测试产物扫描未发现密钥。未读取账户余额或取得实际费用。

## 后果断言

| 旅程 | 真窗口 + 可控网关 | MiMo 真模型 | 断言 |
| --- | --- | --- | --- |
| 用户手动发送 | 通过 | 通过 | 明确选同项目目标并发送；B 实际回复指定标记与 42；A 收到一条关联回复并汇总；没有自动循环或来源私有背景泄漏；刷新保留同 ID 和终态 |
| 代理请求拒绝 | 通过 | 通过 | 模型真实调用 MCP，具体卡展示目标及完整正文；拒绝后通信记录为零，目标没有新回合 |
| 代理请求批准 | 通过 | 通过 | 批准前零记录；批准后目标执行并自动回传；来源结束原回合后汇总；一条请求/回复，无重复投递 |

确定性套件最终 **3/3 通过（10.8 秒）**，含未处理窗口错误为零，以及展开面板后对话区仍有可阅读高度。MiMo 完整套件 **3/3 通过（47.1 秒）**；原始记录中的手动流程来源/目标各两个回合，代理批准流程来源三个、目标两个，拒绝流程目标一个回合。回复正确性以原生任务历史、通信正文和最终源会话文本共同断言。

全仓 `pnpm run check`：**2805 项通过、2 项既有跳过，173 个文件通过、1 个既有文件跳过**；包括格式、lint、源代码/测试类型检查、内核补丁预算、协议形状与许可清单。完整构建通过，通信 MCP 从独立临时目录启动并列出三项工具。最终布局另有样式与组件 **33/33** 通过及渲染层构建通过。

布局修正后的真实手动流程补测 **1/1 通过（17.2 秒）**，继续验证实际回复、关联回传、来源汇总及刷新终态；密钥扫描再次通过。没有重复计算为完整三项套件的一次额外全绿。

## 回归发现与修复

首轮 MiMo 套件 **1 通过 / 2 失败**：目标已执行且回复已回传，测试误用了 `replyText`，实际 DTO 为 `reply`；修正字段后以回复内容和数值断言，而不要求来源汇总逐字复制目标的测试标记。

真实窗口另暴露通信状态事件被主界面当成正文条目处理，抛错阻断后续 IPC 订阅，面板停留旧状态。确定性窗口回归复现；修复非正文事件分支后，完整三项和 MiMo 三项通过。没有靠刷新窗口绕过状态更新检查。

截图检查发现首次布局用了不存在的间距 token，并允许展开内容占满对话区。修正为既有 token、限宽、独立滚动、复选框横排和正常表单样式；布局回归使用真实 Electron `window.innerHeight`，不假定存在固定 Playwright viewport。

## 复验命令与证据

```bash
pnpm run check
pnpm run build
node node_modules/@playwright/test/cli.js test thread-communication.spec.mjs --project=fake
# 密钥从安全环境传入，命令中不包含密钥值：
EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash node node_modules/@playwright/test/cli.js test thread-communication.real.spec.mjs --project=real
```

本机日志：`/private/tmp/evowork-communication-check.log`、`/private/tmp/evowork-communication-build.log`、`/private/tmp/evowork-communication-ui.log`、`/private/tmp/evowork-communication-real-suite.log`；最终布局真模型补测为 `/private/tmp/evowork-communication-real.log`。证据副本保存在 `/private/tmp/evowork-communication-evidence/`：`real/` 包含三项完整原生历史、通信记录及截图；`fake-final/`、`real-layout-final/` 保存最终布局的窗口截图与进程日志。临时目录不是永久归档。

## 验证边界

项目隔离、跨项目明确选择、逐次正文读取授权、完全访问不代答、忙碌排队、归档/删除、并发去重、协调器重建、投递响应丢失、迟到响应和超长失败回复由本机回归覆盖。真实模型专项覆盖上述三条旅程，未做整 App 关闭重开、跨机器、Windows/Linux 或大量会话分页验收；单轮模型样本不能证明长期稳定率。未知投递保留待核对状态，不自动重试；文件引用只传文字，不复制文件或全部历史。
