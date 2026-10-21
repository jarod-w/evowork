# 下一步建议：纯文本漏调修复与两模型真实验收

2026-10-21，macOS arm64。真实 Electron、产品宿主网关、发货内核与随包 MCP；用户指定的两个模型各运行一遍完整用例，Playwright 零重试、零跳过。**最终 MiMo 2/2、DeepSeek 2/2，合计 4/4 通过**。这取代上一轮“两模型各 1/2”的当前结论；旧失败现场保留，不把历史失败改写成成功。

## 最终结果

| 指定模型与配置地址 | 文件交付 → 建议 → 编辑后执行 | 等待补充 → 纯文本交付 → 忽略与恢复 | 总用时 |
|---|---|---|---|
| `mimo-v2.6-flash`，`https://api.xiaomimimo.com/v1` | 通过，2.2 分钟 | 通过，43.9 秒 | 2.9 分钟 |
| `deepseek-flash`，`https://api.deepseek.com/` | 通过，30.0 秒 | 通过，19.0 秒 | 49.3 秒 |

文件用例每次随机生成七个整数，仅放在本机 `sales-input.json`；模型实际调用本机 Python，写入并核验正确的 `analysis.json`。用户只用自然语言说明下一阶段准备制作管理层汇报，没有指定建议工具名。测试核对结构化建议成功提交、运行中已有草稿不被覆盖、刷新重开恢复、Tab 只填草稿且用户消息仍为一条，编辑后发送才增加第二条消息并产生带随机验收标识的 `accepted-report.md`。

纯文本用例先只问交付格式，等待时无建议；用户选择 Markdown 后，在回复中交付三步上线计划，并明确下一阶段准备回滚演练检查清单。最终两模型都提交 `outcome=delivered` 的非空候选，建议包含回滚与演练/检查语义；点击忽略、刷新并重开原任务后仍隐藏，公开历史只有两条真实用户消息。没有自动执行上线或下一阶段工作。

观测到 **58 次指定模型 Chat 请求，58 个响应全部 HTTP 200**：MiMo 文件 20 次、纯文本 8 次，DeepSeek 文件 18 次、纯文本 12 次。实际路由分别为 `https://api.xiaomimimo.com/v1/chat/completions`、`https://api.deepseek.com/v1/chat/completions`；所有任务请求的规则在 system 层，建议工具可用，没有传输错误。四项共四次内核启动，观察期间意外退出 0。见[逐项元数据和提案](assets/2026-10-21-next-actions-real/summary.json)、[两模型退出码](assets/2026-10-21-next-actions-real/run-summary.json)。

## 原因与修复

上轮最终两个纯文本用例均因没有建议而失败；当时四个任务的 47 个请求全为 HTTP 200、回合均 completed，属于模型漏调 MCP，并非鉴权、服务连接或任务执行失败。[原始失败汇总](assets/2026-10-20-next-actions-real/rounds.json)、[MiMo 失败](assets/2026-10-20-next-actions-real/final/mimo-v2.6-flash/playwright.txt)、[DeepSeek 失败](assets/2026-10-20-next-actions-real/final/deepseek-flash/playwright.txt)均保留。

本轮明确“每个回合都登记”，包括纯文本计划/说明和等待输入，不能用“后续可以……”的正文代替，也不能沿用上一回合的登记；用户要求“不写文件”不等于禁止本机候选登记。更新工具说明及随包模式哈希。

另接官方 **Stop command hook**：在当前进程观察到的手动根任务原回合结束前核对登记尝试。完全没有尝试才提醒一次，执行 Agent 在原回合补报；已提交空列表、工具尝试失败、重入、旧回合、子任务、自动化、活动目标、队列或未知状态均不触发补报循环。宿主不读取内核 transcript，不解析回复生成候选，不新增任务或独立推荐模型。提醒会增加原回合推理与用量，仍受原生预算与停止机制控制；提醒后再漏调也直接结束。

本轮 MiMo 两项直接遵守规则，没有 Stop 提醒。DeepSeek 纯文本用例的第一回合先只返回格式问题，**真实触发一次 Stop 提醒并补交 needs_input 空列表**；第二回合直接提交回滚演练候选。公开历史有一条 `hookPrompt`，仍为原来的两个回合、两条用户消息。观测中四条请求包含提醒，是历史上下文延续，不是提醒四次。不能据此宣称真实模型在第二回合触发过 Stop 补救；“交付正文后漏调 → 原回合补报建议”和“忽略提醒也结束”的分支由真实内核确定性用例验证。见[DeepSeek 完整历史](assets/2026-10-21-next-actions-real/deepseek-flash/text-followup/history.json)。

前轮实测还修复了两个实际缺陷，仍包含在当前代码中：国内 Chat 适配曾把 developer 产品指令降为 user，现映射为 system；界面软刷新曾清空已可采纳候选并吞掉 Tab，现刷新期间保留候选，采纳时宿主再次核对，新回合仍立即失效。修复前后的回归分别见 [角色修复前](assets/2026-10-20-next-actions-real/developer-role-before.txt)、[修复后](assets/2026-10-20-next-actions-real/developer-role-after.txt)、[刷新修复前](assets/2026-10-20-next-actions-real/refresh-before.txt)、[修复后](assets/2026-10-20-next-actions-real/refresh-after.txt)。

## 检查与复现

最终完整 `pnpm run build` 退出 0。原版 `pnpm run check` 退出 0：**3027 项通过、2 项既有跳过**；格式、lint、类型、K1 补丁预算、52 个出站协议请求形状与许可清单均通过。真实 Electron + 发货内核的确定性 Playwright **15/15（1.6 分钟）**，覆盖新补报/有限重入，以及输入框、目标和会话通信回归。[检查摘要](assets/2026-10-21-next-actions-real/check-summary.txt)、[构建摘要](assets/2026-10-21-next-actions-real/build-summary.txt)、[Playwright 日志](assets/2026-10-21-next-actions-real/deterministic-regression.txt)。

Stop 服务新增四项回归先失败后通过，加上宿主和脚本等定向测试最终 28/28。首轮全仓检查还因策略包接线守卫仍枚举四个事件而失败；补齐新 Stop 事件与脚本登记后，重跑原版全仓检查通过。没有删除或跳过守卫。[新增回归初始失败](assets/2026-10-21-next-actions-real/stop-unit-before.txt)、[定向通过](assets/2026-10-21-next-actions-real/stop-unit-after.txt)、[首次全仓失败](assets/2026-10-21-next-actions-real/check-first.txt)。

真实模型测试入口（在仓库根执行，两个 preset 分别运行）：

```bash
node node_modules/@playwright/test/cli.js test next-actions.real.spec.mjs --project=real --retries=0
```

启动进程环境设置 `EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash` 或 `deepseek-flash`，凭据仅由隐藏 stdin 读入父进程后通过子进程环境 `EVOWORK_UI_MODEL_KEY` 传递，不在命令参数、源码、配置或证据文件填写密钥。没有替换模型回复或强制 tool_choice。测试只观察指定厂商的型号、端点、HTTP 状态与规则/工具是否存在等布尔元数据，不保存上游请求/响应正文；正常应用公开历史单独收证。

```bash
node node_modules/@playwright/test/cli.js test next-actions.spec.mjs composer.spec.mjs thread-communication.spec.mjs goal.spec.mjs --project=fake --retries=0
pnpm run check
```

前轮过程中的断言转义和 DeepSeek `/v1` 路由预期错误、一次 MiMo 工具执行后回合未及时结束，以及不同轮次漏调/空候选/Tab 竞态的失败都保留在[前轮分轮证据](assets/2026-10-20-next-actions-real/rounds.json)及相邻目录。没有把此前某次诊断通过当作最终通过；本页结论只取修复后的本次完整双模型运行。

## 截图与边界

已查看两模型文件建议界面，以及纯文本忽略后刷新恢复界面；截图分别为 [MiMo 建议](assets/2026-10-21-next-actions-real/mimo-v2.6-flash/file-flow/suggestion.png)、[DeepSeek 建议](assets/2026-10-21-next-actions-real/deepseek-flash/file-flow/suggestion.png)、[MiMo 忽略后](assets/2026-10-21-next-actions-real/mimo-v2.6-flash/text-followup/final.png)、[DeepSeek 忽略后](assets/2026-10-21-next-actions-real/deepseek-flash/text-followup/final.png)。纯文本候选显示和关闭由 Playwright 断言核验，该用例截图保留等待与关闭后的状态。

本轮原始产物及相关源码 **40 个文件精确凭据扫描 0 命中**；复制的 30 个证据文件 API key 形态扫描 0 命中，扫描结果本身另存。前轮证据也保留各轮精确扫描与复制后扫描。[本轮扫描](assets/2026-10-21-next-actions-real/artifact-scan.json)。

只验本机 macOS arm64、这两个模型及上述旅程。页面刷新/重新打开任务不代表整应用进程重启；本轮未补验 Windows/Linux、签名安装包或发布。一次完整通过不等于所有表达下模型必定给出建议；补报有一次上限，空列表和用户拒绝仍然有效。没有修改上游内核。
