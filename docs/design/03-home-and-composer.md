# 03 · 首页与输入区

> 上游：[总纲 §6.2](../evowork-on-codex-design.md)（工作模式）· D8 · [清单 §3 / §5.1 / §5.3](../agent-platform-feature-list.md)
> UI 基线：[类 ChatGPT UI 设计方案](../chatgpt-like-ui-design.md)（Approved）。组件引用 [01 §5](01-ui-design-system.md)。

## 1. 页面结构

```
主内容区（内容列 800 居中）
  ┌ 弹性留白
  ├ 问候语          display/title-1「今天想完成什么？」
  ├ Composer        ComposerShell（随内容自增高）
  ├ 上下文建议       ContextSuggestionChip × 0–4
  └ 说明文字         「AI 可能犯错；重要结果请在交付前确认」
```

首页不创建 Thread。用户发送第一条消息时才 `thread/start` + `turn/start`，随后路由跳到 `/tasks/:threadId`（09 §3.2）。因此**从首页离开不产生空任务**，也不需要“草稿任务”概念。

首页不展示常驻场景分段控件、案例墙、轮播推荐、活动或运营位。建议只是开始任务的可选捷径，不是开始任务的门槛。

---

## 2. 场景（Scenario）—— 本文档集新增的一等概念

### 2.1 它是什么，不是什么

“日常办公 / 代码开发 / 设计创意”保留为**内部场景配置**，不是首页必须先选的一级控件，也不是总纲 §6.2 的工作模式（Craft / Plan / Ask）。两者正交：

|            | 场景                                                               | 工作模式                                               |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------ |
| 回答的问题 | 「我在做哪一类活」                                                 | 「你能动手到什么程度」                                 |
| 影响       | 默认模型、默认权限、启用技能集、提示片段、推荐 chips、默认工作空间 | developer instructions、沙箱与审批策略、写工具是否可用 |
| 数量       | 3（可扩展）                                                        | 3（固定，D8）                                          |
| 位置       | 默认不常显；用于生成上下文建议与新任务默认值                     | Composer 工具行（03 §4.5）                             |
| 内核对应   | 无 —— 纯 EvoWork 概念，展开后落到 `turn/start` 参数                | `ModeKind` + 权限 profile                              |

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
model         = "evowork/deepseek-v4-flash"   # 可被用户在 ModelSelect 里覆盖
reasoning_effort = "medium"
permissions   = "evowork-workspace"            # config.toml 的 [permissions.<id>]
mode          = "craft"                        # 默认工作模式
instructions_file = "modes/craft-office.md"    # 拼进 developer_instructions

# 影响可用能力
skills        = ["documents", "spreadsheets", "presentations", "charts"]
connectors    = []                             # Q9：本期只有 browser，办公场景默认不开
experts_recommended = ["report-writer", "data-analyst", "finance-analyst"]

# 影响首页的上下文建议
[[chips]]
label  = "文档处理"
icon   = "file-text"
prompt = "帮我处理这些文档："
[[chips]]
label  = "数据分析及可视化"
icon   = "pie-chart"
prompt = "分析这份数据并给出可视化："
```

三个 v1 内部场景为 `office`（日常办公，默认）· `code`（代码开发）· `design`（设计创意）。场景只影响默认参数和候选建议，首页从当前上下文选出最多 4 个建议，不把全部场景及 chips 平铺给用户。

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
    "input": [/* … */],
    "cwd": "/Users/x/work/weekly",
    "collaborationMode": {
        "mode": "default", // craft/ask → default；plan → plan（F2：只有两个枚举值）
        "settings": {
            "model": "evowork/glm-flash", // 用户覆盖胜出
            "reasoning_effort": "medium",
            "developer_instructions": "<场景片段 + 模式片段 拼接>",
        },
    },
    "permissions": "evowork-workspace", // 命名 profile；不与 sandboxPolicy 同传（F5）
}
```

- `collaborationMode` 与 `permissions` 都是实验字段，经 09 §3 适配层调用，前端只传语义化的 `{scenarioId, modeId, overrides}`。
- `developer_instructions` 的拼接顺序固定为 **模式片段在前、场景片段在后**（场景更具体，后写的优先），并在末尾附加运行时上下文（当前日期、工作空间路径、可用技能清单摘要）。
- 模式片段文件：`config/modes/{craft,plan,ask}.md`。**它们不进内核仓库** —— 这是 README §4.1 里 P3 补丁得以取消的原因。
- **产品身份不在 `developer_instructions` 里。** 那一层只叠加，盖不住内核写死的「You are a coding agent running in the Codex CLI」。身份走同一次建任务的 `thread/start.baseInstructions`（F25，`config/prompts/base-instructions.md` 是内核 `default.md` 的 fork，只改身份段）。相对路径的 `model_instructions_file` 按 cwd 解析，不能写进配置模板。系统技能 `openai-docs` 按名字关掉：它把「you / this app」绑到 Codex 文档上。

### 2.5 场景配置的交互

- 首页不提供常驻场景切换器。系统可以根据最近项目、附件类型和本机配置选择建议与默认值，但不得自动发送或在用户不知情时提升权限。
- 用户通过建议、插件或项目入口开始时，可携带 `scenarioId` 作为默认参数；用户在 Composer 明确选择的模型、模式、项目和权限始终优先。
- 场景偏好只在本机保存，不跨设备同步（Q1=A）。
- 已存在任务不受场景建议变化影响：场景只在 thread 创建时决定初值，之后由任务自身设置接管（04 §4）。

---

## 3. 问候语与上下文建议

### 3.1 问候语

`display` 36/700，默认文案“今天想完成什么？”。不重复展示品牌名，不做打字机动画。窗口高 < 720 时降为 `title-1` 并压缩顶部留白，保证 Composer 始终在首屏。

### 3.2 上下文建议

- 根据本机场景配置、最近项目和当前可用能力选择 0–4 个建议；不为了填满数量展示低相关内容。
- 点击只把 `prompt` 写入 Composer 并聚焦到末尾，不发送。需要文件的建议可同时打开文件选择器。
- 用户开始输入、加入附件或任务开始后，建议立即消失。
- 建议不采用横向轮播或“换一批”，避免把首页变成内容发现页。

---

## 4. Composer 详细交互

结构见 01 §5.13。本节定义行为。

### 4.1 占位文案

```
描述你的目标，或添加文件开始…
```

占位文案只说明任务目标，不把快捷语法堆在首屏；`@` 与 `/` 可继续作为高级输入能力，并在用户输入对应字符时渐进出现。

### 4.2 `@` 引用

触发字符 `@`，弹出 `Menu`（锚定光标）。四类候选混排，输入即过滤：

| 类别         | 数据源                                         | 插入为                                  |
| ------------ | ---------------------------------------------- | --------------------------------------- |
| 工作空间文件 | `fs/readDirectory` + 内核 file-search 模糊匹配 | `UserInput::Mention { name, path }`     |
| 已上传附件   | 本机 upload 记录（08 §5）                      | `Mention`（指向 `uploads/` 下解析产物） |
| 技能         | `skills/list`                                  | `UserInput::Skill { name, path }`       |
| 资料库条目   | 本机资料索引（06）                             | `Mention`                               |

渲染：输入框内显示为不可分割的 token（`--bg-sunken` 圆角 6 + 图标 14 + 名称），退格整块删除。底层同时维护 `text` + `textElements`（`UserInput::Text.text_elements`，`protocol/src/user_input.rs:16-24`）以便历史与 resume 保真。

### 4.3 `/` 命令

触发字符 `/` 且**必须在行首**（避免路径里的斜杠误触发）。两类：

- **技能直调**：`/ppt`、`/表格` → 插入 `UserInput::Skill` 并在提示词里前置技能名。
- **本地指令**（不发给模型，前端/服务层直接执行）：`/新建自动化`、`/切换到只读`、`/清空`、`/打开工作空间`、`/查看用量`。本地指令项在菜单里用 `--info` 图标区分，防止用户误以为发给了模型。

### 4.4 附件（`+` 按钮 / 拖拽 / 粘贴）

`+ 添加`菜单统一收口：添加本地文件、从资料库选择、引用项目文件、使用插件、管理插件和更多选项。主路径只展示已接通动作；未接通项默认隐藏。

清单 §5.3 要求的文件类型全部在此收口。因为 `UserInput` 没有文档类型（README F6），所有非图片文件都要先过解析管道：

| 输入                                       | 处理                                                                                  |
| ------------------------------------------ | ------------------------------------------------------------------------------------- |
| 粘贴截图 `⌘V`                              | 直接 `UserInput::Image`（data URI）；同时落盘到 `uploads/` 便于回看                   |
| 拖入 / 选择图片                            | `UserInput::LocalImage`（路径）                                                       |
| 拖入 PDF/Word/Excel/PPT/TXT/MD/RTF/CSV/ZIP | **走本机解析管道**（08 §3），落 `uploads/`，注入为 `Text(摘要+路径)` + 关键页 `Image` |
| 拖入代码文件                               | 直接 `Mention`（不解析，agent 用 shell 读）                                           |
| 拖入文件夹                                 | 提示"是否把该文件夹设为工作空间"，而不是逐个上传                                      |

附件在 Composer 内以缩略卡呈现（高 56，含类型图标 + 文件名 + 大小 + 解析进度 + 移除）。解析中允许继续输入但**发送按钮禁用**，并提示「正在本地解析 2 个文件…」。解析失败的文件保留卡片 + `--danger` 态 + 「以原始文件引用」备选（让 agent 自己用 shell 试）。

**隐私文案（K6/Q3 的对外表达点）**：附件区下方常驻一行 `caption`：「文件在本机解析，原始文件不上传。」这句话必须为真 —— 08 §4 保证没有云端兜底路径。

### 4.5 工具行与渐进披露

Composer 工具行按使用频率分层：

```
[+ 添加] [⚡ Craft ▾] [📁 项目：季度汇报 ▾] ··· [模型名 ▾] [发送]
```

| 层级 | 内容 | 规则 |
| --- | --- | --- |
| 常显 | 添加、当前模型、发送/停止 | 完成任务所需的最小集合 |
| 次级 | 工作模式、项目 | 可显示当前值，空间不足时收入菜单 |
| 高级 | 权限、预算、记忆、连接器策略 | 收入“更多选项”，危险权限仍需二次确认 |

| 选择器 | 数据源 | 选项 | 默认 |
| --- | --- | --- | --- |
| 项目 | `project/list` (exp) + 最近使用 | 已有项目 · “选择文件夹…” · “临时目录（不保存）” | 场景或最近项目；无则未选 |
| 权限 | **`permissionProfile/list`**，返回 `{id, description, allowed}`（README F4） | `:workspace` · `:read-only` · `:danger-full-access` · 企业自定义项 | 场景默认；位于更多选项 |
| 模式 | 静态三项 | Craft 你说我做 · Plan 先想后做 · Ask 只谈不做 | 场景默认 |

**权限选择器的三条硬规则**（对齐 10 §2）：

1. `allowed = false` 的项**渲染为禁用并显示原因**（「已被企业策略锁定」），不隐藏 —— 用户需要知道存在这个档位但自己不能选。
2. 选择 `:danger-full-access` 必须过一次二次确认模态，文案列出它意味着什么（可读写全盘、可访问网络），确认后仅对**当前任务**生效，不改全局默认。
3. 权限描述文案直接用协议返回的 `description`（内核已本地化不了中文的话，由适配层做 id→中文文案映射表，见 10 §2.2）。

**模式选择器的联动**：选 Ask 时，权限选择器自动切到只读并置为禁用（tooltip：「Ask 模式固定为只读」）；切回 Craft/Plan 时恢复用户上一次的权限选择。这避免了"Ask 模式 + 完全访问"这种自相矛盾的组合。

### 4.6 发送与执行中

| 态                 | SendButton                                    | 输入框                         |
| ------------------ | --------------------------------------------- | ------------------------------ |
| 空                 | 禁用（`--bg-selected`）                       | 可输入                         |
| 有内容             | `--bg-inverse` 上箭头                         | 可输入                         |
| 解析中             | 禁用 + 提示文案                               | 可输入                         |
| 执行中（在任务页） | 变 `--danger` 方形 = 中断（`turn/interrupt`） | 可输入 → 见 04 §5.4–§5.5 排队/steer |
| 超预算暂停         | 变 `--warning` = 「追加预算继续」             | 可输入                         |

发送后：`thread/start` → `turn/start` → 路由到 `/tasks/:id`。首页 Composer 的所有状态（文本、附件、选择器）迁移到任务页 Composer，用户视觉上是"输入框留在原地、周围长出了对话"。

### 4.7 语音（麦克风）

复用 `thread/realtime/*`（exp）：`start` → `appendAudio` → 文本增量回填输入框。规格：

- 点击开始，再次点击停止；录音中按钮变 `--danger` + 波形指示。
- **默认转写为文本填入输入框，不直接发送**（防误触发执行）。
- 语音数据只在内存与本次请求内，不落盘（K6）；若模型 provider 不支持音频输入，网关按 D2 显式声明能力缺失，前端**隐藏麦克风按钮**而不是点了报错。

---

## 5. 首页内容边界

- 不展示常驻案例墙、轮播推荐、积分、活动 Popover、吉祥物或侧栏运营卡。
- `config/showcase` 与旧 slot 配置不再是新版首页的实现依赖。
- 若未来实现案例库或运营系统，必须作为独立需求重新评审，不得通过已有空 slot 绕过信息架构评审。
- 首页唯一可变内容是 §3.2 的少量上下文建议；它们由本机数据生成，不发送埋点，也不自动执行。

---

## 7. 数据来源与调用汇总

| UI 元素               | 来源                                             | 时机                            |
| --------------------- | ------------------------------------------------ | ------------------------------- |
| 上下文建议            | 本机 `config/scenarios/*.toml` + 最近项目        | 启动时与上下文变化时计算        |
| 模型下拉              | **网关的 `GET /v1/evowork/models`**（不是 `model/list`，见 F24） | 启动时 + 手动刷新（网关不通时「检查模型接入」重试） |
| 权限下拉              | `permissionProfile/list`                         | 启动时 + 策略包更新后           |
| 项目下拉              | `project/list` (exp) + 本机最近使用表            | 启动时 + `project/changed` 通知 |
| 技能候选（`@` / `/`） | `skills/list` + `skills/changed` 通知            | 启动时 + 通知增量               |
| 附件解析              | 本机解析服务（08）                               | 拖入时                          |
| 发送                  | `thread/start` → `turn/start`                    | 用户操作                        |

**模型下拉为什么不用 `model/list`（F24，2026-09-06 订正）**：本文原先写的是
`model/list` + `modelProvider/capabilities/read`。**那条不成立**，决定性的理由是
**只有网关知道哪家厂商的密钥真的配好了** —— 内核会把连不上的模型也列进下拉，
用户选中之后要等到发出一句话、任务失败才知道，而 §8 要求的恰恰相反：
**模型不可用要在发送之前就说**。另两条：不配 `model_catalog_json` 时内核的
`model/list` 返回的是 OpenAI 的型号清单（K5 的对外品牌字符串 + K6 未登记的出网路径）；
内核的 `Model` 结构里与能力徽标对得上的只有 `input_modalities`。

用户在下拉里选的模型按 §2.4 的优先级展开进 `turn/start`（用户显式选择 > 模式 > 场景默认），
**并同时写进任务级设置** —— 只传不存的话，下一回合会从投影表读回旧值，
表现是"切了模型只生效一轮，然后悄悄换回去"。

---

## 8. 空态与异常

| 情况                                  | 表现                                                                                                                                               |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 未选项目就发送                        | 不报错，弹出项目选择器并保留输入；若用户选“临时目录”，用 `~/.evowork/scratch/<date>-<n>/` 并在任务页顶部提示“这是临时目录，产物不会长期保留”       |
| 模型不可用（网关不通 / 未登录 / **没配厂商密钥**） | Composer 顶部插入 `--danger` 提示条 + 「检查模型接入」；没配密钥时**同时给出录入框**（写 `~/.evowork/gateway.env` 并拉起本机网关）。发送按钮禁用。**不静默降级到其他模型** |
| 模型能力缺失（如不支持图片）          | 附件区拒绝图片并说明「当前模型不支持图片输入，可切换模型」（D2：降级必须显式）                                                                     |
| 场景配置损坏                          | 回落到内置 `office` 场景 + Toast 提示，不白屏                                                                                                      |
| 解析运行时未安装（首运行第 ⑤ 步跳过） | 拖入文档时提示「需要安装本地解析组件（约 180MB）」+ 「安装」/「以原始文件引用」两个出路                                                            |
| 本机并发已满（Q11：3）                | 发送按钮变「排队中（前面 1 个）」，允许取消排队；不阻塞输入                                                                                        |
