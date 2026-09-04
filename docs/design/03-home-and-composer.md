# 03 · 首页与输入区

> 上游：[总纲 §6.2](../evowork-on-codex-design.md)（工作模式）· D8 · [清单 §3 / §5.1 / §5.3](../agent-platform-feature-list.md)
> UI 基线：截图 1。组件引用 [01 §5](01-ui-design-system.md)。

## 1. 页面结构（截图 1 复刻）

```
主内容区（内容列 800 居中）
  46 ┌ Hero          display「EvoWork，我帮你」
  24 ├ 场景切换       SegmentedControl 深色 · 日常办公 / 代码开发 / 设计创意
  40 ├ 场景 chips     ScenarioChip × N，横向滚动 + 溢出箭头
  16 ├ Composer      ComposerShell（180，自增至 396）
  32 ├ 区块标题       「不知道做什么，试试最佳实践案例」+ 换一批 + 关闭
  12 └ 案例卡         CaseCard × 4（191 × 12 gap）

标题栏带右端         slot.titlebar-promo（默认关闭，01 §7.4）
主区右上             slot.activity-popover + 吉祥物（默认关闭）
```

首页不创建 Thread。用户发送第一条消息时才 `thread/start` + `turn/start`，随后路由跳到 `/tasks/:threadId`（09 §3.2）。因此**从首页离开不产生空任务**，也不需要"草稿任务"概念。

---

## 2. 场景（Scenario）—— 本文档集新增的一等概念

### 2.1 它是什么，不是什么

截图的「日常办公 / 代码开发 / 设计创意」是**场景**，不是总纲 §6.2 的工作模式（Craft / Plan / Ask）。两者正交：

| | 场景 | 工作模式 |
|---|---|---|
| 回答的问题 | 「我在做哪一类活」 | 「你能动手到什么程度」 |
| 影响 | 默认模型、默认权限、启用技能集、提示片段、推荐 chips、默认工作空间 | developer instructions、沙箱与审批策略、写工具是否可用 |
| 数量 | 3（可扩展） | 3（固定，D8） |
| 位置 | Hero 下方 `SegmentedControl`（决定页面装什么 → 深色变体，01 §5.9） | Composer 底栏 `InlineSelect`（03 §4.5） |
| 内核对应 | 无 —— 纯 EvoWork 概念，展开后落到 `turn/start` 参数 | `ModeKind` + 权限 profile |

把它们做成一个控件会产生 3×3 = 9 种组合的解释负担，且"设计创意 + Ask"这种组合本身合理（只讨论方案不产图），不该被合并掉。

### 2.2 数据模型

`config/scenarios/*.toml`，随产品分发，企业可通过私有源覆盖：

```toml
# config/scenarios/office.toml
id            = "office"
name          = "日常办公"
icon          = "cup"
order         = 10
default       = true

# 展开到 turn/start 的部分
model         = "evowork/deepseek-chat"        # 可被用户在 ModelSelect 里覆盖
reasoning_effort = "medium"
permissions   = "evowork-workspace"            # config.toml 的 [permissions.<id>]
mode          = "craft"                        # 默认工作模式
instructions_file = "modes/craft-office.md"    # 拼进 developer_instructions

# 影响可用能力
skills        = ["documents", "spreadsheets", "presentations", "charts"]
connectors    = []                             # Q9：本期只有 browser，办公场景默认不开
experts_recommended = ["report-writer", "data-analyst", "finance-analyst"]

# 影响首页
[[chips]]
label  = "文档处理"
icon   = "file-text"
prompt = "帮我处理这些文档："
[[chips]]
label  = "数据分析及可视化"
icon   = "pie-chart"
prompt = "分析这份数据并给出可视化："
```

三个 v1 场景与截图一致：`office`（日常办公，默认）· `code`（代码开发）· `design`（设计创意）。截图 1 的 5 个 chips（文档处理 / 金融服务 / 数据分析及可视化 / 个人工作台 / 幻灯片）即 `office` 场景的 `chips`。

### 2.3 为什么必须自建，不能用内核的 preset 机制

内核有 `CollaborationModeMask`（`name` / `mode` / `model` / `reasoning_effort` / `developer_instructions`，`protocol/src/config_types.rs:786`）和 `collaborationMode/list` (exp)，看起来正好能装场景。**但实测 `list_collaboration_modes()` 返回硬编码的 builtins（仅 plan + default），不读任何配置**（`models-manager/src/manager.rs:322`、`models-manager/src/collaboration_mode_presets.rs:16`，2026-09-04 核对 @ `728cb12fe5`，见 README F3）。

结论：
- 场景目录由 **EvoWork 服务层持有**，不试图注册进内核；
- 每次 `turn/start` 由适配层把场景 + 模式 + 用户覆盖项**展开为完整参数**下发；
- 前端不调 `collaborationMode/list`（它只会返回 Plan/Default 两项，对 UI 无用）。

这条是"能放外面就不放里面"（CLAUDE.md §4）的正例：零内核改动、零补丁。

### 2.4 展开规则（场景 + 模式 + 用户覆盖 → `turn/start`）

优先级从低到高：**场景默认值 → 工作模式 → 用户在 Composer 里的显式选择**。

```jsonc
// 场景=office, 模式=craft, 用户改了模型
{
  "threadId": "...",
  "input": [ /* … */ ],
  "cwd": "/Users/x/work/weekly",
  "collaborationMode": {
    "mode": "default",                       // craft/ask → default；plan → plan（F2：只有两个枚举值）
    "settings": {
      "model": "evowork/glm-flash",          // 用户覆盖胜出
      "reasoning_effort": "medium",
      "developer_instructions": "<场景片段 + 模式片段 拼接>"
    }
  },
  "permissions": "evowork-workspace"         // 命名 profile；不与 sandboxPolicy 同传（F5）
}
```

- `collaborationMode` 与 `permissions` 都是实验字段，经 09 §3 适配层调用，前端只传语义化的 `{scenarioId, modeId, overrides}`。
- `developer_instructions` 的拼接顺序固定为 **模式片段在前、场景片段在后**（场景更具体，后写的优先），并在末尾附加运行时上下文（当前日期、工作空间路径、可用技能清单摘要）。
- 模式片段文件：`config/modes/{craft,plan,ask}.md`。**它们不进内核仓库** —— 这是 README §4.1 里 P3 补丁得以取消的原因。

### 2.5 场景切换的交互

- 切换即时生效：chips 整行替换（`--dur-base` 淡出淡入 + 8pt 横移）、`ModelSelect` 与权限选择器回落到新场景默认值、**已输入的文本保留**。
- 若用户已手动改过模型/权限/模式，切换场景时**保留用户的选择**并在该控件旁显示 4px `--accent` 圆点表示"已被你改过"；点击圆点可一键回落场景默认值。
- 场景选择持久化到本机（下次冷启动恢复），但**不跨设备同步**（Q1=A）。
- 已存在的任务不受场景切换影响：场景只在 thread 创建时决定初值，之后由任务自身的设置接管（04 §4.3）。

---

## 3. Hero 与场景 chips

### 3.1 Hero
`display` 36/700，文案「EvoWork，我帮你」。**不做打字机动画**（每次进首页都动会烦）。窗口高 < 720 时 Hero 降为 `title-1` 且顶距降到 24，保证 Composer 不被挤出首屏。

### 3.2 场景 chips
- 数据来自当前场景的 `chips`，最多渲染 8 个，溢出走 `FilterChipRow` 的横向滚动 + 右端 28 圆形箭头（01 §5.11，截图 1 右端即此物）。
- 点击行为：**把 `prompt` 写入 Composer 并聚焦到末尾，不发送**。若 chip 声明了 `requires_file = true`（如「文档处理」），同时打开文件选择器。
- 键盘：`⌥1`–`⌥8` 对应前 8 个 chip。

---

## 4. Composer 详细交互

结构见 01 §5.13。本节定义行为。

### 4.1 占位文案
```
今天帮你做些什么？  @ 引用对话文件，/ 调用技能与指令
```
与截图一致。两段用 `--text-tertiary`，后半段字号同前但可略淡（`opacity .85`），提示两个入口的存在。

### 4.2 `@` 引用
触发字符 `@`，弹出 `Menu`（锚定光标）。四类候选混排，输入即过滤：

| 类别 | 数据源 | 插入为 |
|---|---|---|
| 工作空间文件 | `fs/readDirectory` + 内核 file-search 模糊匹配 | `UserInput::Mention { name, path }` |
| 已上传附件 | 本机 upload 记录（08 §5） | `Mention`（指向 `uploads/` 下解析产物） |
| 技能 | `skills/list` | `UserInput::Skill { name, path }` |
| 资料库条目 | 本机资料索引（06） | `Mention` |

渲染：输入框内显示为不可分割的 token（`--bg-sunken` 圆角 6 + 图标 14 + 名称），退格整块删除。底层同时维护 `text` + `textElements`（`UserInput::Text.text_elements`，`protocol/src/user_input.rs:16-24`）以便历史与 resume 保真。

### 4.3 `/` 命令
触发字符 `/` 且**必须在行首**（避免路径里的斜杠误触发）。两类：
- **技能直调**：`/ppt`、`/表格` → 插入 `UserInput::Skill` 并在提示词里前置技能名。
- **本地指令**（不发给模型，前端/服务层直接执行）：`/新建自动化`、`/切换到只读`、`/清空`、`/打开工作空间`、`/查看用量`。本地指令项在菜单里用 `--info` 图标区分，防止用户误以为发给了模型。

### 4.4 附件（`+` 按钮 / 拖拽 / 粘贴）

清单 §5.3 要求的类型全部在此收口。因为 `UserInput` 没有文档类型（README F6），所有非图片文件都要先过解析管道：

| 输入 | 处理 |
|---|---|
| 粘贴截图 `⌘V` | 直接 `UserInput::Image`（data URI）；同时落盘到 `uploads/` 便于回看 |
| 拖入 / 选择图片 | `UserInput::LocalImage`（路径） |
| 拖入 PDF/Word/Excel/PPT/TXT/MD/RTF/CSV/ZIP | **走本机解析管道**（08 §3），落 `uploads/`，注入为 `Text(摘要+路径)` + 关键页 `Image` |
| 拖入代码文件 | 直接 `Mention`（不解析，agent 用 shell 读） |
| 拖入文件夹 | 提示"是否把该文件夹设为工作空间"，而不是逐个上传 |

附件在 Composer 内以缩略卡呈现（高 56，含类型图标 + 文件名 + 大小 + 解析进度 + 移除）。解析中允许继续输入但**发送按钮禁用**，并提示「正在本地解析 2 个文件…」。解析失败的文件保留卡片 + `--danger` 态 + 「以原始文件引用」备选（让 agent 自己用 shell 试）。

**隐私文案（K6/Q3 的对外表达点）**：附件区下方常驻一行 `caption`：「文件在本机解析，原始文件不上传。」这句话必须为真 —— 08 §4 保证没有云端兜底路径。

### 4.5 底栏三个选择器

截图 1 有两个（「选择工作空间 ∨」「默认权限 ∨」）。工作模式需要第三个 —— 按 README §2 原则做**同族受控扩展**：同一 `InlineSelect` 组件、同一行、紧邻右侧。

```
[📁 选择工作空间 ▾]   [✓ 默认权限 ▾]   [⚡ Craft ▾]
```

| 选择器 | 数据源 | 选项 | 默认 |
|---|---|---|---|
| 工作空间 | `project/list` (exp) + 最近使用 | 已有空间列表 · 「选择文件夹…」· 「临时目录（不保存）」 | 场景默认；无则未选（占位态） |
| 权限 | **`permissionProfile/list`**，返回 `{id, description, allowed}`（`v2/permissions.rs:406`，README F4） | `:workspace`（默认可写）· `:read-only`(只读) · `:danger-full-access`（完全访问）· 自定义 `[permissions.*]` | 场景的 `permissions` |
| 模式 | 静态三项 | Craft 你说我做 · Plan 先想后做 · Ask 只谈不做 | 场景的 `mode` |

**权限选择器的三条硬规则**（对齐 10 §2）：
1. `allowed = false` 的项**渲染为禁用并显示原因**（「已被企业策略锁定」），不隐藏 —— 用户需要知道存在这个档位但自己不能选。
2. 选择 `:danger-full-access` 必须过一次二次确认模态，文案列出它意味着什么（可读写全盘、可访问网络），确认后仅对**当前任务**生效，不改全局默认。
3. 权限描述文案直接用协议返回的 `description`（内核已本地化不了中文的话，由适配层做 id→中文文案映射表，见 10 §2.2）。

**模式选择器的联动**：选 Ask 时，权限选择器自动切到只读并置为禁用（tooltip：「Ask 模式固定为只读」）；切回 Craft/Plan 时恢复用户上一次的权限选择。这避免了"Ask 模式 + 完全访问"这种自相矛盾的组合。

### 4.6 发送与执行中

| 态 | SendButton | 输入框 |
|---|---|---|
| 空 | 禁用（`--bg-selected`） | 可输入 |
| 有内容 | `--bg-inverse` 上箭头 | 可输入 |
| 解析中 | 禁用 + 提示文案 | 可输入 |
| 执行中（在任务页） | 变 `--danger` 方形 = 中断（`turn/interrupt`） | 可输入 → 见 04 §5.8 排队/steer |
| 超预算暂停 | 变 `--warning` = 「追加预算继续」 | 可输入 |

发送后：`thread/start` → `turn/start` → 路由到 `/tasks/:id`。首页 Composer 的所有状态（文本、附件、选择器）迁移到任务页 Composer，用户视觉上是"输入框留在原地、周围长出了对话"。

### 4.7 语音（麦克风）

复用 `thread/realtime/*`（exp）：`start` → `appendAudio` → 文本增量回填输入框。规格：
- 点击开始，再次点击停止；录音中按钮变 `--danger` + 波形指示。
- **默认转写为文本填入输入框，不直接发送**（防误触发执行）。
- 语音数据只在内存与本次请求内，不落盘（K6）；若模型 provider 不支持音频输入，网关按 D2 显式声明能力缺失，前端**隐藏麦克风按钮**而不是点了报错。

---

## 5. 案例位（`slot.showcase`）

截图 1 底部的「不知道做什么，试试最佳实践案例」+ 4 张卡 + 换一批 + 关闭。

| 项 | 设计 |
|---|---|
| 内容来源 | 随包分发的官方案例包（`config/showcase/*.toml`：标题、封面、场景、提示词、可选预置附件）；企业私有源可覆盖 |
| 是否联网 | **不需要**。随包 + 私有源下发，避免为了 4 张卡新增一条出网路径（K6） |
| 换一批 | 在本地案例池里按当前场景过滤后随机取 4，不重复上一批 |
| 关闭 | 本机持久化；可从「更多 → 灵感」重新进入完整案例库 |
| 点击 | 写入 Composer（提示词 + 预选场景 + 预置附件），**不自动发送** |
| 按场景过滤 | 是。切换场景时案例整批替换 |

封面图随包会显著增大安装体积（R10）。规则：**封面统一 382×215 WebP，单图 ≤ 40KB，案例池 ≤ 24 个 → 总计 < 1MB**；超出的案例只给纯文字卡（无封面时 `CaseCard` 降级为 `--bg-sunken` 底 + 大号图标）。

---

## 6. 运营位（Q18 待决策）

截图 1 有三处运营内容：标题栏 pill「做任务赢积分好礼 ›」、活动 Popover「致敬好老师… 领1000积分」+ 吉祥物、侧边栏 `PromoCard`「Buddy加油站·8期」。

按 README §5 的 Q18 默认方案：**布局插槽保留、默认关闭、不实现积分体系**。本文档只定义插槽契约，内容形态待产品决策：

```toml
# config/slots.toml —— 企业版可被 requirements.toml 强制置空
[slots.titlebar-promo]
enabled = false
[slots.activity-popover]
enabled = false
[slots.sidebar-promo]
enabled = false
[slots.showcase]
enabled = true          # 唯一默认开启的，且内容是官方最佳实践而非营销
```

插槽内容渲染规则：只接受**静态内容**（文案 + 图标 + 一个跳转目标），**不接受任何回传埋点**。若 Q18 决策要做积分体系，需要新增的东西不是 UI，而是：云端活动服务 + 用户行为上报通道 + 与 Q3 隐私口径的对齐结论 + 企业版的关闭开关。这三项都不在当前 53 人周的范围里，应单列里程碑。

---

## 7. 数据来源与调用汇总

| UI 元素 | 来源 | 时机 |
|---|---|---|
| 场景切换 / chips | 本机 `config/scenarios/*.toml` | 启动时加载，文件变更热重载 |
| 模型下拉 | `model/list` + `modelProvider/capabilities/read` | 启动时 + 手动刷新 |
| 权限下拉 | `permissionProfile/list` | 启动时 + 策略包更新后 |
| 工作空间下拉 | `project/list` (exp) + 本机最近使用表 | 启动时 + `project/changed` 通知 |
| 技能候选（`@` / `/`） | `skills/list` + `skills/changed` 通知 | 启动时 + 通知增量 |
| 案例卡 | 本机案例池 | 启动时 |
| 附件解析 | 本机解析服务（08） | 拖入时 |
| 发送 | `thread/start` → `turn/start` | 用户操作 |

---

## 8. 空态与异常

| 情况 | 表现 |
|---|---|
| 未选工作空间就发送 | 不报错，弹出工作空间选择器并保留输入；若用户选「临时目录」，用 `~/.evowork/scratch/<date>-<n>/` 并在任务页顶部提示"这是临时目录，产物不会长期保留" |
| 模型不可用（网关不通 / 未登录） | Composer 顶部插入 `--danger` 提示条 + 「检查模型接入」；发送按钮禁用。**不静默降级到其他模型** |
| 模型能力缺失（如不支持图片） | 附件区拒绝图片并说明「当前模型不支持图片输入，可切换模型」（D2：降级必须显式） |
| 场景配置损坏 | 回落到内置 `office` 场景 + Toast 提示，不白屏 |
| 解析运行时未安装（首运行第 ⑤ 步跳过） | 拖入文档时提示「需要安装本地解析组件（约 180MB）」+ 「安装」/「以原始文件引用」两个出路 |
| 本机并发已满（Q11：3） | 发送按钮变「排队中（前面 1 个）」，允许取消排队；不阻塞输入 |
