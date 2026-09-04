# EvoWork 详细设计文档集 —— 索引

## 0. 这套文档是什么

[docs/evowork-on-codex-design.md](../evowork-on-codex-design.md)（下称**总纲**）确定了架构、决策 D1–D9、产品决策 Q1–Q16、里程碑 M0–M9 与风险 R1–R11。本目录是它的**下一层细化**：把每个模块拆到"能直接开工"的粒度 —— 页面规格、组件规格、数据模型、协议调用序列、状态机、文案。

| 项 | 内容 |
|---|---|
| 版本 | v0.1 |
| 日期 | 2026-09-04 |
| 作者 | li.wang |
| 上游内核签出 | `openai/codex` @ `728cb12fe5`（本文所有 `path:line` 于 2026-09-04 在此提交上**实测核对**） |
| UI 基线 | 产品评审附件的 4 张界面截图（见 §3） |
| 状态 | 待评审。含 **4 个新开放问题 Q17–Q20**、**5 条跨模块的总纲修订**（§6）与 **18 条模块级修订建议**（各文档末章，§6.1 汇总） |

**分工边界**：总纲是决策的唯一真源（D\*/Q\*/K\*/M\*/R\*），本目录**不重复也不推翻**它，只做展开。若细化过程中发现总纲的某条判断与内核实际不符，处理方式是在本文 §4 登记修订项、并按 CLAUDE.md §9「改架构先改文档」回写总纲，**不在细化文档里悄悄改口**。

---

## 1. 文档地图

| # | 文档 | 覆盖 | 对应总纲 / 清单 |
|---|---|---|---|
| 01 | [UI 设计系统](01-ui-design-system.md) | 设计 token、布局栅格、32 个组件规格、图标、状态/空态、暗色推导、可访问性 | 清单 §13；总纲 §3.8（[自建]） |
| 02 | [信息架构与导航](02-information-architecture.md) | 7 个侧边栏入口、路由表、页面清单、快捷键、deeplink、通知中心、设备中心 | 清单 §13；总纲 §6.1 |
| 03 | [首页与输入区](03-home-and-composer.md) | 场景包模型、场景切换、场景 chips、Composer（@ / 斜杠 / 附件 / 模型 / 权限 / 模式 / 工作空间 / 语音）、案例位、运营位插槽 | 清单 §3、§5.1、§5.3；总纲 §6.2、D8 |
| 04 | [任务工作台](04-task-workspace.md) | 三栏布局、任务列表（分组/置顶/筛选/搜索）、19 类 Item 渲染规范、审批卡、排队与中断、结果区四视图、任务状态投影 | 清单 §4、§5、§6；总纲 §6.1、§6.10 |
| 05 | [专家 · 技能 · 连接器](05-experts-skills-connectors.md) | 三 Tab 页面规格、卡片模型、安装/信任流程、P0/P1/P2 审计映射、Q5 约束下的降级形态、「发现应用」抽屉 | 清单 §8、§9、§10；总纲 §6.3–6.5 |
| 06 | [资料库](06-library.md) | **总纲缺失模块**：本地产物 / 我的资料 / 团队空间 / 分享收件、三栏规格、与 K6/D9/Q10 的冲突处理 | 清单 §6.2–6.3、§12；总纲 D6、D9 |
| 07 | [自动化](07-automations.md) | 自然语言配置向导、cron 编辑器、执行历史、misfire 文案、设备绑定与迁移 UI、失败与预算通知 | 清单 §7；总纲 D5、§6.9、Q8、Q15 |
| 08 | [产物与文档解析](08-artifacts-and-ingest.md) | 产物识别（**自建**）、四个办公技能包接口、解析管道分级、上传 UX、产物卡片与版本、分享授权流 | 清单 §2、§6；总纲 §6.7、D6、Q10 |
| 09 | [服务层与本机数据模型](09-service-layer.md) | 进程模型、app-server 适配层、事件流→UI 状态、8 张本机 sqlite 表、重连与错误、离线降级 | 清单 —；总纲 §4.1、D3、D9 |
| 10 | [安全与权限 UX](10-security-permissions-ux.md) | 权限 profile 目录、审批卡四类、敏感目录拦截、guardian 分级呈现、预算与并发闸门、审计留痕 | 清单 §5.4、§14；总纲 §6.11–6.12、Q11 |
| — | **[ui-spec.html](ui-spec.html)** ·「可视对照」 | 01 的**渲染面**：色板带实测对比度 · 32 个组件按规格真渲染（可切浅/暗）· 布局与节奏 SVG · **三张页面拼装图**（对应截图 1/2/4，用于逐块比对） | 01 的全部内容 |

**阅读顺序**：先看 [ui-spec.html](ui-spec.html)（10 分钟拿到视觉全貌），再读 01 + 02（骨架与规则），然后按你要做的里程碑挑 —— M2 看 03/04/09，M3 看 08，M4 看 10，M5 看 07，M7 看 05，M8 看 06/08。

> **ui-spec.html 与 01 的关系**：01 是数值真源，HTML 是它的渲染面。两者不一致时**以 01 为准**并回来修 HTML。HTML 按仓库既有约定写成 artifact body 形式（同 `docs/evowork-on-codex-assessment.html`：无 doctype，以 `<title>` + `<style>` 起头），可直接用浏览器打开，也可发布为在线页面。

---

## 2. 本轮细化的一句话结论

**截图所展示的产品，比总纲描述的范围更大**：多出 4 个总纲没有对应条目的模块（资料库、助理、发现应用、积分运营位），而总纲里已决策的 3 件事（Craft/Plan/Ask 模式、Q5 无公开市场、Q1=A 纯本地）在截图里没有对应控件或与截图直接冲突。本文档集的处理原则：

1. **布局与视觉 100% FOLLOW 截图** —— 尺寸、层级、组件族、控件位置都按截图复刻（01）。
2. **截图有、总纲无的模块**：按已定决策（K6/D9/Q5/Q10）给出**不违反决策的最小实现**，并把真正需要产品拍板的部分登记为 Q17–Q20（§5）。
3. **总纲有、截图无的功能**：以**同一组件族、同一位置**做受控扩展，不发明新视觉语言（典型例：Craft/Plan/Ask 作为 Composer 底栏第三个 chip，见 03 §4.5）。
4. **凡引用内核能力，先核对再写** —— §3 是本轮实测结果，§4 是由此产生的总纲修订项。

---

## 3. UI 基线：截图与页面的对应

| 截图 | 页面 | 细化在 |
|---|---|---|
| 1 | 首页 / 新建任务（侧边栏 + Hero + 场景切换 + Composer + 案例位 + 运营位） | 01、02、03 |
| 2 | 专家·技能·连接器 → **技能** Tab | 01、05 |
| 3 | 专家·技能·连接器 → **连接器** Tab | 01、05 |
| 4 | 资料库（三栏：导航 + 资料树 + 内容表格） | 01、06 |

**未被截图覆盖、需按设计系统推导的页面**：任务对话工作台（04）、自动化（07）、专家 Tab（05）、设置/数据管理（02）、通知中心（02）、审批卡（10）。这些页面的所有控件都必须能在 01 的组件清单里找到出处 —— 不允许出现第 33 个组件而不先登记进 01。

> **品牌**：截图中的产品名为 **WorkBuddy**，本文档集统一按 **EvoWork** 落地（总纲 K5：对外不得出现第三方品牌）。品牌只影响 01 §2 的一组 token（appName / logo / mascot / accent）与文案，**不影响任何布局**。若产品对外定名实为 WorkBuddy，替换该组 token 即可，不产生返工。

---

## 4. 内核实测核对结果（2026-09-04 @ `728cb12fe5`）

CLAUDE.md 要求「引用内核代码用 `path:line` 并当场核对」。下表是本轮为写这套文档而实测的结论，路径相对 `../codex/codex-rs/`。**✅ = 总纲判断成立；⚠️ = 需修订总纲**。

| # | 实测事实 | 出处 | 对设计的影响 |
|---|---|---|---|
| F1 | `turn/start` 接受完整 `collaborationMode: CollaborationMode`，含 `settings.developer_instructions`；注释明示它「优先于 model / reasoning_effort / developer instructions」 | `app-server-protocol/src/protocol/v2/turn.rs:243-250` | ✅ 且**更好**：总纲 P3（改 `collaboration-mode-templates` 加 `ask.md`）**不需要打补丁**，Ask 模式纯配置可实现 → 见 §4.1 |
| F2 | `ModeKind` 仅 `Plan \| Default` | `protocol/src/config_types.rs:673-683` | ✅ D8「不新增模式枚举」成立 |
| F3 | `collaborationMode/list` 返回**硬编码** builtins（仅 plan + default），不读 config | `models-manager/src/manager.rs:322`、`models-manager/src/collaboration_mode_presets.rs:16` | ⚠️ 场景包/模式预设**不能靠 `config.toml` 扩展**，必须由 EvoWork 侧维护目录并在每次 `turn/start` 下发完整结构 → 03 §3.3 |
| F4 | `permissionProfile/list` 返回 `{id, description, allowed}`；内置 `:read-only` / `:workspace` / `:danger-full-access`；支持用户自定义 `[permissions.<id>]` + `extends` | `v2/permissions.rs:406-436`、`protocol/src/models.rs:407-413` | ✅ 「默认权限 ∨」下拉可**完全由协议驱动**，`allowed=false` 直接对应企业策略置灰 → 10 §2 |
| F5 | `turn/start.permissions`（命名 profile，实验字段）与 `sandboxPolicy` **互斥** | `v2/turn.rs:207-212` | ✅ 场景/模式只下发 `permissions`，不再自己拼 `sandboxPolicy` → 03 §3.4 |
| F6 | `UserInput` = Text / Image / LocalImage / Audio / LocalAudio / Skill / Mention，**无文档类型** | `protocol/src/user_input.rs:15-55` | ✅ §6.7 前置解析管道成立 → 08 §3 |
| F7 | `ThreadStatus` = `NotLoaded \| Idle \| SystemError \| Active{activeFlags}`；`ThreadActiveFlag` = `WaitingOnApproval \| WaitingOnUserInput` | `v2/thread.rs:1639-1656` | 部分 ✅：待处理态可直接映射；已完成/失败**不在** ThreadStatus 里 |
| F8 | `thread/list` 参数**无状态过滤、无日期区间过滤**（有 cursor / limit / sortKey / sortDirection / archived / sectionId / projectId / cwd / searchTerm / parentThreadId / ancestorThreadId / modelProviders / sourceKinds） | `v2/thread.rs:1368-1439`、`:1498-1503` | ⚠️ 清单 §4.2「按状态或日期筛选」总纲标 [复用] **不成立**，应为 [自建] → 04 §3.4、09 §4 |
| F9 | `ThreadExtra` 是空结构体；`thread/metadata/update` 只支持 `projectId` + `gitInfo` | `v2/thread_data.rs:167`、`v2/thread.rs:979-991` | ⚠️ 协议**没有客户端自定义元数据槽**，EvoWork 的派生状态/场景/产物计数/分享状态必须落本机投影表 → 09 §4.1 |
| F10 | `recognize_artifact_operation` 的输出**只喂 `codex_analytics`**，不进 app-server 协议；且硬编码 `marketplace_name == "openai-primary-runtime"` 与 4 个 plugin 名 / 精确脚本路径 | `core-plugins/src/artifact_operation.rs:4,24-49,57-58`、`core/src/tools/events.rs:111,140-142` | ⚠️ **产物识别 100% 自建**。总纲 D6「内核已有识别逻辑」措辞误导 → 08 §2 |
| F11 | 内核 `artifact_type` 只有 `presentation` / `document` / `spreadsheet` / `pdf`，**无 chart** | `core-plugins/src/artifact_operation.rs:24-49` | 总纲 §6.7 的 `charts` 技能没有内核类型可对齐 → 08 §2.3 自建类型体系 |
| F12 | `TurnStatus` = `Completed \| Interrupted \| Failed \| InProgress`；`turn/diff/updated` 给出**聚合 diff 字符串**；`turn/plan/updated` 给出 plan steps | `v2/turn.rs:32-37`、`:519-533` | ✅ 变更视图与「规划中」态的数据来源确定 → 04 §5.3、§6.3 |
| F13 | `ThreadItem` 共 **19 个变体**：UserMessage / HookPrompt / AgentMessage / FunctionCallOutput / Plan / Reasoning / CommandExecution / FileChange / McpToolCall / DynamicToolCall / CollabAgentToolCall / SubAgentActivity / WebSearch / ImageView / Sleep / ImageGeneration / EnteredReviewMode / ExitedReviewMode / ContextCompaction | `v2/item.rs:237-414` | 对话区渲染面是 19 类，不是"消息+工具"两类 → 04 §5 逐类给规范 |
| F14 | 审批走 **server→client request**（不是通知）：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/tool/requestUserInput`、`item/permissions/requestApproval`、`item/tool/call` | `app-server-protocol/src/protocol/common.rs:1700-1731` | 前端必须实现**可回复的请求处理器**，超时/离线语义要自己定 → 10 §3 |
| F15 | hooks 12 类事件确认无误 | `hooks/src/hook_event_key_label`（`hooks/src/lib.rs:95-111`） | ✅ 总纲 §6.11 策略包清单成立 |
| F16 | 内核确有 `v2/apps.rs` 与 `app/list/updated` 通知 | `v2/apps.rs`、`common.rs:1918` | K7 已决定不复用 Apps 目录；「发现应用」改用 plugin bundle 的 `interface` 元数据自建 → 05 §6 |

### 4.1 F1 的直接收益：补丁清单从 P3+P4 缩到只有 P4

总纲 §7 结论是「真正的代码补丁只有 P3/P4」。F1 实测后 **P3 也可以去掉**：

```
Ask 模式 = turn/start {
  collaborationMode: { mode: "default",
                       settings: { model, reasoning_effort,
                                   developer_instructions: <EvoWork 侧 ask 指令文本> } },
  permissions: "evowork-ask",     // config.toml 里的 [permissions.evowork-ask]，read-only + 无网络
  approvalPolicy: "never"
}
```

`developer_instructions` 由 EvoWork 随包分发（`config/modes/*.md`），不进内核仓库，不需要改 `collaboration-mode-templates/`。**K1 的补丁面因此只剩品牌字符串（P4）一项**，硬上限余量充足。

> 仍需保留的注意点：D8 说 Ask 要在 `ToolContributor` 层过滤写工具（避免模型反复尝试再失败）。这条与 F1 无关，仍然要做 —— 它是 `ext/` 里的扩展，不是补丁。

---

## 5. 新开放问题（Q17–Q20）—— 需产品拍板

这 4 条都是**截图里存在、但总纲第 10 章没有对应决策**的东西，且都触碰已定的硬约束。本文档集已按"不违反现有决策的最小实现"给出默认方案并继续推进设计，**但默认方案是我选的，不是产品定的**。

| # | 问题 | 为什么必须拍板 | 本文档集采用的默认 | 展开在 |
|---|---|---|---|---|
| **Q17** | 是否提供**个人云端存储**？截图 4 显示"已使用 880.1 KB / 5.0 GB + 升级" | 这会新增 D9 之外的**第五项云端数据面职责**，与 K6「本地优先」和 Q1=A 直接冲突；且"升级"意味着存储商业化 | **不做个人云盘**。配额条改为展示**本机磁盘占用**（产物 + 解析缓存），无"升级"入口 | 06 §3.5 |
| **Q18** | 是否做**积分 / 成长 / 运营位**？截图 1 有"做任务赢积分好礼""Buddy加油站·8期""领1000积分""认证老师" | 需要云端活动服务 + 用户行为上报，与 Q3 隐私硬约束的口径要单独对齐；且与企业版定位相悖 | **保留布局插槽、默认不启用**。运营位是配置驱动的 Slot，企业版一键隐藏 | 01 §7.4、03 §6 |
| **Q19** | 「**团队空间**」（截图 4）的形态：只读订阅、还是双向协作？ | 双向协作 = 用户内容常态上云，推翻 D9 | **只读订阅**，复用 D9 已批准的"企业私有源索引"这条云端职责；写入走 Q10 的逐次授权分享通道 | 06 §4 |
| **Q20** | 「**助理**」（截图 1 侧边栏）与「任务」的关系：独立产品形态、还是一个特殊任务？ | 影响任务列表语义与计费口径 | **一个常驻的特殊 Thread**（固定 cwd、默认 Ask 模式、不进任务列表、可 `thread/fork` 升级为正式任务） | 02 §4.2 |

另有 **3 条截图与已定决策的冲突**，不构成新问题（决策已明确），但 UI 必须如实降级，不能照抄截图：

| 冲突 | 已定决策 | UI 处理 |
|---|---|---|
| 截图 2 有「SkillHub」公开市场 Tab、精选/换一换/评分位 | **Q5：v1 不做公开 registry** | Tab 保留但只呈现"官方内置 + 企业私有源"两个来源；SkillHub 位在 v1 不渲染（非置灰，直接不出现），见 05 §3.2 |
| 截图 3 的连接器全是国内生态（腾讯文档 / 企微 / 飞书 / 钉钉 / TAPD / 微云…） | **Q9：本期只做 browser/** | 目录页只列 browser + 用户自建 MCP；不铺国内连接器卡片，不做"推荐未连接"，见 05 §4.3 |
| 截图 4 有「与我共享」收件箱 | Q10 只决策了**出方向**（我分享出去） | v1 只做「我分享的」；「与我共享」需要云端收件与通知，归入 Q19 一并决策，见 06 §4.3 |

---

## 6. 需回写总纲的修订清单

按 CLAUDE.md §9，下面 5 条应在总纲里改掉，**本文档集不代替这次回写**：

| # | 总纲位置 | 现状表述 | 应改为 | 依据 |
|---|---|---|---|---|
| M1 | §7 P3、§3.2 | Ask 模式需新增 `ask.md` 模板，「需改（也可通过 `developer_instructions` 配置注入）」 | **删除 P3**，明确 Ask 走 `turn/start.collaborationMode.settings.developer_instructions`；补丁清单只剩 P4 | F1 |
| M2 | §3.3 表「按状态/日期筛选」 | [复用] · `thread/list` + `ThreadStatus` | **[自建]** · `thread/list` 无状态与日期过滤参数；需本机任务状态投影表 | F8、F9 |
| M3 | D6、§6.7 | 「内核已有识别逻辑（`artifact_operation.rs`）」 | 内核的识别**只服务于 analytics 且硬编码 OpenAI marketplace 名**，产物识别为 **[自建]**；`artifact_operation.rs` 只作**约定参考** | F10 |
| M4 | §6.7 技能表 | 四个技能 documents / spreadsheets / presentations / **charts** | 注明内核 `artifact_type` 无 `chart`，charts 走 EvoWork 自建产物类型 | F11 |
| M5 | 第 10 章 | Q1–Q16 全部决策完毕，无开放项 | 新增 **Q17–Q20**（本文 §5） | 截图与总纲的范围差 |

另建议在总纲 §3.8 补一行：界面 [自建] 的工作量应含**资料库**这一在清单第 6/12 章里被拆散、但在真实产品里是独立一级入口的模块（见 06）。

### 6.1 模块级修订建议（分散在各文档末章）

上表 5 条是**跨模块、动摇总纲判断**的修订。此外每个细化文档在末章登记了自己那块的修订建议，回写时一并处理：

| 文档 | 末章 | 条数 | 主要内容 |
|---|---|---|---|
| 04 任务工作台 | §2.2 内嵌 | 2 | 「按状态/日期筛选」改 [自建]；清单 §4.3 补「已中断」态 |
| 06 资料库 | §8 | 4 | §3.8 补资料库为一级入口；M8 范围增量 +3 人周；补 Q17/Q19；§6.6 补记忆的可见界面 |
| 07 自动化 | §8 | 4 | `automation_run` 增 `trigger` / `original_fire_time` / `failure_class`；环境原因失败不计入自动暂停计数；定时任务强制硬预算 |
| 08 产物与解析 | §9 | 5 | 产物识别改 [自建]；产物类型体系无 `chart`；解析运行时分档分发；结构化生成原则；M3 范围补充 |
| 10 安全与权限 | §10 | 5 | 敏感目录硬拦截对 `danger-full-access` 也生效；定时任务审批超时语义；并发上限不可上调；Q12 保留接口的具体含义；Windows 降级的 UI 处理 |

**两处范围增量需要注意**（不是估算误差，是漏项）：资料库主体约 **+3 人周**（06 §8）、解析运行时的三档分发工作应显式计入 M3（08 §9）。总纲 §8 的 53 人周合计需据此复核。

---

## 7. 约定（本目录内）

- 组件命名统一用 01 §5 的名字（如 `NavItem`、`ItemCard`、`Composer`）；跨文档引用写 `01 §5.12 Composer`。
- 协议方法一律写全名（`thread/list`、`turn/start`），实验方法标注 **(exp)**，并在 09 §3 的适配层收口 —— 前端不直连实验方法。
- 每个页面规格必须给出：布局尺寸 → 数据来源（协议方法或本机表）→ 交互状态 → 空态/错误态 → 文案。缺任一项视为未完成。
- 文案用中文，且**如实**：涉及 Q1=A 的可靠性缺口（本机调度、当前设备、无云端兜底）必须在 UI 上说清，不得暗示云端级 SLA（总纲 R9、D6）。
