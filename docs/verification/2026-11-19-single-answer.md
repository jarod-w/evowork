# 2026-11-19：纯文本回复重复修复

## 原因与变更

用户反馈输入“介绍一下自己”后，自我介绍出现两段，中间有 Stop 策略注入。下一步建议的 Stop handler 会在已展示最终正文后阻止结束、要求执行 Agent 补报建议。模型补报后可能再次输出正文；提示词里的“不重复”不能保证消除这条路径。

取消随包 Stop 注册、脚本、宿主 `/stop` 入口及适配层补报状态。建议继续由执行 Agent 在最终回复前主动登记，遗漏时允许没有建议，不再续跑。保留来源绑定、候选存储、完成后筛选、草稿补全与用户发送流程。同步模式指令及升级哈希，启动时沿用既有 hooks 配置重写机制移除旧注册。未修改内核或按文本相似度隐藏消息。

## 复现与验证

- 修改产品代码前，新窗口用例在真实 Electron、发货内核及本机确定性上游中失败：同一自我介绍期望出现一次，实际出现两次。宿主用例也先失败，旧 `/stop` 地址实际返回 200，期望关闭为 403。[窗口失败](assets/2026-11-19-single-answer/ui-before.txt)、[宿主失败](assets/2026-11-19-single-answer/unit-before.txt)。
- 修复后关联服务/宿主/策略/存储测试 **70/70**；完整构建退出 0。[定向测试](assets/2026-11-19-single-answer/unit-after.txt)、[构建](assets/2026-11-19-single-answer/build.txt)。
- 原窗口套件 **7/7**（单 worker、零重试、7.2 秒）：自我介绍与纯文本计划各只有一个 agentMessage，刷新后仍显示一次，无 hookPrompt；另覆盖非法建议、正常建议/刷新/Tab/方向右键、草稿保护、Escape、等待输入与中断。[窗口通过](assets/2026-11-19-single-answer/ui-after.txt)。

- 全仓 `pnpm run check`：格式、lint、33 包类型检查、**3595 项通过 / 6 项既有跳过**、内核补丁预算及协议形状检查通过。最终退出 1，仅许可证枚举失败：本机 pnpm store 缺少 `dompurify@3.4.14` 的 package index（`ERR_PNPM_MISSING_PACKAGE_INDEX_FILE`），未重新安装依赖或改写许可证清单。[完整检查](assets/2026-11-19-single-answer/check.txt)、[许可证诊断](assets/2026-11-19-single-answer/license-diagnostic.txt)。
- 首次全仓运行使用系统 Python，办公依赖缺失，并暴露本次模式指令的新哈希未登记；已补齐 `shipped.json` 并用现有 `build/office/mac-arm64/runtime/bin/python3` 重跑。当前环境 pnpm 为 11.25.0，设置 `pnpm_config_verify_deps_before_run=false` 使用现有依赖，未触发依赖安装；随包 Python 同时进入 PATH 与 `EVOWORK_OFFICE_PYTHON`。

## 边界

本轮未请求真实厂商模型；确定性上游用于复现模型重复正文的触发路径，不代表真实模型建议质量验收。未升级产品版本、替换安装版或发布；已有历史中的重复正文不追溯删除。
