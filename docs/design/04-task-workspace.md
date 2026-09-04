# 04 · 任务工作台

> 上游：[总纲 §6.1 / §6.10](../evowork-on-codex-design.md)· D6 · [清单 §4 / §5 / §6](../agent-platform-feature-list.md)
> 截图未覆盖此页，全部控件按 [01 §5](01-ui-design-system.md) 推导。这是产品使用时长最集中的页面，也是 M2 的主体。

## 1. 布局

三栏（01 §3.1 骨架 B），与截图 4 的资料库同构，用户不需要学第二套空间模型：

```
┌──────────┬────────────────────────────────┬──────────────────┐
│ 侧边栏    │ 对话区                          │ 结果区（可折叠）  │
│ 260      │ flex · 内容列 800 居中           │ 360–560 可拖拽    │
│          │                                │                  │
│ 任务列表  │ ┌ 任务标题栏（标题栏带内）        │ 产物 / 文件 /     │
│ 在此高亮  │ ├ 消息流（19 类 Item）           │ 变更 / 浏览器     │
│          │ └ Composer（同 03 §4）           │                  │
└──────────┴────────────────────────────────┴──────────────────┘
```

- 结果区**默认收起**（`⌘I` 切换）。首次产生产物或文件变更时**自动展开一次**，之后尊重用户的开合状态（本机持久化，按任务记忆）。
- 结果区展开后对话区内容列若被压到 < 640，内容列取消居中改为左对齐并允许收窄至 560；< 560 时自动收起结果区。
- 侧边栏在任务页与首页完全一致（01 §3.3），只是当前任务项为选中态。

---

## 2. 任务状态：为什么必须自建投影表

### 2.1 内核给了什么

实测（2026-09-04 @ `728cb12fe5`，README F7/F8/F9）：

| 事实 | 出处 |
|---|---|
| `ThreadStatus` = `NotLoaded \| Idle \| SystemError \| Active { activeFlags }`；`ThreadActiveFlag` = `WaitingOnApproval \| WaitingOnUserInput` | `v2/thread.rs:1639-1656` |
| 未加载的 thread 状态恒为 `NotLoaded`，**不携带上次执行结果** | `v2/thread_data.rs:260` |
| `thread/list` **没有状态过滤，也没有日期区间过滤** | `v2/thread.rs:1368-1439` |
| `ThreadExtra` 是空结构体；`thread/metadata/update` 只能改 `projectId` / `gitInfo` —— **协议没有客户端自定义元数据槽** | `v2/thread_data.rs:167`、`v2/thread.rs:979-991` |
| 结果信息在 `turn/completed` 的 `TurnStatus`（`Completed \| Interrupted \| Failed \| InProgress`） | `v2/turn.rs:32-37`、`:509-512` |

### 2.2 结论与派生规则

清单 §4.3 的六态**不能只由 `ThreadStatus` 得到**，清单 §4.2 的「按状态或日期筛选」**不能由 `thread/list` 得到**。因此服务层维护 `thread_projection` 表（09 §4.1），由事件流实时更新：

| 清单状态 | 派生规则 | 数据 |
|---|---|---|
| 进行中 | `ThreadStatus::Active` 且 `activeFlags` 为空 | 实时 |
| 待处理 | `ThreadStatus::Active` 且 `activeFlags` 含 `WaitingOnApproval` 或 `WaitingOnUserInput` | 实时 |
| 规划中 | 投影表 `mode = plan` 且存在 `plan` item 且用户尚未确认执行 | 投影表 |
| 已完成 | 投影表 `last_turn_status = completed` 且当前非 Active | 投影表 |
| 失败 | 投影表 `last_turn_status = failed`，或 `ThreadStatus::SystemError` | 投影表 + 实时 |
| 已中断 | 投影表 `last_turn_status = interrupted` —— **清单没有这一态，但用户会遇到** | 投影表 |
| 已归档 | `thread/list?archived=true` | 内核 |

> **对总纲的修订**：§3.3 把「按状态/日期筛选」标为 [复用] 应改为 [自建]（README §6 M2）。另建议在清单 §4.3 补「已中断」——`TurnStatus::Interrupted` 是真实存在的终态，映射到"已完成"会误导用户，映射到"失败"会让用户以为出错了。UI 上按「已中断」独立呈现（`Badge neutral` + 「已中断，可继续」）。

### 2.3 状态机

```
                    turn/start
        ┌──────────────────────────────► 进行中 ◄──────────┐
        │                                  │              │
     (新建)                    ┌───────────┼──────────┐   │ turn/steer
        │                      ▼           ▼          ▼   │ 或 队列出队
   规划中 ──确认计划──► 进行中   待处理    已完成/失败/已中断─┘
        │                    (审批/追问)      │
        └────────────────────────────────────┴──► 已归档
```

- 「待处理」是**进行中的子态**（内核层面仍是 Active），但在任务列表里必须提到最前面 —— 它是唯一需要用户立刻行动的状态。
- 任何终态都可通过 `thread/resume` + `turn/start` 回到进行中（清单 §4.6）。

---

## 3. 任务列表（侧边栏）

### 3.1 分组结构

清单 §4.1 要求"按文件夹分组"+"任务与空间两个板块"。映射到内核的 `ThreadSection`（总纲 §6.1）：

```
任务 (N)                                    ← SidebarSectionHeader，可折叠
  📌 置顶                                    ← 内置 pinned 分区（threadSection）
      • 季度汇报 PPT              2小时前
  ▾ 周报                                     ← 用户创建的 threadSection
      • 第 36 周周报              1天前
  ▾ 未分组
      • 查询当前黄金价格           1天前
```

- 分组 = `threadSection/*`（`list` / `create` / `update` / `delete`）+ `thread/section/move`。**置顶就是内置的 pinned 分区**，不额外做 `is_pinned` 字段（总纲 §6.1 已定）。
- 排序：分区内按 `sortKey`（默认 `recencyAt`，可切 `createdAt` / `updatedAt` / `sectionPosition` 手动排序）。手动排序只在用户拖拽后启用。
- 拖拽：`TreeItem` 的拖拽规范（01 §5.26）；跨分区拖拽 = `thread/section/move`。
- 分页：`thread/list` 的 cursor 分页，每页 30，滚动到底加载。**列表项渲染用虚拟滚动**（长期用户会有上千任务）。

### 3.2 任务行
`TaskListItem`（01 §5.5）。状态点颜色按 01 §6.1。子任务（`parentThreadId` 非空）**不出现在顶层列表**，只在父任务的对话流里以 `SubAgentActivity` item 呈现（§5.6）。

### 3.3 行操作（清单 §4.4）

悬停 ⋯ 或右键唤出 `Menu`：

| 操作 | 实现 | 备注 |
|---|---|---|
| 置顶 / 取消置顶 | `thread/section/move` → pinned 分区 | — |
| 重命名 | `thread/name/set` | 行内编辑，`⏎` 提交 |
| 移动到分组 | 子菜单列出 sections + 「新建分组…」 | — |
| 打开所在文件夹 | 本机 shell（`open` / `explorer` / `xdg-open`） | 用 `thread.cwd` |
| 在此空间新建任务 | 跳首页 + 预选该 cwd | — |
| **分享任务** | Q10 逐次授权流（08 §7） | 默认关闭；点击先过授权模态 |
| 复制任务链接 | `evowork://task/<id>`（本机 deeplink） | 与"分享"区分：这个不上传 |
| 从中途分叉 | `thread/fork { beforeTurnId }` | 入口也在消息流每条用户消息的悬停操作里（§5.2） |
| 归档 / 取消归档 | `thread/archive` / `thread/unarchive` | 归档后从列表消失，去「更多→数据管理」 |
| 删除 | `thread/delete` | **二次确认，且必须说清是否删除工作空间文件（答案：不删）** |

「保存到工作空间」（清单 §4.4）在本设计里不是一个动作 —— Q1=A 下任务天生就在真实目录里执行。若任务用的是「临时目录」（03 §8），则该菜单项出现，语义为「移动到正式工作空间」（移动目录 + 更新 `cwd` + 重建产物索引路径）。

### 3.4 搜索与筛选

标题栏带的两个图标（01 §3.2）：

**搜索**（放大镜）→ 侧边栏顶部展开 `SearchInput`，实时过滤。数据源分两层：
- 标题匹配：`thread/list?searchTerm=`（内核支持，`v2/thread.rs:1428`）
- 内容匹配：`thread/search` (exp) + `thread/searchOccurrences` (exp)，结果分组显示为「对话内容命中」

**筛选**（漏斗）→ `Popover`，三组条件：

| 条件 | 实现 | 说明 |
|---|---|---|
| 状态（多选，六态 + 已中断） | **本机投影表查询**（内核不支持，§2.1） | 这是投影表存在的主要理由 |
| 时间范围（今天 / 7 天 / 30 天 / 自定义） | 本机投影表 `updated_at` | 同上 |
| 工作空间 / 空间 | `thread/list?cwd=` 或 `?projectId=`(exp) | 内核支持 |
| 模型 | `thread/list?modelProviders=` | 内核支持 |
| 是否有产物 | 本机产物索引 join | 自建 |
| 来源（手动 / 自动化 / CLI） | `thread/list?sourceKinds=` + 投影表 `automation_id` | 混合 |

筛选生效时 `SidebarSectionHeader` 变为「任务 (12 / 148) · 重置筛选」（清单 §4.2 要求的重置入口）。

**实现要点**：筛选走**本机投影表主导 + 内核校正**的顺序 —— 先在 sqlite 里按条件查出 thread_id 列表，再用 `thread/list` 拉取这批的权威元数据（避免投影表标题过期）。不要反过来（先全量拉再本地过滤），上千任务时会卡。

---

## 4. 任务标题栏（在标题栏带内）

```
[← 折叠] │ 季度汇报 PPT ▾   [Badge 进行中]  ····  [🔍] [↗分享] [🕐历史] [◫结果区]
```

清单 §5.2 的四个顶部操作逐一落点：

| 操作 | 实现 |
|---|---|
| 对话内搜索 | `⌘F`，对话区顶部浮出搜索条；数据 `thread/searchOccurrences` (exp)，命中处高亮 + `↑↓` 跳转 + 计数 |
| 分享任务 | Q10 授权流（08 §7）。**默认关闭**，按钮常显但点击先过授权 |
| 历史提问 | `Popover` 列出本任务全部用户消息（`thread/turns/list`），点击滚动定位。长任务的导航主入口 |
| 显示详情面板 | 切换结果区（`⌘I`） |

标题旁 `▾` 展开任务级设置（与 §3.3 的行操作合并，避免两套菜单），额外含：

| 任务级设置 | 实现 |
|---|---|
| 切换工作模式 | 下一次 `turn/start` 生效；**不追溯已发生的回合** |
| 切换权限 profile | `turn/start.permissions`（F5：不与 `sandboxPolicy` 同传） |
| 切换模型 | `turn/start.model` |
| 记忆开关 | `thread/memoryMode/set` (exp) —— 直接满足清单 §5.4 的隐私诉求 |
| 设定预算 | `thread/goal/set` 的 `budget`（Q11，10 §5） |
| 压缩上下文 | `thread/compact/start`，并在流里插入 `ContextCompaction` item |
| 回滚 / 撤销 | `thread/rollback` / `thread/revert`（§6.3） |

---

## 5. 消息流：19 类 Item 的渲染规范

内核的 `ThreadItem` 共 19 个变体（`v2/item.rs:237-414`，README F13）。对话区不是"消息 + 工具"两类，必须逐类给出呈现方式，否则会出现大量"未知事件"占位。

### 5.1 通用规则

- **内容列 800**，用户消息右对齐块（最大宽 640，`--bg-sunken` 底，`--r-lg`），agent 输出**左对齐无气泡**（长文可读性优先）。
- 每个 item 有稳定 `id`，流式增量按 id 合并（`item/agentMessage/delta`、`item/plan/delta`、`item/commandExecution/outputDelta` 等）。
- **默认折叠的项**（过程性）用一行摘要 + 展开箭头；**默认展开的项**（结论性）直接铺开。下表的"默认"列即此。
- 新 item 插入做 120ms 淡入 + 4pt 上移（01 §2.7）；流式文本追加不做动画。
- 自动滚动：仅当用户已在底部时跟随；用户上滑后停止跟随并在右下角显示「↓ 有新内容」按钮。

### 5.2 逐类规范

| # | Item | 默认 | 渲染 |
|---|---|---|---|
| 1 | `UserMessage` | 展开 | 右对齐块。含 `@` token 渲染、附件缩略卡。悬停操作：复制、**从此处分叉**（`thread/fork { beforeTurnId }`）、编辑重发 |
| 2 | `AgentMessage` | 展开 | Markdown 全量渲染（含表格、代码高亮、任务列表）。三类受控 fence 转交 Visualizer（§7）。悬停操作：复制、导出为文件、朗读 |
| 3 | `Reasoning` | **折叠** | 一行「思考中… / 已思考 12 秒」+ 展开后灰底斜体。**若模型无推理能力，网关按 D2 显式声明缺失 → 该项整体不渲染**（不留空壳） |
| 4 | `Plan` | 展开 | 步骤清单卡：每步 `pending / in_progress / completed` 三态图标 + 文案。数据来自 `turn/plan/updated`（`v2/turn.rs:528-533`）。Plan 模式下卡底部有「确认执行 / 修改计划」两个动作（= 清单的"规划中"确认点） |
| 5 | `CommandExecution` | 折叠 | 一行：`$ 命令`（等宽，超长中截）+ 状态点 + 耗时 + 退出码。展开显示输出（`outputDelta` 流式追加，尾部 500 行滚动窗口）。含 `TerminalInteraction` 时提供输入框（交互式命令） |
| 6 | `FileChange` | **展开** | 变更卡：文件路径 + `+n/-m` 统计 + 折叠的 diff（首屏最多 40 行，超出「查看完整变更」跳结果区变更视图）。数据增量来自 `item/fileChange/patchUpdated` |
| 7 | `McpToolCall` | 折叠 | 一行：连接器图标 + `server.tool` + 状态 + 耗时。展开显示入参/出参 JSON（折叠树）。进度来自 `item/mcpToolCall/progress` |
| 8 | `DynamicToolCall` | 折叠 | 同上，但工具由扩展贡献（`ToolContributor`）。图标取自扩展声明 |
| 9 | `FunctionCallOutput` | 折叠 | 通常并入其对应调用项显示，不单独占行；无法关联时以「工具返回」独立折叠行呈现 |
| 10 | `WebSearch` | 折叠 | 一行「搜索：<query>」+ 结果条数；展开为结果列表（标题 + 域名 + 摘要），点击在内置浏览器打开（§6.4） |
| 11 | `ImageGeneration` | 展开 | 图片卡（最大宽 640，点击放大 lightbox）+ 提示词折叠 + 「保存到产物」。对应总纲 §6.8 复用 `ext/image-generation` |
| 12 | `ImageView` | 折叠 | 「已查看图片：<文件名>」+ 缩略图 64 |
| 13 | `SubAgentActivity` | 折叠 | 子任务卡：专家/角色名 + 状态 + token 用量 + 「查看子任务详情」（打开子 thread 的只读侧滑）。这是清单 §9「多角色协作」的可视化 |
| 14 | `CollabAgentToolCall` | 折叠 | 同 13，用于父子 agent 之间的显式调用 |
| 15 | `HookPrompt` | 折叠 | 「策略注入」行 + 来源 hook 名。**企业策略可配置为隐藏**（避免暴露内部策略文本），但审计日志始终记录（10 §6） |
| 16 | `ContextCompaction` | 展开（单行） | 分隔线样式：「—— 已压缩前 42 轮对话以节省上下文 ——」+ 「查看被压缩的内容」 |
| 17 | `EnteredReviewMode` / 18 `ExitedReviewMode` | 展开（单行） | 分隔线：「进入安全审查」/「审查完成」。配合 guardian-v2（10 §4） |
| 19 | `Sleep` | 折叠 | 「等待 30 秒…」+ 倒计时。用于轮询类任务 |

**未知 item**（上游新增变体）：渲染为一行 `caption`「新类型事件（<type>），已记录」+ 展开显示原始 JSON。**绝不静默丢弃** —— 这是 R2（上游高速演进）的防线：用户看到陌生事件比看到空白好，且能立刻反馈给我们。

### 5.3 审批与用户输入（server→client request）

README F14：审批是**服务端发起的请求**，前端必须实现可回复的处理器，而不是被动收通知。四类：

| 请求 | 卡片 | 可选回复 |
|---|---|---|
| `item/commandExecution/requestApproval` | 命令审批卡（含完整命令、cwd、`execpolicy` 判定理由） | `Accept` / `AcceptForSession` / `AcceptWithExecpolicyAmendment` / `Decline` / `Cancel`（`v2/item.rs:66-82`） |
| `item/fileChange/requestApproval` | 变更审批卡（含 diff） | `Accept` / `AcceptForSession` / `Decline` / `Cancel` |
| `item/permissions/requestApproval` | 权限提升卡（要新增哪个路径/网络域） | 同上 + `ApplyNetworkPolicyAmendment` |
| `item/tool/requestUserInput` | 追问卡（agent 主动问用户） | 自由文本 / 选项 |

完整 UX 规格（含超时、离线、批量、置顶条）在 10 §3。此处只定位置：**审批卡内联在消息流的时间线上**（不是模态），同时在对话区顶部出现 `z-400` 吸顶条「有 1 项待你确认 ↓」，点击滚动到卡。

### 5.4 排队追问（清单 §5.1）

`thread/queue/*`（exp，FIFO、可重排、可编辑）。执行中输入并发送 → 入队而非报错。UI：

- Composer 上方出现「排队中 (2)」折叠区，每项可编辑（`thread/queue/update`）、删除（`delete`）、拖拽重排（`reorder`）。
- 队列变更由 `thread/queue/changed` 通知驱动。
- 当前回合结束后自动出队执行（`thread/queue/start`）。

### 5.5 中断与转向（清单 §5.6）

| 动作 | 协议 | UI |
|---|---|---|
| 中断 | `turn/interrupt` | 发送按钮变停止（03 §4.6）；`⌘.` 或 `⎋` |
| 中断后补充 | `thread/resume` + `turn/start` | 中断后流里插入分隔线「已中断」+ Composer 聚焦 |
| 不中断直接转向 | `turn/steer` | 输入框旁提供「立即插话」开关；开启时发送走 `steer` 而非入队 |

「立即插话」与「排队」的差别必须在 UI 上说清（tooltip）：插话会打断当前思路、排队会等它做完。默认排队。

### 5.6 子任务

父任务流里以 `SubAgentActivity` 折叠卡呈现（§5.2 #13）。点击展开只读侧滑面板，内容 = 子 thread 的完整 item 流（`thread/items/list?threadId=<child>`）。谱系查询用 `thread/list?ancestorThreadId=` (exp)。并发上限与预算闸门在 10 §5。

---

## 6. 结果区四视图（清单 §6）

顶部 `SegmentedControl` 浅色变体（01 §5.10 —— 它决定"已装内容怎么看"）：`产物 · 文件 · 变更 · 浏览器`。

### 6.1 产物
2 列产物卡网格。卡片 = 类型图标 + 文件名 + 格式 Badge + 版本 + 生成时间 + 缩略预览（若可生成）。动作：打开、在文件夹中显示、另存为、**分享（Q10 授权流）**、查看历史版本。数据来自本机产物索引（08 §2）。

### 6.2 文件（工作空间文件视图）
文件树（`fs/readDirectory` + `fs/watch` 实时刷新）+ 右侧内容预览（`fs/readFile`）。
- 树上标注本次任务改动过的文件（`--accent` 圆点）。
- 预览按类型分派：文本/代码 → 高亮；图片 → 图片查看器；表格 → 只读表格；PDF → 内嵌预览；其他 → 「用系统默认程序打开」。
- **只读**：结果区不提供编辑（编辑走 agent 或用户自己的编辑器），避免与 agent 并发写冲突。

### 6.3 变更
数据来自 `turn/diff/updated`（聚合 diff 字符串，`v2/turn.rs:519-523`）+ 各 `FileChange` item。
- 上方文件列表（含 `+n/-m`），下方逐文件 diff（并排/统一两种视图切换）。
- 范围切换：**本回合 / 本任务全部**。
- 动作：`thread/revert`（撤销某次变更）、`thread/rollback`（回滚到某个回合）—— 两者都必须二次确认并说清影响范围（会不会动磁盘上的文件）。

### 6.4 浏览器（清单 §6.4）
总纲 §3.3 已判定 `BrowserUseConfig` 只是权限策略层，真实浏览器需外部 MCP server（Q9 保留的唯一连接器）。
- UI：地址栏 + 刷新 + 前进后退 + 「在系统浏览器打开」+ 视口尺寸预设。
- 内容渲染在**独立 origin 的 WebView**，与应用主 origin 隔离（R5）。
- 用途：预览 agent 起的本地 web 应用（`http://localhost:*`）、预览 HTML 产物、查看搜索结果页。
- **不做**：让 agent 通过这个 WebView 操作页面 —— agent 侧的浏览器操作走 browser MCP server 的 CDP 通道，两者是不同的东西，UI 上不混在一起。

---

## 7. Visualizer（总纲 §6.10）

agent 用受控 fence 输出，前端识别渲染。**这是 R5（XSS）的落点，规则不可放宽**：

| Fence | 渲染 | 安全 |
|---|---|---|
| ` ```mermaid ` | mermaid → SVG | 库本地打包；`securityLevel: 'strict'`；渲染结果作为 SVG 插入前过一遍白名单清洗（禁 `<script>`、`<foreignObject>`、事件属性） |
| ` ```evowork-chart ` | JSON spec → 图表库 | **spec 先过 JSON Schema 校验**，非法字段拒绝渲染并显示原始 JSON；不允许 spec 内含函数/表达式字符串 |
| ` ```html ` | 沙箱 iframe | **独立 origin**（`sandbox="allow-scripts"` 但**不给** `allow-same-origin`）+ 严格 CSP（`default-src 'none'; style-src 'unsafe-inline'; img-src data:`）+ 禁外链 + 高度上限 600 后内部滚动 |
| 其他 fence | 代码块 | 高亮 + 复制，不执行 |

三类都在渲染框右上角提供「查看源码」与「保存为文件」。主题适配（清单 §11）：mermaid 与 chart 的配色从 01 §2 的 token 注入，暗色自动切换；HTML iframe 注入 `prefers-color-scheme` 但不强制（模型生成的 HTML 自带样式时不覆盖）。

**多图叙事**（清单 §11）：一条 `AgentMessage` 内多个 fence 按顺序纵向排列，不做轮播 —— 对话流里的横向轮播会丢失上下文。

---

## 8. 空态与异常

| 情况 | 表现 |
|---|---|
| 任务无消息（刚创建） | 对话区显示该任务的场景/模式/工作空间摘要卡 + 「输入你的第一个需求」 |
| 任务不在本机（deeplink 跨设备） | 全页提示「该任务创建于其他设备，本机没有它的记录」+ 说明 A 方案不同步（D6）+ 「打开设备中心」 |
| 结果区无产物 | 空态 + 「产物会在这里出现。文档、表格、幻灯片等交付物生成后自动收集」 |
| 工作空间路径已失效 | 顶部 `--danger` 条 + 「重新指定目录」；禁用发送 |
| 事件流断开 | 顶部 `--warning` 条「与执行内核的连接中断，正在重连…」+ 重连后自动 `thread/read` 补齐缺失 item（09 §5） |
| 上下文将满 | 顶部 `--info` 条「上下文即将用满，可压缩早期对话」+ 「压缩」按钮 |
| 预算耗尽 | 顶部 `--warning` 条 + 任务暂停（Q11：暂停并询问，不自动降级）+ 「追加预算 / 结束任务」 |

---

## 9. 性能约束

| 项 | 约束 | 手段 |
|---|---|---|
| 长对话 | 1000+ item 不卡 | 虚拟滚动 + item 级 memo + 折叠项不渲染内容 |
| 流式 | 高频 delta 不掉帧 | delta 按 60fps 节流合并，单帧最多一次重排 |
| 命令输出 | 单命令 100MB 输出不 OOM | 尾部 500 行滚动窗口，完整输出落本机文件、按需读取 |
| diff | 万行 diff | 虚拟化 diff 视图 + 首屏 40 行 |
| 任务列表 | 上千任务 | 虚拟滚动 + cursor 分页 + 投影表索引 |
| 首屏 | 打开任务 < 300ms 出内容 | 先渲染投影表缓存的最后 20 条 item，再用 `thread/items/list` 校正 |
