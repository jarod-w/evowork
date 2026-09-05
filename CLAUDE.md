# CLAUDE.md — EvoWork

EvoWork 是全场景职场 AI 智能体工作台：用一句话下达需求，自主规划执行，交付可验收的产物。

实现路线一句话：**把 `openai/codex` 当作不可变的执行内核（Execution Kernel），所有 EvoWork 特性通过官方扩展点注入，前端与调度层完全自建。**

单一真源，别在本文件里重复它们的内容：

- [docs/evowork-on-codex-design.md](docs/evowork-on-codex-design.md) —— 架构、决策 D1–D9、上游补丁清单、里程碑 M0–M9、风险 R1–R11、**产品决策记录 Q1–Q29（2026-09-03 与 09-05 已全部决策，无开放项，见第 10 章）**、内核代码路径索引（附录 A）
- [docs/agent-platform-feature-list.md](docs/agent-platform-feature-list.md) —— 功能点清单（需求基线）
- [docs/agent-platform-implementation-summary.md](docs/agent-platform-implementation-summary.md) —— 端云协同架构的观察与推断
- [docs/status.md](docs/status.md) —— **当前开发状态**：做到哪了、什么验过了、什么卡住了。**接手前先读它**
- [docs/build-and-deploy.md](docs/build-and-deploy.md) —— 编译与部署（含上游内核）。**每条命令都实际跑过；没跑通的写明「没验过」**

Cursor 侧的仓级约定正文是 [`.cursorrules`](.cursorrules)，Agent 模式靠
[`.cursor/rules/`](.cursor/rules/) 加载（`00-core.mdc` 用 `@.cursorrules`
把正文拉进上下文，其余按路径挂分册）。与本文件说的是同一套，不要在那边
另写一份「更强」的保证。跨工具入口是 [AGENTS.md](AGENTS.md)，只做指针。

本文件只写「跨会话必须遵守的规则」和「怎么找东西」。

---

## 1. 仓库与工作区

| 位置 | 角色 | 可写性 |
|---|---|---|
| 本仓库 `evowork` | 产品：前端 · 服务层 · 扩展包 · 配置 · 文档 | 可写 |
| `../codex` | 执行内核（`openai/codex` 上游签出，Apache-2.0） | **只读**，见 K1 |

用 [evowork.code-workspace](../evowork.code-workspace) 打开（多根：`evowork` + `codex-kernel`），内核目录在编辑器里被标为只读，构建产物已从搜索/监听中排除。

> **本文件在仓库根**（2026-09-05 从上一层移进来）。放在上一层时它不受版本控制 ——
> 一份承载铁律的文件没有历史、换台机器就没了。
> 不要在上一层再放一份：Claude Code 是从工作目录**向上**找的，两份会同时加载并慢慢分叉——上一层那份副本确实分叉了（说「仓库里还没有代码」，而当时 M0–M9 已经落地），2026-09-05 已删除。
> 上一层现在是空的。代价是：工作目录切到 `../codex` 时向上找不到任何 EvoWork 规则，
> **那种情况下 K1「内核只读」得靠自己记住**——但那么用的话，本来也该从仓库根起手。

**仓库现状**：**M0–M9 的核心实现全部落地**（840 个测试、零跳过，`pnpm run check` 全绿）。
第 3 节的每个目录都已存在且非空 —— 新文件按它落位，不要另起一套。
详细进度、验过什么、卡在什么，一律看 [status.md](docs/status.md)，**不要在本文件里再记一份**。

**内核基线漂移**：总纲 v0.1 的评估基线是 `1c1e17782a`（2026-08-31），详细设计集 v0.1 的实测基线是 `728cb12fe5`（2026-09-03）；`../codex` 当前签出 **`89a4eec6da`（2026-09-04）**，距前者 **237 个提交**、距后者 **53 个提交**。这就是 R2「上游高速演进」的量级。F1–F16 已于 2026-09-05 在当前签出上复核（全部成立，6 处行号已订正），同日实现时新增 **F17 / F18 / F19** 三条（见 [详细设计集 §4](docs/design/README.md)）——
**这三条都不是读文档读出来的，是写代码时被内核的实际行为纠正的**。
**其余带 `path:line` 的断言动手前仍要重新核对**，行号大概率已经变了：

```bash
cd ../codex && git --no-pager log --oneline HEAD..origin/main   # 或用工作区任务 "kernel: 查看上游新增提交"
```

`../codex/AGENTS.md` 是上游写给 agent 的规则，**只在改内核代码时才需要遵守**；在本仓库工作遵守本文件。

---

## 2. 铁律（不可协商）

违反其中任何一条，代价都不是「代码丑」，而是每次上游 rebase 都要重付一遍。

**K1 · 内核不可变。** 不在 `../codex` 里直接改代码。确实无法用扩展点实现时，改动必须落成 `patches/evowork/*.patch`，每个补丁配一份说明「为什么扩展点做不到」。硬上限：**≤ 5 个文件、≤ 500 行**（工作区任务 `evowork: 内核补丁清单自检` 可查）。当前设计判定真正需要打补丁的**只剩 P4（对外可见品牌字符串）一项**，其余全部靠配置绕过 —— 原 P3（`ask.md` 模式模板）已删除：F1 实测 `turn/start.collaborationMode.settings.developer_instructions` 可纯配置实现 Ask 模式，指令文本随 EvoWork 分发在 `config/modes/*.md`，不进内核仓库。

**K2 · 唯一边界是 app-server JSON-RPC v2。** 前端与服务层只说这个协议，不链接 Rust、不调 SDK 内部、不读内核的 sqlite/rollout 文件。协议定义在 `../codex/codex-rs/app-server-protocol/src/protocol/v2/`。初始化时声明 `capabilities.experimentalApi = true` 才能用 `project/*`、`thread/queue/*`、`goal`、timeline 等实验方法；实验方法一律在服务层收一层适配，不让前端直接依赖。

**K3 · 功能注入只走四个官方扩展点。** 优先级从上到下：

1. **技能包**（`SKILL.md` + 脚本）—— 能用它表达就别写 Rust
2. **MCP server** —— 需要外部系统、OAuth、长连接
3. **hooks** —— 策略、审计、配额、审批对接（12 类事件，见 `../codex/codex-rs/hooks/`）
4. **`extension-api` contributor**（Rust）—— 需要内核内部状态或事件流时才用；这是内核自身 guardian / goal / memories / web-search / image-generation 走的正规接口

**K4 · 模型接入走外部 Responses API 网关。** 不改内核模型层，只在 `config.toml` 里配 `model_providers.evowork.base_url` 指向自建网关。**Q2 已决策：必须支持国内模型**，所以网关是全量协议适配层（流式事件重排、工具调用降级、reasoning 占位、cache 口径统一），不是薄转发；每加一家约 1–1.5 人周，语义矩阵见设计文档 D2。`wire_api = "chat"` 已被上游移除，内核只认 Responses API——流式语义、工具调用、reasoning 段、prompt cache 都得由网关补齐。这是全项目**最容易被低估的工作量**（R1）。

**K5 · 许可与品牌。** 保留内核的 `LICENSE`/`NOTICE`，建并维护 `THIRD_PARTY_NOTICES`。产品对外**不得出现 Codex / OpenAI 品牌**。改品牌字符串只改对外可见的那些，内部路径名（如 `CODEX_HOME`）保持不动，减少补丁面。

**K6 · 隐私边界：本地优先。** 「文件处理默认在本地完成、原始数据不上传云端」是**硬约束**（Q3 已决策）。叠加 Q1=A（纯本地桌面应用）后，执行面整体在本机：**不存在"退回云端解析"的兜底路径**，扫描件也不能走云端 OCR。文档解析、数据分析必须本地执行；任何离开本机的动作（分享链接、云记忆、云端多模态）都收敛到**显式授权点**，默认关闭。新增出网路径时，在设计文档里登记。

**K7 · 不复用两块上游能力。** ① codex 的 Apps / 连接器目录——`connectors` 硬编码 `chatgpt.com`，账号与 OAuth 回调都在 OpenAI 侧，自托管不可能；连接器全部自建 MCP server，只借用 `app_tool_policy` 的权限模型思路。② Codex Cloud 云任务。

### 2.1 铁律现在是**机器守着的**，不是靠自觉

写下来的规则会被 deadline 压垮，所以这几条都落成了会失败的检查。改代码撞到它们时，
**先看它拦的是什么，多半它是对的**：

| 铁律 | 谁在守 | 撞上时长什么样 |
|---|---|---|
| K1（补丁预算） | `scripts/patch-budget.mjs`，进 `pnpm run check` | 「超出 K1 上限」 |
| K2（唯一边界） | eslint `@evowork/no-kernel-internals` | 「只有 `services/kernel-adapter` 可以引用 `CODEX_HOME`」—— 它把 launcher 从桌面壳里赶了出来 |
| K5（品牌） | `scripts/gen-third-party-notices.mjs --check` | 依赖树与 NOTICES 不一致 |
| K6（不出网） | `services/ingest/test/pipeline.test.ts` 扫源码里的 `fetch` / `node:http` | 「解析管道里不该出现 fetch(」——**云端兜底是结构上不存在，不是"默认关闭"** |
| Q14（不落盘正文） | `packages/logging` 的类型 + 字段注册表 + 泄露检测 | 没有接受自由字符串的日志入口；未注册的字段被**静默丢掉** |
| 01 §9（token-only） | eslint `@evowork/no-style-literals` + `test/styles.test.ts` 扫 CSS | 「组件里不许出现颜色字面量」—— 它拦下过 mermaid 主题的硬编码兜底色 |

---

## 3. 目录结构（已是现状，不是目标）

```
evowork/
  docs/                  设计与功能文档（唯一真源，改架构先改这里）
  apps/
    desktop/             桌面壳 + 三栏 UI（侧边栏/对话区/结果区）；Q1=A 后它同时是本机服务的宿主
  services/              L3 服务层。Q1=A：下面前五个随桌面 App 在**本机**常驻，后两个在**云端**
    kernel-adapter/      【本机】app-server JSON-RPC v2 适配层（M2a）—— **K2 边界的唯一实现处**
    store/               【本机】本机 sqlite **14 张表** + 两个迁移器 + 状态投影 + automation/artifact 两个 repo（M2a，见 09 §4）
    scheduler/           【本机】定时调度（M5；带时区的 cron · misfire 补偿 · 设备绑定 · 与内核的桥接）
    ingest/              【本机】解析管道：识别 · 六道闸门 · 内置解析器 · 三档运行时（M3，K6，无云端兜底）
    policy/              【本机】安全与策略（M4）：三级路径策略 · profile 文案 · 命令风险 · 并发预算 · 审计链 · **四个 hook 的决策**
    artifacts/           【本机】产物识别（三信号）· 分享授权与上传 · 资料库视图 · fs 监听（M8，D6/Q10）
    gateway/             【云端】Responses API 网关（M1，K4；Q2=必须支持国内模型 → 全量适配）
    identity/            【云端】账号 · 租户 · 配额 · 审计汇总 · 签名策略包下发 —— **尚未开始**
  packages/              跨层共享库（只放"被两层以上使用、复制会造成语义分裂"的东西）
    protocol/            app-server v2 的类型与传输（手写子集 = 依赖面的声明）
    logging/             结构化日志：正文字段在序列化层被过滤（Q14「不落盘」的实现处）
    tokens/              01 §2 的 design token（前端与 charts 技能共用）
  ext/                   L2 Rust 扩展 crate（extension-api contributor）
  plugins/               L2 随产品分发的插件包
    skills/              办公产物技能：documents / spreadsheets / presentations / charts
    agents/              专家角色 *.toml（agent-roles 格式）
    connectors/          MCP server 集合。**本期只做 browser/**（Q9：国内生态集成推 v2）
    hooks/               策略包 `evowork-policy/`：四个事件的 I/O 壳，**决策在 `services/policy`**（放脚本里就测不了）
  config/                config.toml 模板 · requirements.toml · 权限 profile · 模式模板
  patches/evowork/       对内核的补丁 + 每个补丁的理由说明（K1 硬上限；**当前为空**）
  build/                 M9 打包：electron-builder 配置 · entitlements。**是源码不是产物**
  scripts/               漂移雷达（含 F1–F16 断言复核）· 补丁预算 · 许可清单 · **provider 实测探针** · 打包预算
  tools/                 开发期工具（eslint 规则：K2 边界 + token-only 样式）
```

**每个目录下有一份 README**，写清它的里程碑、对应设计文档、该目录特有的纪律。新增目录时一并加。

---

## 4. 新需求落在哪一层（先走这棵树，再写代码）

```
是纯展示 / 渲染 / 交互？
  └→ L4 前端 apps/desktop  （Visualizer 也在这里：mermaid、evowork-chart、沙箱 iframe）

需要跨用户、跨会话、定时、或持久化元数据？
  └→ L3 services/          （调度、产物索引、配额、解析管道）

是「一段能被模型调用的能力」？
  ├→ 能用 SKILL.md + 脚本表达      → plugins/skills/      ← 首选
  ├→ 要连外部系统 / OAuth          → plugins/connectors/  （MCP server）
  └→ 要读写内核内部状态或事件流    → ext/                 （Rust contributor）

是策略 / 审批 / 审计 / 成本控制？
  └→ plugins/hooks/        （session_start · pre_tool_use · permission_request ·
                            post_tool_use · subagent_start/stop · session_end）

以上都不行？
  └→ 先在 docs/ 里写清「为什么扩展点做不到」，再考虑 patches/evowork/（K1）
```

判不出来时，默认往**外**推：能放服务层就不放扩展，能放技能就不写 Rust。

---

## 5. 概念映射（EvoWork ↔ 内核）

| EvoWork | 内核 | 说明 |
|---|---|---|
| 任务 | Thread | 一个 rollout 文件 + sqlite 元数据 |
| 空间 / 工作空间 | Project + cwd | `project/*`（实验方法） |
| 文件夹分组 / 置顶 | ThreadSection | 内置 pinned 分区即置顶 |
| 消息 / 回合 | Turn / Item | `thread/turns/list`、`thread/items/list` |
| 子任务 | Subagent Thread | `parentThreadId` / `ancestorThreadId` |
| 产物 | 工作空间里的文件 | 文件系统是真源，服务层只存索引（D6） |
| Craft / Plan / Ask | CollaborationMode + 权限 profile | Ask = 只读沙箱 + 不审批 + 过滤写工具，**不新增枚举值**（D8） |
| 「规划中」状态 | 无对应 | 服务层按 mode + 是否有 `plan` item 派生 |

---

## 6. 内核高频入口（其余见设计文档附录 A）

| 要找什么 | 去哪 |
|---|---|
| GUI 协议（K2 边界） | `../codex/codex-rs/app-server-protocol/src/protocol/v2/` |
| 扩展点签名（K3） | `../codex/codex-rs/ext/extension-api/src/lib.rs` |
| 已有扩展的写法参考 | `../codex/codex-rs/ext/{goal,memories,guardian-v2,image-generation,web-search}/` |
| 技能格式与示例 | `../codex/codex-rs/skills/`、`skills/src/assets/samples/` |
| 插件 / 市场 manifest | `../codex/codex-rs/plugin/`、`core-plugins/` |
| 产物识别约定 | `../codex/codex-rs/core-plugins/src/artifact_operation.rs` |
| 沙箱 / 审批策略 | `../codex/codex-rs/sandboxing/`、`protocol/src/protocol.rs`、`execpolicy/` |
| hooks 事件 | `../codex/codex-rs/hooks/` |
| **hooks 的输入输出契约**（F19，三条"写错了不报错"） | `hooks/src/schema.rs:278-296`（输入）· `hooks/src/engine/output_parser.rs:450/459/510`（输出）—— 我们这边的镜像在 `services/policy/src/hooks/contract.ts` |
| 官方 SDK（服务层可用） | `../codex/sdk/typescript`、`../codex/sdk/python` |

---

## 7. 常用命令

```bash
# ── 本仓库（改代码前后各跑一次，它是唯一的验收口径）──
pnpm run check                    # 格式 · lint（含 K2 边界规则）· 类型（含测试）· 测试 · K1 补丁预算
pnpm run build                    # 四步装配：tsc → 复制入口与 vendor → esbuild 三个入口 → vite 渲染层
pnpm run test -- --project store  # 只跑一个包
node scripts/kernel-drift.mjs     # 上游漂移 + F1–F16 断言机器复核

# 拿到某家模型的 key 之后跑一次，把能力表里的 verified 变成有依据的值（U2）
EVOWORK_PROBE_KEY=... node scripts/verify-provider.mjs \
  --base https://api.deepseek.com --model deepseek-v4-flash --reasoning true

code evowork.code-workspace                       # 打开多根工作区

cd ../codex                                       # just 会自动切到 codex-rs/
(cd codex-rs && cargo build -p codex-app-server)  # 构建 EvoWork 唯一对话的进程
just app-server-test-client                       # 交互式 JSON-RPC 客户端，摸协议行为
just exec "根据 data/ 下的表格生成一份周报 docx"   # 办公场景端到端冒烟（M0）
just codex                                        # TUI，看内核原生行为
codex execpolicy check -r <policy> -- <cmd>        # 单独校验命令白名单 DSL（-r 可重复）
git --no-pager log --oneline HEAD..origin/main    # 上游漂移（D7）
```

同名任务已配在工作区里（终端 → 运行任务）。

**本机运行时**（08 §4 的"按需下载的办公扩展"，已装）：

| 位置 | 内容 | 谁在用 |
|---|---|---|
| `~/.evowork/runtime/office/` | 独立 venv：python-docx · openpyxl · python-pptx · matplotlib · pdfplumber | 四个技能的 `render.py`（缺模块时**自动换到这个解释器重跑**）· `services/ingest` 的运行时探测 |

装在自己的目录里而不是系统 python：卸载 = 删一个目录，系统 python 升级不会带走它，
而"装没装"这个判断就是"那个解释器能不能 import 那些模块"，没有歧义。
企业离线部署用 `EVOWORK_OFFICE_PYTHON` 覆盖路径。

---

## 8. 已定的产品决策 —— 照着做，别再当成开放问题

设计文档第 10 章的 **Q1–Q29 全部决策完毕，没有开放项了**（Q1–Q16 于 2026-09-03，Q17–Q29 于 2026-09-05）。下面是会直接影响写码方式的几条，完整表格见 [设计文档 §10.1 / §10.1.1 / §10.1.3](docs/evowork-on-codex-design.md)：

| 决策 | 结论 | 写码时意味着什么 |
|---|---|---|
| **Q1 部署形态** | **A 纯本地桌面应用** | 调度器 / 解析 / 产物索引都是**本机常驻进程**，不是云服务；云端只有账号·私有源索引·模型网关·分享托管四件事（D9） |
| **Q2 国内模型** | **必须支持** | 网关按全量适配层设计（K4、D2） |
| **Q3 隐私** | **硬约束** | 见 K6，没有云端兜底 |
| Q6 Windows | 支持，暂用上游 `windows-sandbox-rs` | 不自研沙箱；隔离强度结论在 M4 给出 |
| Q8 定时任务 | SKIP + 不自动重试 + 连败 3 次自动 PAUSE | scheduler 数据模型已定型（设计文档 §6.9） |
| Q9 国内生态集成 | **本期不做** | connectors 只做 browser/；别去写飞书/企微/钉钉/腾讯文档 |
| Q10 产物分享 | 显式授权后上传，默认关闭 + 有效期 | 任何上传动作都要有逐次授权入口 |
| Q11 并发与预算 | 单用户 3 并行（按本机资源下调）+ 单任务硬预算 + 超预算暂停询问 | 用 `ThreadGoal.budget` 与 `subagent_start` hook，别自建 |
| Q13 CLI | 保留，独立品牌「EvoWork CLI」 | CLI 的命令名/帮助文案属于 K5 的对外可见字符串 |
| **Q14 网关托管** | 云端统一托管为主 + 企业私有部署包；**网关不落盘 prompt 与响应体** | 网关的日志、APM trace（span attribute）、错误上报三条路径都不许带正文，只记 token 数/时延/错误码 |
| **Q15 多设备** | automation 绑定创建它的设备，其他设备只读 + 可「迁移到本机」，离线超 7 天提示迁移 | scheduler 要有 `device_id`；迁移时重置 misfire 基准，否则新设备一上线就补一堆历史触发 |
| **Q16 国内模型 P0** | **DeepSeek · Kimi · GLM-5.3-flash** 三家 | 网关先按 DeepSeek 做基准实现；GLM-5.3-flash 是轻量档，M0 就用它验证产物质量的下限 |
| **Q17 个人云盘** | **不做** | 资料库的配额条显示**本机磁盘占用**（产物 + 解析缓存 + 索引），动作是「清理」不是「升级」；别加第五项云端数据面职责 |
| Q18 运营位 | 保留插槽、**默认关闭**、不做积分体系 | 四个插槽（`titlebar-promo`/`activity-popover`/`sidebar-promo`/`showcase`）配置驱动，只有 `showcase` 默认开；**插槽只渲染静态内容，禁任何行为回传埋点** |
| Q19 团队空间 | **只读订阅** | 复用「企业私有源索引」这一条云端职责，不新增；写入方向走 Q10 分享通道。「与我共享」收件箱不做 |
| **Q20 助理** | **一个常驻的特殊 Thread** | 固定 cwd `~/.evowork/assistant/`、默认 Ask、不进任务列表、可 `thread/fork` 升级；别为它自建会话存储 |
| **Q23 桌面壳** | **Electron** | 不用 Tauri（体积优势被随包 Python 运行时抹平，而侧载子进程/自动更新/公证的成熟度 Electron 更高） |
| **Q24 前端栈** | **React + TS + Vite，32 组件全自建（token 驱动），不引 UI 库** | 组件只能来自 01 §5 的清单；**出现第 33 个组件先补进 01** |
| **Q25 品牌** | 代码与文档统一 **EvoWork** | WorkBuddy 只是候选对外名；品牌层 = `--accent` 系列 + appName + logo + mascot 四项 token |
| Q26 首发平台 | **macOS 首发**，Windows 随 M4 结论 | Windows 隔离不足时把 `evowork-full` 标 `allowed:false` **并给原因页**，不静默降级 |
| **Q27 M2a** | **单列里程碑**（服务层与协议适配 2–3 人周） | 前端**不得**直连实验方法，一律经适配层（破 K2 的最常见方式就是把它挤压掉） |
| Q29 自建推理 | **无** | 网关保留私有 endpoint + 自定义鉴权的配置项（成本≈0），不为它排期 |

**本期不做**：多模态视频 / 3D（Q4）、公开技能市场与上架审核（Q5）、国内生态集成（Q9）、设计文档第 15 章「下一代」除「审计留痕」与「单任务预算」外的方向（Q12）、**个人云盘（Q17）**、**团队空间双向协作与「与我共享」（Q19）**、**积分/运营活动体系（Q18）**。

**M0 必须拿到结论的三件事**（决策已定，但只有真做才会暴露）：GLM-5.3-flash 能否撑住 PPT/表格产物质量（R4）· 网关不落盘承诺的可审计手段（R7）· misfire 补偿的真实体验与文案一致性（R9）。

---

## 9. 约定

- **文档中文，commit message 英文**（subject 与 body 都是）。
- **改架构先改文档**：决策（D*）、补丁清单（P*）、新增出网路径、新增内核依赖，都先在 `docs/evowork-on-codex-design.md` 落地再动代码；文档与代码冲突时，文档是错的那一方要被修掉，不要让代码悄悄漂移。
- 引用内核代码用 `path:line` 形式，并**当场核对**（第 1 节：行号会漂）。
- 讨论功能时用第 5 节的映射表说话（「任务」还是「Thread」都行，但别混着造第三个词）。
- 别把内核能力重新实现一遍。动手前先在 `../codex` 里搜一遍——设计文档的判断是清单里 55–60% 的能力内核已有，且深度普遍超过清单描述（沙箱、审批、子 agent、插件市场尤其）。

### 9.1 写代码时的几条（都是踩过才写下来的）

- **断言写后果，不写实现。** `expect(x).toBe(3)` 半年后没人知道为什么是 3。
  写成「超预算只给两个动作，**没有"用便宜模型继续"**（Q11：不自动降级）」，改的人才知道自己在破坏什么。
- **渲染层的可选 prop 写成 `?: T | undefined`**，服务层保持 `exactOptionalPropertyTypes` 的严格语义。
  React 边界上"没这个字段"与"字段是 undefined"没有区别，而每处转发都写条件展开会把 JSON 淹没在噪音里。
  这不是把开关关掉 —— `apps/desktop/src/main`、`packages/`、`services/` 仍然受它约束。
- **降级、跳过、认不出来都要如实说。** 「不静默降级」在这个项目里出现了太多次（D2 的能力缺失、
  03 §8 的模型不可用、08 §4 的运行时缺失、07 §5 的漏跑）—— 它们是同一条纪律的不同落点。
- **测试跳过要能被环境证伪。** `skipIf(装了扩展)` 在装了扩展的机器上会让"没装时怎么办"永远没人验，
  而那条路径恰恰是用户第一次用时走的。正确做法是**强制构造那个环境**（如 `EVOWORK_OFFICE_PYTHON` 指向不存在的路径）。
- **两个模块各自对，合起来可能不对。** 接线时抓到过四个这类缺陷（幂等键与补偿策略互斥、
  产物类型订正被去重挡掉、共用骨架的签名不匹配、日志字段名没注册）。
  **端到端测试不是锦上添花** —— 它是唯一能抓到这类问题的东西。

---

## 10. 开工前检查清单

0. **先读 [status.md](docs/status.md)** —— 做到哪了、什么验过了、什么卡住了。省得重做已有的东西。
1. 这个需求在设计文档里有对应条目吗？状态是 [复用] / [改造] / [自建]？
2. 如果是 [复用]，我是不是在重写内核已有的东西？
3. 它落在第 4 节决策树的哪一层？有没有更「外」的落法？
4. 是否触碰 K1–K7 中的任何一条？触碰了就先改文档。
5. 依赖的内核 `path:line` 还成立吗？（`git log HEAD..origin/main`）
6. 有没有引入未经显式授权的出网路径？（K6）
7. 要用一个 01 §5 清单之外的 UI 组件吗？**先把它补进 01 §5**（现在是 32 个，四个新页面一个都没加）。

---

## 11. 还没被证伪的断言（**别当成已验证**）

完整表格在 [work-priority §10](docs/work-priority.md)。这里只列结论，因为它们最容易被
「代码写完了」这件事盖过去：

| # | 断言 | 需要什么才能证伪 |
|---|---|---|
| U1 | GLM-5.3-flash 能撑住 PPT / 表格产物质量（R4） | 人工评分（08 §5.4 的三个任务）。**协议语义验过了不等于产物质量验过了** |
| U3 | misfire 补偿的真实体验与文案一致（R9） | 真机关机一夜再唤醒。单测能证明落库顺序对，证明不了 OS 的休眠行为 |
| U4 | 三平台签名 / 公证链路可用 | P0-5 的证书 |
| U5 | Windows 隔离强度足以支撑 `evowork-full`（Q6 / Q26） | 一台 Windows 机器。当前 `WINDOWS_ISOLATION = 'unknown'`，**按保守侧走** |

**U2 已于 2026-09-05 关闭**：三家模型全部对真实 endpoint 实测过，并因此改出三个真缺陷。
