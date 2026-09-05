# EvoWork 平台设计文档 —— 基于 OpenAI Codex 内核的实现方案

## 0. 文档信息

| 项               | 内容                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 版本             | v0.4（Q1–Q29 全部决策 + 详细设计集回写）                                                                                                                                                         |
| 日期             | 2026-09-05（v0.2 修订于 2026-09-03，v0.3 于 2026-09-04，v0.4 于 2026-09-05）                                                                                                                     |
| 作者             | li.wang                                                                                                                                                                                          |
| 状态             | **已确认** —— 第 10 章 Q1–Q29 全部决策完毕，**无开放项**。Q29（是否有自建推理服务）结论为"无"，网关保留配置项不排期                                                                              |
| 本轮决策（v0.4） | Q17=**不做个人云盘** · Q18=**运营位保留插槽默认关闭** · Q19=**团队空间只读订阅** · Q20=**助理 = 常驻特殊 Thread** · Q21–Q29 见 §10.3（工程与排期）                                               |
| 评估基线         | `openai/codex` main 分支 @ **`89a4eec6da`（2026-09-04）**；F1–F16 十六条内核断言已于 2026-09-05 在此提交上重新实测，同日实现 M2a 时新增 **F17 / F18**（两条推翻了详细设计 09 §3.2–3.3 的机制描述，已回写）。见 [详细设计集 README §4](design/README.md)；本文附录 A 的路径按此基线核对 |
| 输入文档         | `agent-platform-feature-list.md`（EvoWork 功能点清单）· [详细设计集 01–10](design/README.md)                                                                                                     |

---

## 1. 结论摘要

**可以用 codex 做内核，但只能当"内核"，不能当"产品"。**

| 维度     | 判断                                                                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 功能覆盖 | 清单中约 **55–60%** 的能力 codex 已有实现，且深度普遍**超过**清单描述（尤其沙箱、审批、插件市场、子 agent）                                                                                                                                           |
| 需改造   | 约 **25%**（模型接入层、连接器目录、产物技能）                                                                                                                                                                                                        |
| 必须自建 | 约 **15–20%**（**整个前端**、**定时调度**、可视化渲染、文档解析入口、国内生态集成）                                                                                                                                                                   |
| 许可     | Apache-2.0，可商用闭源分发；须保留 `LICENSE`/`NOTICE`，**不得使用 Codex / OpenAI 品牌**                                                                                                                                                               |
| 主要风险 | ① 上游高速演进带来的 rebase 成本；② codex 为"编码 agent"优化，与"通用办公 agent"存在持续的假设摩擦；③ Q2 决策必须支持国内模型 —— 网关要为每家模型补齐 Responses API 全套语义（见 D2、M1、R1）；④ Q1=A 后调度与分发的可靠性成本由客户端承担（R9、R10） |

**核心策略：把 codex 当作不可变的执行内核（Execution Kernel），所有 EvoWork 特性通过官方扩展点注入，前端与调度层完全自建。**

---

## 2. 目标与非目标

### 2.1 目标

- G1 复用 codex 的 agent 循环、工具执行、沙箱、审批、上下文管理、会话持久化，不重写。
- G2 EvoWork 的差异化能力（办公产物、国内生态、定时自动化、可视化）以**插件/扩展/外部服务**形式实现。
- G3 对上游 codex 的侵入式修改控制在**可枚举的补丁清单**内（目标 ≤ 5 个文件、≤ 500 行）。
- G4 前端与内核之间只通过 **app-server JSON-RPC 协议**通信，不依赖 Rust 内部 API。

### 2.2 非目标（本期不做）

- N1 不重写 agent 循环、不替换 Responses API 协议。
- N2 不复用 codex 的 Apps/连接器目录（绑定 chatgpt.com，见 §5.4）。
- N3 不复用 Codex Cloud（云任务）。
- N4 不做第 15 章"下一代"方向的完整落地（但保留接口，见 Q12）。
- N5 不做视频 / 3D 生成，只做图片（Q4 已决策，见 §6.8）。
- N6 不做公开技能市场：v1 只有官方内置技能 + 企业私有源（Q5 已决策，见 §6.3）。
- N7 不做国内生态集成：腾讯文档 / ima / 乐享 / 企业网盘上传本期全部不做（Q9 已决策，见 §6.5）。
- N8 不做**个人云端存储**（Q17，v0.4）：资料库的配额条是本机磁盘占用，没有"升级"入口。
- N9 不做**团队空间的双向协作**与**「与我共享」收件箱**（Q19，v0.4）：团队空间是只读订阅。
- N10 不做**积分 / 成长 / 运营活动体系**（Q18，v0.4）：只保留配置驱动的布局插槽，默认关闭，且不带任何行为回传。

---

## 3. 能力基线盘点

图例：**[复用]** 直接可用 · **[改造]** 需适配/扩展 · **[自建]** 零基础

### 3.1 核心能力（清单第一章）

| 清单能力                    | 状态       | codex 对应                                                | 说明                                                            |
| --------------------------- | ---------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| 理解自然语言 / 自主规划执行 | [复用]     | `codex-rs/core` agent 循环                                | 成熟                                                            |
| 本地文件操作                | [复用]     | `codex-rs/file-system`、`apply-patch`                     | 含 diff 应用、审批                                              |
| 多任务并行                  | [复用]     | `ThreadManager` + `spawn_subagent`                        | `codex-rs/ext/agent/src/lib.rs`                                 |
| 多模态任务处理              | [改造]     | 见 §3.5                                                   | 文档/PPT/表格产物技能不在仓库                                   |
| 结果可交付                  | **[自建]** | `core-plugins/src/artifact_operation.rs` **仅作约定参考** | 内核既无生成逻辑，其识别逻辑也用不上：见 D6 的 v0.4 修订（F10） |

### 3.2 工作模式（清单第三章）

| 清单能力          | 状态   | codex 对应                                                                                                                                                                   |
| ----------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Craft（你说我做） | [复用] | `collaboration-mode-templates/templates/default.md` + `SandboxPolicy::WorkspaceWrite`                                                                                        |
| Plan（先想再做）  | [复用] | `collaboration-mode-templates/templates/plan.md`                                                                                                                             |
| Ask（只谈不动）   | [改造] | 无现成模式，= 命名权限 profile `evowork-ask`（只读 + 无网络）+ `AskForApproval::Never` + 由 `turn/start.collaborationMode.settings.developer_instructions` 下发 ask 指令文本 |

> 相关定义：`codex-rs/protocol/src/protocol.rs`（`AskForApproval` / `SandboxPolicy`）、`codex-rs/protocol/src/config_types.rs:673`（`ModeKind`，仅 `Plan | Default`）。
>
> **v0.4 修订（依据 F1，M1）**：Ask 模式**不需要新增 `ask.md` 内核模板**，因此 §7 的 P3 补丁已删除。指令文本随 EvoWork 分发在 `config/modes/ask.md`，每次 `turn/start` 由适配层拼进 `collaboration_mode.settings.developer_instructions`（该字段注释明示它优先于 model / reasoning_effort / developer instructions，`app-server-protocol/src/protocol/v2/turn.rs:243-251`）。仍需保留的是 D8 里「在 `ToolContributor` 层过滤写工具」那条 —— 它是 `ext/` 扩展，不是补丁。

### 3.3 任务管理与对话（清单第四、五章）

| 清单能力                     | 状态       | codex 对应（app-server 方法）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 任务列表 + 分页              | [复用]     | `thread/list`（支持 cursor、`sortKey`、`cwd`、`archived`、`searchTerm`）                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 搜索任务标题                 | [复用]     | `thread/list` 的 `searchTerm` / `thread/search`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 对话内搜索                   | [复用]     | `thread/searchOccurrences`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 按状态/日期筛选              | **[自建]** | `thread/list` **既无状态过滤也无日期区间过滤**（参数只有 cursor / limit / sortKey / sortDirection / archived / sectionId / projectId / cwd / searchTerm / parentThreadId / ancestorThreadId / modelProviders / sourceKinds / originators，`v2/thread.rs:1368-1439`）；且 `ThreadExtra` 是空结构体、`thread/metadata/update` 只能改 projectId / gitInfo（`v2/thread_data.rs:167`、`v2/thread.rs:979-991`）—— **协议没有客户端元数据槽**。需本机 `thread_projection` 投影表（详细设计 09 §4.1、04 §2）。**v0.4 修订（F8/F9，M2）** |
| 置顶 / 文件夹分组            | [复用]     | `threadSection/*`（含内置 pinned 分区、手动排序 `section_position`）                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 重命名                       | [复用]     | `thread/name/set`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 归档 / 取消归档 / 删除       | [复用]     | `thread/archive`、`thread/unarchive`、`thread/delete`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 打开所在文件夹               | [自建]     | 前端本地能力                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 分享任务（公开链接）         | [自建]     | 需服务端托管；Q10 已决策：显式授权后上传，默认关闭 + 链接有有效期                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 继续处理已完成任务           | [复用]     | `thread/resume`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 从中途分叉                   | [复用]     | `thread/fork`（支持 `beforeTurnId`、`ephemeral`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 中断 / 中断后补充            | [复用]     | `turn/interrupt`、`turn/steer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 追问排队                     | [复用]     | `thread/queue/*`（FIFO、可重排、可编辑）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 粘贴截图 / 上传图片          | [复用]     | `UserInput::Image` / `LocalImage`（`codex-rs/protocol/src/user_input.rs:15`）                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 上传 PDF/Word/Excel/ZIP      | [自建]     | **`UserInput` 无文档类型**，需前置解析管道，见 §6.7                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `@` 引用文件/技能/规则       | [复用]     | `UserInput::Skill` / `Mention` + `file-search` 模糊搜索                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 执行过程展示                 | [复用]     | `item/*` 事件流（`agentMessage`/`plan`/`reasoning`/`commandExecution`/`fileChange`）                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 工作空间文件视图             | [复用]     | `fs/*` 工具 + `fs/watch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 变更视图（本次任务改了什么） | [复用]     | `fileChange` item + `codex apply`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 内置浏览器预览               | [改造]     | `BrowserUseConfig` 只是**权限策略层**，真实浏览器需外部 MCP server                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 语音交互                     | [复用]     | `thread/realtime/*`（WebSocket / WebRTC，text/audio 双模态）                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 3.4 技能与专家（清单第八、九章）

| 清单能力                                   | 状态   | codex 对应                                                                                                                    |
| ------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 技能加载（用户级/项目级）                  | [复用] | `codex-rs/skills`、`ext/skills`；根目录：`<config>/skills`、`~/.agents/skills`、`<project>/.agents/skills`                    |
| 动态技能选择                               | [复用] | `ext/skills/src/dynamic_skill_selector.rs`                                                                                    |
| 技能市场（搜索/安装/升级）                 | [复用] | `core-plugins/src/marketplace*.rs`、`npm_source.rs`、`plugin_bundle_archive.rs`；**Q5：v1 只接企业私有源，不建公开 registry** |
| 技能安全审计（P0/P1/P2）                   | [改造] | `ext/guardian-v2` 有风险分级与可信白名单，需映射到 P0/P1/P2 语义                                                              |
| 自定义技能创建                             | [复用] | 内置示例技能 `skill-creator`、`plugin-creator`（`codex-rs/skills/src/assets/samples/`）                                       |
| 内置办公技能（文档/表格/PPT/图片/视频/3D） | [自建] | **不在仓库**，从 OpenAI 私有市场下载；本期做文档/表格/PPT/图表 + 图片，**视频与 3D 不做**（Q4）                               |
| 专家中心（100+ 角色）                      | [改造] | `codex-rs/agent-roles`（TOML 定义，每角色可带独立 config 层）；角色内容需自建                                                 |
| 专家推荐                                   | [自建] | 需推荐逻辑                                                                                                                    |
| 多角色协作                                 | [复用] | `spawn_subagent` + `thread/list?ancestorThreadId` 谱系查询                                                                    |

### 3.5 连接器与 MCP（清单第十章）

| 清单能力          | 状态   | codex 对应                                                                                                             |
| ----------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| MCP 协议支持      | [复用] | `mcp-server`（对外）、`rmcp-client`（对内）、`ext/mcp`                                                                 |
| MCP 工具权限策略  | [复用] | `connectors/src/app_tool_policy.rs`                                                                                    |
| 200+ 第三方连接器 | [自建] | codex 的 Apps 目录**硬编码 chatgpt.com**（`connectors/src/lib.rs:484`），一个都拿不到；**Q9 已决策本期只做浏览器 MCP** |
| 连接器推荐        | [自建] | **本期不做**（Q9）                                                                                                     |
| 安全信任机制      | [复用] | 新增连接器需显式信任 + `permission_request` hook                                                                       |

### 3.6 记忆、可视化、自动化（清单第七、十一、十二章）

| 清单能力                    | 状态       | codex 对应                                                                               |
| --------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| 用户级本地记忆              | [复用]     | `memories/read`、`memories/write`、`ext/memories/src/local/`；目录 `CODEX_HOME/memories` |
| 工作空间记忆                | [复用]     | `AGENTS.md` 层级加载 + `ext/history-notes`                                               |
| 云端记忆                    | [改造]     | backend 是 trait，远端实现需自建；**Q1=A + Q3 下默认关闭**，见 §6.6                      |
| 历史对话检索                | [复用]     | `thread/searchOccurrences` + `thread/list`                                               |
| **定时执行 / Automations**  | **[自建]** | **全仓库无 cron/scheduler，零基础**                                                      |
| 可视化（SVG/HTML/Chart.js） | [自建]     | 无渲染层（本属前端职责）                                                                 |

### 3.7 安全与隐私（清单第十四章）

这是 codex **强于**清单描述的部分，建议直接继承并对外宣传。

| 能力             | 状态   | codex 对应                                                                                                                                                                                                                     |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 三平台沙箱       | [复用] | `linux-sandbox`（landlock/seccomp）、`windows-sandbox-rs`、macOS Seatbelt                                                                                                                                                      |
| 命令白名单 DSL   | [复用] | `codex-rs/execpolicy`（`codex execpolicy` 子命令可独立校验）                                                                                                                                                                   |
| 网络出口管控     | [复用] | `codex-rs/network-proxy`、`SandboxPolicy` 的 `network_access`                                                                                                                                                                  |
| 高危操作二次确认 | [复用] | `AskForApproval::Granular`、`permission_request` hook                                                                                                                                                                          |
| 提示注入防护     | [复用] | **`ext/guardian-v2`**：独立安全审查 subagent，动作风险分级 + 审查证据留存                                                                                                                                                      |
| 凭据管理         | [复用] | `codex-rs/secrets`、`keyring-store`                                                                                                                                                                                            |
| 策略即代码       | [复用] | `codex-rs/hooks` 12 类事件：`pre_tool_use`、`post_tool_use`、`permission_request`、`pre_compact`、`post_compact`、`session_start`、`session_end`、`user_prompt_submit`、`subagent_start`、`subagent_stop`、`stop`、`interrupt` |
| 管理员强制策略   | [复用] | `requirements.toml` + `allow_managed_hooks_only`                                                                                                                                                                               |
| Agent 密码学身份 | [复用] | `codex-rs/agent-identity`（ed25519 + JWT）、`workload-identity`                                                                                                                                                                |

### 3.8 界面（清单第十三章）

| 清单能力                            | 状态       | 说明                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 侧边栏 / 对话区 / 结果区            | [自建]     | 仓库内只有 TUI（`codex-rs/tui`）。桌面 App 与 VS Code 扩展**闭源**，`codex app` 仅下载安装器                                                                                                                                                |
| **资料库（一级入口）**              | **[自建]** | **v0.4 新增行**：清单把它拆散在第 6 / 12 章，但真实产品里是与「任务」同级的一级入口（三栏 + 索引 + 全文搜索 + 记忆可见面）。工作量见 §8 M8 的范围增量（+3 人周），设计见 [06 资料库](design/06-library.md)                                  |
| **场景包（首页 SegmentedControl）** | **[自建]** | `collaborationMode/list` 返回**硬编码** builtins（仅 plan + default，不读配置：`models-manager/src/manager.rs:322`、`collaboration_mode_presets.rs:16`，F3）。场景目录由 EvoWork 持有，每次 `turn/start` 展开为完整参数下发（设计 03 §2.3） |

---

## 4. 总体架构

### 4.1 分层图

```
┌──────────────────────────────────────────────────────────────────────┐
│  L4  EvoWork 前端（100% 自建）                                        │
│  ┌────────────┬────────────────────────┬────────────────────────┐    │
│  │ 侧边栏      │ 对话区                  │ 结果区                  │    │
│  │ 任务/空间   │ 消息流 · 输入 · 引用     │ 产物 · 文件 · 变更 · 预览│    │
│  │ 分组/置顶   │ 中断 · 追问 · 语音       │ Visualizer(SVG/Chart)  │    │
│  └────────────┴────────────────────────┴────────────────────────┘    │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  app-server JSON-RPC v2（同机 stdio / localhost）
┌───────────────────────────────┴──────────────────────────────────────┐
│  L3  EvoWork 本机常驻服务（Q1=A：随桌面 App 分发，与内核同一台机器）    │
│  ┌──────────────┬──────────────┬──────────────┬──────────────────┐  │
│  │ Scheduler    │ 文档解析管道  │ 产物索引      │ 策略/配额/审计    │  │
│  │ 本机 cron    │ PDF/Office→MD│ 本机 sqlite   │ 本机执行 + 缓冲   │  │
│  │ 常驻 + 唤醒  │ 原始文件不出机│ 文件系统为真源│ 离线可用          │  │
│  └──────────────┴──────────────┴──────────────┴──────────────────┘  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  HTTPS · 控制面常连；数据面仅在显式授权时开启
┌───────────────────────────────┴──────────────────────────────────────┐
│  L3′ EvoWork 云端（薄 —— Q1=A 下只保留必须联网的四件事）              │
│  ┌──────────────┬──────────────┬──────────────┬──────────────────┐  │
│  │ 账号/租户    │ 企业私有源索引│ 产物分享托管  │ 审计汇总/策略下发 │  │
│  │ 配额·授权    │ (Q5：无公开市场)│显式授权+有效期│ 签名策略包       │  │
│  └──────────────┴──────────────┴──────────────┴──────────────────┘  │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Responses API 网关（Q2：国内模型 / Anthropic → Responses，不落盘）│ │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────┴──────────────────────────────────────┐
│  L2  EvoWork 扩展包（插件形态，随产品分发）                            │
│  ┌───────────────┬────────────────┬───────────────┬───────────────┐ │
│  │ 办公产物技能   │ 专家角色包      │ MCP 连接器集   │ Hooks 策略包   │ │
│  │ ppt/doc/xlsx  │ agents/*.toml  │ 飞书/企微/钉钉 │ 审计·配额·合规 │ │
│  │ /pdf/图表     │ 100+ 角色       │ 腾讯文档/浏览器│               │ │
│  └───────────────┴────────────────┴───────────────┴───────────────┘ │
└───────────────────────────────┬──────────────────────────────────────┘
                                │  extension-api / plugin manifest / MCP
┌───────────────────────────────┴──────────────────────────────────────┐
│  L1  codex 内核（Apache-2.0，尽量不改，跟随上游）                      │
│  core · tools · thread-store · rollout · skills · agent-roles         │
│  sandboxing · execpolicy · guardian-v2 · hooks · memories · goal      │
│  app-server · otel · plugin marketplace                              │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.2 一次「定时生成周报」的完整数据流

```
① 本机 Scheduler 到点触发（桌面 App 常驻进程；cron + validFrom/validUntil + ACTIVE）
        ↓  机器休眠/关机错过的触发按 misfire 策略补偿（D5）
        ↓  幂等键 = automation_id + fire_time（本机 sqlite 唯一索引，无需分布式锁）
② 服务层调用 app-server: thread/start { cwd: <工作空间>, collaborationMode: craft }
        ↓
③ turn/start { input: [Text(任务描述), Mention(@周报模板技能)] }
        ↓
④ codex 内核：加载 AGENTS.md → 选中技能 → 规划 → 调工具
        ↓  每个工具调用前触发 pre_tool_use hook（审计+配额）
        ↓  高危动作经 guardian-v2 风险分级；命中则 permission_request
⑤ 产物技能生成 report.docx  →  fileChange item 上报
        ↓
⑥ 本机服务监听 item/completed，识别产物 → 写入本机产物索引（类型/版本/所属任务）
        ↓  产物本体始终留在工作空间目录，不上传（K6）
⑦ turn/completed → Scheduler 写本机执行历史（成功/失败/token 消耗）
        ↓  仅统计摘要（无 prompt、无文件内容）按策略上报云端配额/审计
        ↓
⑧ 前端收到 thread/status/changed，结果区刷新产物卡片
```

---

## 5. 关键设计决策

### D1 —— 不 fork 核心逻辑，走官方扩展点

**决策**：所有 EvoWork 功能通过 `codex-rs/ext/extension-api` 的 contributor 机制注入，而非修改 `core`。

可用的注入点（`ext/extension-api/src/lib.rs`）：

| Contributor                  | 用途                                                         |
| ---------------------------- | ------------------------------------------------------------ |
| `ToolContributor`            | 注册新工具（如"生成图表"、"上传到腾讯文档"）                 |
| `ContextContributor`         | 注入上下文片段（如租户策略、工作空间记忆）                   |
| `ThreadLifecycleContributor` | 会话启停钩子（`ThreadStart`/`Ready`/`Resume`/`Stop`/`Idle`） |
| `ApprovalReviewContributor`  | 自定义审批评估逻辑                                           |
| `McpServerContributor`       | 动态贡献 MCP server                                          |
| `SkillInvocationContributor` | 技能调用拦截                                                 |
| `TokenUsageContributor`      | 成本计量（对接配额）                                         |
| `ConfigContributor`          | 配置层贡献                                                   |

**理由**：这是 codex 自己内部功能（guardian、goal、memories、web-search、image-generation 全部）使用的正规接口，稳定性远高于 `core` 内部 API。

**代价**：`ext/extension-api` 是 Rust crate，写扩展需要 Rust 能力；纯脚本能力只能走 plugin/MCP。

### D2 —— 模型接入 = 独立的 Responses API 网关

> **Q2 已决策（2026-09-03）：必须支持国内模型。** 网关因此不是"薄转发"而是**全量协议适配层**，工作量由 6 上调到 8 人周（§8 M1、§9 R1）。**Q16 已决策：P0 三家 = DeepSeek · Kimi · GLM-5.3-flash**（各约 1–1.5 人周适配，合计 3–4.5 人周，含在 M1 的 8 人周里）。
>
> **Q14 已决策：网关云端统一托管为主，另提供企业私有部署包。** 网关**不落盘 prompt 与响应体**，只记 token 计数、时延与错误码。这是一条对外可审计的承诺，实现上要同时管住三条会泄露正文的路径：应用日志、APM trace（span attribute 不带 input/output）、错误上报（异常堆栈不得携带请求体）。私有部署形态下厂商密钥由客户自持，EvoWork 云完全不接触 prompt。

**决策**：不改 codex 的模型层，在外部部署一个协议网关，把国内模型 / Anthropic 的 API 翻译成 OpenAI **Responses API**。codex 侧只配置 `model_providers.evowork.base_url` 指向网关。

**关键事实**：`wire_api = "chat"` 已被上游移除（`codex-rs/model-provider-info/src/lib.rs:58`），只支持 Responses API。内置 provider 仅 OpenAI / Amazon Bedrock / Ollama / LMStudio。

**理由**：把协议差异隔离在一个可独立测试、可独立扩容的服务里，避免污染内核、避免每次 rebase 冲突。

**代价**：网关必须实现 Responses API 的**流式语义**、**工具调用**、**reasoning 段**、**prompt cache 语义**。这是本方案**最容易被低估的工作量**（见 §8 M1）。

**每接一家国内模型必须补齐的语义矩阵**（缺一项都会在真实任务里暴露）：

| 语义                                         | 国内模型现状               | 网关的补齐方式                                                        |
| -------------------------------------------- | -------------------------- | --------------------------------------------------------------------- |
| 流式事件序列（`response.*` 增量事件）        | 多为 OpenAI Chat 风格 SSE  | 事件重排，`item_id` / `output_index` 由网关自行编号                   |
| 工具调用（并行调用、增量 arguments）         | 支持度参差，部分不支持并行 | 不支持并行时降级为串行并在网关合并；arguments 分片重组                |
| reasoning 段 / `encrypted_content`           | 基本无对应物               | 有思维链的映射为 `reasoning` item；无则留空占位，**不得伪造**         |
| prompt cache（`prompt_cache_key`、命中计费） | 少数支持且语义不一         | 网关维护映射；不支持时如实上报 0 命中，避免配额口径失真               |
| 多模态输入（图片）                           | 支持度参差                 | 不支持时网关明确报错，由前端回落到"本地 OCR + 文字描述"（受 Q3 约束） |
| token 用量口径                               | 各家计数方式不同           | 统一换算为内核 `TokenUsage`，供 `TokenUsageContributor` 计量          |

**P0 三家的已知适配重点**（Q16，动手前按当时的实际 API 重新核对，各家迭代很快）：

| 模型          | 适配重点                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| DeepSeek      | 有推理型号，思维链字段可映射为 `reasoning` item；工具调用成熟度相对好，作为**基准实现**先做                 |
| Kimi          | 长上下文是卖点，但 cache 与计费口径要单独核对；注意工具调用的并行支持度                                     |
| GLM-5.3-flash | **flash 属轻量档**，工具调用稳定性与长指令遵循通常弱于旗舰档 —— M0 就该拿它验证最差情况，而不是等到 M1 末期 |

> ⚠️ 选型提示：P0 名单里给的是"厂商 + 具体型号"，而办公产物（PPT 排版、表格计算）对指令遵循要求高。若 GLM-5.3-flash 在 M0 的产物质量验证中不达标，应当及早换成同厂旗舰档，而不是靠技能模板硬扛（关联 R4）。

**DeepSeek 实测结果（2026-09-05，`scripts/verify-provider.mjs` 对 api.deepseek.com）** —— 上表"动手前重新核对"的第一次兑现。三个型号（`deepseek-chat` / `deepseek-reasoner` / `deepseek-v4-flash`）全部可用，19 条断言全通过，其中**三条与原先的假设不一致**：

| # | 原先的假设 | 实测 | 影响 |
| --- | --- | --- | --- |
| 1 | `deepseek-reasoner` 不支持并行工具调用 | **支持** —— 一次返回 `get_weather` + `get_time` 两个 `tool_calls` | 能力表已订正。原值会让网关做一次没必要的串行化降级 |
| 2 | 名字带 flash 的是轻量非推理档 | `deepseek-v4-flash` **是推理模型**（流式 65 帧里 44 帧 `reasoning_content`） | 按名字猜会让 `from-chat.ts` 走进"上游给了思维链但能力表说没有"分支，**推理段整块丢掉** |
| 3 | usage 帧的 `choices` 是空数组（OpenAI 形状） | usage 帧**同时带 `choices`、`delta.content` 与 `finish_reason`** | 若按"看到 usage 就跳过这一帧"写，会丢掉最后一段文本。现有实现先取 usage 再遍历 choices，不受影响 |

其余实测确认：流式增量在 `choices[0].delta.content`；工具调用首帧带 `id` + `function.name`、后续帧只带 `arguments` 片段；cache 口径是 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`（不是 OpenAI 的 `prompt_tokens_details`，两者 DeepSeek 都给）；未知模型返回 400 + `error.code = invalid_request_error`，能映射为永久性错误（映射不上会被内核当成可重试）。

**Kimi 与 GLM 实测结果（2026-09-05 同日拿到另两把 key）** —— 三家至此全部跑通，Q16 名单的协议语义部分收口：

| 维度 | DeepSeek（chat / reasoner / v4-flash） | Kimi（kimi-k3） | GLM（glm-5.3-flash） |
| --- | --- | --- | --- |
| 流式增量 | `choices[0].delta.content` | 同 | 同 |
| **推理** | chat 无；reasoner / v4-flash 有 | **有**（64 帧里 61 帧） | **有**（65 帧里 64 帧） |
| 并行工具调用 | 三个型号都支持 | 支持 | 支持 |
| **cache 字段** | `prompt_cache_hit_tokens`（顶层） | **`cached_tokens`（顶层）** | `prompt_tokens_details.cached_tokens`（嵌套） |
| usage 帧的 `choices` | **非空**（带 delta + finish_reason） | 空数组（OpenAI 形状） | **非空** |
| **图片输入** | v4-flash **接受但看不见**（HTTP 200 + "无法识别"） | **真能看**（32×32 纯红图答"红色"） | **真能看** |
| 未知模型的错误 | 400 + `code=invalid_request_error` | **404 + 只有 `type`，无 `code`** | 400 + `code="1214"` |

这一轮实测**改出了三个真缺陷**（都不是"写得不好"，是会让用户遇到坏行为的）：

1. **Kimi 的 404 会被内核无限重试。** 错误体里没有 `code`、语义在 `type` 里，而映射只看 `code`；查不到就落到"原样返回"，内核对映射不上的错误一律当可重试（`sse/responses.rs:461-470`）。修法两处：`code` 缺失时回退到 `type`；401/403/404 一并列入永久状态码。
2. **Kimi 的 cache 命中永远显示 0。** 它把命中数放在 usage 顶层的 `cached_tokens`，而规范化只认另两种写法。这条不会报错 —— 0 是"不支持 cache"的合法取值，所以漏读不会有人发现。
3. **三家主力型号全是推理模型**，而能力表按"旗舰才推理、flash 是轻量档"的直觉写了三个 `false`。标错的后果是推理段整块不显示，用户只觉得这模型不动脑子。

另外两条值得记的观察（不是缺陷，是选型信息）：

- **`imageInput` 有三种结局，不是两种**：真能看（Kimi / GLM）· 明确拒绝 · **接受请求但看不见**（deepseek-v4-flash）。第三种最危险，因为它不报错，只能靠能力表拦在前面 —— 这正是 D2「降级必须显式」要防的形态。
- **推理模型会吃掉 `max_tokens`**：给 64 token 预算时 DeepSeek 与 GLM 都返回**空 content**（预算全被思维链花完，`finish_reason` 仍是 stop）。调用方按非推理模型的经验设小预算，拿到的是"模型没回话"而不是报错。

能力表用 `verified` / `verifiedAt` / `unverified` 三个字段区分"验过什么、没验什么"，并由能力端点透出。`maxContextTokens` 要塞满上下文才能测，五个型号都仍在 `unverified` 里。

> ⚠️ 风险：Responses API 的 reasoning/encrypted_content 语义在非 OpenAI 模型上无对应物，需设计降级策略。**降级必须显式**：网关在响应里标注能力缺失，前端据此隐藏对应 UI（如推理过程折叠区），而不是静默留白。

### D3 —— 前端只接 app-server JSON-RPC

**决策**：前端不链接 Rust，不调 SDK 内部，只说 app-server v2 协议。初始化时声明 `capabilities.experimentalApi = true` 以启用 project、queue、goal、timeline 等实验方法。

**理由**：协议有版本化与实验字段 opt-in 机制（`codex-rs/app-server-protocol`），是唯一被上游承诺兼容性的边界。另有官方 TS/Python SDK（`sdk/typescript`、`sdk/python`）可用于服务层。

**代价**：部分能力标记 experimental，可能在上游变更。需在服务层做一层适配收敛。

### D4 —— 连接器全量走 MCP，放弃 codex 的 Apps 目录

**决策**：不复用 `codex-rs/connectors` 的目录/安装/OAuth 流程（绑定 chatgpt.com），改为自建 MCP server 集合 + 自建目录服务。保留 `app_tool_policy` 的权限模型思路。

**理由**：`connector_install_url()` 硬编码 `https://chatgpt.com/apps/...`，账号体系与 OAuth 回调均在 OpenAI 侧，不可能自托管。

### D5 —— Scheduler 是**桌面 App 内的本机常驻进程**（Q1=A 的直接后果）

**决策**：调度器随桌面 App 分发，作为常驻后台进程运行在用户机器上，automation 定义与执行历史落本机 sqlite。执行时复用同机常驻 app-server（省启动开销），批处理场景用 `codex exec`。云端只保存 automation **定义**的备份供多设备可见，**不负责触发**。

**理由**：Q1=A 决定执行必须在本机；触发点若放云端，到点时机器可能离线，反而多一层不可靠的远程唤醒。codex 完全没有调度能力，且调度涉及幂等、重试、告警，本就不该进内核。

**Q1=A 带来的三个必须解决的问题**（B 方案下不存在）：

| 问题                 | 处理                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 关机 / 休眠错过触发  | `misfire_policy`：`FIRE_ONCE_ON_WAKE`（默认，唤醒后只补一次）/ `FIRE_ALL`（逐次补齐）/ `DROP`；只补 `catchup_window`（默认 24h）内的触发                              |
| 同账号多设备重复执行 | **Q15 已决策**：automation 绑定创建它的设备（`device_id`），只有该设备触发；其他设备只读展示"在 <设备名> 上运行"并提供「迁移到本机」；绑定设备离线超 **7 天**提示迁移 |
| 到点时机器在睡眠     | macOS `IOPMAssertion` / launchd `StartCalendarInterval`，Windows 任务计划程序唤醒定时器，Linux systemd timer + `WakeSystem=true`；**唤醒执行默认关闭**，需显式开启    |

**代价**：可靠性从"服务端保证"降级为"尽力而为"。前端必须如实展示 `下次执行时间` 与 `上次跳过原因`，不得让用户误以为是云端级 SLA。见 R9。

### D6 —— 产物 = 文件系统为真源 + 服务层元数据索引

**决策**：产物本体落在工作空间目录（与 codex 的文件模型一致），服务层维护索引表（任务 ID、类型、格式、版本、生成时间、分享状态）。

**产物识别 = [自建]（v0.4 修订，依据 F10，M3）**。原文"内核已有识别逻辑"**不成立**，实测三条事实：

1. `recognize_artifact_operation()` 的返回值只被 `codex_analytics` 消费（`core/src/tools/events.rs:108-150`），**不进 app-server 协议** —— 前端拿不到任何产物事件；
2. 它要求 `attribution.plugin_id.marketplace_name == "openai-primary-runtime"`（硬编码的 OpenAI marketplace 名，`core-plugins/src/artifact_operation.rs:4,51-58`），且只认 4 个硬编码 plugin 名 + 精确脚本路径；
3. §7 的 P5 本来就要把 analytics 关掉。

因此 EvoWork 自建识别，走三个互补信号（任一命中即入索引，按绝对路径去重）：① **技能显式上报**（主，官方四技能调 EvoWork 自己的 `mark_artifact`）② `FileChange` item（兜底，按扩展名匹配）③ `post_tool_use` hook 扫描（保险）。`artifact_operation.rs` 只**沿用参数形状**（`--operation-kind` / `--expected-output-count` / `--output-format`），以便上游哪天把识别接进协议时能低成本切换；**不复用它的 marketplace 名**（K5）。详见 [08 §2](design/08-artifacts-and-ingest.md)。

**理由**：保持"文件即产物"的心智，避免引入独立的产物存储导致与工作空间视图分裂。

**Q1=A 修正**：索引表落在**本机 sqlite**（与 `CODEX_HOME` 同级）。云端只在用户显式点击分享时才收到该产物副本与元数据（Q10=A：默认关闭、逐次授权、链接有有效期）。跨设备的"我的全部产物"视图只覆盖当前设备 —— 这是 A 方案的已知功能缺口，要在 UI 上说清而不是隐藏。

### D7 —— 上游同步：最小补丁 + 季度 rebase

**决策**：维护一份 `patches/evowork/*.patch`，每个补丁必须有 issue 说明"为什么无法通过扩展点实现"。CI 对 upstream/main 做每日试合并告警。

**理由**：从最近提交（Guardian 证据保留、token budgeting 默认开关、`update_plan` 改为 opt-in）看，核心 API 仍在快速变动。补丁面越小，跟随成本越低。

### D8 —— Ask 模式用权限组合实现，不新增模式类型

**决策**：`Ask` = `SandboxPolicy::ReadOnly { network_access: false }` + `AskForApproval::Never` + 一份新的 `ask.md` developer instructions。通过 `turn/start` 的 `permissions` profile 切换。

**理由**：避免动 `CollaborationMode` 枚举（属于 protocol，改动会波及 schema 与 SDK 生成）。

### D9 —— 部署形态 = 纯本地桌面应用，云端只做「不得不联网的四件事」

**决策（Q1 = A，2026-09-03）**：agent 循环、沙箱、工具执行、文档解析、调度、产物索引**全部在用户机器上**。云端只保留四类职责：

| 云端职责                                   | 为什么不能放本地                           | 数据面                                                                      |
| ------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------- |
| 账号 / 租户 / 配额 / 授权                  | 跨设备身份与企业管控的唯一真源             | 只有身份与计量，无内容                                                      |
| 企业私有源索引（Q5：v1 无公开市场）        | 分发与审核天然中心化                       | 下行为主                                                                    |
| 模型网关（D2）                             | 密钥托管、计量、三家国内模型适配（Q2/Q16） | prompt 过境但**不落盘**；Q14：云端托管为主 + 企业私有部署包（客户自持密钥） |
| 产物分享托管（Q10=A）· 审计汇总 · 策略下发 | 对外分享与企业合规必须有服务端             | **默认关闭**，逐次显式授权，链接有有效期                                    |

**理由**：

1. 与 Q3（隐私为硬约束）同向 —— "原始数据不出本机"从产品承诺变成部署形态的自然结果，而不是靠约束云端行为来兜底。
2. 沙箱与文件访问语义最简单：内核看到的 cwd 就是用户真实工作目录，中间没有同步层。
3. 企业私有化诉求只需私有化那一层薄云端（甚至完全离线），不必搬运执行面。

**代价（必须正面承担，不要在实现里假装不存在）**：

| 代价                                                                  | 落点                                                                                       |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 调度可靠性下降（关机即不跑）                                          | D5 的 misfire / 唤醒策略；R9                                                               |
| 多租户治理弱：策略无法在服务端强制拦截                                | 签名策略包下发 + `requirements.toml` + `allow_managed_hooks_only`；离线超期降级为只读；R11 |
| 分发成本：内核二进制 + Python/Node 运行时 + 三平台签名公证 + 自动更新 | 新增里程碑 M9；R10                                                                         |
| 跨设备体验割裂（产物、执行历史只在本机）                              | UI 明示"当前设备"，不做隐式同步；Q15                                                       |
| 用户机器资源上限即并发上限                                            | Q11 的"单用户 3 并行"改为按本机 CPU / 内存动态下调                                         |

**被这条决策否定的选项**：不做云端容器执行（C），不做"本地执行 + 云端编排"的双活调度（B）。后续任何设计若需要"服务端在用户离线时替他做事"，必须先回到本条重新决策。

---

## 6. 模块详细设计

### 6.1 会话与任务管理

直接映射，无需自建存储：

| EvoWork 概念    | codex 概念      | 备注                                           |
| --------------- | --------------- | ---------------------------------------------- |
| 任务            | Thread          | 一个 thread 一个 rollout 文件 + sqlite 元数据  |
| 空间 / 工作空间 | Project + cwd   | `project/*` API（实验），绑定多个绝对路径 root |
| 文件夹分组      | ThreadSection   | 内置 pinned 分区即"置顶"                       |
| 消息 / 回合     | Turn / Item     | `thread/turns/list`、`thread/items/list` 分页  |
| 子任务          | Subagent Thread | `parentThreadId` / `ancestorThreadId` 查询谱系 |

**任务状态映射**（清单 §4.3 → `ThreadStatus`）：

| 清单状态 | 实现                                        |
| -------- | ------------------------------------------- |
| 运行中   | `ThreadStatus` 活跃 + 有 in-flight turn     |
| 已完成   | `turn/completed` status = completed         |
| 失败     | `turn/completed` status = failed            |
| 待处理   | 有 pending approval 或 `request_user_input` |
| 规划中   | collaborationMode = plan 且未确认           |
| 已归档   | `thread/archive`                            |

> 注：清单的"规划中"在 codex 里不是独立状态，需服务层根据 mode + 是否存在 `plan` item 派生。

### 6.2 工作模式

三份 developer instructions 模板 + 三套权限 profile：

```
craft:  default.md  + workspace-write  + on-request approval
plan:   plan.md     + read-only        + never approval
ask:    ask.md(新)  + read-only        + never approval + 禁用所有写工具
```

Ask 模式需在 `ToolContributor` 层过滤掉写类工具（不只靠沙箱，避免模型反复尝试后报错的体验问题）。

### 6.3 技能与市场

- **技能格式**：沿用 `SKILL.md` + frontmatter，零改动。
- **技能根目录**：`<config>/skills`、`~/.agents/skills`、`<project>/.agents/skills`。
- **分发**：打成 plugin bundle，manifest 可声明 `skills` / `mcpServers` / `apps` / `hooks` / `commands` + `interface`（displayName、logo、brandColor、screenshots、category、defaultPrompt）—— 这套元数据足以驱动一个应用商店级 UI。
- **需自建（Q5 已决策：v1 只做官方内置技能 + 企业私有源）**：v1 不建公开 registry、不做上架审核与评分，只需一个企业私有源索引（复用内核已支持的 npm source / git / 本地目录三种装载方式）。公开市场推迟到 v2 —— 这把 M7 从 8 人周降到 5 人周。
- **安全审计**：`marketplace_policy.rs` + bundle 校验 + `guardian-v2` 白名单 → 映射为 P0/P1/P2 分级。

### 6.4 专家系统

```toml
# ~/.evowork/agents/finance-analyst.toml
name = "finance-analyst"
description = "财务分析专家：擅长财报解读、比率分析、预算编制"
nickname_candidates = ["小财", "Ledger"]

# 以下为该角色独立的 config 层
model = "evowork-pro"
[collaboration_mode]
developer_instructions = "..."
```

- 加载：`codex-rs/agent-roles`，支持 `agents/` 目录发现 + 配置层合并。
- 协作：`spawn_subagent` 派生子线程，父线程通过 `AgentSpawner` capability 编排。
- **需自建**：100+ 角色的内容本身、推荐算法、角色管理后台。

### 6.5 连接器 / MCP

> **Q9 已决策（2026-09-03）：国内生态集成本期不做。** 腾讯文档 / ima 知识库 / 乐享 / 企业网盘的上传集成，以及飞书 / 企微 / 钉钉连接器全部推迟到 v2；**本期只保留浏览器 MCP**（它不属于国内生态集成，且是网页类任务与预览的基础）。M6 因此从 8 人周降到 2 人周。MCP 协议能力本身仍然完整复用内核，用户可自行接入第三方 MCP server。

每个连接器 = 一个 MCP server + 一份权限声明。下面是 v2 的目标形态，本期只落 `browser/`：

```
evowork-connectors/
  feishu/        (docs, calendar, im, approval)
  wecom/
  dingtalk/
  tencent-docs/
  browser/       (CDP，配合 BrowserUseConfig 的 origin 级 access/downloads/uploads 策略)
```

OAuth 令牌存 `codex-rs/secrets` + `keyring-store`，不落明文配置。

### 6.6 记忆系统

| 层级       | 实现                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户级本地 | `CODEX_HOME/memories`（沿用 codex 结构，`memory/reset` API 可清空）                                                                                        |
| 工作空间级 | `AGENTS.md` 层级加载 + `ext/history-notes` 日志/笔记                                                                                                       |
| 云端       | 实现 `MemoryBackend` trait 的远端版本（`ext/memories/src/backend.rs`）；**Q1=A + Q3 硬约束下默认关闭**，开启需显式授权，且只同步结构化记忆条目、不同步原文 |
| 会话内检索 | `thread/searchOccurrences`                                                                                                                                 |

> `thread/memoryMode/set` 可按任务开关记忆写入，直接满足隐私诉求。

**v0.4 修订（依据 06 §5）**：记忆必须有**用户可见、可编辑的界面入口**，否则"隐私可控"只是配置项而非体验。落点两处：① 资料库「我的资料」下的固定节点「长期记忆」——条目列表，可查看 / 编辑 / 删除单条，`memory/reset` (exp) 对应「清空全部」；② agent 每次写入用户级记忆，**在对话流里插入一条可见单行 item**（「已记住：<摘要>」+「撤销」）—— 不做静默记忆。云端记忆默认关闭，因此**不为它做一级入口**。

### 6.7 产物系统与文档解析

**输出侧（生成产物）**——需自建 4 个技能包：

| 技能            | 输出格式         | 实现建议              |
| --------------- | ---------------- | --------------------- |
| `documents`     | doc/docx/md/pdf  | python-docx / pandoc  |
| `spreadsheets`  | csv/tsv/xls/xlsx | openpyxl              |
| `presentations` | ppt/pptx         | python-pptx，配模板库 |
| `charts`        | svg/png          | matplotlib / vega     |

技能通过 EvoWork 自己的 `container_tools/mark_artifact` 脚本向**本机 artifacts 服务**上报产物意图（参数形状沿用内核 `artifact_operation.rs` 的约定，但不经过内核，见 D6 的 v0.4 修订）。

**v0.4 修订（三条，依据 F11 与 08 §4/§5.3）**：

1. **内核 `artifact_type` 只有 `presentation` / `document` / `spreadsheet` / `pdf`，没有 `chart`**（`core-plugins/src/artifact_operation.rs:24-49`）。因此 `charts` 技能没有内核类型可对齐，EvoWork 自建 9 类产物类型体系：`document` / `spreadsheet` / `presentation` / `pdf` / `chart` / `image` / `webpage` / `data` / `archive`（08 §2.3）。`chart` 与 `image` 都可能是 png，**靠信号源而不是扩展名区分**。
2. **解析运行时按档位分发**（对齐 R10「按需下载而非全量随包」）：基础包（TXT/MD/CSV/TSV/ZIP/JSON，0MB，随主程序）· 办公扩展（Python + python-docx/openpyxl/python-pptx/pdfplumber，~120MB，按需下载）· OCR 扩展（tesseract + 中文模型，~60MB，按需下载）。企业离线部署提供全量包。**产物生成技能与解析管道共用同一档位**，提示文案必须统一（08 §4）。
3. **结构化生成原则（R4 的主要缓解手段）**：模型的输出不是 pptx/docx 本体、也不是 python 代码，而是一份**受 JSON Schema 约束的内容 JSON**；排版、字号、留白、配色由 `render.py` 按模板库完成。理由：轻量档模型（Q16 的 GLM-5.3-flash）在"生成 python-pptx 代码"上失败率高，在"填受约束 JSON"上可靠得多。每个技能必须带 JSON Schema，校验失败把具体错误回给模型让它修一次，而不是直接失败（08 §5.3）。

**输入侧（解析上传文件）**——`UserInput` 只支持 Text / Image / Audio，因此：

```
前端上传 → 服务层解析管道（PDF/Office/ZIP → Markdown + 附件图片）
        → 落到工作空间 uploads/ 目录
        → 以 Text(摘要+路径) + Image(图表页) 形式注入 turn/start
        → agent 需要细节时用 shell 读原文件
```

> ⚠️ 这条链路是"文件处理默认在本地完成"隐私承诺的关键实现点。
> **Q3 已决策为硬约束 + Q1=A 后，这不再是可选项**：解析管道是桌面 App 的本机进程，随包分发解析运行时（Python/Node，安装包 +100–300MB，见 M9 与 R10）；**不存在"退回云端解析"的兜底路径**，扫描件也不能走云端 OCR，只能用本地 OCR 或如实告诉用户无法处理。

### 6.8 多模态生成

| 能力                     | 状态                                                       |
| ------------------------ | ---------------------------------------------------------- |
| 文生图 / 图生图          | `ext/image-generation`，走当前 model provider，可直接复用  |
| 文生视频 / 图生视频      | **本期不做**（Q4）；v2 再评估，需新 extension + 第三方 API |
| 文生 3D / 图生 3D        | **本期不做**（Q4）；同上                                   |
| 图片视频特效（模板驱动） | **本期不做**（Q4，依赖视频能力）                           |

> Q4 已决策（2026-09-03）：本期只做图片生成，直接复用 `ext/image-generation`，增量成本≈0。视频与 3D 各约 3 人周，放 v2。

### 6.9 自动化任务（Scheduler）

数据模型：

```
automation                -- 存本机 sqlite；定义可选备份到云端供多设备可见
  id, tenant_id, owner_id, name
  device_id               -- 绑定的执行设备（Q1=A + Q15：只有这台机器触发，其他设备只读可迁移）
  prompt                  -- 自然语言任务描述
  workspaces[]            -- 一个或多个执行目录（本机绝对路径）
  schedule                -- cron 表达式 / once@timestamp
  timezone
  valid_from, valid_until
  status                  -- ACTIVE | PAUSED
  concurrency_policy      -- SKIP（Q8 已决策，固定值；QUEUE/ALLOW 保留字段不实现）
  retry_policy            -- Q8 已决策：失败不自动重试
  consecutive_failures    -- 连续失败计数，达 3 自动置 PAUSED 并通知（Q8）
  misfire_policy          -- FIRE_ONCE_ON_WAKE | FIRE_ALL | DROP   (Q1=A 新增，见 D5)
  catchup_window          -- 补偿窗口，默认 24h
  wake_system             -- 是否允许唤醒睡眠中的机器，默认 false
  created_at, updated_at

automation_run
  id, automation_id, fire_time, thread_id
  status                  -- RUNNING | SUCCEEDED | FAILED | SKIPPED | MISSED
  skip_reason             -- CONCURRENCY | MACHINE_OFFLINE | OUT_OF_WINDOW | QUOTA
  trigger                 -- SCHEDULED | MANUAL | MANUAL_TEST | CATCHUP   (v0.4 新增)
  original_fire_time      -- CATCHUP 时指向原定时刻                        (v0.4 新增)
  failure_class           -- MODEL | SCRIPT | APPROVAL_TIMEOUT | ENVIRONMENT | QUOTA (v0.4 新增)
  token_usage, cost, error_summary
  started_at, finished_at
```

**v0.4 的三条修订（依据 07 §8）**：

1. **`trigger` + `original_fire_time` 是文案一致性的硬前提**：`FIRE_ONCE_ON_WAKE` + 关机一夜错过 1 次 + 开机补跑，历史里必须出现**两条**记录（一条 `MISSED / MACHINE_OFFLINE` 指向原定时刻 + 一条 `SUCCEEDED` 标注「补跑（原定 …）」）。只留补跑那一条，用户永远不知道自己漏了 —— 这直接决定 scheduler 的落库顺序（先写 MISSED 再补跑，09 §6.1），不只是 UI。
2. **环境原因失败不计入 `consecutive_failures`**（对 Q8 的细化）：`failure_class = ENVIRONMENT`（电脑关机导致执行中断、工作空间路径失效等）不计数。否则笔记本用户的自动化会在三天内全部被自动暂停。只有任务自身失败（`MODEL` / `SCRIPT` / `APPROVAL_TIMEOUT`）才计数。
3. **定时任务强制要求硬预算**（对 Q11 的收紧）：Q11 只说"单任务硬预算"，此处要求自动化**不得不设** —— 一个失控循环会在夜里烧完配额。

**执行（Q1=A 版本）**：单机进程，幂等键落成 sqlite 唯一索引即可，**不需要分布式锁**。

> **2026-09-05 修订（接线时实测）**：幂等键是 **`automation_id + fire_time + trigger`** 三列，
> 不是原文写的两列。原因是它与本节 v0.4 修订第 1 条（先写 MISSED 再补跑）**直接冲突**：
> 那两条记录共享同一个 `fire_time`（补跑的 `original_fire_time` 就是被错过的那个时刻），
> 两列的唯一索引会让补跑那条插不进去 —— 表现是「历史里只有一条『错过』，任务再也没跑」。
> 两个模块各自都对，合起来才不对，所以它是被端到端接线测试抓出来的，不是单测。进程启动时先做一次 misfire 扫描：`[max(last_fire, now - catchup_window), now]` 区间内应触发而未落库的时间点，按 `misfire_policy` 处理，其余记 `MISSED / MACHINE_OFFLINE`。

**失败语义（Q8 已决策）**：上次未跑完又到点 → `SKIP` 并记 `skip_reason = CONCURRENCY`；失败不自动重试；`consecutive_failures` 连续 3 次 → 自动 `PAUSED` + 通知用户。执行历史只留本机，云端仅收 token / cost 统计摘要用于配额。

**设备迁移（Q15 已决策）**：「迁移到本机」= 改写 `device_id` + **把 misfire 基准重置为迁移时刻**（否则新设备一上线就按 `catchup_window` 补出一堆历史触发）。迁移是排他操作，用云端那份 automation 定义做乐观锁，避免两台设备同时认领。若工作空间路径在新设备上不存在，迁移必须失败并要求用户重选目录，不得静默改路径。

### 6.10 可视化（Visualizer）

纯前端职责。约定 agent 用受控 fence 输出，前端识别并渲染：

- ` ```mermaid ` → mermaid 渲染
- ` ```evowork-chart ` （JSON spec）→ Chart.js / Vega
- ` ```html ` → **沙箱 iframe**（CSP 严格限制，禁 script 外链）

> ⚠️ 安全：渲染模型生成的 HTML 是 XSS 面。必须在独立 origin 的 iframe + CSP 白名单内渲染。

### 6.11 安全与权限

三层纵深，全部复用：

```
① 沙箱层     SandboxPolicy（read-only / workspace-write / danger-full-access）
             + landlock/seccomp (Linux) / Seatbelt (macOS) / windows-sandbox
② 策略层     execpolicy 命令白名单 DSL
             + hooks(pre_tool_use / permission_request) 做租户策略与配额
             + requirements.toml 管理员强制层（allow_managed_hooks_only）
③ 审查层     guardian-v2 安全审查 subagent（风险分级 + 可信工具/技能白名单 + 证据留存）
             + AskForApproval::Granular 细粒度人工确认
```

EvoWork 需新增的 Hooks 策略包：

| Hook                  | 用途                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session_start`       | 注入租户策略、检查配额                                                                                                                                |
| `pre_tool_use`        | 审计留痕、敏感路径拦截（桌面/下载/文档目录白名单）；**能力面不得扩大**：安装时声明 `network: none` 的技能运行时出网一律拒绝并记审计（05 §3.3 规则 2） |
| `permission_request`  | 对接前端审批 UI + 企业审批流                                                                                                                          |
| `post_tool_use`       | 产物识别、成本累计                                                                                                                                    |
| `subagent_start/stop` | 并发数与预算控制                                                                                                                                      |
| `session_end`         | 审计归档                                                                                                                                              |

**v0.4 修订（依据 10 §2.3）**：敏感目录的**硬拦截清单对 `danger-full-access` 同样生效**，不可绕过。硬拦截 = 系统目录（`/System`、`/Windows`、`/usr/bin`…）+ 密钥与凭据（`~/.ssh`、`~/.aws`、keychain、浏览器 profile）+ EvoWork 自身配置（`~/.evowork/config.toml`、`requirements.toml`）。理由：用户点「完全访问」是为了让 agent 装依赖、改工作空间外的项目文件，不是为了让它读走 SSH 私钥；把这条做成不可绕过比在审批卡上写警告有效得多。第二级（桌面 / 下载 / 文档 / 工作空间之外的任何路径）走 `permission_request` 逐次审批。

### 6.12 可观测与成本治理

- `codex-rs/otel` → OpenTelemetry 导出，接自有 APM。**Q14 约束**：网关侧的 span 不得携带 prompt / 响应正文，只放 token 数、时延、错误码；应用日志与错误上报同理。
- `codex-rs/rollout-trace` → 完整执行轨迹，用于回放与事故复盘。
- `ext/goal` 的 `ThreadGoal` 已带 **token budget** 字段，可直接用作单任务成本上限。
- `TokenUsageContributor` → 实时计量对接配额系统。

**并发与预算（Q11 已决策）**：

| 项                                 | 结论                                                                                                                     | 实现                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 单用户并行任务数                   | **3**，且按本机 CPU / 内存动态下调（Q1=A：机器就是资源上限）。**上限不可由用户上调，只可下调**（v0.4 修订，10 §5.1）     | `min(3, floor(可用内存GB / 2), CPU核数 - 1)`，最低 1；`subagent_start` hook 拒绝超限派生 + 前端排队 |
| 单任务 token 预算                  | **硬预算**；**定时任务不得不设**（v0.4 修订，07 §3.2）                                                                   | `ThreadGoal.budget`，无需自建                                                                       |
| 超预算行为                         | **暂停并询问用户**（不自动降级、不静默失败）                                                                             | 预算耗尽 → `turn` 暂停 + `request_user_input`                                                       |
| **审批超时**（v0.4 新增，10 §3.6） | 交互式任务**不自动拒绝**（用户回来还能继续）；**定时任务超时 10 分钟自动 `Decline`**，run 记 `FAILED / APPROVAL_TIMEOUT` | 定时任务没人看着，挂在审批上会一直占并发额度                                                        |

**第 15 章方向本期落地范围（Q12 已决策）**：只做两项，其余保留接口不实现。

| 落地项     | 复用件                                                    | 实现要点                             |
| ---------- | --------------------------------------------------------- | ------------------------------------ |
| 审计留痕   | `rollout-trace` + hooks（`pre_tool_use` / `session_end`） | 轨迹留本机，云端只收摘要（Q1=A、Q3） |
| 单任务预算 | `ext/goal` 的 `ThreadGoal.budget`                         | 与上面 Q11 是同一套机制，不重复造    |

> 未落地但保留接口：Agent 密码学身份（`agent-identity`）、对抗式验证（`guardian-v2` + `review/start`）、声明式目标持续 reconcile。
>
> **v0.4 明确「保留接口」的具体含义**（依据 10 §6）：`audit_log` 表预留 `agent_identity` 与 `verification_ref` 两个可空列、**不写入**；`review/start` **不在适配层暴露**。除此之外不为这三个方向留任何代码。

---

## 7. 上游改动清单（必须打补丁的点）

目标：控制在 5 个文件以内。

| #      | 位置                                                   | 改动                            | 能否避免                                                                                                                                                                       |
| ------ | ------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1     | `codex-rs/connectors/src/lib.rs:484`                   | `chatgpt_base_url` 默认值可配置 | 可用环境变量 `CODEX_APP_SERVER_CHATGPT_BASE_URL` 绕过，**无需改码** ✅                                                                                                         |
| P2     | `codex-rs/model-provider-info/src/lib.rs`              | 注册 EvoWork provider           | 可用 `config.toml` 的 `model_providers` 绕过，**无需改码** ✅                                                                                                                  |
| ~~P3~~ | ~~`codex-rs/collaboration-mode-templates/templates/`~~ | ~~新增 `ask.md`~~               | **v0.4 删除**（F1）：`turn/start.collaborationMode.settings.developer_instructions` 纯配置可实现，指令文本随 EvoWork 分发在 `config/modes/*.md`，不进内核仓库，**无需改码** ✅ |
| P4     | 品牌字符串（`CODEX_HOME`、UA、提示文案）               | 改为 EvoWork                    | 需改，且面较散 —— 只改对外可见字符串，保留内部路径名。**Q13 已决策保留 CLI**，故 CLI 的命令名、帮助文案、版本输出也进入"对外可见"范围，补丁面略增但仍在 K1 上限内              |
| P5     | 遥测端点                                               | 关闭/改向                       | 走配置                                                                                                                                                                         |

**结论（v0.4 修订）：真正的代码补丁只剩 P4 一项（品牌字符串），其余全部靠配置。** K1 的硬上限（≤5 文件 / ≤500 行）余量充足。这比 v0.3 的判断更强地验证了 D1。

---

## 8. 里程碑与工作量估算

以 3–4 人研发（1 Rust / 2 前端+服务 / 1 技能与内容）为基准，单位：人周。

| 里程碑                                           | 内容                                                                                                                                                     | 估算  | 交付判定                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------- |
| **M0 可行性验证**                                | 跑通 codex → 自研网关 → 国内模型；用 `codex exec` + 一个自写 PPT 技能完成端到端"生成汇报"                                                                | 3     | 一句话生成 pptx 成功                                                                   |
| **M1 模型网关**                                  | Responses API 完整语义（流式、工具调用、reasoning 降级、cache）+ **DeepSeek / Kimi / GLM-5.3-flash 三家适配**（Q2/Q16）+ 企业私有部署包（Q14）           | 8     | 官方 SDK 测试套件通过；三家均跑通端到端工具调用；日志/trace/错误上报三条路径均不含正文 |
| **M2a 服务层与协议适配**（v0.4 从 M2 拆出，Q27） | app-server 适配层 + 实验方法降级表 + 8 张本机 sqlite 表（含两个迁移器）+ 事件流→UI 状态投影 + 断连重连与会话恢复                                         | 2–3   | 前端只调语义化 API；杀掉 app-server 后 UI 能自愈并如实提示                             |
| **M2 前端 MVP**                                  | 三栏布局 + 任务列表 + 对话流（19 类 Item）+ 审批请求处理器 + 中断/追问 + 变更视图                                                                        | 10    | 覆盖清单第四、五章                                                                     |
| **M3 办公技能包**                                | documents / spreadsheets / presentations / charts + 文档解析管道 + **三档运行时分发**（v0.4 显式计入）                                                   | **9** | 覆盖清单 §2.1、6.2                                                                     |
| **M4 安全与策略**                                | Hooks 策略包 + guardian 分级映射 + 审计留痕（Q12）+ 单任务预算（Q11/Q12）+ **Windows 沙箱隔离强度评估**（Q6）                                            | 4     | 通过内部安全评审；Windows 侧给出明确的能力/降级结论                                    |
| **M5 Automations**                               | **本机常驻调度器**（misfire 补偿 + 系统唤醒 + 设备绑定，Q1=A）+ 执行历史 + 前端配置界面                                                                  | 5     | 覆盖清单第七章；关机 8 小时后按 misfire 策略正确补偿                                   |
| **M6 连接器**                                    | **仅浏览器 MCP**（Q9：国内生态集成本期不做）                                                                                                             | 2     | 网页任务与预览可用                                                                     |
| **M7 技能包 + 专家**                             | 企业私有源装载 + 角色内容（Q5：不做公开 registry 与审核）                                                                                                | 5     | —                                                                                      |
| **M8 可视化 + 产物分享 + 资料库**                | Visualizer + 本机产物索引 + 分享链接（Q10：默认关闭、逐次授权、有有效期）+ **资料库主体**（三栏 + 索引 + FTS 全文搜索 + 记忆可见面，v0.4 范围增量，Q28） | **8** | —                                                                                      |
| **M9 桌面分发**（Q1=A 新增）                     | 打包（内核二进制 + Python/Node 解析运行时）、三平台签名/公证、自动更新、崩溃回收、EvoWork CLI 随包（Q13）                                                | 3     | 三平台安装包可自动升级，离线可用                                                       |

合计约 **57 人周**（≈ 4 人 × 3.6 月）到达本期范围对齐。

**v0.4 对合计的修正（53 → 57）**，三项都不是估算误差：

| 类型     | 内容                                                                                    | 增量 |
| -------- | --------------------------------------------------------------------------------------- | ---- |
| 漏排 A   | 服务层与协议适配没有独立里程碑，被 M2 的 10 人周隐含吞掉 → 单列 **M2a 2–3 人周**（Q27） | +2~3 |
| 漏排 B   | 解析运行时的三档分发（R10 要求按需下载）在 M3 里未显式包含 → M3 8→9                     | +1   |
| 范围增量 | 资料库主体（清单里被拆散、真实产品里是一级入口）→ 并入 M8，5→8（Q28）                   | +3   |

与 v0.1（57 人周）的差异全部来自 v0.3 决策：M1 +2（Q2 国内模型）、M9 +3（Q1=A 桌面分发）、M6 −6（Q9 不做国内生态）、M7 −3（Q5 不做公开市场）；v0.4 又加回上表三项。

**关键路径 ≈ P0（1.5 周）+ M0（3 周）+ M1（8 周）≈ 12.5 周**，前提是网关有一名专职的人从 M0 结束就满负荷投入（Q21）。M0 之后三条泳道齐跑（网关 / 服务层+前端 / 技能与解析），**第 12 周内测可演示**（Q22）。

**不含**：多模态视频 / 3D（Q4）、国内生态集成（Q9）、公开技能市场（Q5）、第 15 章除审计与预算外的方向（Q12）。
**另需常设 0.5 人力**跟随上游做季度 rebase（Q7），不计入上表。

---

## 9. 风险登记册

| ID  | 风险                                                                                                              | 影响 | 概率             | 缓解                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Responses API 网关工作量被低估**                                                                                | 高   | 高               | Q2 已决策必须支持国内模型 → M1 上调至 8 人周；M0 先做最小验证；每家模型的流式/工具调用差异单独建测试用例；预留 1.5 倍 buffer                                                                                                                                                                                                                                                                               |
| R2  | 上游 API 快速变动，rebase 成本失控                                                                                | 高   | 中               | 补丁清单化；CI 每日试合并；必要时在稳定 tag freeze                                                                                                                                                                                                                                                                                                                                                         |
| R3  | **定位摩擦**：codex 假设 git 仓库 + 编码场景，办公场景（"写个周报"）持续别扭                                      | 高   | 高               | M0 就在办公场景验证，而非编码场景                                                                                                                                                                                                                                                                                                                                                                          |
| R4  | 模型能力不足导致产物质量差（PPT 排版、图表美观）                                                                  | 中   | 高               | 技能内置模板库，减少模型自由度；**Q16 的 P0 里含轻量档 GLM-5.3-flash，M0 必须用它跑产物质量验证**，不达标就换旗舰档而不是靠模板硬扛                                                                                                                                                                                                                                                                        |
| R5  | Visualizer 渲染模型生成 HTML 引入 XSS                                                                             | 高   | 中               | 独立 origin iframe + 严格 CSP                                                                                                                                                                                                                                                                                                                                                                              |
| R6  | Apache-2.0 合规疏漏（NOTICE、商标）                                                                               | 中   | 低               | 法务过一遍；建 `THIRD_PARTY_NOTICES`                                                                                                                                                                                                                                                                                                                                                                       |
| R7  | 隐私承诺（"原始数据不上传"）与云端能力（分享链接、云记忆、云端多模态）冲突                                        | 高   | **低**（已收敛） | Q1=A + Q3 硬约束把执行面整体留在本机；剩余出网点只有分享链接（Q10）与云记忆，均默认关闭并逐次授权；模型调用这条必然出网的路径由 Q14 的「网关不落盘」承诺兜底，且该承诺需可审计（配置固化 + 日志抽查）                                                                                                                                                                                                      |
| R8  | Windows 沙箱成熟度低于 Linux/macOS                                                                                | 中   | 中               | Q6 已决策暂用上游 `windows-sandbox-rs`，不自研；M4 单独评估隔离强度，若不足则 Windows 侧禁用 `danger-full-access` 并以审批为主。**v0.4 补 UI 落法（10 §7）**：隔离不足时把 `evowork-full` 在 `permissionProfile/list` 里标成 `allowed: false` **并给出原因页**（设置→「本机安全能力」列出当前平台的沙箱类型、可用隔离级别、因此受限的功能），**不静默降级**；Q26 已决策 macOS 首发，Windows 随 M4 结论再定 |
| R9  | **本机调度不可靠**：关机 / 休眠 / 时区变更 / 多设备导致定时任务漏跑或重复跑                                       | 高   | 高               | D5 的 misfire 补偿 + 设备绑定 + 可选唤醒；前端如实展示"下次执行时间 / 上次跳过原因"，不承诺云端级 SLA                                                                                                                                                                                                                                                                                                      |
| R10 | **桌面分发成本**：安装包含内核二进制 + Python/Node 运行时（+100–300MB）、三平台签名公证、自动更新、内核随上游升级 | 中   | 高               | 单列 M9；解析运行时按需下载而非全量随包；升级走差量包                                                                                                                                                                                                                                                                                                                                                      |
| R11 | **治理弱化**：Q1=A 后企业策略无法在服务端强制拦截，只能下发到每台设备                                             | 中   | 中               | 策略包签名 + 启动时校验 + `requirements.toml` / `allow_managed_hooks_only`；离线超期自动降级为只读模式                                                                                                                                                                                                                                                                                                     |

---

## 10. 决策记录与剩余问题

> **2026-09-03 产品评审：Q1–Q16 全部决策完毕**，含三个阻塞项（Q1/Q2/Q3）与两个由 Q1=A 派生的问题（Q14/Q15）。
> **2026-09-05：Q17–Q20（产品，来自详细设计集）与 Q21–Q29（工程与排期，来自 work-priority）全部决策完毕，本章无开放项。**
> 本章保留结论与展开位置的指针，是后续详细设计的前提；要推翻其中任何一条，先改本章再改代码。

### 10.1 已决策（2026-09-03）

| #      | 问题                   | 决策                                                                                                              | 展开在                                 |
| ------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| 🔴 Q1  | 部署形态               | **A 纯本地桌面应用** —— 执行 / 沙箱 / 解析 / 调度 / 产物索引全部在本机；云端只做账号·私有源索引·模型网关·分享托管 | **D9**、§4.1、D5、D6、§6.9、R9–R11、M9 |
| 🔴 Q2  | 主力模型与国内模型     | **必须支持国内模型** —— 网关是全量协议适配层而非薄转发；P0 名单见 Q16                                             | **D2**（语义矩阵）、M1（6→8）、R1      |
| 🔴 Q3  | 隐私边界               | **硬约束** —— 解析必须本地执行、不得用云端 OCR、离开本机的动作逐次显式授权                                        | §6.7、§6.6、R7                         |
| 🟡 Q4  | 视频 / 3D 生成         | **本期不做**，只做图片（复用 `ext/image-generation`，增量成本≈0）                                                 | §6.8、N5                               |
| 🟡 Q5  | 技能市场               | **v1 只做官方内置技能 + 企业私有源**，公开 registry / 审核 / 评分推 v2                                            | §6.3、D9、M7（8→5）、N6                |
| 🟡 Q6  | Windows 支持           | **支持，暂用上游 `windows-sandbox-rs`**，不自研沙箱；隔离强度在 M4 单独评估                                       | §3.7、R8、M4                           |
| 🟡 Q7  | 与上游的关系           | **跟随** —— 季度 rebase，补丁硬上限 5 文件 / 500 行，常设 0.5 人力                                                | D7、§7、§8                             |
| 🟡 Q8  | 定时任务语义           | **SKIP**（不并行）+ **失败不自动重试** + **连续 3 次失败自动 PAUSE 并通知**                                       | §6.9                                   |
| 🟡 Q9  | 国内生态集成           | **本期不做** —— 飞书 / 企微 / 钉钉 / 腾讯文档 / ima / 乐享 / 企业网盘全部推 v2，只保留浏览器 MCP                  | §6.5、M6（8→2）、N7                    |
| 🟡 Q10 | 产物分享形态           | **A 显式授权后上传 EvoWork 云** —— 默认关闭、逐次授权、链接有有效期                                               | D6、D9、M8                             |
| 🟡 Q11 | 并发与成本上限         | **单用户 3 并行**（按本机资源动态下调）+ **单任务 token 硬预算** + **超预算暂停询问**                             | §6.12、D9                              |
| 🟢 Q12 | 第 15 章「下一代」方向 | **只落「审计留痕」与「单任务预算」两项**，其余保留接口不实现                                                      | §6.12、N4                              |
| 🟢 Q13 | 是否保留 CLI           | **保留**，以「EvoWork CLI」独立品牌对外                                                                           | §7 P4、M9                              |
| 🟡 Q14 | 模型网关托管形态       | **云端统一托管为主 + 企业私有部署包**；网关**不落盘 prompt 与响应体**，只记 token 计数、时延、错误码              | D2、D9、§6.12、M1、R7                  |
| 🟡 Q15 | 多设备定时任务归属     | **绑定创建它的设备**，其他设备只读 + 可「迁移到本机」；绑定设备离线超 7 天提示迁移                                | D5、§6.9                               |
| 🟡 Q16 | 国内模型 P0 名单       | **DeepSeek · Kimi · GLM-5.3-flash** 三家                                                                          | D2（适配重点）、M1、R4                 |

> Q16 的另一半"是否有自建推理服务"已在 v0.4 作为 Q29 正式决策为**「无」**：网关仍保留私有 endpoint + 自定义鉴权的配置项（成本≈0），但不为它专门排期。若后续确有自建推理，回到 D2 补一条适配。

### 10.1.1 产品决策 Q17–Q20（2026-09-05，来自详细设计集 §5）

四条都是**截图里存在、v0.3 第 10 章没有对应决策**的东西，且都触碰已定硬约束。结论 = 采纳详细设计集的默认方案。

| #      | 问题                                                            | 决策                                                                                                                                                                                                                                                    | 为什么这样定                                                                                                                                                                                            | 展开在                                                                            |
| ------ | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 🟡 Q17 | 是否提供个人云端存储？（截图 4 的「880.1 KB / 5.0 GB + 升级」） | **不做个人云盘**。配额条改为展示**本机磁盘占用**（产物 + 解析缓存 + 索引），右侧动作是「清理」而不是「升级」                                                                                                                                            | 它换来的用户价值（跨设备取文件）远小于它打破的隐私叙事：个人云存储会成为 D9 之外的**第五项云端数据面职责**，与 K6 / Q1=A 直接冲突，且"升级"意味着存储商业化。真要跨设备，Q10 的逐次授权分享通道够用     | [06 §3.5](design/06-library.md)                                                   |
| 🟡 Q18 | 是否做积分 / 成长 / 运营位？                                    | **保留布局插槽、默认不启用**。四个插槽（`titlebar-promo` / `activity-popover` / `sidebar-promo` / `showcase`）配置驱动，只有 `showcase` 默认开且内容是官方最佳实践；企业版可用 `requirements.toml` 强制置空。**插槽只渲染静态内容，不接受任何回传埋点** | 布局成本已经付了（插槽就是几个 div），但云端活动服务 + 用户行为上报是另一个量级的投入，且与企业版定位相悖。要做积分体系，需新增的不是 UI 而是：活动服务 + 行为上报通道 + 与 Q3 的口径对齐，应单列里程碑 | [01 §7.4](design/01-ui-design-system.md)、[03 §6](design/03-home-and-composer.md) |
| 🟡 Q19 | 「团队空间」是只读订阅还是双向协作？                            | **只读订阅**。复用 D9 已批准的「企业私有源索引」这条云端职责，把它从技能分发扩展到资料分发（同一通道、同一签名校验、同一信任模型）；写入方向仍走 Q10 的逐次授权。**「与我共享」收件箱 v1 不做**（Tab 不渲染）                                           | 这是唯一能既保住 D9、又让「团队空间」不是空壳的形态。双向协作 = 用户内容常态上云，直接推翻 D9，另需多端一致性、冲突合并、权限模型与审计，是独立产品级投入                                               | [06 §4](design/06-library.md)                                                     |
| 🟡 Q20 | 「助理」与「任务」的关系？                                      | **一个常驻的特殊 Thread**：固定 cwd（`~/.evowork/assistant/`）、默认 Ask 模式、**不进任务列表**、可 `thread/fork` 升级为正式任务。token 消耗**计入**配额与预算，但在用量视图里单列一项「助理」                                                          | 任务列表、产物、审批、预算这四套机制全部挂在 Thread 上；助理若自建会话存储，就要把四套机制各做一遍且与 D6/Q11 口径分裂。做成特殊 Thread 后天然拥有排队、中断、搜索、压缩、记忆能力，增量近零            | [02 §4.2](design/02-information-architecture.md)                                  |

### 10.1.2 三条截图与已定决策的冲突（决策已明确，UI 必须如实降级）

不构成新问题，但**不能照抄截图**：

| 冲突                                           | 已定决策                 | UI 处理                                                                                                                                                                                                          |
| ---------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 截图 2 的「SkillHub」公开市场 Tab、精选/评分位 | Q5：v1 不做公开 registry | Tab **直接不渲染**（不是置灰 —— 置灰会让用户反复点、反复失望）；只呈现「官方内置 + 企业私有源」两个来源，每张卡**必须标来源**（05 §3.2）                                                                         |
| 截图 3 的 18 张国内生态连接器卡                | Q9：本期只做 browser     | 不出现，**也不做"即将推出"占位卡**（占位卡等于承诺排期）；目录只列 browser + 用户自建 MCP + 私有源下发的 MCP，顶部常驻一行说明「本版支持通过 MCP 接入任意第三方服务，官方连接器目录将在后续版本提供」（05 §4.3） |
| 截图 4 的「与我共享」收件箱                    | Q10 只决策了出方向       | v1 只做「我分享的」；「与我共享」随 Q19 决策为不做（06 §4.3）                                                                                                                                                    |

**三条必须记住的交叉影响**（后续设计不要各自为政）：

1. **Q1=A 与 Q3=硬约束互相加固**：隐私不再靠"约束云端行为"兜底，而是部署形态的自然结果。代价集中在调度可靠性（R9）与分发体积（R10），已分别有落点。
2. **Q2 与 Q9 方向相反**：模型侧的国内适配全做（+2 人周），生态侧的国内集成全不做（−6 人周）。净工作量下降，但对外表述要分清 —— **"支持国内模型" ≠ "支持国内办公生态"**。
3. **Q1=A 削弱了 Q5/Q10/Q12 对云端的依赖**：私有源、分享托管、审计汇总都变成"薄且默认关闭"的云端功能，企业私有化时可以整层替换或直接离线。

### 10.1.3 工程与排期决策 Q21–Q29（2026-09-05，来自 [work-priority §6.2](work-priority.md)）

| #   | 问题                            | 决策                                                                               | 为什么这样定                                                                                                                                                                                         |
| --- | ------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q21 | 团队规模与开工日期              | **按 4 人配置（1 Rust / 2 前端+服务 / 1 技能与内容），且网关必须是专职一人**       | M1 网关是不可压缩的关键路径，兼职做它会把 12.5 周变成 20 周以上。若只有 1–2 人，范围砍到 P0 + M1 + M2a + M2 + M3（约 30 人周）、P3 全部推后，**而不是每个里程碑都做一半**                            |
| Q22 | 首个对外可演示节点              | **第 12 周内测**，交付面 = M0 + M1 + M2a + M2 + M3 的端到端「一句话生成 pptx」     | 这是关键路径的自然落点，不需要为它挪范围；再早只能演示 demo 级别的东西，反而消耗一次演示机会                                                                                                         |
| Q23 | 桌面壳 Electron 还是 Tauri      | **Electron**                                                                       | Tauri 的核心优势是安装体积，但 R10 已确定要随包 Python 解析运行时（+100–300MB），体积优势被抹平；而本项目要做的侧载子进程管理、自动更新、崩溃回收、三平台公证，Electron 侧方案成熟度明显更高         |
| Q24 | 前端技术栈                      | **React + TypeScript + Vite；01 的 32 个组件全自建（token 驱动），不引 UI 库**     | 截图的视觉语言（暖灰底、深色选中态分段控件、目录式两栏）与任何现成库的默认风格都不一致，改造成本高于自建；而 01 已把 token 与规格写到可直接实现的粒度                                                |
| Q25 | 对外品牌 EvoWork 还是 WorkBuddy | **代码与文档统一落 EvoWork**；WorkBuddy 作为候选对外名保留                         | K5 只禁第三方品牌，不禁我们自己的名字。改名只影响 01 §2 一组 token 与文案、不影响任何布局，但**越晚改，散落在 P4 补丁里的字符串越多**，而补丁面有 K1 硬上限                                          |
| Q26 | 是否 macOS 首发                 | **macOS 首发**；Windows 随 M4 的隔离强度结论再定                                   | R8 明确 Windows 沙箱成熟度低于 macOS/Linux，且 Q6 已决定不自研沙箱。若 M4 评估不足，Windows 侧要禁用 `danger-full-access` 并改以审批为主 —— 这是产品体验差异而非工程量差异，需要产品先看到结论再承诺 |
| Q27 | M2a 是否单列里程碑              | **单列 M2a，2–3 人周，从 M2 的 10 人周里显式拆出**（已回写 §8）                    | 它是 8 张本机表 + 适配层 + 重连语义，一行 UI 都不含。混在 M2 里必然被前端进度挤压，而它被挤压的直接后果是前端绕过适配层直连实验方法 —— 破 K2，且 rebase 就碎                                         |
| Q28 | 资料库的 3 人周增量             | **并入 M8，M8 从 5 改为 8 人周**（已回写 §8）                                      | 资料库与产物索引、分享授权共用同一批本机表和同一套三栏骨架，拆成 M8b 只会多一次上下文切换                                                                                                            |
| Q29 | 是否有自建推理服务              | **按「无」处理**；网关保留私有 endpoint + 自定义鉴权的配置项（成本≈0），不为它排期 | 保留配置项的成本几乎是零，而为一个不存在的 endpoint 做适配与测试不是                                                                                                                                 |

### 10.2 决策落地后要盯的三件事

问题已经答完，但下面三条只有在真做的时候才会暴露，**M0 就要拿到结论**，别等到里程碑末期：

1. **GLM-5.3-flash 的产物质量**（Q16 + R4）：轻量档模型能不能撑住 PPT 排版与表格计算，是"换模型"还是"加模板"的分水岭。
2. **网关不落盘承诺的可审计性**（Q14 + R7）：日志、APM trace、错误上报三条路径要有固化配置与抽查手段，而不是靠约定。
3. **misfire 补偿的真实体验**（Q1=A + Q8 + Q15）：关机一夜后到底补几次、补的是哪次，用户看到的文案是否与实际一致。

---

## 附录 A —— 代码路径索引

> **基线**：路径于 2026-09-05 在 `89a4eec6da` 核对。本附录只给**目录级**路径（目录名比行号稳定得多）；需要行号的断言集中在 [详细设计集 README §4 的 F1–F16](design/README.md)，那里每条都带 `path:line` 且标注了核对日期。动手前仍按 CLAUDE.md §1 重新核对 —— 距 v0.3 基线 `728cb12fe5` 已 53 个提交，距 v0.1 基线 `1c1e17782a` 已 237 个。

| 主题                   | 路径                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------- |
| agent 循环与工具       | `codex-rs/core`、`codex-rs/tools`                                                       |
| 扩展接口               | `codex-rs/ext/extension-api/src/lib.rs`                                                 |
| 子 agent               | `codex-rs/ext/agent/src/lib.rs`                                                         |
| 工作模式模板           | `codex-rs/collaboration-mode-templates/templates/`                                      |
| 审批 / 沙箱策略        | `codex-rs/protocol/src/protocol.rs:984`（`AskForApproval`）、`:1070`（`SandboxPolicy`） |
| 会话存储               | `codex-rs/thread-store`、`codex-rs/rollout`                                             |
| 技能                   | `codex-rs/skills`、`codex-rs/ext/skills`                                                |
| 技能示例               | `codex-rs/skills/src/assets/samples/`                                                   |
| 插件与市场             | `codex-rs/plugin`、`codex-rs/core-plugins`                                              |
| 产物识别               | `codex-rs/core-plugins/src/artifact_operation.rs`                                       |
| 专家角色               | `codex-rs/agent-roles`                                                                  |
| MCP                    | `codex-rs/mcp-server`、`codex-rs/rmcp-client`、`codex-rs/ext/mcp`                       |
| 连接器（ChatGPT 绑定） | `codex-rs/connectors/src/lib.rs:484`                                                    |
| 记忆                   | `codex-rs/memories/{read,write}`、`codex-rs/ext/memories`                               |
| 图片生成               | `codex-rs/ext/image-generation`                                                         |
| 目标与预算             | `codex-rs/ext/goal`                                                                     |
| 安全审查               | `codex-rs/ext/guardian-v2`                                                              |
| 沙箱                   | `codex-rs/sandboxing`、`linux-sandbox`、`windows-sandbox-rs`                            |
| 命令策略 DSL           | `codex-rs/execpolicy`                                                                   |
| Hooks                  | `codex-rs/hooks`（12 类事件见 `src/lib.rs:95-110`）                                     |
| 身份                   | `codex-rs/agent-identity`、`codex-rs/workload-identity`                                 |
| GUI 协议               | `codex-rs/app-server`、`codex-rs/app-server-protocol/src/protocol/v2/`                  |
| SDK                    | `sdk/typescript`、`sdk/python`                                                          |
| 可观测                 | `codex-rs/otel`、`codex-rs/rollout-trace`、`codex-rs/analytics`                         |
| 模型 provider          | `codex-rs/model-provider-info/src/lib.rs`（`:57` chat 已废弃）                          |

## 附录 B —— 术语

| 术语               | 含义                                                   |
| ------------------ | ------------------------------------------------------ |
| Thread             | codex 的会话单元，对应 EvoWork 的「任务」              |
| Turn               | 一轮用户输入到 agent 完成的过程                        |
| Item               | Turn 内的原子事件（消息、推理、命令、文件变更）        |
| Rollout            | Thread 的持久化轨迹文件（JSONL）                       |
| Collaboration Mode | 工作模式（default / plan）                             |
| Contributor        | `extension-api` 的扩展注入点                           |
| Guardian           | codex 的安全审查 subagent                              |
| Skill              | `SKILL.md` 定义的能力包                                |
| Plugin             | 可含 skills / mcpServers / hooks / commands 的分发单元 |
| Marketplace        | 插件来源（npm / git / 本地目录）                       |
| app-server         | codex 面向 GUI 的 JSON-RPC 服务                        |
