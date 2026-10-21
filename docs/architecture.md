# EvoWork 实现架构（as-built）

> **2026-10-18 独立会话通信交互更新**：随包 stdio MCP `plugins/connectors/thread-communication/server.mjs` 以短期 bearer 连接宿主 `thread-communication-host.ts` 的随机回环 HTTP 端口，按原生 MCP 调用核对来源并逐次确认共享范围。`kernel-adapter/thread-communication.ts` 协调权威本机 `thread_message` 队列，以官方协议恢复目标并开始正常回合，沿用目标模型与权限；最终回复返回来源且不自动循环。用户在正常对话中用自然语言发起，任务页不再挂载独立通信表单或记录列表；既有 IPC 动作、状态事件与底层队列保留。此通道补充下文早期七通道基线，未改变 K2 的唯一内核边界。详见 [17](design/17-thread-communication.md)。

> **2026-10-20 按当前代码订正**：§1–§10 中已被后续实现推翻的现状描述（IPC 频道与动作数、本机表数与迁移版本、包与依赖、解析器、分享通道、新增出网通道、侧栏入口、补丁预算、§10 偏差表）已改成当前代码的样子；§5.1 / §5.8 已按下一段的 Composer 修订改写。各功能的验收边界仍以 [status.md](status.md) 为准。

> **2026-10-01 Composer 修订基线：** 本文有关强制选项目、最近项目自动预选、无项目附件阻断、任务中途改 cwd、按 cwd 推断所有任务归属的旧条款由[修订设计](superpowers/specs/2026-09-27-composer-pick-folder-design.md)取代（§5.1 / §5.8 已按此改写）。全局首页默认无项目；无项目任务使用宿主登记的独立持久 cwd；附件先在草稿内本地暂存，发送前归入最终环境；创建后固定 cwd，换项目新建任务；显式归属优先，旧/外部任务才按最长路径边界匹配。无项目自动化可执行，真实环境错误立即暂停。`InlineSelect.actions` 承载选择文件夹动作。宿主在权威 `meta` 中保存草稿/任务环境、projectId 和首次发送状态，不读取内核内部存储。

> **这份文档描述代码现在是怎么组织的**，不描述它应该怎么组织。
>
> 分工边界（照 CLAUDE.md §9「改架构先改文档」）：
>
> | 问题 | 去哪 |
> | --- | --- |
> | 为什么这么设计、决策是什么（D1–D11 / Q1–Q46 / K1–K7 / 里程碑 / 风险） | [总纲](evowork-on-codex-design.md) |
> | 某个模块的页面规格、字段、协议序列 | [详细设计集 01–21](design/README.md)（无 18） |
> | 做到哪了、什么验过了、什么卡住了 | [status.md](status.md) |
> | 怎么编译、怎么部署 | [build-and-deploy.md](build-and-deploy.md) |
> | **代码里有哪些进程、哪些包、谁调谁、边界在哪、谁在守** | **本文** |
>
> 本文**不重复也不推翻**总纲。两边冲突时以总纲为准，并回来修本文。
> 本文的每条断言都能在仓库里找到对应文件，链接直接给出。
>
> 撰写基线：仓库 `ui_based_codex` 分支 @ `342abe0`（2026-09-08）；内核签出 `../codex` @ **`7769bccbb2`（2026-09-07）**，
> 断言基线当时是 `89a4eec6da`（见 §10 偏差 1）。**上一版基线是 2026-09-05**，此后落地的 M10a（模型管理）、
> 「项目」页、办公扩展安装器、审计链路、网关子进程、产品身份底稿都已经进本文。
> 2026-10-20 订正时对照的是仓库 @ `ee9faa8e`；机器上没有 `../codex`，涉及内核 `path:line` 的断言未重新核对。

---

## 1. 一张图：进程与信任边界

L1–L4 分层图见[总纲 §4.1](evowork-on-codex-design.md)。那是**逻辑分层**；下面是**实际跑起来的进程**，
两者不是一一对应的 —— L3 的本机服务并没有各自的进程，它们是 Electron 主进程里的模块。

```
用户机器
┌──────────────────────────────────────────────────────────────────────────────┐
│  渲染进程（Chromium）                                                          │
│  React 19 · 应用外壳 + 侧边栏 + 8 个主视图 · Visualizer(沙箱 iframe)             │
│  contextIsolation=true · nodeIntegration=false · sandbox=true                 │
└───────────────────────────────┬──────────────────────────────────────────────┘
                    ① preload contextBridge：7 个订阅 + 159 个动作 + 1 条审批请求，**无 ipcRenderer**
┌───────────────────────────────┴──────────────────────────────────────────────┐
│  Electron 主进程 = 本机服务宿主                                                │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ kernel-adapter │ store │ scheduler │ ingest │ artifacts │ policy       │  │
│  │ projects │ runtime-installer │ model-access（密钥库 · 拓扑 · 四层模型表）  │  │
│  │ catalog │ hub-client │ image-generation │ computer-use │ 会话通信 · 更新  │  │
│  │  （同进程内的模块，**不拆进程**：加起来就是一个 sqlite 加几个 watcher）    │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│  sqlite: ~/.evowork/evowork.db（node:sqlite · WAL · FTS5）                    │
│  密钥: ~/.evowork/secrets.bin（safeStorage 密文，**不读回渲染层**）              │
└──────┬──────────────┬─────────────────┬───────────────────┬──────────────────┘
       │ ② stdio      │ ⑤ 子进程         │ ④ 受限子进程        │ ⑦ HTTPS（装扩展）
       │ JSON-RPC v2  │ + 进程环境注入    │                    │
┌──────┴──────────┐ ┌─┴────────────────┐ ┌┴──────────────┐ ┌──┴─────────────────┐
│ codex-app-server│ │ 本机网关（D11 常驻）│ │ 技能 render.py │ │ python-build-      │
│ 内核 · 常驻 1 个 │ │ hosted/private 转发 │ │ 解析器子进程   │ │ standalone + wheels│
│ 只读 · 不改      │ │ 密钥只在它的环境里 │ │ office/ocr 档  │ │ （K6 登记的出网）   │
└──────┬──────────┘ └─┬────────────────┘ └───────────────┘ └────────────────────┘
       │ ③ 内核 spawn 短命 hook 进程（stdin/stdout 各一行 JSON）→ 追加 ~/.evowork/audit.jsonl
       │   pre_tool_use · permission_request · post_tool_use · session_end     └─ 宿主搬进 audit_log 表
       │
       │ 内核唯一的模型出网：{base_url}/responses，**base_url 恒为本机 loopback**（D11）
       └────────────────────────────────▶ ② 本机网关 ── hosted 模型再转到 identity /v1/responses ─┐
════════════════════════════════════════════════════════════════════ 设备边界 ══╪═══
                                                                                ▼
                                    ┌──────────────────────────────────────────────┐
                                    │ DeepSeek · Kimi · GLM · 用户自定义 endpoint      │
                                    │ （Chat 协议；网关做 Responses↔Chat 全量翻译）     │
                                    └──────────────────────────────────────────────┘
┌────────────────────────────┐   ⑥ 分享上传：**逐次授权后**才发生，默认关闭
│ identity + apps/web（账号/管理）│◀──────  分享托管在 services/share（与 identity 分进程分库）
│ JWT · 租户默认模型 · 计量      │
└────────────────────────────┘
```

**图里是 2026-09 的七条基线通道**（§4 逐条说明谁实现、谁在守）。⑦ 是 2026-09-07 新增的：办公扩展的下载器单独放进 `services/runtime-installer`，
**正是为了让 `services/ingest` 的"不出网"扫描能收紧成整个 `src/` 目录**而不必留口子。

2026-10 起又加了几条出网路径，图里没画（每条都是用户显式开启或触发，出网登记见[总纲](evowork-on-codex-design.md) D9 / K6）：

| 路径 | 实现处 | 何时出网 |
| --- | --- | --- |
| 在线升级：取签名清单与安装包 | [update-check.ts](../apps/desktop/src/main/update-check.ts) → `https://update.nucleant.cn/` | 用户点「检查更新」/「下载」；自动检查每天最多一次，受开关控制 |
| 插件 Hub：取签名索引与内容包 | [services/hub-client](../services/hub-client/) → `https://hub.nucleant.cn` | 用户点「刷新」；自动拉取（启动 + 每小时）受开关控制 |
| AI 图片：本机图片服务 → 本机网关 → 服务商 | [image-host.ts](../apps/desktop/src/main/image-host.ts) · [services/gateway/src/images.ts](../services/gateway/src/images.ts) | 每次具体上传/费用确认之后（复用 ⑤ 的网关出口） |
| 浏览器 MCP：独立 Chrome profile 访问网页与搜索 | [plugins/connectors/browser](../plugins/connectors/browser/) | 连接器被信任后，按任务 origin 逐次授权 |

OCR 组件**不在运行时下载**：[ocr-install.ts](../services/runtime-installer/src/ocr-install.ts) 只从管理员配置的离线包
（`EVOWORK_OCR_BUNDLE` + `EVOWORK_OCR_BUNDLE_DIGEST`，见 [service-host.ts](../apps/desktop/src/main/service-host.ts)）校验后安装；
`ocr-sources.json` 只被构建期的 `scripts/build-ocr-bundle.mjs` 读。

除 ⑤、⑥、⑦ 与上表之外，没有任何东西离开这台机器（K6，见 §9 的守卫表）。随包的图片、会话通信、文件交付 MCP 只连宿主的本机回环端口，电脑操控 MCP 只连宿主的私有 Unix socket，都不出设备。

进程划分的判据是**崩溃域**，不是模块边界：
[service-host.ts](../apps/desktop/src/main/service-host.ts) 的头注释写明了本机服务不拆进程的理由 ——
拆进程要多付 IPC、崩溃恢复、双向同步三份复杂度，而它们共享同一个 sqlite，收益为零。
真正需要隔离的是内核（会崩、要重启、要退避）、网关（持密钥、要按配置重启）与解析/渲染子进程（跑不可信内容），它们各自在进程外。

---

## 2. 模块地图

`pnpm-workspace.yaml` 收 `apps/*` · `services/*` · `packages/*` · `tools/*` 四组，
外加 `plugins/skills/*`（有 vitest 配置但不是 workspace 包）。

| 包 | 位置 | 职责一句话 | 关键文件 |
| --- | --- | --- | --- |
| `@evowork/protocol` | [packages/protocol](../packages/protocol/) | app-server JSON-RPC v2 的**手写子集**：帧、方法清单、类型 | [methods.ts](../packages/protocol/src/methods.ts) = 依赖面的声明 |
| `@evowork/logging` | [packages/logging](../packages/logging/) | 结构化日志；Q14「不落盘正文」的实现处 | [fields.ts](../packages/logging/src/fields.ts) 字段白名单（M10a 加了 `credentialSource` / `authMode` / `secretStore` / `quotaClass` / `tenantId`；**刻意不注册 `userId` 与 `password`**） |
| `@evowork/account` | [packages/account](../packages/account/) | JWT 验签 · PKCE · 计量类型。无网络、无存储 | [jwt.ts](../packages/account/src/jwt.ts) · [claims.ts](../packages/account/src/claims.ts) |
| `@evowork/tokens` | [packages/tokens](../packages/tokens/) | design token + 对比度断言 + CSS 变量生成 | [contrast.ts](../packages/tokens/src/contrast.ts) |
| `@evowork/kernel-adapter` | [services/kernel-adapter](../services/kernel-adapter/) | **K2 边界的唯一实现处**：会话/心跳/重启/恢复/能力降级/事件定序/审批/场景展开/**就地起名**/**产品身份** | [adapter.ts](../services/kernel-adapter/src/adapter.ts) · [title.ts](../services/kernel-adapter/src/title.ts) · [identity.ts](../services/kernel-adapter/src/identity.ts) |
| `@evowork/store` | [services/store](../services/store/) | 本机 sqlite：两类表 · 两个迁移器 · 状态派生 · 投影 · automation/artifact/project/audit/share 五个 repo | [schema.ts](../services/store/src/schema.ts) · [repositories.ts](../services/store/src/repositories.ts) |
| `@evowork/scheduler` | [services/scheduler](../services/scheduler/) | 定时调度：带时区 cron · misfire 补偿 · 失败分类 · 设备绑定 · 与内核的桥 | [cron.ts](../services/scheduler/src/cron.ts) · [kernel-bridge.ts](../services/scheduler/src/kernel-bridge.ts) |
| `@evowork/ingest` | [services/ingest](../services/ingest/) | 本机解析管道：识别 · 六道闸门 · 内置解析器 · 三档运行时探测 | [pipeline.ts](../services/ingest/src/pipeline.ts) · [probe.ts](../services/ingest/src/probe.ts) |
| `@evowork/runtime-installer` | [services/runtime-installer](../services/runtime-installer/) | 办公扩展（自包含 CPython + 六个钉死版本的包 + 中文字体）的按需安装；**K6 登记：唯一为装扩展而出网的包** | [install.ts](../services/runtime-installer/src/install.ts) · [manifest.ts](../services/runtime-installer/src/manifest.ts) |
| `@evowork/policy` | [services/policy](../services/policy/) | 路径三级策略 · 命令风险 · 预算并发 · 审计链 · **四个 hook 的决策** | [paths.ts](../services/policy/src/paths.ts) · [hooks/contract.ts](../services/policy/src/hooks/contract.ts) |
| `@evowork/projects` | [services/projects](../services/projects/) | 「项目」（= 总纲的空间）的判定与视图逻辑：归属、卡片、文件树排序。**不做 I/O** | [membership.ts](../services/projects/src/membership.ts) · [cards.ts](../services/projects/src/cards.ts) |
| `@evowork/catalog` | [services/catalog](../services/catalog/) | 技能 / 连接器 / 专家目录的判定与视图：P0/P1/P2 静态审计、来源标注、信任态。**不做 I/O** | [audit.ts](../services/catalog/src/audit.ts) · [skills.ts](../services/catalog/src/skills.ts) · [connectors.ts](../services/catalog/src/connectors.ts) |
| `@evowork/artifacts` | [services/artifacts](../services/artifacts/) | 产物识别（三信号）· 版本 · fs 对账 watcher · 分享授权与上传 · 资料库视图 | [recognize.ts](../services/artifacts/src/recognize.ts) · [watcher.ts](../services/artifacts/src/watcher.ts) |
| `@evowork/gateway` | [services/gateway](../services/gateway/) | Responses↔Chat 全量翻译 · 三家 provider · 错误映射 · SSE · **模型表四层合并** · **托管转发** | [pipeline.ts](../services/gateway/src/pipeline.ts) · [forward.ts](../services/gateway/src/forward.ts) · [tenant-models.ts](../services/gateway/src/tenant-models.ts) |
| `@evowork/identity` | [services/identity](../services/identity/) | 云端账号 · 租户 · 默认模型 · 计量。无内容面 | [service.ts](../services/identity/src/service.ts) · [http.ts](../services/identity/src/http.ts) |
| `@evowork/web` | [apps/web](../apps/web/) | 账号页与租户管理端。密码表单只在这里。**有改密页**。分享页 `/s/<id>` 是独立 bundle（`share.html` + `src/share/`），不读账号会话 | [screens/](../apps/web/src/screens/) · [share/](../apps/web/src/share/) |
| `@evowork/share` | [services/share](../services/share/) | 云端分享托管（D9 第三条职责）：上传 / 撤销 / 元数据 / 解锁 / 取字节 / 到期清扫。与 identity 分进程分库 | [service.ts](../services/share/src/service.ts) · [http.ts](../services/share/src/http.ts) |
| `@evowork/hub-protocol` | [packages/hub-protocol](../packages/hub-protocol/) | 插件 Hub 的索引协议。无网络、无存储 | [index-format.ts](../packages/hub-protocol/src/index-format.ts) |
| `@evowork/hub-client` | [services/hub-client](../services/hub-client/) | 插件 Hub 的本机下行通道：拉索引 · 验签 · 缓存 · 下载内容包 · 校验 sha256。不落盘内容、不判更新 | [client.ts](../services/hub-client/src/client.ts) |
| `@evowork/image-generation` | [services/image-generation](../services/image-generation/) | 本机 AI 图片交付：图片操作权威元数据 · 输入校验与 PNG 校验。不持密钥、不直接调用服务商 | [input.ts](../services/image-generation/src/input.ts) · [png.ts](../services/image-generation/src/png.ts) |
| `@evowork/computer-use` | [services/computer-use](../services/computer-use/) | 电脑操控的固定协议、状态机与 `cua_repl` MCP 实现（打包进 `plugins/connectors/computer-use/vendor/`）。原生 Helper 在 [apps/computer-use-macos](../apps/computer-use-macos/)（Swift，不是 workspace 包） | [protocol.ts](../services/computer-use/src/protocol.ts) · [session.ts](../services/computer-use/src/session.ts) |
| `@evowork/desktop` | [apps/desktop](../apps/desktop/) | Electron 壳 + 本机服务宿主 + 全部 UI | [service-host.ts](../apps/desktop/src/main/service-host.ts) · [renderer-bridge.ts](../apps/desktop/src/main/renderer-bridge.ts) · [model-access.ts](../apps/desktop/src/main/model-access.ts) |
| `@evowork/eslint-plugin` | [tools/eslint-plugin-evowork](../tools/eslint-plugin-evowork/) | 把 K2 与 token-only 两条纪律做成会失败的规则 | [no-kernel-internals.js](../tools/eslint-plugin-evowork/src/no-kernel-internals.js) |

**非包资产**：[plugins/skills/](../plugins/skills/) 四个办公技能（SKILL.md + schema + `render.py` + 共用骨架 + `interface.json`）+ `ui-design`（指令包，无渲染脚本）+ `image-generation` · `computer-use`（引导技能）+ `skill-creator` ·
[plugins/hooks/evowork-policy/](../plugins/hooks/evowork-policy/) 策略包的 I/O 壳 ·
[plugins/connectors/](../plugins/connectors/) 随包 stdio MCP：`browser`（官方浏览器，Q9；含免 Key 搜索）· `image-generation` · `thread-communication` · `workspace-files` · `computer-use`（`cua_repl`）·
[config/](../config/) 内核配置模板 · 模式片段 · 场景包 · **产品身份底稿 `prompts/base-instructions.md`**（F25）· 案例池 ·
[scripts/](../scripts/) 门禁与雷达 · [build/](../build/) 打包配置 + **`build/kernel/<os>-<arch>/` 随包的内核二进制**（不进 git，由 `scripts/build-kernel.mjs` 打补丁编出；迄今只在 `mac-arm64` 上构建过）+ `build/computer-use/`（macOS Helper，由 `scripts/build-computer-use.mjs` 装配）。

**尚无实现**：`ext/`（Rust contributor，只有 README）· 预置专家角色包（`plugins/agents/` 故意为空）· 企业私有源索引的管理面（**Q44 未决策**）。见 §10。

### 2.1 依赖图（实测自各包 `package.json`）

```
                       ┌─────────────────┐
                       │ @evowork/logging│  ← 谁都依赖它，它谁都不依赖
                       └────────┬────────┘
        ┌──────────────┬────────┼─────────────┬───────────────┬─────────────┐
        ▼              ▼        ▼             ▼               ▼             ▼
┌───────────────┐ ┌──────────┐ ┌────────┐ ┌───────────┐ ┌────────────┐ ┌─────────┐
│   protocol    │ │ scheduler│ │ ingest │ │ artifacts │ │  gateway   │ │ policy  │
└───────┬───────┘ └──────────┘ └───┬────┘ └───────────┘ └────────────┘ └────┬────┘
        ▼                          ▼                                        ▼
  ┌──────────┐            ┌───────────────────┐                       ┌──────────┐
  │  store   │            │ runtime-installer │                       │ projects │
  └────┬─────┘            └───────────────────┘                       └──────────┘
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

上图之后新增的依赖边（2026-10-20 实测各包 `package.json`，图未重画）：
`kernel-adapter → policy` · `gateway → account` · `catalog → hub-protocol` · `hub-protocol → account` ·
`hub-client → account, hub-protocol` · `image-generation → store, gateway` · `share / identity → account, logging` ·
`runtime-installer → ingest, logging` · `computer-use`、`account`、`tokens` 无内部依赖。

四条能从图里直接读出来的事实：

1. **`protocol` 只被 `store` 与 `kernel-adapter` 依赖，外加 `desktop` 主进程的两处导入**
   （[renderer-bridge.ts](../apps/desktop/src/main/renderer-bridge.ts) 的 `import type { ThreadItem, Turn, UserInput }`，
   [local-services.ts](../apps/desktop/src/main/local-services.ts) 的 `fileChangeKind`）。
   **渲染层仍然不依赖它** —— K2 的结构性保证是"前端连协议的类型都拿不到"，这一条没变；
   主进程那两处是翻译 Item 形状时的类型与一个纯函数，不是调用面。
2. **`scheduler` / `ingest` / `artifacts` / `policy` / `gateway` 互不依赖**，也不依赖适配层
   （反方向有一条：`kernel-adapter` 依赖 `policy`）。
   它们之间的接线全部集中在 [local-services.ts](../apps/desktop/src/main/local-services.ts) 一个文件里
   （scheduler 需要的适配层能力用**结构类型** `TaskRunner` 表达，见 [kernel-bridge.ts](../services/scheduler/src/kernel-bridge.ts)）。
3. **`gateway` 只依赖 `logging` 与 `account`**（后者提供云端模式的 `jwtAuth`）—— 它要能独立部署成一个文件（见 §8）。
   反过来，`desktop` 依赖 `gateway` 是为了共用**类型与校验**（`CustomModelSpec` / `validateCustomModel` / 四层合并），不是为了在进程内跑它。
4. **`projects` 只依赖 `policy`**（路径硬拦截：`~/.ssh` 不能被设成空间根），`catalog` 只依赖 `hub-protocol`，`runtime-installer` 只依赖 `ingest` 与 `logging`（复用运行时探测与档位文案）。

---

## 3. 分层与逻辑分层的对应

| 总纲的层 | 代码里是什么 | 备注 |
| --- | --- | --- |
| L4 前端 | [apps/desktop/src/renderer/](../apps/desktop/src/renderer/) | 只认 IPC 频道，不认协议方法名。渲染层 import 服务层时**只许走子路径导出**（barrel 会带进 `node:*`，vite 构建直接炸） |
| L3 本机服务 | `services/{kernel-adapter,store,scheduler,ingest,policy,artifacts,projects,catalog,runtime-installer,hub-client,image-generation,computer-use}` + `apps/desktop/src/main/` 里的宿主模块（`model-access` / `secret-store` / `app-config` / `custom-models` / `audit-ingest` / `catalog-host` / `hub-host` / `image-host` / `library-host` / `task-environments` / `thread-communication-host` / `computer-use-host` / `update-check` / `policy-pack` 等） | 同进程模块，宿主是 Electron 主进程。desktop 里那几份要 Electron API 或以注入方式接收 I/O；`catalog` 与 `projects` 一样**不做 I/O** |
| L3′ 云端 | `services/gateway`（本机子进程 + 云端同一份）· `services/identity` · `services/share`（分享托管）· `apps/web`（账号/管理 + 分享页） | 网关、identity、share 都是独立进程 |
| L2 扩展包 | `plugins/{skills,hooks}`（已建）· `plugins/connectors/{browser,computer-use,image-generation,thread-communication,workspace-files}`（MCP）· `plugins/agents/`（空，不预置角色）· `ext/`（只有 README） | K3 的四个扩展点用了三个 |
| L1 内核 | `../codex`，**只读**；随包二进制在 `build/kernel/` | 补丁预算 5 文件 / 500 行，当前用了 4 文件 / 208 行（`patches/evowork/` 两个补丁，`node scripts/patch-budget.mjs`） |

---

## 4. 七条跨边界通道

每条通道都有**唯一的实现处**。这一节的价值不在于"通道有哪些"，而在于**破它的最短路径**是什么、谁拦着。

### ① 渲染进程 ↔ 主进程：preload contextBridge

- 实现：[preload/index.ts](../apps/desktop/src/preload/index.ts) ↔ [service-host.ts](../apps/desktop/src/main/service-host.ts) 的 `IPC` + [renderer-bridge.ts](../apps/desktop/src/main/renderer-bridge.ts) 的 `createRendererActions`。
  契约类型在 [shared/ipc.ts](../apps/desktop/src/shared/ipc.ts)，**两侧共用一份** —— 2026-09-06 之前三处各写一份、各自能编译、合起来是断的。
- 渲染进程能做的**全部事情**：订阅 `computerUseStatus` / `uiEvent` / `notice` / `degrade` / `pendingApprovals` / `runtimeProgress` / `updateStatus` 七个频道；
  调用 `RENDERER_ACTIONS` 里的 **159 个动作**（2026-10-20 实数；分组以 preload 源码里的注释为准，这里不再逐类计数）；
  另有一条主进程→渲染进程的审批**请求**频道 `askApproval`。
- `ipcRenderer` 本身**绝不暴露** —— 暴露它等于把整个 IPC 面交出去，之后每次"临时加个频道"都会绕过这里。
- **动作清单与实现逐项相等**由 `bootstrap.test.ts` 钉住（`RENDERER_ACTIONS` ↔ `ServiceHost['actions']`）。这条约束是被一次真实故障换来的：主进程只注册了审批一个 handler，界面上"回车没反应"且一行报错都没有。
- **密钥只朝一个方向走**：`saveProviderKey` / `addCustomModel` / `applyModelAccess` 把它送进主进程，没有任何动作把它送回来 —— 返回的视图类型里**没有 `apiKey` 字段**，只有后四位（[secret-store.test.ts](../apps/desktop/test/secret-store.test.ts) 扫渲染层收到的完整 payload）。
- 窗口参数（`contextIsolation` / `nodeIntegration` / `sandbox` / `webviewTag`）由
  [bootstrap.ts](../apps/desktop/src/main/bootstrap.ts) 以**注入**方式接收 Electron API，
  因此"我们到底用什么参数开的窗口"是一条**可断言的事实**。preload 的打包入口是 **CJS**（`preload-entry.cjs`）：窗口开着 `sandbox: true`，Electron 的沙箱化 preload 不支持 ESM。

### ② 主进程 ↔ 内核：app-server JSON-RPC v2（K2）

- 实现：[kernel-adapter](../services/kernel-adapter/)，**唯一说协议的地方**。
- 传输：stdio + NDJSON，[jsonrpc.ts](../packages/protocol/src/jsonrpc.ts) 只管帧与双向分发，不认识任何 EvoWork 概念。
- 会话治理在 [session.ts](../services/kernel-adapter/src/session.ts)：握手（`initialize` → **`initialized`**，F17）→ 心跳 → 崩溃退避重启（1s/2s/4s…上限 30s）
  → 重启后对所有打开的 thread 做 `thread/resume` + `thread/items/list` 补齐 → **顶部提示一次「执行内核已重启」**（不静默重启）。
- 实验方法（`project/*`、`thread/queue/*`、timeline 等）必须在 `initialize` 声明 `capabilities.experimentalApi = true`，
  且**每一个都要在降级表里有兜底路径**，由 `assertDegradationCoverage()` 在 `createAdapter()` 启动时钉住。
- **每次 `thread/start` 都带三样东西**，都是 2026-09-06/07 真跑出来的（F20–F25）：
  `baseInstructions`（随包 `config/prompts/base-instructions.md`，整段替换系统底稿 —— 只叠加 `developer_instructions` 盖不住「Codex CLI」）·
  `config` 里按名字关掉系统技能 `openai-docs`（[identity.ts](../services/kernel-adapter/src/identity.ts)）·
  `collaborationMode.settings` 用 **snake_case** 且 `model` 必填（F20/F22：写错不报错，只是静默丢掉）。
- 任务标题由适配层**从第一条需求就地取、不调模型**，并写回内核 `thread/name/set`（[title.ts](../services/kernel-adapter/src/title.ts)）—— 内核里没有任何自动命名路径，`thread/name/updated` 只在客户端显式命名后才发。
- 宿主给内核的 `extraEnv` 里带 `EVOWORK_AUDIT_LOG`（hook 是内核的子进程，环境从那儿继承）与网关令牌；
  **双击启动的应用不继承 shell 环境**，所以这些值必须由宿主显式传，不能指望 `env_key`。

### ③ 内核 → 策略 hook → 审计表

- 壳在 [plugins/hooks/evowork-policy/bin/](../plugins/hooks/evowork-policy/bin/)，**决策在 [services/policy](../services/policy/)** ——
  放脚本里就测不了。
- 输入输出契约镜像在 [hooks/contract.ts](../services/policy/src/hooks/contract.ts)，三条"写错了不报错"的硬约束（F19）：
  `deny` 必须带非空 reason · 没有 `ask` · `updatedInput` 只配 `allow`。违反时内核**丢掉整条输出**，策略静默失效。
- hook 产出的审计记录**追加到 `~/.evowork/audit.jsonl`**，由宿主的 [audit-ingest.ts](../apps/desktop/src/main/audit-ingest.ts) 搬进 `audit_log` 表（搬完截断，插入失败不截断）。
  中间隔一个文件而不是让 hook 直接写库：hook 是短命子进程，与常驻的桌面进程抢 sqlite 写锁只会让审计被静默吞掉。
  链式哈希的校验 `verifyChain` 在主进程（持有权威数据的那一层），不在渲染层。
- 打包时策略包的编译产物被 vendor 进 hook 目录（§8 第 ② 步），漏了这步同样是**静默失效**。

### ④ 主进程 → 技能 / 解析子进程

- 技能：`SKILL.md` 声明能力，`container_tools/render.py` 出产物，`mark_artifact.mjs` 上报。
- 运行时按 [runtime.ts](../services/ingest/src/runtime.ts) 分三档 `base` / `office` / `ocr`。`office` 档装在 `~/.evowork/runtime/office/`
  （python-build-standalone 的 `install_only` 构建：自包含、位置无关、自带 pip；**不用 `uv venv`**，它建的目录不可搬运），
  四个技能的 `render.py` 缺模块时**自动换到这个解释器重跑**。可用 `EVOWORK_OFFICE_PYTHON` / `EVOWORK_OFFICE_BUNDLE` 覆盖。
- TS 侧与 Python 侧（`plugins/skills/_shared/evowork_skill.py`）的档位文案是**同一份数据**，由测试逐字段比对。
- 解析器子进程**必须关网络**。[parsers/](../services/ingest/src/parsers/) 现有 `builtin.ts` · `zip.ts` ·
  `office.ts` + `office.py`（Word / Excel / PPT / PDF 文本层）· `ocr.py`（tesseract）· `library.py`（资料库抽取）。
  OCR、资料库抽取、PDF 分页与 Office 预览经 [isolated-process.ts](../services/ingest/src/isolated-process.ts)
  起子进程（macOS 上 fail closed）；**`office.ts` 的文本解析仍是直接 `execFile`**，只拿掉网络相关环境变量，不在沙箱里（§10）。

### ⑤ 内核 → 本机网关 → 厂商：唯一的模型出网路径

- 内核只认 Responses API（`wire_api = "chat"` 已被上游移除），所以网关是**全量协议适配层**而不是薄转发：
  [to-chat.ts](../services/gateway/src/translate/to-chat.ts) · [from-chat.ts](../services/gateway/src/translate/from-chat.ts) ·
  [usage.ts](../services/gateway/src/translate/usage.ts)。
- 三个端点，零框架依赖（理由是企业私有部署包要过客户合规）：
  `POST /v1/responses` · `GET /v1/evowork/models` · `GET /healthz|/readyz`。
- **本机网关常驻**（D11 / [app-config.ts](../apps/desktop/src/main/app-config.ts)）：
  内核 `base_url` 恒为 loopback；宿主把它作为**子进程**拉起（[gateway-process.ts](../apps/desktop/src/main/gateway-process.ts)），
  等到端口在听才算起来，退出时回收。`app.toml` 的 `mode` 描述的是**默认模型的上游在哪**，
  不是"网关在哪"。`isLocalGateway()` 的 URL 反推退役为**一次性兼容**（老装机的 `config.toml`
  已有非 loopback 地址而 `app.toml` 不存在时推一次写成 `private` 并写回，随后把内核 URL 改回 loopback）。
  hosted 模型转到 identity `/v1/responses`（带 access JWT）；private 未登录用本机静态 token
  转到 `upstream_base_url`（11 §12 第 7 条：不要求我们的账号）。
- **密钥的流向只有一个方向**：渲染层 →（一次 IPC）→ 主进程 → `safeStorage` → `secrets.bin`；用时解密后**经进程环境注入网关子进程**，
  网关只从进程环境读密钥，不读配置文件、不落盘（[model-access.ts](../apps/desktop/src/main/model-access.ts)）。
  自定义模型的密钥每把单独一个 `EVOWORK_CUSTOM_KEY_<n>` 变量，元数据 JSON 里只有变量名 —— 一次"打印下配置"不会 N 把同时泄漏。
- 模型目录是**四层合并**（[layers.ts](../services/gateway/src/layers.ts)）：② 企业覆盖 > ②' 租户默认（M10b）> ③ 本机自定义 > ① 内置元数据。
  被停用的模型**留在列表里带原因**；每条带 `credentialSource`（`byok` / `hosted` / `private`），下拉里显示 —— 它同时回答"花谁的钱"与"数据过谁的境"。
  **模型下拉的真源是这个端点，不是内核的 `model/list`**（F24：内核不知道哪家密钥配好了，且不配 catalog 时会列 OpenAI 型号）。
- **鉴权默认拒绝所有请求**（`staticTokenAuth` 常量时间比对）。本机子进程始终用宿主自签的静态 token
  给内核；云端 JWT 只出现在转发头 `EVOWORK_ACCESS_JWT` 里，**不把本机子进程改成 `AUTH_MODE=hosted`**。
- 错误码映射不是锦上添花：内核对**映射不上的错误一律当可重试**，于是"模型不存在"会被重试到上限。
  映射表与内核的分流逻辑对照见 [providers/registry.ts](../services/gateway/src/providers/registry.ts) 头注释。
- **D11 已落地**：内核 `base_url` 恒为 loopback；hosted / private 都经本机网关转发。

### ⑥ 产物分享上传：本机内容离开设备的唯一常规通道

- [share.ts](../services/artifacts/src/share.ts) + [upload.ts](../services/artifacts/src/upload.ts) + [share-flow.ts](../services/artifacts/src/share-flow.ts)；云端托管在 [services/share](../services/share/)。
- 流程**刻意做得重**：每次过授权模态 · 不记住选择 · 不做批量 · 一次一个 `artifactId` · 可撤销 · 到期自动删（默认 24h）。
- **授权在前、读文件在后**：顺序反了的话，"用户取消了授权"与"文件已被读进内存"会同时成立。
- 日志里没有文件名 —— 文件名本身可能就是敏感信息。
- **现状：两端都已接**。[service-host.ts](../apps/desktop/src/main/service-host.ts) 用 `createShareFlow` / `createUploader` 组装，
  渲染层经 `prepareShare` / `createShare` / `createThreadShare` / `revokeShare` / `listShares` 五个动作调用
  （`prepareShare` 不上传任何东西）；接收方打开的 `/s/<id>` 页面在 [apps/web/share.html](../apps/web/share.html)。

### ⑦ 办公扩展下载：唯一为装扩展而出网的路径（K6 登记）

- [services/runtime-installer](../services/runtime-installer/)：从 [manifest.ts](../services/runtime-installer/src/manifest.ts) 钉死的 URL + 校验和下载 CPython，六个 python 包由 pip 从清华镜像（`--index-url`）安装，中文字体从随包的 `Resources/office/NotoSansSC.ttf` 拷出再切静态实例，装进 `~/.evowork/runtime/office/`，
  装完做"搬走目录再跑"的可搬运检查，然后 `probe.invalidate()` 重探。
- 用户在 App 里点「现在安装」（引导第 ③ 步 / 设置页）才触发；进度经 `runtimeProgress` 频道推送，文案真源在安装器包里。
- 离线机器用 `EVOWORK_OFFICE_BUNDLE` 指向离线包（`scripts/build-office-bundle.mjs` 打），此时下载函数**一被调用就炸**（测试如此构造）。
- 它不在 `services/ingest` 里，是为了让那边的 K6 扫描（`fetch(` / `node:http`）能覆盖整个 `src/` 目录而不留口子。

---

## 5. 八条关键数据流

### 5.1 首次发送一条需求

```
渲染层 Composer ──send({text, draftId?, scenarioId?, modelId?, modeId?, workspaceId?, …})──▶ 主进程
   （首页不创建 Thread —— 发第一条消息时才建，建好回 id，前端据此切页）
        │
        ├─ draftId + workspaceId → task-environments.ts 登记草稿环境 → overrides.cwd
        │    有项目：项目根（id→path 只有主进程知道，渲染层不持有绝对路径）
        │    无项目：独立新目录 ~/.evowork/workspaces/<uuid>，或设置「常规」里自选工作目录下的 <uuid>
        │    环境（cwd + projectId）写进权威 meta；创建后 cwd 固定，换项目要新建任务
        ├─ modelId → overrides.model，并写进任务级设置（下一回合生效，不追溯）
        ├─ modeId → overrides.modeId，同样写进任务级设置（Q45 审批三档）
        ├─ scenario.ts: 场景 + 审批档 + 覆盖 → turn/start 参数
        │    三档展开为 permissions + approvalPolicy + approvalsReviewer
        │    collaborationMode.mode 一律 default；developer_instructions 来自 craft.md（snake_case，F22）
        │    指令文本来自 ~/.evowork/modes/*.md（首次运行装入，F23；**不新增内核枚举值**，D8/F1）
        ▼
   kernel-adapter ──thread/start{cwd, baseInstructions, config}──▶ 内核 ──turn/start{input}──▶ 本机网关 ──▶ 模型
        │                                                     ◀──────── 通知流 ────────
        └─ titleFromText(第一条需求) ──thread/name/set──▶ 内核（真源），投影表跟着更新
```

### 5.2 事件流的三个消费者（顺序是结构性保证，不是约定）

[events.ts](../services/kernel-adapter/src/events.ts)：**先落库 → 再更新 UI → 最后触发副作用**。

每个 handler 只**返回**一个待执行副作用列表，由路由器在落库与 UI 更新之后统一执行 ——
handler 里根本没有直接触发副作用的入口。理由：UI 崩溃/刷新后能从投影表恢复，反之不行。

| 消费者 | 落点 |
| --- | --- |
| 投影表 | `thread_projection` · `item_digest`（状态、用量、摘要） |
| UI | 适配层给出**任务视角**事件（`task-status` / `item-delta` / …），[renderer-bridge.ts](../apps/desktop/src/main/renderer-bridge.ts) 再翻成**组件视角**（`task-created` / `task-updated` / `item` / `turn-failed` / `projects-changed`）。两次翻译不是重复：混成一层就会有"为了 UI 方便往适配层加字段"的压力，那正是 K2 被磨掉的方式 |
| 副作用 | 通知 · 并发计数 · 预算闸门 · 产物识别 · `automation_run` 落库 · 推理耗时掐表（内核的 `Reasoning` 不给时长，主进程按 `item/started→completed` 算） |

`turn-failed` 单独一种事件且**原样带内核给的原因**（`Turn.error`，仅 failed 时填充）：状态只回答"成没成"，用户此刻唯一需要的是"为什么"。

### 5.3 定时任务

```
scheduler 到点（cron + 命名时区 + DST 两个边界）
   │ 幂等键 = automation_id + fire_time + trigger（本机 sqlite 唯一索引，不需要分布式锁）
   │ 关机错过 → misfire 三策略（Q8：SKIP + 不自动重试）；**先写 MISSED 再补跑**
   ▼
kernel-bridge.startRun ──▶ adapter.createTask ──▶ 内核
   │  与交互式任务的三处不同：**必填硬预算** · 审批 10 分钟自动取消 · 失败要分类
   ▼
turn/completed ──▶ classifyFailure ──▶ 只有"任务自身的问题"计入连败
                                        └─ 连败 3 次 → 自动 PAUSE；内核退出 → 在跑的全判 ENVIRONMENT（不计连败）
```

幂等键里的 `trigger` 是接线时被端到端测试逼出来的：MISSED 与 CATCHUP 共享同一个 `fire_time`，两列键会让补跑那条永远插不进去。
设备绑定：automation 绑定创建它的设备（`device_id`），其他设备只读 + 可迁移；**迁移时重置 misfire 基准**。
调度循环按分钟 `setInterval` 对表；**睡眠唤醒事件（`wake_system`）尚未接**（§10）。

### 5.4 文件上传与解析（全程不出网）

```
拖入 → ① magic-byte 识别 + 编码嗅探
     → ② 六道闸门（大小 · 数量 · 压缩炸弹 · 路径穿越 · …；archive 先列后解，穿越拒整包）
     → ③ 落盘 <工作空间>/uploads/<时间戳-slug>/original.<ext>
     → ④ 解析器（内置纯计算 / office / ocr 三档）→ content.md · assets/ · meta.json
     → ⑤ 注入 turn/start：**路径 + 摘要 + 关键页，不塞全文**
     → ⑥ 索引进资料库全文（FTS5 trigram）
```

`office` / `ocr` 档缺失时只有两个出路："装扩展"（⑦）或"以原始文件引用"。
**不存在"传到云上解析"这条分支** —— [pipeline.test.ts](../services/ingest/test/pipeline.test.ts) 扫**整个 `src/`** 里的
`fetch(` / `node:http` / `node:https` 来钉住这件事。

### 5.5 产物识别与索引

```
① 技能 mark_artifact 上报（意图/期望数量/格式/显示名，元数据最全）
② FileChange item / fs 对账 watcher（agent 用 shell/python 直接写的文件）  ── 任一命中即入索引，按绝对路径去重
③ post_tool_use hook（脚本内部批量生成，绕过前两者）
        │  优先级 ① > ② > ③（png 到底是 chart 还是 image，只有信号源知道）
        │  内容没变但来了更高优先级信号 → **元数据订正**（`corrected` 分支，不产生新版本）
        ▼
   artifact 表：指向文件的**元数据**，不含内容（D6：文件系统是真源）
        └─ 于是「删索引 ≠ 删文件」是自然结果，不需要额外约定
```

watcher 是**轮询 + 对账**（[watcher.ts](../services/artifacts/src/watcher.ts)），不用 `fs.watch` 的 recursive（会丢事件）；
内容哈希只取**前 64KB + 大小**；文件被挪走时先按哈希认领 MISSING 记录再判 MOVED。打开任务时开始盯它的工作空间，关掉任务不停。

### 5.6 一次模型调用

```
内核 ──POST {base_url}/responses（Responses 协议）──▶ 本机网关（mode=local 时是 App 子进程）
   ├─ 鉴权：常量时间比对令牌，默认拒绝
   ├─ 按 model id 查四层合并后的目录：被企业停用 → 403 model_denied（原文透出）
   ├─ 能力查表：模型不支持的能力**显式降级并告知**，不静默
   ├─ to-chat：instructions / 工具结果 / 图片（不支持则拒绝，不假装）/ 上一轮的 reasoning_content 回填（推理模型要求）
   ├─ provider.send → 上游（DeepSeek / Kimi / GLM / 用户自定义 endpoint）
   ├─ from-chat：Chat 流 → Responses 事件（编号 · 工具参数重组 · reasoning 段）
   ├─ usage：三家 cache 字段位置各不相同，逐家读；无数据时如实报 0 / 宁可省略，不编
   └─ 错误 → 内核认识的 error.code（映射不上 = 被当成可重试；`code` 缺失回退到 `type`）
   ▼
SSE 回内核。**全程不落盘 prompt 与响应体**（Q14）
```

### 5.7 密钥与拓扑（M10a）

```
启动：ensurePaths → ensureKernelConfig（内核家目录，已存在不覆盖）→ ensureModeInstructions
   → app.toml（mode；不存在且 config.toml 有非 loopback 地址时反推一次并写回）
   → 密钥库（safeStorage 可用？不可用 → **拒绝保存**，直到用户显式二选一）
   → 一次性迁移：gateway.env / gateway-token 导入密钥库后改名 .migrated（钥匙串不可用的机器**不迁移、继续读旧文件**）
   → mode=local：令牌不存在则自签 → 解密密钥 + 编码自定义模型 → 拼进子进程环境 → 起网关 → 等端口在听
   → GET /v1/evowork/models → Composer 下拉与设置页共用同一份目录
设置页改任一项 → 密钥库 → 重启网关 → 重拉目录（model-access.ts 的状态机把这条链路收在一处）
```

`secretStore`（`keychain` / `dpapi` / `libsecret` / `plaintext-fallback` / `unavailable`）落日志字段 —— 降级要**可审计**。

### 5.8 「项目」（= 空间）

本机 `project_local` / `project_root` 两张**权威表**是真源，内核 `project/*` 只做**尽力镜像**（`kernel_id` 为 NULL 不影响任何功能）——
2026-09-07 把口径从"内核为主、本机兜底"反转过来：Q1=A 是纯本地应用、`project/*` 是实验方法、EvoWork 要存的字段超出内核 `Project` 的形状。
`project/list` 保留为启动探针（降级判定机制依赖一个"无副作用、不需要 thread 上下文"的方法）。
首页下拉的工作空间 = 这两张表，全局首页默认无项目、不预选最近项目；任务归属**先看宿主登记的显式 `projectId`**
（[task-environments.ts](../apps/desktop/src/main/task-environments.ts)，存在权威 `meta`），
只有没有登记的旧任务/外部任务才按 `thread_projection.cwd` 落在哪个根下（最长路径边界）判定（[membership.ts](../services/projects/src/membership.ts) 的 `ownerProjectOf`）；
空间记忆是根目录下的 `AGENTS.md`，写入前经三级路径策略。

### 5.9 本机自动记忆与外部项目导入（2026-10-17）

自动记忆与项目 `AGENTS.md` 指令独立。设置/`/import` 及记忆弹窗链接共用导入向导，经五个语义 IPC 动作进入 `kernel-adapter/memory-import.ts`；适配层通过原生 `externalAgentConfig/detect`、`import`、`import/readHistories` 导入 Claude Code 项目记忆。宿主只保存短期候选选择，不读取记忆正文或内部数据库，也不迁移其他配置类型。产品补缺启用原生迁移开关，尊重显式关闭；读取和生成设置不随导入改变。完成结果以原生历史核对，后台整理与新任务读取继续由内核负责。没有新增中心记忆或对外网络通道，模型整理沿用现有网关。详见 [20](design/20-memory-import.md) 和[验收记录](verification/2026-10-17-memory-import.md)。

---

## 6. 本机数据模型

驱动是 Node 内置 `node:sqlite`（`DatabaseSync`），自带 WAL 与 FTS5 —— 没有原生模块，
因此 Electron 打包不需要按 ABI 重编译（代价是 Electron 的 Node 版本必须 ≥ 22.5，见 §8）。库在 `~/.evowork/evowork.db`。

**24 张业务表分两类**（[schema.ts](../services/store/src/schema.ts) 的 `TABLES`，2026-10-20 实数），外加迁移器自建的 `meta` 表（"25 张"的口径含它）：

| 类别 | 真源在哪 | 迁移失败时 | 表 |
| --- | --- | --- | --- |
| **投影类**（8） | 内核 / 文件系统 | **丢弃重建**，附一条警告，继续启动 | `thread_projection` `item_digest` `library_node` `library_index`(FTS5) `library_document` `library_chunk` `access_log` `unknown_event` |
| **权威类**（16） | 只在这里 | 备份 → 失败则回滚并**抛错，宁可启动失败** | `project_local` `project_root` `artifact` `automation` `automation_run` `share` `subscription` `notification` `audit_log` `thread_message` `image_operation` `follow_up_receipt` `follow_up_queue` `follow_up_control` `follow_up_composer` `next_action` |

两类各有**独立的版本号与独立的迁移器**（[migrate.ts](../services/store/src/migrate.ts)，投影类当前 **v5**、权威类当前 **v7**），
两条路径没有任何共享的可写状态 —— 不这么做的话，"重建索引"的逻辑总有一天会把 `automation` 表也清了。

`artifact` 归权威类是一个需要说明的判断：产物**本体**的真源是文件系统（D6），
但索引里的 `title`（可重命名而不改文件名）、`version` 链、`share_id`、`source_signal`
在磁盘上没有对应物 —— 丢了就再也推不出来。`project_*` 归权威类同理：用户建的空间丢了推不回来，内核镜像在干净机器上恒为空。

**任何表都不许有 `user_id` / `tenant_id`**（D10 / Q31=A）：数据属于这台机器，不属于账号。
[schema-no-tenancy.test.ts](../services/store/test/schema-no-tenancy.test.ts) 扫两个迁移器的**全部 DDL**；
2026-09-08 首次跑它就抓到 `automation` 里两个从没人读写的列，迁移 v3 已删。

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
点开一行走 `openTask`（`thread/items/list`，25 条一页按页拉完）—— 对话条目只活在当场事件流里，不拉历史则重启后已完成任务是空对话。

---

## 7. 跨切面机制

### 7.1 日志：Q14 的实现处

[packages/logging](../packages/logging/) 三层防线：

1. **接口形状** —— 没有接受自由字符串的日志入口；
2. **字段注册表**（白名单，不是黑名单）—— 只有注册过的字段名 + 符合形状的值能进，未注册的字段**静默丢掉**；
3. **泄露检测** —— 对输出做 8 字滑窗断言，用于测试与"不落盘"承诺的可审计手段。

字段类型里**没有"短自由文本"档**：`label` / `title` 这类字段名毫无问题，但值是自然语言。
想记路径就记 `pathKind + pathDigest + extension`，想记错误就记 `errorClass + errorCode + messageDigest`。
**刻意不注册**的两个字段：`userId`（本机日志里不留能对外关联到人的稳定标识）与 `password`（客户端进程里就不该有它，Q33=A）。

"静默丢掉"是设计意图，也真的咬过人：上传日志写了 `sizeBytes`，注册表里叫 `byteSize` —— 那条日志从没出现过。**一个概念一个名字。**

### 7.2 能力降级：一律显式

[capabilities.ts](../services/kernel-adapter/src/capabilities.ts)。实验方法的可用性用**探测 + 失败即降级**判定
（`experimentalFeature/list` 返回的是内核运行时功能开关，与"某个实验协议方法在不在"无关 —— F18）。
区分 -32601（上游删了方法 → 降级）与 -32600（我们没声明 `experimentalApi` → **自己的 bug，必须响亮失败**）。
每条降级都带一句**给用户看的话**，UI 必须显示，不许假装正常；部分降级还带 `mustAlsoDo`
（例：`approvalsReviewer` 不可用时帮我批准必须禁用并给原因，不得静默当成请求批准）。

同一条纪律的其他落点：模型能力缺失（下拉里灰色划除，不隐藏）· 被企业停用的模型（留在列表里带原因）· 未知权限 profile（显示 id 本身）·
办公扩展没装（说清缺哪几个模块）· `safeStorage` 不可用（让用户选，不静默写明文）· Windows 隔离强度未知（停用完全访问并给原因页）·
模型目录读不到（`ModelUnavailableReason` 七种，每种下一步动作不同，不压成布尔值）。

### 7.3 审批

内核的审批是**服务端请求**（不是通知），发出后会一直等回复（F14）。两套超时策略：
交互式**不自动拒绝**（一直等，用户就在旁边）；无人值守 **10 分钟自动取消**（"一直等"等于任务永远卡住）。
`askApproval` 未提供时默认 **decline** —— 没人能确认时选择不做。批量变更**不给**「本次任务内都允许」。

### 7.4 安全策略

路径三级（[paths.ts](../services/policy/src/paths.ts)）：**硬拦截**（系统目录 · 密钥凭据 · EvoWork 自身配置）
→ **需逐次审批**（桌面/下载/文档/图片，以及工作空间之外的任何路径）→ **工作空间内**（按 profile 放行）。

两条判定顺序上的硬约束：**硬拦截先于工作空间判定，且不看 `permission_mode`**（否则把工作空间设在 `~/.ssh` 就能绕过），
**`..` 必须在匹配前解析**。硬拦截对 `evowork-full` 同样生效 —— 用户点"完全访问"是为了装依赖，不是为了让 agent 读走 SSH 私钥。
这条同时是提示注入的最后一道防线：注入能骗过模型、能骗过用户点"允许"，骗不过一个不看谁在请求的路径判定。
「项目」的根目录选择与项目说明（`AGENTS.md`）写入也过这同一套判定（`@evowork/projects` 依赖 `policy` 的唯一理由）。

平台能力默认值走保守侧：Windows 隔离强度当前是 `unknown`，因此 `evowork-full` 标 `allowed:false` **并给原因页**，不静默降级。

### 7.5 前端

- 视图切换不用 router：`MainView` 八个值（`task` / `library` / `automations` / `audit` / `projects` / `catalog` / `settings` / `more`）+ `activeTaskId` + `settingsSection`。
  侧边栏一级入口是 [sidebar.tsx](../apps/desktop/src/renderer/views/sidebar.tsx) 的 `MAIN_NAV` 四项（新建任务 · 自动化 · 插件 · 资料库），其下是「项目」与「最近」两个分区；
  底部「更多」菜单（`MORE_MENU`：设置 · 数据管理 · 用量与预算 · 用量与审计 · 关于），项直接落到某个视图或设置页的某个分区（`settings:models` 这种形式）。
  设置页是**一页多分区**，不是若干视图。**没有页面的入口也必须在 `NAV_TO_VIEW` 里出现**（`UnbuiltPage` 如实说没做，不是白屏）；「助理」入口 2026-09-07 整个下架（方案留在 02 §4.2）。
- 样式**零字面量**：颜色与 px 只能来自 [packages/tokens](../packages/tokens/)，由 eslint 规则在渲染层文件上强制。
  组件只能来自 01 §5 的清单（现 **37** 个；第 33 ProgressBar · 34 Dialog / ItemCard · 35 SecretInput · 36 GlobalSearchPalette · 37 SettingsRow 都是先登记再实现）。
- 渲染层 import 服务层**只许走子路径导出**（barrel 会带进 `node:crypto` / `node:child_process`，vite 直接失败），`styles.test.ts` 扫源码拦这类导入。
- **每个顶层视图根都要在 `.ew-app >` 的 flex 规则里**（`styles.test.ts`）—— 新造一个类、CSS 里一条规则都没有，那一页会缩成左上角一小块，而组件自己的样式全对。
- Visualizer 是不可信内容的落点：沙箱 iframe **给 `allow-scripts`、绝不给 `allow-same-origin`**（两者同给等于没有沙箱）·
  SVG 白名单清洗且**点名删 `foreignObject`** · chart spec 拒绝未知字段与函数字符串。mermaid 走动态 import，独立 chunk（2026-09-12 实测：主 chunk 415KB，mermaid core 614KB，见 status.md 指标表）。

### 7.6 拓扑与凭据（M10a）

三个文件、一个状态机、一条纪律：

| 文件 | 内容 | 谁写 |
| --- | --- | --- |
| `~/.evowork/app.toml` | `[gateway] mode = local\|hosted\|private` + `upstream_base_url`（**不是** `base_url`，那是内核那边"网关在哪"的字段） | 宿主（[app-config.ts](../apps/desktop/src/main/app-config.ts)） |
| `~/.evowork/models.toml` | 第③层自定义模型的**元数据** + 密钥的**变量名**，里面没有密钥 | 宿主（[custom-models.ts](../apps/desktop/src/main/custom-models.ts)），形状与校验来自 `@evowork/gateway` |
| `~/.evowork/secrets.bin` | 厂商密钥 + 网关令牌的 `safeStorage` 密文 | [secret-store.ts](../apps/desktop/src/main/secret-store.ts)，`safeStorage` 是**注入**的（不 import electron，"钥匙串不可用"那条路径能在测试里跑） |

状态机在 [model-access.ts](../apps/desktop/src/main/model-access.ts)：拓扑决定要不要自签令牌；密钥与自定义模型一起决定网关子进程的环境；改任何一样都要重启网关再重拉目录。
散在宿主里的话，"改一把密钥之后会发生什么"只能靠真跑一次来验。

纪律：**[gateway-env.ts](../apps/desktop/src/main/gateway-env.ts) 里没有任何写盘函数**（2026-09-08 删掉三个，有测试守着）。
不是因为没人调用，而是一个"暂时没人用但随手能用"的写明文函数，迟早会在某次赶工里被重新接上。

---

## 8. 构建与分发拓扑

`pnpm run build` = [scripts/build.mjs](../scripts/build.mjs) 四步，顺序刻意（在 macOS 上，四步之前先跑 `scripts/build-computer-use.mjs` 装配电脑操控 Helper）：

| 步 | 做什么 | 漏了会怎样 |
| --- | --- | --- |
| ① `tsc --build tsconfig.build.json` | 产出所有包的 JS 与声明（solution 风格，新包要在 references 里登记） | 新包不被类型检查覆盖 |
| ② 复制 `electron-entry.mjs` | 入口是 `.mjs`（唯一 import electron 的文件，被 tsc 跳过） | 打包产物**没有入口** |
| ③ esbuild 打单文件入口 | `dist/gateway/main.js` · `dist/identity/main.js` · `desktop/main/bootstrap.bundle.js` · `desktop/preload/index.bundle.cjs`（入口 `preload-entry.cjs`，必须 CJS）· **hook 策略包 `vendor/policy.mjs`** · 浏览器连接器的 `vendor/policy.mjs` · 电脑操控 MCP `vendor/server.mjs`（只 external electron）。打完单独验证策略包可 import、浏览器 / 图片 / 会话通信 MCP 能脱离仓库启动；再把 `office.py` / `ocr.py` / `library.py` 拷到 `apps/desktop/dist/main/` | workspace 包的 exports 指向 TS 源码，直接 `node dist/…` 会炸；策略包若只是拷 `dist/index.js`（2026-10-01 前就是这样），打包后的应用里策略**静默失效**；漏拷解析脚本则装好的 App 拖入 docx 永远「解析失败」；preload 漏打则 `window.evowork` 不存在 |
| ④ vite 打渲染层（`base: './'`） | mermaid 走[动态 import](../apps/desktop/src/renderer/components/mermaid-renderer.ts)，天然独立 chunk | `base: '/'` 在 `file://` 下指向文件系统根 → 整页全白且没有任何报错 |

入口把两件事拆开：`app.isPackaged`（随包资源在哪）与 `EVOWORK_DEV`（连不连 vite）。未打包时按**入口文件**定位仓库根，不看 `process.cwd()`。
ESM 入口**不顶层 await** `whenReady()`（与 Electron 的 `ready` 互相等 → 进程活着、零个 Helper、一行输出都没有）。

分发（M9，配置在 [build/](../build/)）：electron-builder 三平台 + 差量更新 + macOS entitlements；内核二进制从 `build/kernel/<os>-<arch>/` 进 `extraResources`，中文字体从 `build/office/NotoSansSC.ttf` 进 `Resources/office/`；macOS 包另带 `build/computer-use/EvoWork Computer Use.app`（`mac.extraResources`，发布标记仍关闭）；
`electron` 装在仓库根（electron-builder 检测到 pnpm workspace 后从根解析版本）；`app.asar` 排除 `node_modules`（三个入口都是自包含 bundle）。
[package-plan.mjs](../scripts/package-plan.mjs) 守两件事 —— **体积预算与档位边界**（防止 office/ocr 档混进基础包），
以及**缺任一签名 secret 就整体降级为未签名并把标注写进文件名**（半签名的产物看起来像正式包）。
Electron **44**（Node 24）：`node:sqlite` 要 Node ≥ 22.5，而 Electron 的 Node 比同期 LTS 落后一到两代 —— 选内置模块前先查这个。

`~/.evowork/` 布局（[resolvePaths](../apps/desktop/src/main/service-host.ts)）：

```
~/.evowork/
  evowork.db            本机 sqlite（23 张业务表 + meta）
  app.toml              EvoWork 自己的配置：mode / upstream_base_url（D11）
  models.toml           第③层自定义模型的元数据（无密钥）
  secrets.bin           safeStorage 密文（厂商密钥 + 网关令牌）
  secrets.plain.json    明文兜底 —— **只在用户显式选择时才会被创建**
  gateway.env.migrated  旧明文密钥文件，首次启动导入后改名；钥匙串不可用的机器不改名、继续读
  gateway-token         旧令牌文件，同上
  audit.jsonl           hook 追加的审计记录，宿主搬进 audit_log 后截断
  artifacts.jsonl       技能 mark_artifact 的上报队列（resolvePaths 的 artifactLog）
  config.toml           `resolvePaths` 里仍有这个条目，但**没有任何读写方** —— 内核只读 kernel/config.toml（F21）
  requirements.toml
  modes/                执行指令片段（craft.md 进 Composer 三档；plan.md / ask.md 仅内部。首次运行装入，已存在不覆盖）
  scenarios/            场景包
  logs/
  kernel/               = 内核家目录。config.toml **在这里**（F21），宿主只知道"内核的家在这儿"，
                        **不知道那个环境变量叫什么** —— 那是适配层的知识
  runtime/office/       办公扩展（自包含 CPython + 六个包 + fonts/；卸载 = 删一个目录）
  runtime/ocr/          本地 OCR 组件（只从校验过的离线包安装）
  workspaces/           无项目任务的独立 cwd（每个任务一个 <uuid>；设置「常规」可改到自选目录）
  drafts/               Composer 草稿附件的暂存区，发送前归入最终环境
  …                     其余由各宿主模块按需创建、不在 resolvePaths 里：library/ · cache/ · hub/ ·
                        attachment-sources/ · file-revisions/ · policy-pack.json · jwks.json · update.json
```

启动顺序也是刻意的：**建目录 → 装配置模板与模式片段 → 拓扑 → 密钥库（含迁移）→ 开库 → 起内核 → 起网关（mode=local）→ 审计搬运 → 调度器**。
权威表迁移失败要中止启动，此时不该已经有一个内核进程在那儿等着；`~/.evowork` 不存在时内核往 stderr 打一行就退出、而我们默认丢弃它的 stderr。

---

## 9. 架构不变量与守卫

这一节是本文档最该被读的部分。**每条不变量都有一个会失败的检查**；
改代码撞到它们时，先看它拦的是什么 —— 多半它是对的。

| 不变量 | 谁在守 | 撞上时长什么样 |
| --- | --- | --- |
| K1 内核补丁 ≤5 文件 / ≤500 行 | [patch-budget.mjs](../scripts/patch-budget.mjs)（进 `pnpm run check`） | 「超出 K1 上限」 |
| K2 只有 kernel-adapter 说协议 | eslint [`@evowork/no-kernel-internals`](../tools/eslint-plugin-evowork/src/no-kernel-internals.js) | 「只有 `services/kernel-adapter` 可以引用 `CODEX_HOME`」；判定的是**字符串字面量与成员访问**而非模块图，因为破 K2 的典型写法不 import 任何东西。它把 launcher 从桌面壳里赶了出来，也拦着 `service-host.ts` 提那个环境变量的名字 |
| K5 依赖清单与 NOTICES 一致 | [gen-third-party-notices.mjs --check](../scripts/gen-third-party-notices.mjs) | 依赖树与 `THIRD_PARTY_NOTICES.md` 不一致 |
| K6 解析管道不出网 | [ingest/test/pipeline.test.ts](../services/ingest/test/pipeline.test.ts) 扫**整个 `src/`** | 「解析管道里不该出现 fetch(」—— 下载器因此被放进另一个包 |
| Q14 不落盘正文 | [packages/logging](../packages/logging/) 类型 + 字段注册表 + 泄露检测 | 未注册字段被静默丢掉；形状不对的值进不去 |
| D10 本机表无租户列 | [store/test/schema-no-tenancy.test.ts](../services/store/test/schema-no-tenancy.test.ts) 扫两个迁移器的全部 DDL | 「本机表不许有 `tenant_id`」 |
| Q34 密钥不进渲染层、不静默写明文 | [desktop/test/secret-store.test.ts](../apps/desktop/test/secret-store.test.ts) + [gateway-env.test.ts](../apps/desktop/test/gateway-env.test.ts) | 渲染层收到的 payload 里出现密钥原文；`gateway-env.ts` 里出现写盘函数 |
| IPC 动作清单与实现逐项相等 | [desktop/test/bootstrap.test.ts](../apps/desktop/test/bootstrap.test.ts) | `RENDERER_ACTIONS` 多一项而 `actions` 没有 → 编译期红；少注册 → 「回车没反应」 |
| 样式 token-only · 深路径导入 · 视图根在 flex 规则里 · ModelSelect 三条尺寸约束 | eslint `@evowork/no-style-literals` + [desktop/test/styles.test.ts](../apps/desktop/test/styles.test.ts) | 「组件里不许出现颜色字面量」；渲染层 import 了 barrel；新视图缩成左上角一小块 |
| 每个实验方法都有降级路径 | `assertDegradationCoverage()`，在 `createAdapter()` 里 | 启动即抛 —— 缺一条降级等于给未来留一次白屏 |
| 落库 → UI → 副作用的顺序 | [events.ts](../services/kernel-adapter/src/events.ts) 的结构：handler 只能**返回**副作用 | 想在 handler 里直接触发副作用，会发现没有那个入口 |
| 投影表可丢、权威表不可丢 | 两个迁移器、两套版本号、无共享可写状态 | 权威迁移失败 → 回滚 + 启动失败（这是设计要求） |
| `collaborationMode.settings` 三个键名是 snake_case | `Object.keys(settings)` 逐字断言（scenario 测试） | 写成 camelCase 不报错，只是**产品身份漏成 Codex CLI**（F22） |
| hook 输出契约（F19） | [hooks/contract.ts](../services/policy/src/hooks/contract.ts) 的类型 | 写错了内核**丢掉整条输出**，策略静默失效 —— 所以必须在类型层拦 |
| 审计记录装不下正文 | [audit.ts](../services/policy/src/audit.ts) 的类型里没有那种字段 | 想记正文得先改类型，而改类型会被 review 看见 |
| 运行时文案 TS/Python 两侧一致 | [ingest/test/runtime.test.ts](../services/ingest/test/runtime.test.ts) 逐字段比对 | 用户以为解析和生成要装两个不同的东西 |
| "没装扩展怎么办"必须被测到 | `WITHOUT_OFFICE_RUNTIME` 夹具：`EVOWORK_OFFICE_PYTHON` 指向不存在的路径 + `sitecustomize.py` 只挡那四个模块 | 开发机用户级 site-packages 里有 python-docx 时，这条路径永远没人验 —— 而它是用户第一次用时走的 |
| 打包产物的四条"装得上、看不出哪里错了" | [desktop/test/packaging.test.ts](../apps/desktop/test/packaging.test.ts) | 入口顶层 await · preload 无入口 · `~/.evowork` 没人建 · vite `base` 绝对路径 |
| 内核事实仍成立（[kernel-assertions.json](../scripts/kernel-assertions.json) 的 49 条，编号 F1–F53，其中 F36–F38 / F44 无条目） | [kernel-drift.mjs](../scripts/kernel-drift.mjs) + [kernel-assertions.json](../scripts/kernel-assertions.json)，每日 CI | `LINE-MOVED`（行号漂，不算失败）/ `BROKEN`（断言被上游推翻） |

一条贯穿全仓库的写法纪律：**断言写后果，不写实现**。`expect(x).toBe(3)` 半年后没人知道为什么是 3；
写成「超预算只给两个动作，没有"用便宜模型继续"」，改的人才知道自己在破坏什么。

---

## 10. 已知偏差（写作时实测，2026-09-09；2026-10-20 按当前代码复核）

架构文档最容易腐化的部分是"现状描述"，所以这一节写死在文档里而不是口头传递。
2026-10-20 复核时删掉了已修掉的两行（原第 3 行「分享托管仍未接」、原第 11 行「电脑操控尚未进入当前架构」），其余行按当前代码改写，编号保留不重排。

| # | 偏差 | 实测 |
| --- | --- | --- |
| 1 | 内核签出与断言基线的对应关系**本机无法复核** | [kernel-assertions.json](../scripts/kernel-assertions.json) 的基线是 `d583e73c4d12`（2026-09-24 复核），共 **49** 条断言（编号 F1–F53，F36–F38 / F44 无条目）。2026-10-20 订正时机器上没有 `../codex`，`kernel-drift.mjs` 未重跑；2026-09-09 记录的"签出 `7769bccbb2` 领先基线 `89a4eec6da`、OK 12 · LINE-MOVED 5 · BROKEN 0"是当时那台机器上的结果 |
| 2 | K3 的四个扩展点用了三个 | 技能包 ✅ · hooks ✅ · MCP server ✅（随包 `browser` · `image-generation` · `thread-communication` · `workspace-files` · `computer-use`）· Rust contributor ❌（`ext/` 只有 README；内部只读路径若恢复仍要 `ToolContributor` 过滤写工具，Q45 后这条不再挡 Composer） |
| 4 | 第 ② 层签名策略包已接（M10c） | identity ES256 签 payload 原文 → 桌面验签后写 `~/.evowork/requirements.toml`。无包 / 未登录不锁 BYOK。超期只读，文案见 11 §8。第 ②' 层在登录后由 identity catalog 注入（`EVOWORK_TENANT_MODELS`）；private 未登录则本机网关拉客户网关的目录 |
| 5 | 专家角色包为空 | `plugins/agents/` 不预置角色（编造 100+ 专家等于铺演示数据）。用户可在「技能·连接器 → 专家」新建，或把 TOML 放到 `~/.evowork/agents/`。信任连接器只写 `config.toml`，**不假装有 live reload** |
| 6 | 办公解析子进程不在沙箱里；OCR 无可用发行包 | 办公档（docx / xlsx / pptx / pdf 文本层 / rtf）由 `createOfficeParser` + `office.py` 接入，但 `office.ts` 直接 `execFile`，未经 [isolated-process.ts](../services/ingest/src/isolated-process.ts)（OCR / 资料库抽取 / PDF 分页 / Office 预览已走它，macOS 上 fail closed；其他平台未套 landlock 等）。OCR 本地首版（`ocr.py` + tesseract）已接，但运行时只从管理员配置的离线包安装，默认构建里显示"尚未配置可验证的 OCR 发行包" |
| 7 | `wake_system` 与睡眠唤醒事件未接 | `automation.wake_system` 列存在、表单里能选；`services/scheduler` 与 `apps/desktop/src/main` 里没有任何 `powerMonitor` / 唤醒钩子，调度靠分钟 `setInterval`。休眠唤醒后要等下一个 tick 才做 misfire 扫描（09 §6.3 写的是"直接触发") |
| 8 | 表数口径 | `TABLES` 里是 **24** 张（8 投影 + 16 权威），另有迁移器自建的 `meta`；含 meta 的口径是 25 张 |
| 9 | 随包内核只有一个平台 | `build/kernel/` 不进 git，由 `scripts/build-kernel.mjs` 打补丁编出，迄今只在 `mac-arm64` 上构建过；Windows / Linux 的二进制要在 CI 里构建后放进对应目录，`scripts/package.mjs` 缺它时会拒绝打包 |
| 10 | 桌面壳仍有少量 UI 声明了但没接 | 侧边栏行菜单现在只露 `rename` / `share…` / `archive` / `delete` 四项（[sidebar.tsx](../apps/desktop/src/renderer/views/sidebar.tsx) 的 `rowMenuItems`）：改名与分享由渲染层另走 `renameTask` 与分享授权流，归档 / 删除经 `rowAction` 调内核的 `archiveTask` / `deleteTask`；`RowAction` 类型里其余值（pin / unpin / move / reveal / new-in-workspace / copy-link / fork；分叉另有独立动作 `forkTask`）落到 `rowAction` 只记一条 `desktop.row_action.unimplemented` 日志，但菜单里已不展示。「更多」菜单的禁用项已移除。`@` 候选已由 `searchComposerMentions` 提供；**语音输入**只有一个由 `micAvailable` 控制的按钮，没有任何调用方传这个值，因此不显示 |

另有若干"还没被证伪的断言"（GLM 产物质量 · misfire 真机体验 · 签名公证链路 · Windows 隔离强度 · `safeStorage` 真机行为），
它们是**结论层面**的空白而不是架构层面的，见 [work-priority §10](work-priority.md) 与 [status.md §3](status.md)。

---

## 11. 改这份文档的规则

1. **本文跟着代码走，不跟着计划走。** 一个模块的实现改了，本文同一次改；一个模块只是被规划了，不进本文。
2. **决策不写在这里。** 出现"为什么选 A 不选 B"时，正确做法是写进[总纲](evowork-on-codex-design.md)并在这里引用它。
3. **§9 的表只收有守卫的不变量。** 没有机器守卫的约定属于 CLAUDE.md 或模块 README ——
   混进来会让这张表从"会失败的检查清单"退化成"愿望清单"，而那正是它想避免的东西。
4. **§10 只增不藏。** 偏差被修掉时删掉那一行并在 commit message 里说明；发现新偏差就加一行。
5. 引用内核代码用 `path:line` 并**当场核对**（行号会漂）。

## Computer Use 接线（2026-09-24，未开放发布）

`cua_repl` stdio MCP → 带令牌/递增序号的私有 Unix socket → 桌面宿主 → 签名校验后的原生 Helper 私有 stdio。宿主使用 kernel-adapter 的任务上下文与审批路由，renderer 只暴露启停、撤权、状态订阅等语义动作。原生源码与 macOS 打包入口已加入，但发布标记强制关闭；不能把 Linux 构建通过描述成 macOS 能力可用。具体限制见 status.md 的第二批实现记录。


### 下一步建议（2026-10-20）

随包 `next_actions` MCP 向本机回环宿主提交结构化候选；适配层用真实在途工具 item 核对任务、回合、服务器、工具和递归参数。权威 v7 的 `next_action` 表保存最后一组候选及采纳/关闭状态，与待执行队列独立。回合成功结束后筛选目标、审批与队列状态，再通过语义 IPC 交给 Composer；点击填入或 Tab 只形成草稿，用户发送仍经过现有投递链路。没有新增外网或独立模型请求。详见 [22](design/22-next-actions.md)。

官方 Stop hook 为纯文本回合补齐一次结束检查：本轮未尝试建议登记时，原执行 Agent 在同一回合收到一次提醒，可能增加一次推理；已尝试、工具失败或提醒重入均放行。宿主只按公开回合事件和本机状态核对身份，不读内核私有历史、不解析最终正文或生成候选。活动目标、队列和未知状态不触发提醒，停止与预算仍由内核负责。
