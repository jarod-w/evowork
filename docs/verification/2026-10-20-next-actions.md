# 下一步建议实现与验收（2026-10-20）

已接通当前 Agent → 随包本机 MCP → 来源校验 → 本机权威存储 → 成功回合后筛选 → Composer 灰字建议 → 用户采纳为草稿 → 原发送链路。设计见 [22](../design/22-next-actions.md)。内核未修改，没有独立推荐模型请求或新增外网路径。

## 已验证的行为

- 候选最多三个，第一条展示；无价值建议及等待输入可提交空列表，不做模板兜底。候选正文不从最终回答或附件中解析。
- 宿主根据真实在途 MCP item 核对根手动任务、回合、服务器、工具及递归参数；伪造任务、修改嵌套正文、歧义/已结束调用和旧令牌拒绝。
- 候选先为 proposed，成功回合后才成为 available；失败、中断、新回合不复活旧建议。目标 active/paused/blocked/usageLimited/budgetLimited、审批、归档、自动化、子任务和原生/本机队列抑制展示。
- 建议与待发输入分开，采纳/关闭通过条件更新只消费一次。旧 v6 升级到权威 v7，正文及关闭状态跨存储重开保留，投影重建不删除；任务删除清理。
- 输入框有文字、附件、引用、补全或执行状态时隐藏。Enter 不采纳空白灰字；Tab、点击填入只更新草稿，采纳后可编辑，发送才新增用户消息。回执等待期间输入的新草稿和切换任务后的新建议不被迟到响应覆盖。
- 页面刷新按现有产品行为回首页，重新打开原任务后恢复可用建议；忽略后刷新重开仍隐藏。1280 与 480 窗口截图已查看，480 下关闭现有侧栏浮层后建议、填入与忽略均可见。

## 命令与结果

使用本机已有 pnpm 10.30.3（给 PATH 添加指向该已安装入口的临时目录，未安装包或修改依赖）。默认 Homebrew pnpm 会尝试获取项目指定版本，在受限网络下失败；以下执行的仍是仓库原版脚本。

- `pnpm run build`：退出 0。含 Swift Helper、主进程、preload、渲染层及新增 MCP 脱离 workspace 的独立启动检查。最初受限环境的 Swift 缓存/嵌套沙箱拒绝，最终在正常本机环境构建通过。
- `pnpm run check`：退出 0，**3016 通过、2 项既有跳过**。含格式、lint、生产及测试类型、全部单元/集成测试、补丁预算、52 项出站请求协议形状与许可清单。
- `node node_modules/@playwright/test/cli.js test next-actions.spec.mjs composer.spec.mjs thread-communication.spec.mjs goal.spec.mjs --project=fake --retries=0`：**13/13（55.1 秒）**，零 Playwright 重试、零跳过。真实 Electron、发货内核、随包 MCP、本机确定性模型上游；包括四项新增建议旅程与九项现有功能回归。

首轮完整检查拦到模式指令新哈希未登记，已按 shipped.json 的既有版本升级规则补齐。首轮刷新测试以为会保留任务视图，按当前刷新回首页行为改为重新打开原任务后断言建议仍在，未放宽存储恢复断言。窄窗收证关闭现有侧栏浮层后再次截图。最终结果如上。

## 证据与边界

[完整窗口](assets/2026-10-20-next-actions/next-action.png) · [480 窗口](assets/2026-10-20-next-actions/next-action-480.png) · [13 项 UI 输出](assets/2026-10-20-next-actions/ui.log) · [检查摘要](assets/2026-10-20-next-actions/check-summary.txt) · [构建摘要](assets/2026-10-20-next-actions/build-summary.txt) · [内核生命周期记录](assets/2026-10-20-next-actions/kernel-lifecycle.json)。

仅验 macOS arm64。真实厂商模型是否会稳定提交高质量建议、整应用进程重启的 UI 恢复、Windows/Linux 尚未专项验收。存储重开与页面刷新已分别验证，不能等同于整应用重启验证。语义上是否重复已完成工作依赖模型按指令生成；宿主完成事件只证明回合结束。没有发布安装包或修改用户当前任务、模型连接及密钥。
