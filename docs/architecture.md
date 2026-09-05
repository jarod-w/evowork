# EvoWork 实现架构（as-built）

> **这份文档描述代码现在是怎么组织的**，不描述它应该怎么组织。
>
> 分工边界（照 CLAUDE.md §9「改架构先改文档」）：
>
> | 问题 | 去哪 |
> | --- | --- |
> | 为什么这么设计、决策是什么（D1–D9 / Q1–Q29 / K1–K7 / 里程碑 / 风险） | [总纲](evowork-on-codex-design.md) |
> | 某个模块的页面规格、字段、协议序列 | [详细设计集 01–10](design/README.md) |
> | 做到哪了、什么验过了、什么卡住了 | [status.md](status.md) |
> | 怎么编译、怎么部署 | [build-and-deploy.md](build-and-deploy.md) |
> | **代码里有哪些进程、哪些包、谁调谁、边界在哪、谁在守** | **本文** |
>
> 本文**不重复也不推翻**总纲。两边冲突时以总纲为准，并回来修本文。
> 本文的每条断言都能在仓库里找到对应文件，链接直接给出。
>
> 撰写基线：仓库 `ui_based_codex` 分支，2026-09-05；内核签出 `../codex` @ `728cb12fe5`（见 §10 的偏差说明）。

---

## 1. 一张图：进程与信任边界

L1–L4 分层图见[总纲 §4.1](evowork-on-codex-design.md)。那是**逻辑分层**；下面是**实际跑起来的进程**，
两者不是一一对应的 —— L3 的五个本机服务并没有各自的进程，它们是 Electron 主进程里的模块。

```
用户机器
┌──────────────────────────────────────────────────────────────────────────────┐
│  渲染进程（Chromium）                                                          │
│  React 19 · 三栏 UI · Visualizer(沙箱 iframe)                                 │
│  contextIsolation=true · nodeIntegration=false · sandbox=true                 │
└───────────────────────────────┬──────────────────────────────────────────────┘
                    ① preload contextBridge：4 个订阅 + 6 个动作，**无 ipcRenderer**
┌───────────────────────────────┴──────────────────────────────────────────────┐
│  Electron 主进程 = 本机服务宿主                                                │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ kernel-adapter │ store │ scheduler │ ingest │ artifacts │ policy       │  │
│  │  （同进程内的模块，**不拆进程**：加起来就是一个 sqlite 加几个 watcher）    │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│  sqlite: ~/.evowork/evowork.db（node:sqlite · WAL · FTS5）                    │
└──────┬──────────────────────────┬────────────────────────┬───────────────────┘
       │ ② stdio JSON-RPC v2      │ ④ 受限子进程            │
┌──────┴───────────────────┐   ┌──┴──────────────────┐  ┌──┴──────────────────┐
│ codex-app-server（内核）  │   │ 技能 render.py       │  │ 解析器子进程          │
│ 常驻 1 个 · 只读 · 不改   │   │ python venv（三档）  │  │ office/ocr 档        │
└──────┬───────────────────┘   └─────────────────────┘  └─────────────────────┘
       │ ③ 内核 spawn 短命 hook 进程（stdin/stdout 各一行 JSON）
       │   pre_tool_use · permission_request · post_tool_use · session_end
       │
       │ ⑤ HTTPS（内核唯一的出网调用：{base_url}/responses）
════════╪══════════════════════════════════════════════════════════ 设备边界 ═══
        ▼
┌────────────────────────────┐        ┌──────────────────────────────────────┐
│ Responses API 网关（云/私有）│───────▶│ DeepSeek · Kimi · GLM（Chat 协议）    │
│ Node http，零框架，三个端点  │        └──────────────────────────────────────┘
└────────────────────────────┘
┌────────────────────────────┐   ⑥ 分享上传：**逐次授权后**才发生，默认关闭
│ 分享托管 / identity（未建）  │◀──────
└────────────────────────────┘
```

**六条跨边界通道，全仓库只有这六条**（§4 逐条说明谁实现、谁在守）。除 ⑤ 与 ⑥ 之外，
没有任何东西离开这台机器 —— 这不是"默认关闭"，是**结构上不存在**（K6，见 §9 的守卫表）。

进程划分的判据是**崩溃域**，不是模块边界：
[service-host.ts](../apps/desktop/src/main/service-host.ts) 的头注释写明了五个本机服务不拆进程的理由 ——
拆进程要多付 IPC、崩溃恢复、双向同步三份复杂度，而它们共享同一个 sqlite，收益为零。
真正需要隔离的是内核（会崩、要重启、要退避）与解析/渲染子进程（跑不可信内容），它们各自在进程外。

---

## 2. 模块地图

`pnpm-workspace.yaml` 收 `apps/*` · `services/*` · `packages/*` · `tools/*` 四组，
外加 `plugins/skills/*`（有 vitest 配置但不是 workspace 包）。

| 包 | 位置 | 职责一句话 | 关键文件 |
| --- | --- | --- | --- |
| `@evowork/protocol` | [packages/protocol](../packages/protocol/) | app-server JSON-RPC v2 的**手写子集**：帧、方法清单、类型 | [methods.ts](../packages/protocol/src/methods.ts) = 依赖面的声明 |
| `@evowork/logging` | [packages/logging](../packages/logging/) | 结构化日志；Q14「不落盘正文」的实现处 | [fields.ts](../packages/logging/src/fields.ts) 字段白名单 |
| `@evowork/tokens` | [packages/tokens](../packages/tokens/) | design token + 对比度断言 + CSS 变量生成 | [contrast.ts](../packages/tokens/src/contrast.ts) |
| `@evowork/kernel-adapter` | [services/kernel-adapter](../services/kernel-adapter/) | **K2 边界的唯一实现处**：会话/心跳/重启/恢复/能力降级/事件定序/审批/场景展开 | [adapter.ts](../services/kernel-adapter/src/adapter.ts) |
| `@evowork/store` | [services/store](../services/store/) | 本机 sqlite：两类表 · 两个迁移器 · 状态派生 · 投影 | [schema.ts](../services/store/src/schema.ts) |
| `@evowork/scheduler` | [services/scheduler](../services/scheduler/) | 定时调度：带时区 cron · misfire 补偿 · 失败分类 · 设备绑定 | [cron.ts](../services/scheduler/src/cron.ts) |
| `@evowork/ingest` | [services/ingest](../services/ingest/) | 本机解析管道：识别 · 六道闸门 · 内置解析器 · 三档运行时 | [pipeline.ts](../services/ingest/src/pipeline.ts) |
| `@evowork/policy` | [services/policy](../services/policy/) | 路径三级策略 · 命令风险 · 预算并发 · 审计链 · **四个 hook 的决策** | [paths.ts](../services/policy/src/paths.ts) |
| `@evowork/artifacts` | [services/artifacts](../services/artifacts/) | 产物识别（三信号）· 版本 · 分享授权与上传 · 资料库视图 | [recognize.ts](../services/artifacts/src/recognize.ts) |
| `@evowork/gateway` | [services/gateway](../services/gateway/) | Responses↔Chat 全量翻译 · 三家 provider · 错误映射 · SSE | [pipeline.ts](../services/gateway/src/pipeline.ts) |
| `@evowork/desktop` | [apps/desktop](../apps/desktop/) | Electron 壳 + 本机服务宿主 + 全部 UI | [service-host.ts](../apps/desktop/src/main/service-host.ts) |
| `@evowork/eslint-plugin` | [tools/eslint-plugin-evowork](../tools/eslint-plugin-evowork/) | 把 K2 与 token-only 两条纪律做成会失败的规则 | [no-kernel-internals.js](../tools/eslint-plugin-evowork/src/no-kernel-internals.js) |

**非包资产**：[plugins/skills/](../plugins/skills/) 四个办公技能（SKILL.md + schema + `render.py` + 共用骨架）·
[plugins/hooks/evowork-policy/](../plugins/hooks/evowork-policy/) 策略包的 I/O 壳 ·
[config/](../config/) 内核配置模板与模式片段 · [scripts/](../scripts/) 门禁与雷达 · [build/](../build/) 打包配置。

**尚无实现**：`services/identity`（云端账号，只有 README）· `ext/`（Rust contributor，只有 README）·
`plugins/agents/` · `plugins/connectors/`（均只有 `.gitkeep`）。见 §10。

### 2.1 依赖图（实测自各包 `package.json`）

```
                       ┌─────────────────┐
                       │ @evowork/logging│  ← 谁都依赖它，它谁都不依赖
                       └────────┬────────┘
              ┌─────────────────┼──────────────────┬─────────────┐
              ▼                 ▼                  ▼             ▼
      ┌───────────────┐  ┌────────────┐   ┌────────────┐  ┌──────────┐
      │   protocol    │  │  scheduler │   │   ingest   │  │  policy  │
      └───────┬───────┘  │  artifacts │   └────────────┘  └──────────┘
              ▼          │  gateway   │
        ┌──────────┐     └────────────┘
        │  store   │
        └────┬─────┘
             ▼
     ┌────────────────┐          ┌──────────┐
     │ kernel-adapter │          │  tokens  │（无依赖，被渲染层与 charts 技能共用）
     └───────┬────────┘          └────┬─────┘
             └────────────┬───────────┘
                          ▼
                  ┌───────────────┐
                  │    desktop    │  ← 唯一把所有东西接到一起的地方
                  └───────────────┘
```

三条能从图里直接读出来的事实：

1. **`protocol` 只被 `store` 与 `kernel-adapter` 依赖**，渲染层不依赖它 —— K2 的结构性保证：
   前端连协议的**类型**都拿不到，更谈不上调用。
2. **`scheduler` / `ingest` / `artifacts` / `policy` 互不依赖**，也不依赖适配层。
   它们之间的接线全部集中在 [local-services.ts](../apps/desktop/src/main/local-services.ts) 一个文件里
   （scheduler 需要的适配层能力用**结构类型** `TaskRunner` 表达，见 [kernel-bridge.ts](../services/scheduler/src/kernel-bridge.ts)）。
3. **`gateway` 不依赖除 logging 外的任何内部包** —— 它要能独立部署成一个文件（见 §8）。

---

## 3. 分层与逻辑分层的对应

| 总纲的层 | 代码里是什么 | 备注 |
| --- | --- | --- |
| L4 前端 | [apps/desktop/src/renderer/](../apps/desktop/src/renderer/) | 只认 IPC 频道，不认协议方法名 |
| L3 本机服务 | `services/{kernel-adapter,store,scheduler,ingest,policy,artifacts}` | 同进程模块，宿主是 Electron 主进程 |
| L3′ 云端 | `services/gateway`（已建）· `services/identity`（未建） | 网关是独立进程/独立部署单元 |
| L2 扩展包 | `plugins/{skills,hooks}`（已建）· `plugins/{agents,connectors}` · `ext/`（未建） | K3 的四个扩展点用了两个 |
| L1 内核 | `../codex`，**只读** | 补丁预算 5 文件 / 500 行，当前用了 0 |

---

## 4. 六条跨边界通道

每条通道都有**唯一的实现处**。这一节的价值不在于"通道有哪些"，而在于**破它的最短路径**是什么、谁拦着。

### ① 渲染进程 ↔ 主进程：preload contextBridge

- 实现：[preload/index.ts](../apps/desktop/src/preload/index.ts) ↔ [service-host.ts](../apps/desktop/src/main/service-host.ts) 的 `IPC`
- 渲染进程能做的**全部事情**：订阅 `uiEvent` / `notice` / `degrade` / `pendingApprovals` 四个频道，
  调用 `send` / `interrupt` / `decideApproval` / `rowAction` / `refreshVisible` / `listScenarios` 六个动作。
- `ipcRenderer` 本身**绝不暴露** —— 暴露它等于把整个 IPC 面交出去，之后每次"临时加个频道"都会绕过这里。
- 窗口参数（`contextIsolation` / `nodeIntegration` / `sandbox` / `webviewTag`）由
  [bootstrap.ts](../apps/desktop/src/main/bootstrap.ts) 以**注入**方式接收 Electron API，
  因此"我们到底用什么参数开的窗口"是一条**可断言的事实**，而不是一段没人读的代码。

### ② 主进程 ↔ 内核：app-server JSON-RPC v2（K2）

- 实现：[kernel-adapter](../services/kernel-adapter/)，**唯一说协议的地方**。
- 传输：stdio + NDJSON，[jsonrpc.ts](../packages/protocol/src/jsonrpc.ts) 只管帧与双向分发，不认识任何 EvoWork 概念。
- 会话治理在 [session.ts](../services/kernel-adapter/src/session.ts)：握手 → 心跳 → 崩溃退避重启（1s/2s/4s…上限 30s）
  → 重启后对所有打开的 thread 做 `thread/resume` + `thread/items/list` 补齐 → **顶部提示一次「执行内核已重启」**（不静默重启）。
- 实验方法（`project/*`、`thread/queue/*`、timeline 等）必须在 `initialize` 声明 `capabilities.experimentalApi = true`，
  且**每一个都要在降级表里有兜底路径**，由 `assertDegradationCoverage()` 在 `createAdapter()` 启动时钉住。

### ③ 内核 → 策略 hook：短命进程，stdin/stdout 各一行 JSON

- 壳在 [plugins/hooks/evowork-policy/bin/](../plugins/hooks/evowork-policy/bin/)，**决策在 [services/policy](../services/policy/)** ——
  放脚本里就测不了。
- 输入输出契约镜像在 [hooks/contract.ts](../services/policy/src/hooks/contract.ts)，三条"写错了不报错"的硬约束（F19）：
  `deny` 必须带非空 reason · 没有 `ask` · `updatedInput` 只配 `allow`。违反时内核**丢掉整条输出**，策略静默失效。
- 打包时策略包的编译产物被 vendor 进 hook 目录（§8 第 ② 步），漏了这步同样是**静默失效**。

### ④ 主进程 → 技能 / 解析子进程

- 技能：`SKILL.md` 声明能力，`container_tools/render.py` 出产物，`mark_artifact.mjs` 上报。
- 运行时按 [runtime.ts](../services/ingest/src/runtime.ts) 分三档 `base` / `office` / `ocr`，
  独立 venv 装在 `~/.evowork/runtime/office/`，可用 `EVOWORK_OFFICE_PYTHON` 覆盖。
- TS 侧与 Python 侧（`plugins/skills/_shared/evowork_skill.py`）的档位文案是**同一份数据**，由测试逐字段比对。
- 解析器子进程**必须关网络**（沙箱在 M4 强制，`ingest` 这一侧是接口约束）。

### ⑤ 内核 → 模型网关：HTTPS（唯一的模型出网路径）

- 内核只认 Responses API（`wire_api = "chat"` 已被上游移除），所以网关是**全量协议适配层**而不是薄转发：
  [to-chat.ts](../services/gateway/src/translate/to-chat.ts) · [from-chat.ts](../services/gateway/src/translate/from-chat.ts) ·
  [usage.ts](../services/gateway/src/translate/usage.ts)。
- 三个端点，零框架依赖（理由是企业私有部署包要过客户合规）：
  `POST /v1/responses` · `GET /v1/evowork/models` · `GET /healthz|/readyz`。
- **鉴权默认拒绝所有请求** —— 一个默认放行的网关一旦被误部署到公网，代价是别人用我们的额度。
- 错误码映射不是锦上添花：内核对**映射不上的错误一律当可重试**，于是"模型不存在"会被重试到上限。
  映射表与内核的分流逻辑对照见 [providers/registry.ts](../services/gateway/src/providers/registry.ts) 头注释。

### ⑥ 产物分享上传：本机内容离开设备的唯一常规通道

- [share.ts](../services/artifacts/src/share.ts) + [upload.ts](../services/artifacts/src/upload.ts)。
- 流程**刻意做得重**：每次过授权模态 · 不记住选择 · 不做批量 · 一次一个 `artifactId` · 可撤销 · 到期自动删（默认 24h）。
- **授权在前、读文件在后**：顺序反了的话，"用户取消了授权"与"文件已被读进内存"会同时成立。
- 日志里没有文件名 —— 文件名本身可能就是敏感信息。

---

## 5. 六条关键数据流

### 5.1 首次发送一条需求

```
渲染层 Composer ──send({text})──▶ 主进程
   （首页不创建 Thread —— 发第一条消息时才建，建好回 id，前端据此切页）
        │
        ├─ scenario.ts: 场景 + 模式 + Composer 覆盖 → turn/start 参数
        │    Ask/Plan/Craft 用 collaborationMode.settings.developer_instructions 表达，
        │    指令文本来自 ~/.evowork/modes/*.md（**不新增内核枚举值**，D8/F1）
        ▼
   kernel-adapter ──thread/start{cwd}──▶ 内核 ──turn/start{input}──▶ 模型
        ◀──────────────── 通知流 ────────────────
```

### 5.2 事件流的三个消费者（顺序是结构性保证，不是约定）

[events.ts](../services/kernel-adapter/src/events.ts)：**先落库 → 再更新 UI → 最后触发副作用**。

每个 handler 只**返回**一个待执行副作用列表，由路由器在落库与 UI 更新之后统一执行 ——
handler 里根本没有直接触发副作用的入口。理由：UI 崩溃/刷新后能从投影表恢复，反之不行。

| 消费者 | 落点 |
| --- | --- |
| 投影表 | `thread_projection` · `item_digest`（状态、用量、摘要） |
| UI | 一个**语义化**事件（`task-status` / `item-delta` / …，不含协议方法名） |
| 副作用 | 通知 · 并发计数 · 预算闸门 · 产物识别 · `automation_run` 落库 |

### 5.3 定时任务

```
scheduler 到点（cron + 命名时区 + DST 两个边界）
   │ 幂等键 = automation_id + fire_time（本机 sqlite 唯一索引，不需要分布式锁）
   │ 关机错过 → misfire 三策略（Q8：SKIP + 不自动重试）
   ▼
kernel-bridge.startRun ──▶ adapter.createTask ──▶ 内核
   │  与交互式任务的三处不同：**必填硬预算** · 审批 10 分钟自动取消 · 失败要分类
   ▼
turn/completed ──▶ classifyFailure ──▶ 只有"任务自身的问题"计入连败
                                        └─ 连败 3 次 → 自动 PAUSE
```

设备绑定：automation 绑定创建它的设备（`device_id`），其他设备只读 + 可迁移；
**迁移时重置 misfire 基准**，否则新设备一上线就补一堆历史触发。

### 5.4 文件上传与解析（全程不出网）

```
拖入 → ① magic-byte 识别 + 编码嗅探
     → ② 六道闸门（大小 · 数量 · 压缩炸弹 · 路径穿越 · …；archive 先列后解，穿越拒整包）
     → ③ 落盘 <工作空间>/uploads/<时间戳-slug>/original.<ext>
     → ④ 解析器（内置纯计算 / office / ocr 三档）→ content.md · assets/ · meta.json
     → ⑤ 注入 turn/start：**路径 + 摘要 + 关键页，不塞全文**
     → ⑥ 索引进资料库全文（FTS5 trigram）
```

`office` / `ocr` 档缺失时只有两个出路："装扩展"或"以原始文件引用"。
**不存在"传到云上解析"这条分支** —— [pipeline.test.ts](../services/ingest/test/pipeline.test.ts) 扫源码里的
`fetch(` / `node:http` / `node:https` 来钉住这件事。

### 5.5 产物识别与索引

```
① 技能 mark_artifact 上报（意图/期望数量/格式/显示名，元数据最全）
② FileChange item（agent 用 shell/python 直接写的文件）      ── 任一命中即入索引，按绝对路径去重
③ post_tool_use hook（脚本内部批量生成，绕过前两者）
        │  优先级 ① > ② > ③（png 到底是 chart 还是 image，只有信号源知道）
        ▼
   artifact 表：指向文件的**元数据**，不含内容（D6：文件系统是真源）
        └─ 于是「删索引 ≠ 删文件」是自然结果，不需要额外约定
```

### 5.6 一次模型调用

```
内核 ──POST {base_url}/responses（Responses 协议）──▶ 网关
   ├─ 能力查表：模型不支持的能力**显式降级并告知**，不静默
   ├─ to-chat：instructions / 工具结果 / 图片（不支持则拒绝，不假装）
   ├─ provider.send → 上游（DeepSeek / Kimi / GLM）
   ├─ from-chat：Chat 流 → Responses 事件（编号 · 工具参数重组 · reasoning 段）
   ├─ usage：cache 无数据时如实报 0 / 宁可省略，不编
   └─ 错误 → 内核认识的 error.code（映射不上 = 被当成可重试）
   ▼
SSE 回内核。**全程不落盘 prompt 与响应体**（Q14）
```

---

## 6. 本机数据模型

驱动是 Node 内置 `node:sqlite`（`DatabaseSync`），自带 WAL 与 FTS5 —— 没有原生模块，
因此 Electron 打包不需要按 ABI 重编译。库在 `~/.evowork/evowork.db`。

**13 张业务表分两类**（[schema.ts](../services/store/src/schema.ts)），外加迁移器自建的 `meta` 表：

| 类别 | 真源在哪 | 迁移失败时 | 表 |
| --- | --- | --- | --- |
| **投影类**（6） | 内核 / 文件系统 | **丢弃重建**，附一条警告，继续启动 | `thread_projection` `item_digest` `library_node` `library_index`(FTS5) `access_log` `unknown_event` |
| **权威类**（7） | 只在这里 | 备份 → 失败则回滚并**抛错，宁可启动失败** | `automation` `automation_run` `share` `audit_log` `subscription` `notification` `artifact` |

两类各有**独立的版本号与独立的迁移器**（[migrate.ts](../services/store/src/migrate.ts)），
两条路径没有任何共享的可写状态 —— 不这么做的话，"重建索引"的逻辑总有一天会把 `automation` 表也清了。

`artifact` 归权威类是一个需要说明的判断：产物**本体**的真源是文件系统（D6），
但索引里的 `title`（可重命名而不改文件名）、`version` 链、`share_id`、`source_signal`
在磁盘上没有对应物 —— 丢了就再也推不出来。

### 6.1 投影表为什么必须存在

不是缓存优化，是**协议缺口**：

- `thread/list` 没有状态与日期过滤（F8）；
- `ThreadExtra` 是空结构体，没有客户端元数据槽（F9）；
- `ThreadStatus` 只有 `notLoaded | idle | systemError | active` —— **已完成/失败/已中断都不在里面**，
  它们只出现在 `turn/completed` 的 `TurnStatus` 里，而未加载的 thread 恒为 `notLoaded`（F7）。

所以"这个任务现在是什么状态"必须由**实时状态 + 投影记录**共同回答
（[derive-status.ts](../services/store/src/derive-status.ts)）。只看一半都会得出错误答案：
只看 `ThreadStatus`，所有历史任务都是 `notLoaded`；只看投影表，正在跑的任务看不出来。

派生状态 8 个：`running` `pending` `planning` `completed` `failed` `interrupted` `archived` `idle`。
判定顺序即优先级，其中两处刻意：**归档最先**（用户动作优先于系统状态）、**「待处理」优先于「进行中」**。

### 6.2 权威字段的两条校正路径

`thread/list` 没有"按 id 过滤"的参数，所以文档里"先查 id、再批量拉权威元数据"这一步做不到。实际做法是两条并行：

1. 列表先用投影表**立刻**渲染，再对**当前可见页**（≤30 条）逐个 `thread/read` 校正 —— 有界，只在筛选生效时发生；
2. 定期对账：启动时 + **每 10 分钟**一次 `thread/list?useStateDbOnly` 刷新 title/cwd。

"哪些行现在可见"只有渲染层知道，所以由侧边栏往外报（`onVisibleChange` → `refreshVisible`）。

---

## 7. 跨切面机制

### 7.1 日志：Q14 的实现处

[packages/logging](../packages/logging/) 三层防线：

1. **接口形状** —— 没有接受自由字符串的日志入口；
2. **字段注册表**（白名单，不是黑名单）—— 只有注册过的字段名 + 符合形状的值能进，未注册的字段**静默丢掉**；
3. **泄露检测** —— 对输出做 8 字滑窗断言，用于测试与"不落盘"承诺的可审计手段。

字段类型里**没有"短自由文本"档**：`label` / `title` 这类字段名毫无问题，但值是自然语言。
想记路径就记 `pathKind + pathDigest + extension`，想记错误就记 `errorClass + errorCode + messageDigest`。

### 7.2 能力降级：一律显式

[capabilities.ts](../services/kernel-adapter/src/capabilities.ts)。实验方法的可用性用**探测 + 失败即降级**判定
（`experimentalFeature/list` 返回的是内核运行时功能开关，与"某个实验协议方法在不在"无关 —— F18）。
每条降级都带一句**给用户看的话**，UI 必须显示，不许假装正常；部分降级还带 `mustAlsoDo`
（例：`collaborationMode` 不可用时必须靠 `ToolContributor` 过滤写工具，否则 Ask 模式名存实亡）。

"不静默降级"在这个项目里出现了太多次（模型能力缺失、运行时缺失、漏跑、隔离强度未知），它们是**同一条纪律的不同落点**。

### 7.3 审批

内核的审批是**服务端请求**（不是通知），发出后会一直等回复（F14）。两套超时策略：
交互式**不自动拒绝**（一直等，用户就在旁边）；无人值守 **10 分钟自动取消**（"一直等"等于任务永远卡住）。
`askApproval` 未提供时默认 **decline** —— 没人能确认时选择不做。

### 7.4 安全策略

路径三级（[paths.ts](../services/policy/src/paths.ts)）：**硬拦截**（系统目录 · 密钥凭据 · EvoWork 自身配置）
→ **需逐次审批**（桌面/下载/文档/图片，以及工作空间之外的任何路径）→ **工作空间内**（按 profile 放行）。

两条判定顺序上的硬约束：**硬拦截先于工作空间判定，且不看 `permission_mode`**（否则把工作空间设在 `~/.ssh` 就能绕过），
**`..` 必须在匹配前解析**。硬拦截对 `evowork-full` 同样生效 —— 用户点"完全访问"是为了装依赖，不是为了让 agent 读走 SSH 私钥。
这条同时是提示注入的最后一道防线：注入能骗过模型、能骗过用户点"允许"，骗不过一个不看谁在请求的路径判定。

平台能力默认值走保守侧：Windows 隔离强度当前是 `unknown`，因此 `evowork-full` 标 `allowed:false` **并给原因页**，不静默降级。

### 7.5 前端

- 路由只有两个页面（首页 / 任务页），"在哪个页面"就是 `activeTaskId` 是不是 null，不需要 router。
- 样式**零字面量**：颜色与 px 只能来自 [packages/tokens](../packages/tokens/)，由 eslint 规则在渲染层文件上强制。
- Visualizer 是不可信内容的落点：沙箱 iframe **给 `allow-scripts`、绝不给 `allow-same-origin`**（两者同给等于没有沙箱）·
  SVG 白名单清洗且**点名删 `foreignObject`** · chart spec 拒绝未知字段与函数字符串。

---

## 8. 构建与分发拓扑

`pnpm run build` = [scripts/build.mjs](../scripts/build.mjs) 四步，顺序刻意：

| 步 | 做什么 | 漏了会怎样 |
| --- | --- | --- |
| ① `tsc --build tsconfig.build.json` | 产出所有包的 JS 与声明（solution 风格，新包要在 references 里登记） | 新包不被类型检查覆盖 |
| ② 复制 `electron-entry.mjs` + **vendor 策略包** | 入口是 `.mjs`（唯一 import electron 的文件，被 tsc 跳过）；策略包要进 hook 目录 | 打包产物**没有入口**；策略在打包后的应用里**静默失效** |
| ③ esbuild 打三个单文件入口 | `gateway/main` · `desktop/main/bootstrap` · `desktop/preload`（只 external electron） | workspace 包的 exports 指向 TS 源码，直接 `node dist/…` 会炸 |
| ④ vite 打渲染层 | mermaid 走[动态 import](../apps/desktop/src/renderer/components/mermaid-renderer.ts)，天然独立 chunk | 主 chunk 被一个可视化库撑大 |

分发（M9，配置在 [build/](../build/)）：electron-builder 三平台 + 差量更新 + macOS entitlements；
[package-plan.mjs](../scripts/package-plan.mjs) 守两件事 —— **体积预算与档位边界**（防止 office/ocr 档混进基础包），
以及**缺任一签名 secret 就整体降级为未签名并把标注写进文件名**（半签名的产物看起来像正式包）。

`~/.evowork/` 布局（[resolvePaths](../apps/desktop/src/main/service-host.ts)）：

```
~/.evowork/
  evowork.db        本机 sqlite
  config.toml       内核配置（**只有内核认识的键**）
  requirements.toml
  modes/            Craft/Plan/Ask 的指令片段（取代原 P3 补丁）
  scenarios/        场景包
  logs/
  kernel/           = CODEX_HOME。宿主只知道"内核的家在这儿"，
                    **不知道那个环境变量叫什么** —— 那是适配层的知识
  runtime/office/   办公扩展的独立 venv（卸载 = 删一个目录）
```

启动顺序也是刻意的：**先开库、再起内核**。权威表迁移失败要中止启动，此时不该已经有一个内核进程在那儿等着。

---

## 9. 架构不变量与守卫

这一节是本文档最该被读的部分。**每条不变量都有一个会失败的检查**；
改代码撞到它们时，先看它拦的是什么 —— 多半它是对的。

| 不变量 | 谁在守 | 撞上时长什么样 |
| --- | --- | --- |
| K1 内核补丁 ≤5 文件 / ≤500 行 | [patch-budget.mjs](../scripts/patch-budget.mjs)（进 `pnpm run check`） | 「超出 K1 上限」 |
| K2 只有 kernel-adapter 说协议 | eslint [`@evowork/no-kernel-internals`](../tools/eslint-plugin-evowork/src/no-kernel-internals.js) | 「只有 `services/kernel-adapter` 可以引用 `CODEX_HOME`」；判定的是**字符串字面量与成员访问**而非模块图，因为破 K2 的典型写法不 import 任何东西 |
| K5 依赖清单与 NOTICES 一致 | [gen-third-party-notices.mjs --check](../scripts/gen-third-party-notices.mjs) | 依赖树与 `THIRD_PARTY_NOTICES.md` 不一致 |
| K6 解析管道不出网 | [ingest/test/pipeline.test.ts](../services/ingest/test/pipeline.test.ts) 扫源码 | 「解析管道里不该出现 fetch(」 |
| Q14 不落盘正文 | [packages/logging](../packages/logging/) 类型 + 字段注册表 + 泄露检测 | 未注册字段被静默丢掉；形状不对的值进不去 |
| 样式 token-only | eslint `@evowork/no-style-literals` + `desktop/test/styles.test.ts` | 「组件里不许出现颜色字面量」 |
| 每个实验方法都有降级路径 | `assertDegradationCoverage()`，在 `createAdapter()` 里 | 启动即抛 —— 缺一条降级等于给未来留一次白屏 |
| 落库 → UI → 副作用的顺序 | [events.ts](../services/kernel-adapter/src/events.ts) 的结构：handler 只能**返回**副作用 | 想在 handler 里直接触发副作用，会发现没有那个入口 |
| 投影表可丢、权威表不可丢 | 两个迁移器、两套版本号、无共享可写状态 | 权威迁移失败 → 回滚 + 启动失败（这是设计要求） |
| hook 输出契约（F19） | [hooks/contract.ts](../services/policy/src/hooks/contract.ts) 的类型 | 写错了内核**丢掉整条输出**，策略静默失效 —— 所以必须在类型层拦 |
| 审计记录装不下正文 | [audit.ts](../services/policy/src/audit.ts) 的类型里没有那种字段 | 想记正文得先改类型，而改类型会被 review 看见 |
| 运行时文案 TS/Python 两侧一致 | [ingest/test/runtime.test.ts](../services/ingest/test/runtime.test.ts) 逐字段比对 | 用户以为解析和生成要装两个不同的东西 |
| 内核事实 F1–F16 仍成立 | [kernel-drift.mjs](../scripts/kernel-drift.mjs) + [kernel-assertions.json](../scripts/kernel-assertions.json)，每日 CI | `LINE-MOVED`（行号漂，不算失败）/ `BROKEN`（断言被上游推翻） |

一条贯穿全仓库的写法纪律：**断言写后果，不写实现**。`expect(x).toBe(3)` 半年后没人知道为什么是 3；
写成「超预算只给两个动作，没有"用便宜模型继续"」，改的人才知道自己在破坏什么。

---

## 10. 已知偏差（写作时实测）

架构文档最容易腐化的部分是"现状描述"，所以这一节写死在文档里而不是口头传递。

| # | 偏差 | 实测 |
| --- | --- | --- |
| 1 | **内核签出与文档记录的基线不一致** | `../codex` HEAD = `728cb12fe5`（2026-09-03），与 origin/main 同步；而 [kernel-assertions.json](../scripts/kernel-assertions.json) 与 CLAUDE.md §1 记的基线是 `89a4eec6da`（2026-09-04）—— 这个提交在本地克隆里**不存在**。`node scripts/kernel-drift.mjs --no-fetch` 在实际签出上跑出 **OK 16 · LINE-MOVED 0 · BROKEN 0**，所以断言本身没问题，但"当前签出是 89a4eec6da"这句话在这台机器上不成立 |
| 2 | K3 的四个扩展点用了两个 | 技能包 ✅ · hooks ✅ · MCP server ❌（`plugins/connectors/` 只有 `.gitkeep`，Q9 本期不做）· Rust contributor ❌（`ext/` 只有 README） |
| 3 | 云端只建了网关 | `services/identity`（账号 · 租户 · 配额 · 签名策略包下发）只有 README。因此 §4 通道 ⑥ 的**云端一侧尚不存在**，`upload.ts` 面向一个还没有实现的端点 |
| 4 | 专家角色包为空 | `plugins/agents/` 只有 `.gitkeep`，总纲提到的"100+ 角色"一个都没有 |
| 5 | "14 张表"的说法 | `TABLES` 里是 **13** 张（6 投影 + 7 权威），第 14 张是迁移器自建的 `meta` |

另有若干"还没被证伪的断言"（GLM 产物质量 · misfire 真机体验 · 签名公证链路 · Windows 隔离强度），
它们是**结论层面**的空白而不是架构层面的，见 [work-priority §10](work-priority.md) 与 [status.md §3](status.md)。

---

## 11. 改这份文档的规则

1. **本文跟着代码走，不跟着计划走。** 一个模块的实现改了，本文同一次改；一个模块只是被规划了，不进本文。
2. **决策不写在这里。** 出现"为什么选 A 不选 B"时，正确做法是写进[总纲](evowork-on-codex-design.md)并在这里引用它。
3. **§9 的表只收有守卫的不变量。** 没有机器守卫的约定属于 CLAUDE.md 或模块 README ——
   混进来会让这张表从"会失败的检查清单"退化成"愿望清单"，而那正是它想避免的东西。
4. **§10 只增不藏。** 偏差被修掉时删掉那一行并在 commit message 里说明；发现新偏差就加一行。
5. 引用内核代码用 `path:line` 并**当场核对**（行号会漂）。
