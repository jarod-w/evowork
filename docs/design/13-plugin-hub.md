# 13 · 插件 Hub：专家 · 技能 · 连接器的分发与更新

> 上游：[总纲](../evowork-on-codex-design.md) D9 · K5 · K6 · K7 · Q5 · Q9 · Q18 · Q30 · Q44 · [05 插件](05-experts-skills-connectors.md) · [11 §7 策略包](11-account-and-models.md)
> 组件引用 [01 §5](01-ui-design-system.md)。

| 项 | 内容 |
| --- | --- |
| 版本 | v1.5 |
| 日期 | 2026-10-02 |
| 作者 | li.wang |
| 状态 | **决策完毕（2026-10-02）：HUB-Q1–Q11 及 HUB-Q5a / Q6a / Q8a 全部确认**（结论见 §10 各条开头）。**已回写总纲**（2026-10-02，总纲 v0.13 §10.1.7，明细见 §11）。**H0 与 H1 的客户端已实现**（2026-10-02，见 §13.1）；H2 之前没有签名密钥与 CDN，所以精选源在产品里如实显示「还没有接入」、不发请求 |
| 内核签出 | `openai/codex` @ **`d583e73c4d`（2026-09-21）**。本文所有内核 `path:line` 都在这个提交上当场核对过 |
| 实测样本 | 本机内核已同步的 OpenAI curated 市场快照（`~/.evowork/kernel/.tmp/plugins`，`plugins.sha` = `5fd93af4cd`）；已安装 App 0.0.4 的内核二进制 |

**分工边界**：总纲是 D\*/Q\*/K\* 的唯一真源，本文**不推翻**它。本文的方案有几处要动总纲（Q5 的措辞、D9 的归属、K6 新增一条登记、修正一条已有登记），全部列在 §11。

**已回写总纲（2026-10-02，总纲 v0.13）**：Q5 / N6 / §6.3 的「官方内置」、D9 的「企业私有源索引」、Q30 的补充、K6 的两条新登记和一条订正、§10.1.7 决策表。明细见 §11。

---

## 0. 一句话结论

1. **自建一条「签名索引 + 下行分发」的通道（Hub）**。EvoWork 官方源和企业私有源用同一套协议，客户端只认签过名的源。05 §3.3 / §7 已经为「企业私有源」定下签名、拒装、缓存这几条规则，Hub 就是把它们落成实现，并让 EvoWork 自己也成为其中一个源。
2. **数量靠云端的自动化筛选管道扩大，不靠放宽客户端的入口**：许可 → 安全 → 兼容 → 试跑 → 改写 → 签名。只有被某道闸标记出来的条目才需要人工看。
3. **「装得多」不等于「用得好」**：内核放进 prompt 的技能目录有预算，超了会让所有技能一起变差（HF6）。所以要分三层：默认启用的核心集、按任务带入的精选层、用户自装的长尾。
4. **ChatGPT 生态**：ChatGPT Apps 不接（K7）。开源技能和厂商自建的 MCP 经管道收编进 Hub。
5. **先决修复**：「套件」Tab 现在只是碰巧没显示 OpenAI 的「Codex official」市场（HF4 / HF5）。这个修复不依赖本文其余任何决策，应该先做。

---

## 1. 背景与目标

### 1.1 需求

| # | 需求原话 | 本文的回应 |
| --- | --- | --- |
| R-a | 自建「专家 / 技能 / 连接器」hub，用户能随时收到最新内容 | §3–§6 |
| R-b | 默认也能用 ChatGPT 的技能 / 连接器 | §8：拆成三类成分分别处理，ChatGPT Apps 不接 |
| R-c | 用开源技能，并且希望可用的技能尽可能多 | §6（分层）+ §7（管道） |

### 1.2 现状（2026-10-02 核对）

「插件」页的数据全部来自 [`catalog-host.ts:121`](../../apps/desktop/src/main/catalog-host.ts) 的 `readCatalog`，再由 [`renderer-bridge.ts`](../../apps/desktop/src/main/renderer-bridge.ts) 的 `catalogWithKernelSkills` 补上内核状态：

| Tab | 随包 | 其他来源 | 本机现状 |
| --- | --- | --- | --- |
| 技能 | `Resources/plugins/skills/` 下 7 个（charts · computer-use · documents · presentations · skill-creator · spreadsheets · ui-design），标「官方内置」，不能卸载 | `~/.evowork/skills/`（用户从本地目录或 Git 安装） | 目录不存在 |
| 连接器 | 只有 browser | `~/.evowork/connectors.json`（用户自建的 MCP） | 文件不存在 |
| 专家 | **无**（`plugins/agents/` 里只有 README） | `~/.evowork/agents/*.toml`（用户创建） | 空 |
| 技能 → 套件 | 无 | 内核 `plugin/list` | 空，但空的原因不对（HF4） |

内核的 `skills/list` 只给上面已经列出的技能补状态（启用与否、路径），**不会**往目录里加内核独有的技能。

### 1.3 目标

- **G1** 内容可以独立于 App 版本发布、更新和吊销。
- **G2** 每一个进入客户端的条目都可追溯：来源仓库、提交、许可、审计结论、谁签的名。
- **G3** 可用技能的数量随管道的处理量增长，不随人工审核的人数线性增长。
- **G4** 启用的技能再多，也不会把内核的技能目录预算挤爆（HF6）。
- **G5** 企业私有源和官方源共用同一个客户端，企业可以关闭官方源、完全离线（HUB-Q11）。

### 1.4 非目标

- **N1** 不做第三方提交、上架审核、评分、下载量（Q5；05 §3.2）。Hub 里每一个条目都是 EvoWork 或企业**自己选、自己签**的。
- **N2** 不接 ChatGPT Apps / 连接器目录（K7）。
- **N3** 不做推送长连接（§4.4 说明理由）。
- **N4** 不回传安装数据或使用遥测（R12：Hub 是下行通道，不能长成数据面）。
- **N5** 不建 `/admin/sources`（Q44 仍未决策）。

---

## 2. 核对结果

先列事实，方案建立在这些事实上。编号用 HF 前缀，避免和 [README §4](README.md) 的 F1–F33 冲突。已登记为 [README §4](README.md) 的 **F36–F44**（HF1→F36 … HF9→F44；最初写成 F34–F42，与已有的 F34 / F35 撞号，2026-10-02 订正）。HF4–HF8 与 V6 的发现（F45）已进 `scripts/kernel-assertions.json`。

### 2.1 内核

| # | 事实 | 依据 | 对方案的影响 |
| --- | --- | --- | --- |
| **HF1** | 内核插件包只能装 skills · mcp_servers · apps · hooks，**没有 agent role** | `plugin/src/manifest.rs:19-25` | 内核市场装不了专家，专家必须走我们自己的通道 |
| **HF2** | 内核**不验插件签名** | `plugin/src/bundled_hooks.rs:2` 的注释原文 `it does not verify plugin signatures`；`core-plugins/src` 里没有签名校验代码 | 05 §3.3 第 3 条（验签失败拒装）只能在我们这一层做 |
| **HF3** | 内核市场的来源只有 git 和本地目录；更新靠显式调用 `marketplace/upgrade` | `core-plugins/src/marketplace_add/metadata.rs:138-143` · `core-plugins/src/marketplace_upgrade.rs:73` | 客户机器连不上 GitHub（HF10），git 来源对客户不可用 |
| **HF4** | `plugin/list` 的 `workspace-directory` 是 **ChatGPT 的远端目录**。没有 ChatGPT 登录时，整个请求返回错误 | `app-server/src/request_processors/plugins.rs:719`；**实测**（App 0.0.4 的内核）：`chatgpt authentication required for remote plugin catalog` | 「套件」Tab 现在是空的，因为请求失败、错误被吞掉了（[`renderer-bridge.ts:891`](../../apps/desktop/src/main/renderer-bridge.ts)），不是因为没有内容 |
| **HF5** | `local` 类型**包含** OpenAI curated 市场 | `plugins.rs:617`（`include_openai_curated = !use_remote_global_catalog`，我们这里恒为 true）· `core-plugins/src/manager.rs:3540`（`marketplace_roots` 把 curated 目录加进根）· `manager.rs:620`（没有 ChatGPT 登录时读 `api_marketplace.json`）；**实测**只传 `['local']`：返回 `openai-api-curated`，显示名 **「Codex official」**，50 个插件 | 总纲 K6 登记「内核的插件市场同步」那一行写的「界面上看得见吗：看不见」，**理由不成立**（§9） |
| **HF6** | 技能目录进 prompt 有预算：上下文窗口的 2%（拿不到窗口大小时退回 8,000 字符）。超了先截断描述，再**删掉全部描述**并漏掉一部分技能 | `ext/skills/src/render.rs:17-25` | 启用得越多，所有技能越难被正确触发（§6） |
| **HF7** | 技能目录下 `agents/openai.yaml` 写 `policy.allow_implicit_invocation: false` 时，这个技能**仍然启用，但不进 prompt 目录** | `ext/skills/src/provider/host.rs:144-149` · `ext/skills/src/catalog.rs:256-262`（`is_model_visible = enabled && prompt_visible`）· `ext/skills/src/loader/mod.rs:20-21` | 这是「按需层」的内核机制（§6）。**推断**：这样的技能仍能被显式选中，因为显式选中只检查 enabled（HF8）。**这一点还没在真内核上验证**（§12 V1） |
| **HF8** | 显式选中（结构化的 `UserInput::Skill`）**会跳过已停用的技能** | `skills/src/selection.rs:82` | 「装了但停用，用的时候再带进任务」**这条路走不通** |
| **HF9** | 技能 name ≤ 64 字符，description ≤ 1024 字符 | `skills/src/interface.rs:10-11` | 管道的兼容闸要检查（§7 G4） |

### 2.2 EvoWork 侧

| # | 事实 | 依据 |
| --- | --- | --- |
| **HF10** | 客户机器访问不了 GitHub raw，中文字体就是因此改成随包分发的 | [`build/electron-builder.yml`](../../build/electron-builder.yml) 的注释 |
| **HF11** | 已有一套签名信封，可以直接复用：ES256，签 `payloadJson` 的**原文**，信封是 `{payloadJson, signature, kid}` | [`packages/account/src/policy-pack.ts`](../../packages/account/src/policy-pack.ts) |
| **HF12** | Composer 的「使用插件」已经把技能按 `type: 'skill'` 传进任务 | [`renderer-bridge.ts:1915`](../../apps/desktop/src/main/renderer-bridge.ts) |
| **HF13** | 05 §3.2 写的是「套件」Tab「❌ 当前不渲染」，但代码里它在渲染 | [`catalog.tsx`](../../apps/desktop/src/renderer/views/catalog.tsx) 的 `{ id: 'bundles', label: '套件' }` |

### 2.3 生态样本（OpenAI curated 快照，62 个插件 / 502 个技能）

| 维度 | 数据 | 说明 |
| --- | --- | --- |
| 成分 | 带技能的 46 · 声明厂商 MCP（`.mcp.json`）的 31 · 声明 ChatGPT Apps（`.app.json`）的 36 | 一个插件可以同时包含多种成分 |
| 许可（按技能数，取插件级 `license`） | MIT 243 · Proprietary 121 · Apache-2.0 59 · 未写 53 · Apache-2.0 AND CC-BY-4.0 12 · Figma 开发者条款 12 · GPL-3.0 1 · UNLICENSED 1 | **宽松许可合计 314 个，其中 285 个是纯 Markdown**。这是插件级许可；逐个技能核对后数字还会变 |
| 运行时 | 377 个（75%）纯 Markdown，没有脚本；91 个带 Python | 最常见的第三方依赖是 `requests`（49 个），也就是要联网 |
| 场景 | 多数面向开发者 | 适合职场场景的比例要低得多 |

### 2.4 外部

- SKILL.md 已经是开放标准（Agent Skills），被 30 多个工具采用。Claude、Codex、Cursor 生态的技能，**格式上**大多能直接被内核读取。
- 2026 年初的 **ClawHavoc** 事件：341 个恶意技能被投放到 OpenClaw 的 ClawHub，历史累计超过 1,184 个。很多根本没有脚本，只在 SKILL.md 的「前置条件」里诱导用户安装恶意工具（ClickFix 手法）。**只审脚本不够，指令文本也必须审。**
- `anthropics/skills`：示例技能是 Apache-2.0；**文档类技能（docx / pptx / xlsx / pdf）是 source-available，不是开源**。这恰好和我们自己的四个办公技能重合，不能拿来用。

---

## 3. 总体方案

```
上游开源仓库（固定提交，镜像）
        │ 采集
        ▼
┌───────────────── 云端：筛选管道（CI）─────────────────┐
│ G1 采集 → G2 许可 → G3 安全 → G4 兼容 → G5 试跑 →      │
│ G6 改写 → G7 签名发布                                  │
└──────────────────────────┬────────────────────────────┘
                           ▼
              Hub 静态托管（对象存储 / CDN）
              index.json（签名）+ 内容包（sha256）
                           │
  企业私有源（同一协议，内容留在企业侧，Q44）────┤
                           ▼
┌──────────────────── 桌面 App（本机）────────────────────┐
│ services/hub-client：拉索引 · 验签 · 缓存 · 下载 · 校验   │
│ services/catalog：合并目录 · 静态审计 · 更新判定（不出网）│
│ catalog-host：落盘 → ~/.evowork/{skills,agents,          │
│               connectors.json} → 内核 skills / config     │
└─────────────────────────────────────────────────────────┘
```

**Hub 是什么形态：没有 Web 界面，就是一个静态目录**，和 apt / rpm 仓库同一类：签过名的元数据 + 一堆包，客户端下载、验签、校验。

```
<cdn>/v1/<sourceId>/index.json                         签名信封（4.1），相当于 rpm 的 repomd.xml + 签名
<cdn>/v1/<sourceId>/pkgs/<kind>/<id>/<version>.tar.gz  内容包（4.2），sha256 写在索引里
```

| 谁 | 在哪里操作 |
| --- | --- |
| 用户浏览、安装、更新 | 桌面 App 的「插件」页。Hub 本身不提供任何页面 |
| 我们发布内容 | 向 `evowork-hub` 仓库提交 / 提 PR → CI 跑 §7 的管道 → 请求离线签名 → 上传到 CDN。**PR 评审就是我们的「管理后台」** |
| 企业管理员 | 只有 WEB 管理端策略页里的一个勾选框（4.7）；不浏览内容，不碰 Q44 |

要区分两样东西：**`evowork-hub` 仓库是源头**（上游清单、管道代码、内容），**CDN 上的目录是产物**（CI 生成，不回写进仓库）。和 rpm 仓库相比，我们的索引多了四样：审计结论、吊销列表、`sequence` 防回滚、`expiresAt` 防冻结（4.1）。不做 Web 浏览页，是因为公开可浏览的条目目录就是 Q5 / N1 不做的那种公开市场。

**为什么不直接用内核的市场机制**：HF1（装不了专家）、HF2（不验签名）、HF3 + HF10（git 来源客户用不了），再加上 `plugin/install` 直接落盘、绕过我们的 P0/P1/P2 审计。所以分发通道自建，**落盘继续走 catalog-host 现有的安装路径**。索引字段可以参考内核 `marketplace.json` 的形状，但不复用它的安装流程。

---

## 4. 分发协议

### 4.1 索引

外层直接用策略包的信封（HF11），不另造一套：

```json
{ "payloadJson": "<下面这段 JSON 的原文>", "signature": "<base64url, ES256>", "kid": "evowork-hub-2026a" }
```

`payloadJson` 的结构：

```json
{
  "schemaVer": 1,
  "source": { "id": "evowork", "displayName": "EvoWork 精选" },
  "sequence": 1287,
  "issuedAt": 1790000000,
  "expiresAt": 1790604800,
  "items": [
    {
      "id": "meeting-minutes",
      "kind": "skill",
      "version": "1.3.0",
      "package": { "path": "pkgs/skill/meeting-minutes/1.3.0.tar.gz", "sha256": "…", "size": 18342 },
      "minAppVersion": "0.0.5",
      "defaultEnabled": true,
      "promptVisible": true,
      "interface": { "displayName": "会议纪要", "description": "…", "category": "办公" },
      "audit": { "level": "p0", "network": [], "commands": [], "hooks": false },
      "license": { "spdx": "MIT", "upstream": "github.com/<org>/<repo>", "commit": "…", "modified": true }
    }
  ],
  "revoked": [ { "id": "some-skill", "versions": ["<1.2.1"], "reason": "发现诱导安装外部程序的指令" } ]
}
```

| 字段 | 为什么要有 |
| --- | --- |
| `sequence` | 单调递增。客户端拒绝比已缓存版本小的索引，防止有人拿一份旧的合法索引来回滚 |
| `expiresAt` | 过期的索引照样展示缓存，但会提示，并且**不允许新装**（4.5）。防止攻击者冻结一份旧索引不放新的过来 |
| `revoked` | 吊销跟着索引走，拉到下一次索引就生效。不需要推送（4.4） |
| `audit` | 云端的审计结论，带 `rulesVersion`（审计规则的版本）。**客户端会本地再审一遍**，比对方式见 5.3，不单信云端 |
| `promptVisible` | 决定条目进核心层还是按需层（§6） |
| `license` | 可追溯（G2），也是 `THIRD_PARTY_NOTICES` 的数据来源。没写许可的条目 `spdx` 记为 `NOASSERTION`；按 HUB-Q5a=A，这类条目的 `package` 指向上游的固定提交，不指向我们的 CDN |

### 4.2 内容包

- 一个条目一个包，格式 `tar.gz`，下载后先比对索引里的 `sha256`。
- 技能包 = 技能目录原样打包（含原始 LICENSE 文件 + 修改说明）。
- 专家包 = 一份 agent-role TOML（05 §5.1 的格式）。
- 连接器包：远程 MCP = 一条连接器记录（与 `connectors.json` 的条目同构），不带任何代码。stdio MCP（HUB-Q6=B）= 连接器记录 + **包内自带、版本钉死的 server 源码**，整包校验 sha256。按 HUB-Q6a=A，只能是源码：JS 用 Electron 自带的 node 运行，Python 用办公运行时运行；依赖必须预先打进包里。

### 4.3 密钥

| 源 | 公钥从哪来 | 私钥在哪 |
| --- | --- | --- |
| EvoWork 官方源 | **随 App 分发并钉死**（按 `kid` 列表） | 离线签名机，CI 只能请求签名，拿不到私钥 |
| 企业私有源 | 由策略包下发（Q44 推荐的「只注册源与签名密钥」） | 企业自持 |

轮换：新旧 `kid` 并存一个 App 版本周期。私钥泄露时，靠发版把那个 `kid` 从钉死列表里删掉。

### 4.4 拉取

| 项 | 设计 |
| --- | --- |
| 时机 | 启动时一次，之后每 1 小时一次，加上「插件」页的手动刷新 |
| 方式 | `If-None-Match` 条件请求。没有变化时只回一个 304，成本接近零 |
| 推送 | **不做**。推送要每台客户端保持一条常驻长连接，等于多出一条常开的出网路径，换来的只是延迟从约 1 小时降到几秒。唯一真正需要快的是吊销，1 小时已经够用 |
| 未登录 | **HUB-Q3=B**：默认**不自动拉**，用户可以在设置里打开「未登录时也获取 EvoWork 精选内容」（打开这个动作本身就是显式授权）。开关关着时，插件页的「刷新」按钮按同一条规则算显式触发，点一次拉一次（与在线升级提案 B1 的「检查更新」同一口径）。开关关着、也没点刷新时，只显示随包内容和已有缓存 |
| 账号令牌 | 拉官方源**一律不带**账号令牌，登录了也不带，这样一次拉取关联不到某个账号（与在线升级提案 B1 同一口径）。企业私有源需不需要鉴权，由企业的策略包决定 |
| 失败 | 退回缓存，用 05 §7 已有的文案：「…暂时无法访问，显示的是缓存内容（更新于 X）」 |

### 4.5 校验失败与过期

| 情况 | 处理 |
| --- | --- |
| 验签失败 / `sequence` 回退 / `schemaVer` 不认识 | 丢弃这份新索引，继续用缓存，并给出 warning 条。**不提供「仍然使用」** |
| 索引过期 | 照样展示缓存，**禁止新装**，已装的条目不受影响。吊销列表按最后一份有效索引执行 |
| 内容包 sha256 对不上 | 拒装，Toast 显示「签名校验失败」。按 05 §7 的规定，**不提供重试** |

### 4.6 K6 登记（2026-10-02 已写进总纲）

| 项 | 内容 |
| --- | --- |
| 触发 | 已登录：App 启动 + 每小时一次 + 手动刷新。未登录（HUB-Q3=B）：默认只有用户点「刷新」时才拉；用户在设置里打开开关后，与已登录时相同。安装或更新时下载内容包（这些都是用户动作，或者是 5.4 规则内的更新） |
| 去哪 | Hub 的 CDN 域名（官方源）；企业私有源由策略包配置的地址。按 HUB-Q5a=A：没写许可的条目，在用户点安装时直接访问上游代码托管站（如 `github.com`） |
| 带什么 | **只有 GET**。只带 `If-None-Match` 和 App 版本（用于 `minAppVersion` 过滤，也可以改成纯客户端过滤，连这个都不带）。**不带** prompt、文件名、任务 id、设备 id、账号令牌，不回传装了什么 |
| 完整性 | 索引验签 + `sequence` 防回滚 + 内容包 sha256 |
| 出口 | 只有 `services/hub-client` 出网。它不放进 `services/catalog`，理由和 runtime-installer 不放进 ingest 一样：让 catalog 能被「整目录扫不出出网调用」这条测试守住 |
| 不出网时 | 企业用离线包 `EVOWORK_HUB_BUNDLE`（4.7），**这条路径一个字节都不出网**；企业也可以用 `EVOWORK_HUB_OFFICIAL=off` 或策略包整个关掉官方源；完全离线又没有离线包时，只用随包内容 |

---

### 4.7 企业管控与离线包（HUB-Q11=A）

**① 策略包开关 `disableOfficialHub`**。走 M10c 已上线的策略包通道（11 §7）：租户管理员在 WEB 管理端的策略页（[`admin-policy.tsx`](../../apps/web/src/screens/admin-policy.tsx)）勾选 → identity 用 ES256 签名 → 成员登录后 `GET /v1/policy-pack` → 桌面验签、缓存，交给 `PolicyPackView`。做法与现有的 `disableShare` 完全相同（分享流程读到它就挡住，并说明原因：[`service-host.ts:1413`](../../apps/desktop/src/main/service-host.ts)）。管理端只多一个勾选框，没有源列表也不浏览内容，所以不碰 Q44。

| 开关打开后 | 行为 |
| --- | --- |
| 出网 | hub-client 不再向官方源发任何请求 |
| 插件页 | 不显示「EvoWork 精选」的来源筛选和条目；顶部常驻 caption「你所在的组织已停用 EvoWork 精选内容」 |
| **已装的精选条目** | **停用并写明原因，不静默删除**（与吊销一致）。管理员关掉官方源的意思是「不要用外部内容」，只停止更新不够 |
| 不受影响 | 随包的官方内置内容、企业私有源、用户从本地目录或 Git 自己装的 |
| 策略包过期 | 按 R11 的既有规则进入只读；这个开关**按最后一份有效策略包执行**，不因过期而放开 |

**② 部署时的环境变量 `EVOWORK_HUB_OFFICIAL=off`**。策略包要登录后才拿得到，管不到从不登录的机器。这类机器按 HUB-Q3=B 默认本来就不会自动拉取，但用户可以手动打开或点「刷新」。企业要连这条路也堵上，就在 MDM 下发应用时设置这个变量，用法与 `EVOWORK_OFFICE_BUNDLE` 相同。设置之后，设置页里那个开关和插件页的「刷新」都不再出现，原因如实写出。

**③ 离线包 `EVOWORK_HUB_BUNDLE`**。照搬办公运行时的离线包（[`build-office-bundle.mjs`](../../scripts/build-office-bundle.mjs)）：

- 在有网的机器上运行 `scripts/build-hub-bundle.mjs`，打出一个目录：我们签名的索引原件 + 选中条目的内容包 + `MANIFEST.json`。环境变量指向这个目录后，hub-client 只读本地，**一个字节都不出网**，用和 runtime-installer 离线路径同一类测试守住。
- **签名照验**：离线包在内网流转时被改过，同样装不上。
- **离线索引单独签一个较长的有效期**（建议 180 天）。在线索引的短有效期防的是「冻结一份旧索引不放新的过来」（4.5），而离线场景的源在企业手里，这个风险低得多；照搬短有效期，企业就得每周导一次。代价是**吊销要等企业导入新包才生效**（§14）。
- **企业白名单 `allowlist.json`**：可以附在离线包里，列出只保留哪些条目。它**不需要签名**，因为它只能从已签名的索引里删掉条目、不能加，装不进任何没有经过我们签名的内容。这让企业不用建管理界面，也能自己筛选官方内容。

## 5. 本机落位与安装

### 5.1 代码落位

| 位置 | 职责 | 出网 |
| --- | --- | --- |
| `services/hub-client/`（新建，本机） | 拉索引、验签、缓存、下载内容包、校验 sha256 | **是**，而且是唯一为 Hub 出网的包 |
| `services/catalog/` | 合并 Hub 条目与本机条目、静态审计、判断更新是否扩大了能力（5.4） | 否（加一条整目录扫描测试守着） |
| [`catalog-host.ts`](../../apps/desktop/src/main/catalog-host.ts) | 落盘、同步进内核、写 `config.toml` | 否 |
| `apps/desktop/src/renderer/views/catalog.tsx` | 来源筛选、更新 / 吊销 / 过期这几种状态的展示 | 否 |

### 5.2 来源标签

05 §3.2 规定每张卡**必须**标来源。新增：

| `source` | 标签 | 能否卸载 |
| --- | --- | --- |
| `hub` | 「EvoWork 精选」 | 能 |
| `private` | 「企业私有源」（标签已存在于 `sourceLabel`） | 能（企业策略另有规定的除外） |

现有的 `official`（官方内置）/ `local`（本地目录）/ `git`（Git）不变。

### 5.3 安装

| 类型 | 步骤 |
| --- | --- |
| 技能 | 下载 → 校验 sha256 → **本地再跑一遍静态审计**：规则版本与索引的 `rulesVersion` 相同时，结论必须一致，否则拒装（视为内容或索引被动过）；版本不同时（App 比 Hub 的 CI 旧或新，HUB-Q9=A 之后这很常见），**取两边更严的那个等级**，不拒装 → P1 / P2 让用户确认（05 §3.3） → 写入 `~/.evowork/skills/<id>/`，来源标记写 `hub <sourceId> <version>` → 复制进内核的 `skills/` → 如果 `promptVisible=false`，写 `agents/openai.yaml`，内容 `policy.allow_implicit_invocation: false`（HF7） |
| 专家 | 写入 `~/.evowork/agents/<id>.toml`，与 `createExpert` 同一个目录 |
| 连接器 | 以 `kind: 'hub'`、`trusted: false` 写入 `connectors.json` → 用户「审查并信任」 → 才写进 `config.toml`。**永远不自动信任**（K6 的显式授权点）。stdio 类一律按 P2 呈现（HUB-Q6=B）：信任卡写明「它会以你的身份在这台电脑上运行程序，能读写你能读写的所有文件」，**输入连接器名称确认**；这一步同时算作信任，不再要求第二次点「信任」 |

没写许可的技能（HUB-Q5a=A）：下载这一步改为从上游的固定提交直接取，仍然按索引里的 sha256 校验，后面的步骤与上表相同。上游访问不了时，如实提示「需要能访问 <host>」，**不退回我们的 CDN**。

### 5.4 更新

| 新版本和已装版本相比 | 处理 |
| --- | --- |
| 审计等级没升，网络域名、命令、hooks 也都没增加 | 静默更新，保留上一版，可以回滚 |
| 等级升高，或任何一项能力扩大 | **不自动更新**。卡片显示「有更新，需重新确认」，走 5.3 的确认流程 |
| 被吊销 | 立即停用（技能设为 disabled，连接器从 `config.toml` 移除），卡片写明原因。**不静默删除** |
| 要求的 `minAppVersion` 高于当前 App | 不更新，卡片提示「需要更新 EvoWork」 |
| stdio 连接器的任何新版本 | **一律不静默更新**，按「需重新确认」处理。它的代码能做什么没法靠静态分析框住，「能力没扩大」这个前提证明不了，只能按扩大对待 |

**为什么这样定**：不加这条规则，签名和审计只在第一次安装时管用。之后谁拿到发布密钥，谁就能往所有客户端推任意代码。以上是 HUB-Q4 的建议方案。

### 5.5 随包内容与 Hub

现在的 `installSkill` 会拒绝与随包技能同名的安装（「这是随包技能，已经在目录里了」）。**HUB-Q7=A**：Hub 可以发布随包技能的新版本，版本高的生效；卸载 Hub 版本后回落到随包版本。这样修一个技能的 bug 不用发整个 App。

### 5.6 界面

- 来源筛选多一个「EvoWork 精选」。卡片角标显示版本和「更新于」。
- 新增的卡片状态：「有更新，需重新确认」、「已吊销」（附原因）、「需要更新 EvoWork」。
- 「新上架」**只在插件页里**标注，**侧栏和首页不放红点或角标**（Q18：不设运营位）。
- 已启用、进 prompt 的技能超过预算时，技能 Tab 顶部常驻一条 warning：「已启用的技能太多，模型将看不到部分技能的说明」。这是「不静默降级」的落点（§6）。
- 设置里加一个开关「未登录时也获取 EvoWork 精选内容」，默认关闭（HUB-Q3=B）。登录状态下不显示这个开关，因为登录后本来就会自动拉。未登录、开关关着时，插件页顶部常驻一行 caption：「登录或在设置中开启后，可以获取 EvoWork 精选内容」，如实说明为什么只有随包内容。
- 预计只用 01 §5 已有的组件（ItemCard · Badge · FilterChip · Dialog · Toast）。如果需要新组件，先补进 01 §5。

---

## 6. 「装得多」与 prompt 预算

HF6 决定了一件事：**目录里有多少，和进 prompt 的有多少，必须是两个数**。

| 层 | 数量级 | 内核状态 | 用户怎么用 | 谁决定进哪一层 |
| --- | --- | --- | --- | --- |
| 核心层 | 约 20–30 个，以预算为准 | 启用 + 进 prompt 目录 | 任何任务里模型都能自己选用 | 索引的 `promptVisible=true`；CI 检查核心层总成本 |
| 按需层 | 数百个 | 启用 + **不进 prompt**（HF7） | Composer「使用插件」显式带入（HF12） | `promptVisible=false` |
| 长尾 | 不设上限 | 用户装的时候选 | 「从 Git 安装 / 本地目录」，标注来源，我们不背书，也不在目录里列出 | 用户自己 |

- **核心层的预算按支持的最小上下文窗口来算**。CI 用模型注册表里最小的 context window 乘以 2%，计算核心层所有条目的名称 + 描述成本，超了就让发布失败。不能等用户那边触发截断才发现。
- **按需层完全依赖 HF7 的推断**：「不进 prompt 的技能，仍能通过 `UserInput::Skill` 显式选中」。**这是整个分层方案的前提，§12 的 V1 必须最先验证。** 万一不成立，退路是：用户选中某个按需技能时，由 catalog 把它切换成可见，任务结束再切回去。代价是同时在跑的其他任务也会看到这个技能。
- 用户自己把太多技能设成可见时，按 5.6 给出 warning，不静默截断。

---

## 7. 筛选管道（云端 CI）

### 7.1 七道闸

| 闸 | 做什么 | 判定 | 人工 |
| --- | --- | --- | --- |
| **G1 采集** | `sources.yaml` 列出上游仓库，每个仓库钉死提交并镜像到我们这边（HF10） | — | 新增上游仓库要人工批准 |
| **G2 许可** | **逐个技能**核对 SPDX，不只看仓库级：`anthropics/skills` 就是同一个仓库里混着两种许可的例子 | HUB-Q5：宽松许可白名单内的走完整流程；**没写许可的也收**，按 HUB-Q5a 处理；Proprietary、source-available、copyleft 不过 | 无 |
| **G3 安全** | 复用 [`services/catalog/src/audit.ts`](../../services/catalog/src/audit.ts) 的静态审计（单一真源，不在管道里另写一份）。**再加指令文本规则**：诱导先装某个工具、`curl \| sh`、`iwr \| iex`、大段 base64、webhook / 粘贴站域名、读取 `~/.ssh` 或钥匙串之类的凭据路径。含二进制文件的直接剔除。stdio 连接器（HUB-Q6a=A）：启动命令不是 Electron 自带的 node 或办公运行时的 Python 的、用 `npx` / `uvx` / `pipx run` 这类运行时拉包的、包里含原生二进制的，一律拒绝 | 命中「诱导安装」类规则 = 拒绝；P2 = 必须人工 | P2 与可疑命中 |
| **G4 兼容** | frontmatter 符合 HF9 的限制；标出依赖特定宿主的写法（`${CLAUDE_PLUGIN_ROOT}`、「用 Bash 工具」、`allowed-tools` 这类别家的 frontmatter）；Python import 能否由办公运行时满足；用到的 CLI 工具本机是否有；要联网的必须声明域名 | 满足不了的依赖 = 不过，计入统计（7.3） | 标记项 |
| **G5 试跑** | 用**打过补丁的内核**（带 `KERNEL_PROVENANCE.json`）跑一个固定的冒烟任务，经网关调国内模型 | 技能被调用、没有报错、产出与这个类别的预期一致 | 抽检 |
| **G6 改写** | 生成中文的 displayName / description / category（`interface.json`）；去掉 Claude / Codex / OpenAI / ChatGPT 字样（K5）；保留原 LICENSE，附修改说明（Apache-2.0 §4(b) 要求注明修改） | — | 抽检译文 |
| **G7 签名发布** | `sequence` 加 1、请求离线签名、上传、生成 NOTICES | — | 无 |

**怎么扩量**：G2 / G4 是纯规则，G3 只有命中的才进人工，G5 用抽检。人工量 ≈ 被标记的条目数，而不是条目总数。

### 7.2 首批来源（建议）

| 来源 | 收什么 | 不收什么 |
| --- | --- | --- |
| `anthropics/skills` | 示例技能（Apache-2.0） | 文档类技能（source-available，并且和我们的办公技能重合） |
| `openai/plugins`（curated 快照） | 宽松许可的技能（插件级估算 314 个）＋ 没写许可的技能（53 个，按 HUB-Q5a）；厂商 MCP 端点进连接器（§8） | Proprietary 等明确限制的；ChatGPT Apps |
| 厂商自己维护的技能仓库 | 宽松许可的 | — |
| skills.sh 这类目录 | **只用来发现候选和排序**，不当作可信来源 | 不直接从那里取内容 |
| 开源子代理集合（Markdown + frontmatter） | **本期不收**（HUB-Q10=A），二期再做转换成 agent-role TOML 的工作 | 本期全部 |

### 7.3 运行时扩包

G4 会统计：「如果办公运行时多一个包 X，能多放进来多少技能」。按这个数据决定要不要往 `~/.evowork/runtime/office/` 加包，不靠拍脑袋。每加一个包都走 runtime-installer 的版本钉死流程，并更新 08 §4 和总纲 K6 的登记。

### 7.4 会收到多少

**不预估。** 拿 §2.3 的样本，按插件级许可估出 367 个候选（宽松许可 314 ＋ 没写许可 53），但 G3–G5 的淘汰率要真跑一遍才知道，而且其中适合职场场景的比例更低。§12 的 V2 会给出第一个真实数字。

### 7.5 `evowork-hub` 仓库的约束

仓库是**公开的**，所以下面几条不是建议而是硬约束。它们同时写进那个仓库自己的 CLAUDE.md：在那里工作时读不到本仓库的 CLAUDE.md。

| 约束 | 为什么 |
| --- | --- |
| **没写许可的内容永远不提交进仓库**，只在 CI 的临时目录里分析，仓库里只存索引元数据 | 提交到公开仓库本身就是再分发；HUB-Q5a=A 定的是「只做索引、不托管」 |
| **签名私钥永远不进仓库，也不进 CI 的环境变量** | 4.3：离线签名，CI 只能请求签名 |
| 根目录的 MIT 许可**只覆盖我们自己的代码与内容**；镜像进来的第三方内容各自保留原 LICENSE，Apache-2.0 的同时保留 NOTICE 并注明修改 | 否则会被读成「整个仓库都是 MIT」，等于替别人改了许可 |
| 审计规则从 evowork 的 `services/catalog` 引用，**不复制**。evowork 也是公开仓库，可以用 git 依赖钉住提交 | HUB-Q9=A；两份规则一分叉，5.3 的版本比对就失去意义 |
| 改写后面向用户的文字里不出现 Codex / OpenAI / ChatGPT / Claude 字样 | K5 |
| stdio 连接器只收包内自带的 JS / Python 源码 | HUB-Q6a=A |
| 专家只收我们自己写的 | HUB-Q10=A |
| 不接受第三方提交新条目（可以接受问题反馈和下架请求） | N1 / HUB-Q1 |

---

## 8. ChatGPT 生态的处理

| 成分 | 样本数 | 本质 | 处理 |
| --- | --- | --- | --- |
| 技能（SKILL.md） | 46 个插件 / 502 个技能 | 纯文件 | 经 §7 的管道收编 |
| 厂商自建 MCP（`.mcp.json`） | 31 | 标准的远程 MCP，比如 sentry 指向 `https://mcp.sentry.dev/mcp`，OAuth 在厂商那边 | 做成 Hub 的连接器条目（HUB-Q6=B）。样本里 26 个是远程、5 个是 stdio（3 个用 `node`，1 个用 `npx`，1 个用自带的启动脚本）。用户仍然要逐个「信任 + 授权」，stdio 类按 P2 |
| ChatGPT Apps（`.app.json`，id 形如 `asdk_app_…`） | 36 | 经 chatgpt.com 的连接器网关转发，账号和 OAuth 回调都在 OpenAI 那边 | **不接**（K7）。真要接，得先推翻 K7，代价是账号体系要依赖 OpenAI，而国内用户普遍没有 ChatGPT 账号 |

**「默认能用」的含义**：收编进来的条目**默认出现在目录里**，但**不默认安装、不默认信任**。连接器如果默认就被信任，就破了 K6 的「显式授权点」。

厂商 MCP 进 Hub，等于开始做「官方连接器目录」。05 §4.3 现在的文案是「官方连接器目录将在后续版本提供」，所以这是一个新决策（HUB-Q6）。Q9 只管国内生态，不挡这件事；但海外 SaaS 在国内网络下能否连通，需要逐个实测（§12 V4）。

---

## 9. 先决修复：「套件」Tab

**问题**（HF4 / HF5 / HF13）：适配层 [`listPluginBundles`](../../services/kernel-adapter/src/adapter.ts) 传的是 `['local', 'workspace-directory']`。第二项让整个请求失败，桥接层把错误吞掉，于是 Tab 是空的。只要有人去掉 `workspace-directory`，或者内核以后不再返回这个错误，「Codex official」的 50 个插件就会出现在产品里，同时破 K5 和 Q5。

**修复**（不依赖本文其余任何决策）：

1. 适配层只传 `['local']`。
2. 过滤掉 `path` 位于 `<kernelHome>/.tmp/plugins/` 下的所有市场。**按路径判，不按名字判**：名字有 `openai-curated` / `openai-api-curated` 两个，以后还可能再多。
   **滤掉的是这条通道，不是内容**：curated 里宽松许可的 314 个技能、没写许可的 53 个（只做索引，HUB-Q5a）和厂商 MCP（26 个远程 + 5 个 stdio，后者按 HUB-Q6a 改成包内源码）经 Hub 收编（§7.2）；用户也可以自己从 Git / 本地目录装，照常审计。过滤只针对内核自动同步的 `<kernelHome>/.tmp/` 目录，用户主动登记到别处的本机市场不受影响（按 9.1 先审后装）。ChatGPT Apps 哪条路都不行（K7）。
3. 加载出错时写进 `bundleErrors`，不要吞成空列表（「不静默降级」）。
4. **守卫要判这一类，不只判这一个**：测试断言「渲染层收到的任何 bundle，其 `marketplacePath` 都不在 `<kernelHome>/.tmp/` 之下」，而不是「没有叫 openai-curated 的那一项」。
5. 改正总纲 K6 登记里「界面上看得见吗」那一行的理由，并订正 05 §3.2 与代码不一致的地方（HF13）。

**HUB-Q8=B：「套件」Tab 长期保留**，只列本机与工作区的市场。保留就必须补上它绕过审计的口子，规则见 9.1。

### 9.1 保留「套件」Tab 的附加规则

内核插件包走 `plugin/install`，不验签名（HF2），也不经过我们的 P0/P1/P2 审计。05 §3.3 要求所有安装都先审计，所以：

1. **安装前审计。** `plugin/list` 给每个插件都带了 `source`（`app-server-protocol/src/protocol/v2/plugin.rs:711`，类型定义在 `:904`），分为 `local`（带路径）、`git`、`npm` 三种。`local` 的内容在调用安装前就已经在磁盘上，catalog 先对那个路径下的文件跑同一套静态审计，P1 / P2 确认之后才调用 `plugin/install`。来源标签用「本地目录」：市场是用户自己放的，与「从本地目录安装」同一个信任级别，不要求签名。
2. **非本地来源（git / npm）：先装后审**（HUB-Q8a=B）。顺序是：
   - **装之前**先往内核配置写 `plugins.<id>.enabled = false`（内核用这个键管插件的启停：`core-plugins/src/toggles.rs:13-24`），让它以停用状态落盘。
   - 调 `plugin/install`，内核去 git / npm 取内容。
   - 对内核落盘的目录跑同一套静态审计。通过：P1 / P2 让用户确认，确认后再写 `enabled = true`。不通过：立即 `plugin/uninstall`，卡片写明原因。
   - **V6 已核对（2026-10-02）：预写不生效。** 内核装完**无条件**写 `enabled = true`（`core-plugins/src/manager.rs:2256` 的 `set_user_plugin_enabled(.., true)`；实测预写的 `false` 被覆盖）。所以实现退成「装完立刻写 `enabled = false`」，**不再预写**，空窗如实登记在 §14。落盘目录 = `<kernelHome>/plugins/cache/<市场 name>/<插件名>/<localVersion>`（没有版本时是 `local`；`core-plugins/src/store.rs` 的 `plugin_root`），里面带 `.git`，审计时跳过。
   - 内容是内核在用户点安装时去 git / npm 取的，客户机器连不上 GitHub（HF10）或 npm 时会装不上，要如实提示「需要能访问 <host>」。这也是一条新的、由用户触发的出网路径，要登记进 K6（§11）。
3. **带 `apps` 的插件**（ChatGPT Apps，K7）显示为不可安装，原因写「包含本产品不支持的应用连接器」。文案里不出现 ChatGPT 字样（K5）。
4. **插件里的 MCP server** 会随插件一起被内核启用，绕过连接器的「审查并信任」。所以安装确认卡要逐个列出这些 server，stdio 类按 P2（与 HUB-Q6=B 同一口径）；用户确认这一步同时算作信任。
5. **插件里的 hooks** 按 P2（05 §3.3）。
6. **工作区市场**：适配层现在 `cwds` 传的是空数组，项目里的 `.agents/plugins/marketplace.json` 不会被发现。要显示工作区市场，得把项目根目录传进 `cwds`。
7. **prompt 预算**：从套件装进来的技能同样占核心层预算（HF6），5.6 的超预算 warning 要把它们算进去。
8. **05 §3.2 改为「渲染，只列本机与工作区市场」**，HF13 的不一致以改文档收场（§11）。

---

## 10. 决策记录（HUB-Q）—— 2026-10-02 全部确认

每条都保留了原始选项和建议，结论写在条目开头。已回写总纲 §10.1.7，保留 HUB-Q 编号（同 CU-Q），回写明细见 §11。

### HUB-Q1 · 「EvoWork 精选」源算不算 Q5 说的「官方内置」？

> **已决策（2026-10-02）：A**（采纳建议）。官方内置 = 随包 + EvoWork 签名的精选源；N1 不变：不接受第三方提交，不做评分。

- **A**：算。把 Q5 的「官方内置」改为「随包 + EvoWork 签名的精选源」。仍然不接受第三方提交、不做评分（N1）。
- **B**：不算。Hub 推到 v2，和公开市场一起做。
- **建议 A**。Q5 防的是「我们来当别人内容的分发平台」。精选源里每一条都是我们自己选、自己审、自己签、自己负责，性质与随包相同，只是不跟着 App 发版。
- 影响：总纲 Q5 / N6 / §6.3 的措辞；M7 的范围。

### HUB-Q2 · Hub 在 D9 里算哪项职责？

> **已决策（2026-10-02）：A**（采纳建议）。并入「企业私有源索引」，不新增第五项云端职责。官方源的内容包托管在 EvoWork CDN；企业源的内容留在企业侧。

- **A**：并入「企业私有源索引」这一项，EvoWork 官方源是其中一个源。
- **B**：新增第五项云端职责。
- **建议 A**。两者协议、签名、信任模型完全相同（Q19 也是这样复用这一项的）。需要写明的差别是：**官方源的内容包托管在我们的 CDN 上**，而企业源的内容仍然留在企业侧（Q44）。官方源只有下行，不碰用户数据，不触发 R12。
- 影响：总纲 D9 表格的「企业私有源索引」一行。

### HUB-Q3 · 未登录用户要不要拉 Hub？（Q30：未登录时对我们的域名零请求）

> **已决策（2026-10-02）：B**（没有采纳建议 A）。未登录时默认不自动拉，设置里可以手动打开；插件页的「刷新」算显式触发。落点见 4.4、4.6、5.6。
> **需要改 Q30 的措辞**，改法与[在线升级提案 B1](../superpowers/specs/2026-10-02-online-update-design.md) 要写进总纲的规则是同一条：「用户显式触发的请求可以发，自动或后台发起的不行；用户在设置里打开自动拉取，这个动作本身就是显式授权」。这条规则只写一次，两边共用（§11）。
> 与原来的建议 A 相比：不再要求安装包附带索引快照，打包体积不增加；代价是开关关着的未登录用户只能看到随包内容和已有缓存。

- **A**：不拉。安装包里附带一份打包时的索引快照和对应的内容包，未登录也能用这份快照里的内容。
- **B**：未登录时默认不拉，但设置里可以手动打开（需要修改 Q30 的措辞）。
- **C**：不管登录与否都默认拉。
- **建议 A**，以后需要时再加 B。C 直接违反 Q30。
- 影响：打包体积会增加（快照里的纯 Markdown 技能很小，带运行时依赖的另算）。

### HUB-Q4 · 已装条目怎么更新？

> **已决策（2026-10-02）：A**（采纳建议）。规则见 5.4。

- **A**：能力不扩大就静默更新，扩大了就要重新确认，吊销立即停用（5.4）。
- **B**：一律手动更新。
- **C**：一律自动更新。
- **建议 A**。B 让「随时拿到最新」落空，C 让审计只在首次安装时管用。

### HUB-Q5 · 许可白名单收到哪一级？

> **已决策（2026-10-02）：A，另外没写许可的也收**（在建议 A 之上放宽了一项）。宽松许可的按原方案处理：托管、改写、签名。Proprietary、source-available、copyleft 仍然不收。没写许可的怎么收，见 HUB-Q5a。

- **A**：只收宽松许可：MIT · Apache-2.0 · BSD-2/3-Clause · ISC · CC0-1.0 · CC-BY-4.0。
- **B**：也收 copyleft：GPL · LGPL · MPL · CC-BY-SA。
- **建议 A**。从样本看，copyleft 只有 1 个，收进来的收益接近零，却要在分发与修改义务上多做法务判断。没写许可的一律不收。

### HUB-Q5a · 没写许可的条目怎么收？（由 HUB-Q5 引出）

> **已决策（2026-10-02）：A**。只做索引，不托管、不改写，用户安装时客户端直接从上游下载。**C（主动给作者提 issue 请求授权）不做**；但上游作者自己补上宽松许可后，管道下一次重跑时 G2 会把它判成宽松许可，条目自然转为托管，不需要额外的流程。落点见 4.1、4.6、5.3、§14。

**背景**：没写许可**不等于**可以随便用。版权默认归作者，没有许可就意味着别人不能复制、分发或修改（[choosealicense](https://choosealicense.com/no-permission/)）。GitHub 服务条款 D.5 只允许其他用户**在 GitHub 上**查看和 fork 公开仓库，不包括把内容拿到 GitHub 以外再分发。宽松许可的那套流程——镜像到我们的 CDN（G1）、改写（G6）、签名下发（G7）——放到无许可内容上，三步分别是复制、改编和分发。样本里这类技能有 53 个。

- **A：只做索引，不托管、不改写。** Hub 里只放我们自己写的中文简介、上游地址、固定提交，以及我们按那个提交算好的 sha256（索引条目本身照样签名）。用户点安装时，客户端**直接从上游下载**，按 sha256 校验，本地审计，然后安装。详情页不渲染上游的 SKILL.md 原文，只显示我们写的简介和上游链接。G3 / G4 照跑（只读分析，不对外分发）；G6 改写不适用。
  - 代价 ①：客户机器访问不了 GitHub 时装不上（HF10），要如实提示「需要能访问 <host>」，不退回我们的 CDN。
  - 代价 ②：不能改写，内容里的 Claude / Codex 字样会留在模型读到的文本里。产品界面不显示原文，所以 K5 管的对外可见面不受影响，但模型可能在回答里复述这些名字。
  - 代价 ③：多出一个出网目的地（上游代码托管站，只在用户点安装时访问），4.6 的 K6 登记要加上。
- **B：和宽松许可一样托管、改写、签名。** 体验最好，但每一个条目都是未经授权的复制、改编和再分发，版权风险最高。
- **C：先请求授权。** 管道自动给上游提 issue，请作者加一个许可；加上之后转为宽松许可流程。作者没回复之前不收。
- **建议 A + C 同时做**：先按 A 收进来，同时由管道自动发授权请求；作者一旦加上宽松许可，就自动转成托管条目，可以改写和中文化。**上线前请法务确认 A 的做法**：「只做索引、由用户自己下载」降低了风险，但不等于没有风险。另外不管选哪个，都要有下架流程：接到作者的请求，下一份索引就把条目吊销。

### HUB-Q6 · Hub 发不发连接器？发哪种？

> **已决策（2026-10-02）：B**（没有采纳建议 A）。远程 MCP 和 stdio 都发，stdio 一律定为 P2。落点见 4.2、5.3、5.4、§8、§14；stdio 的代码形态见 HUB-Q6a。远程 MCP 那部分仍需要改 05 §4.3 的文案，并逐个实测国内能否连通（§12 V4）。

- **A**：发，但**只发远程 MCP**（HTTP，OAuth 在厂商侧），不发 stdio 类。
- **B**：远程 MCP 和 stdio 都发，stdio 一律定为 P2。
- **C**：本期不发连接器，只发技能和专家。
- **建议 A**。stdio 连接器等于往用户机器上下发可执行代码，是供应链风险最高的形态。远程 MCP 只是一个 URL，信任和授权都由用户逐个完成。选 A 需要同时改 05 §4.3 的文案，并逐个实测国内能否连通（§12 V4）。

### HUB-Q6a · stdio 连接器允许哪些代码形态？（由 HUB-Q6 引出）

> **已决策（2026-10-02）：A**（采纳建议）。只允许包里自带的 JS / Python 源码，分别用 Electron 自带的 node 和办公运行时运行；禁止原生二进制，也禁止运行时拉包。上游原本用 `npx` 之类启动的，由管道把依赖预先打进内容包，打不进去的就不收。落点见 4.2、G3、§14。

**背景**：内核把 stdio MCP server 当作普通子进程直接启动（`rmcp-client/src/stdio_server_launcher.rs:279`，`Command::new`，没有沙箱包装），它以用户身份运行，不在任务的沙箱里。所以 stdio 连接器能做的事，就是用户自己能做的所有事。P2 管的是「让用户知道」，管不了它「实际做什么」，因此代码从哪来、能不能被我们校验，比审计等级更要紧。

- **A：只允许包内自带的源码。** JS 用 Electron 自带的 node 运行（`ELECTRON_RUN_AS_NODE`，与 browser 连接器相同）；Python 用办公运行时运行。**不允许原生二进制，也不允许运行时拉包**（`npx -y …`、`uvx …`、`pipx run …`），G3 见到这类命令直接拒绝。
- **B：在 A 的基础上允许原生二进制。** 要求对它做代码签名和公证，而我们现在没有 Apple 证书（U4）；不签就只能直接运行未签名的二进制。
- **C：允许运行时拉包。** 适配面最宽，但每次启动都从 npm / PyPI 取一份我们没校验过的代码，签名和 sha256 全部失效。
- **建议 A**。只有 A 能让「签名 + sha256」管到实际运行的那份代码。样本里 5 个 stdio 有 3 个本来就是 `node`，迁移成本低；用 `npx` 的那 1 个，需要在管道里把依赖预先打包进内容包。

### HUB-Q7 · Hub 能不能发布随包技能的新版本？

> **已决策（2026-10-02）：A**（采纳建议）。规则见 5.5。

- **A**：能。版本高的生效，卸载 Hub 版本后回落到随包版本（5.5）。
- **B**：不能，随包技能只跟着 App 更新。
- **建议 A**，修技能的 bug 不必发整个 App。需要改 `installSkill` 里「同名即拒绝」那条规则。

### HUB-Q8 · 「套件」Tab 长期还留不留？

> **已决策（2026-10-02）：B**（没有采纳建议 A）。长期保留，只列本机与工作区的市场。它绕过审计的口子由 9.1 的规则补上；非本地来源怎么处理见 HUB-Q8a。

- **A**：Hub 上线后删掉。内核的本机市场不再在产品里出现。
- **B**：保留，但只显示本机和工作区的市场（§9 修复之后的样子）。
- **建议 A**。内核插件包走 `plugin/install`，**绕过了我们的签名和 P0/P1/P2 审计**（HF2），这和 05 §3.3 冲突。而且 05 §3.2 本来就写的是不渲染（HF13）。§9 的修复是过渡措施。

### HUB-Q8a · 「套件」里来源是 git / npm 的插件怎么办？（由 HUB-Q8 引出）

> **已决策（2026-10-02）：B**（没有采纳建议 A）：先装后审。为了缩小空窗，装之前先把它写成停用，审计通过、用户确认后再启用；不通过就卸载。流程和还没核对的两点见 9.1 第 2 条与 §12 V6。

**背景**：`local` 来源的内容在安装前就在磁盘上，可以先审后装（9.1）。git / npm 来源的内容要等内核执行 `plugin/install` 时才下载，安装之前我们拿不到。

- **A：显示为不可安装。** 原因写「来源不是本机目录，EvoWork 无法在安装前检查它」。
- **B：先装后审。** 调完 `plugin/install` 立刻审计已经落盘的内容，不通过就卸载。问题是内容已经落盘，而内核装完可能马上启用，审计结论出来之前有一个空窗。
- **C：我们自己先下载审计。** 先 `git clone` / `npm pack` 到临时目录审计，通过后再让内核装。问题是内核会再下载一次，两次拿到的未必相同（除非钉了 sha），而且客户机器连不上 GitHub（HF10）。
- **建议 A**。只有 A 能守住「先审后装」。想用这类插件的用户，可以自己把它下载成本地目录，再走 `local` 来源，这条路是通的。

### HUB-Q9 · 内容和管道放在哪个仓库？

> **已决策（2026-10-02）：A**（采纳建议）。**仓库已于 2026-10-02 创建**：`../evowork-hub`（远端 `jarod-w/evowork-hub`，**公开仓库**），约束见 7.5。新建独立仓库 `evowork-hub`，审计规则从本仓库的 `services/catalog` 引用，不复制（例如作为带版本的包发布，或用 git 依赖钉住提交）。由此引出一条规则：两个仓库各自发版，Hub 的 CI 和用户手里的 App 会经常用不同版本的审计规则，所以 5.3 的比对改成按规则版本判断（同版本必须一致，不同版本取更严的等级），索引的 `audit` 加上 `rulesVersion`。

- **A**：新建独立仓库 `evowork-hub`，放上游清单、内容和 CI；审计规则从本仓库的 `services/catalog` 引用，不复制。
- **B**：放进本仓库的 `hub/` 目录。
- **建议 A**。内容更新频繁，不该和产品代码共用提交历史与 `pnpm run check`。审计规则必须只有一份，否则云端和客户端的结论会分叉，而 5.3 恰恰靠「两边结论一致」来拒装。

### HUB-Q10 · 专家从哪来？

> **已决策（2026-10-02）：A**（采纳建议）。本期只发 EvoWork 自己写的专家；开源子代理集合的转换（B）留到二期。7.2 的对应行随之定为「本期不收」。

- **A**：本期只发 EvoWork 自己写的专家。
- **B**：也把开源子代理集合转换成 agent-role TOML 后发布。
- **建议 A，B 留到二期**。专家是人格、模型和权限的组合，需要按产品逐个调；格式转换本身简单，但转出来的专家质量没法自动验证（G5 管技能好验，管专家难验）。

### HUB-Q11 · 企业侧怎么管官方源？

> **已决策（2026-10-02）：A**（采纳建议）。四处细节也按建议定：① 关掉官方源时，已装的精选条目停用并写明原因；② 不登录的机器用部署时的环境变量 `EVOWORK_HUB_OFFICIAL=off` 管；③ 离线索引单独签较长的有效期（建议 180 天），代价是离线环境的吊销会滞后；④ 离线包可附企业白名单，只能减、不能加，不需要签名。落点见 4.6、4.7、§13、§14。

- **A**：策略包加一个开关「禁用 EvoWork 精选源」，并提供离线包（同 `EVOWORK_OFFICE_BUNDLE` 的思路）。
- **B**：本期不做，企业版和个人版一样。
- **建议 A**。企业离线部署是既定场景（Q14），而且这只是在策略包上加一个开关，不需要建管理面，所以不碰 Q44 那条「开着期间不要建 `/admin/sources`」。

---

## 11. 回写记录（2026-10-02）

HUB-Q 沿用 12 篇 CU-Q 的做法，**保留自己的编号，不占总纲的 Q 号**，所以和在线升级提案的 Q46 不冲突。

| 文档 / 代码 | 改了什么 | 状态 |
| --- | --- | --- |
| 总纲 §0 | 版本 v0.13、状态行、本轮决策 | ✅ 已回写 |
| 总纲 N6 · §3 能力映射 · §6.3 · §10.1 Q5 | 「官方内置」含 EvoWork 签名的精选源（HUB-Q1） | ✅ 已回写 |
| 总纲 D9 | 「企业私有源索引」一行：精选源是其中一个源，内容托管与只下行（HUB-Q2） | ✅ 已回写 |
| 总纲 §10.1.4 Q30 · [11 §13.4](11-account-and-models.md) · CLAUDE.md §8 | 「零请求管的是自动 / 后台请求；显式触发可以发；打开开关即显式授权」（HUB-Q3=B）。**只在总纲 Q30 写一处**，11 与 CLAUDE.md 引用它；[在线升级提案](../superpowers/specs/2026-10-02-online-update-design.md) B1 回写时也应引用这里，不再另立 | ✅ 已回写 |
| 总纲 K6 登记 | 新增「插件 Hub 拉取」「『套件』安装时内核取 git / npm 内容」两节；**订正**「内核的插件市场同步」里「界面上看得见吗」的理由（HF4 / HF5） | ✅ 已回写 |
| 总纲 §10.1.7 | HUB-Q1–Q11 决策表 | ✅ 已回写 |
| CLAUDE.md §8 | 开头一句加上「HUB-Q1–Q11 已决策」 | ✅ 已回写 |
| 05 §3.1 / §3.2 / §4.3 / §7 | 来源（已决策未实现的三类）、「套件」Tab 改为渲染（HF13 以改文档收场）、连接器目录与文案说明、两条新异常态 | ✅ 已回写 |
| [11 §7](11-account-and-models.md) | 策略包将新增 `disableOfficialHub`（HUB-Q11） | ✅ 已回写（文档）；`packages/account` 的 `PolicyPackPayload` 是代码，实现时改 |
| README §1 / §4 | 文档地图加 13；HF1–HF9 登记为 **F36–F44**（原写 F34–F42，与 2026-09-26 已进 `kernel-assertions.json` 的 F34 / F35 撞号，2026-10-02 订正） | ✅ 已回写 |
| `scripts/kernel-drift.mjs` | 给 HF4–HF8 加断言（F39–F43），V6 的「安装无条件启用」加为 F45 | ✅ 2026-10-02（`scripts/kernel-assertions.json`） |
| CLAUDE.md §3 | 目录结构加 `services/hub-client` 与 `packages/hub-protocol` | ✅ 2026-10-02（目录已建出来） |
| `packages/account` | 策略包的信封抽成 `envelope.ts`，Hub 索引与策略包共用（HF11） | ✅ 2026-10-02 |

---

## 12. 验证计划

| # | 验什么 | 怎么验 | 为什么排在这里 |
| --- | --- | --- | --- |
| **V1** | HF7 的推断：不进 prompt 的技能能否被 `UserInput::Skill` 选中 | 在真内核上：装一个写了 `allow_implicit_invocation: false` 的技能 → 确认它不在 prompt 目录里 → 用「使用插件」选中 → 确认 SKILL.md 被注入 | 按需层（§6）的前提。不成立就要走 §6 写的退路 |
| **V2** | 第一个真实的通过数 | 对本机 502 个样本技能跑 G2–G4 | 回答「到底能收多少」 |
| **V3** | 预算余量 | 测当前 7 个随包技能占了多少目录成本，按最小上下文窗口算还剩多少 | 决定核心层能放几个 |
| **V4** | 海外厂商 MCP 在国内网络下能否连通 | 对候选端点逐个实测 | HUB-Q6 选 A 的前提 |
| **V5** | §9 的修复 | 单测 + 守卫，加上一次真内核下的 `plugin/list` | 先决修复 |
| **V6** | 先装后审的两点前提（HUB-Q8a=B） | 在真内核上：① 预先写 `plugins.<id>.enabled = false` 再安装，看装完是不是停用；② 找到 git / npm 来源插件落盘的目录，确认审计读到的就是内核要加载的那份 | 决定 9.1 第 2 条有没有空窗 |

### 12.1 验证结果（2026-10-02）

**口径**：第一轮用的是 `../codex` 的 2026-09-05 上游 debug 构建（没有 P6）。**2026-10-02 在 `build-kernel.mjs --debug` 编出的打补丁内核上复测了 V1 / V5 / V6，结论全部一致**（内核 `d583e73c4d`，补丁 `0001-exec-overwrite-approval.patch`，二进制 sha256 与 `KERNEL_PROVENANCE.json` 一致；每次用独立的 `CODEX_HOME` 与 `HOME`）。复测补充的两点：① 内核刚启动时 `plugin/list(['local'])` 可能还**没有** curated 市场，约 5 秒后同步完才出现 —— 有没有它取决于启动时机，§9 的 `.tmp/` 过滤两种情况都得守住；② 用适配层 `setPluginEnabled` 的同一份 `config/batchWrite` 写停用后，`plugin/list` 显示 `enabled: false`，**该插件的技能从 `skills/list` 里整个消失**（不是列成停用）。没测：空窗期间恰好开始的回合会不会带上它；写停用之后的回合 prompt 里确实没有它（只看了 `skills/list`）。脚本与原始结果在会话临时目录，没有进仓库。

| # | 结论 | 依据 |
| --- | --- | --- |
| **V1** | **成立** | 写了 `allow_implicit_invocation: false` 的技能：`skills/list` 里 `enabled: true`；第一轮发给模型的请求里没有它的名字和描述（对照技能在）；以结构化的 `UserInput::Skill` 选中时 SKILL.md 正文被注入；**在文本里提到它的名字也会被注入**。按需层（§6）的前提成立，退路用不上 |
| **V3** | 7 个随包技能合计 **≈489 token**（平均 70；按装在 `/Applications/EvoWork.app/...` 下的路径算，路径本身约占 30%） | 口径（`ext/skills/src/render.rs`）：每个进目录的技能一行 `- <name>: <description> (file: <路径>)`，描述截到 1024 字符，**4 字节 ≈ 1 token**，预算 = 上下文窗口 × 2%。按支持的最小窗口 128K（`services/gateway/src/known-models.ts`，标着 `unverified`）算预算 2,560，**余量约 2,070 ≈ 30 个平均大小的技能**——与 §6 估的「核心层 20–30 个」一致。中文描述按字节算，比英文贵约 2–3 倍 |
| **V5** | **成立** | `plugin/list` 只传 `['local']`：返回 `openai-api-curated`（「Codex official」，50 个插件），路径在 `<kernelHome>/.tmp/plugins/` 下，被 `listBundles` 按路径滤掉；加上 `workspace-directory` 整个请求报 `-32600 chatgpt authentication required for remote plugin catalog`（HF4 / HF5 实测复现）。单测与守卫见 `services/catalog/test/bundles.test.ts`、`apps/desktop/test/bundle-host.test.ts` |
| **V6** | ① **预写不生效**（见 9.1 第 2 条）；② 落盘目录可由 `plugin/list` 的市场 `name` + 插件名 + `localVersion` 推出 | 另一个发现：用 `marketplace/add` 加的 git 市场落在 `<kernelHome>/.tmp/marketplaces/<name>/`，**同样会被 §9 的 `.tmp/` 过滤滤掉**。产品里没有添加市场的入口，所以这不影响现在的用法；要在「套件」里看到 git / npm 来源的插件，市场本身得是用户放在 `.tmp/` 之外的本机目录 |

---

## 13. 分期（粗估，未评审）

| 期 | 内容 | 粗估 |
| --- | --- | --- |
| H0 | §9 先决修复 + V1 / V3 | 2–3 人天 |
| H1 | 协议、`services/hub-client`、catalog 合并、安装与更新（含 5.4 的判定） | 约 2 人周 |
| H2 | 云端静态托管、离线签名、CI 发布 | 约 1 人周 |
| H3 | 管道 G1–G4 + V2 | 约 2 人周 |
| H4 | G5 试跑 + G6 改写 | 1–2 人周 |
| H5 | 首批内容上线；连接器条目（HUB-Q6=B） | 持续 |
| H6 | 企业管控（4.7）：策略开关 + 环境变量 1–2 人天；离线包 + 白名单 3–5 人天 | 约 1–1.5 人周 |

---

### 13.1 H0 / H1 实现状态（2026-10-02）

| 部分 | 落在哪 | 状态 |
| --- | --- | --- |
| §9 先决修复（只传 `local`、按路径滤 `.tmp/`、错误进 `bundleErrors`、判一类的守卫） | `services/kernel-adapter` · `services/catalog/src/bundles.ts` · `apps/desktop/src/main/bundle-host.ts` | ✅ |
| 9.1 安装前审计（本机来源先审后装；git / npm 先装后审；带 apps 不可装；插件内 MCP 与 hooks 按 P2；工作区市场传 `cwds`；渲染层传来的路径不可信、安装前重新列一遍） | 同上 | ✅；第 7 条（套件技能计入预算）随 5.6 的预算条一起做了：数的是内核 `skills/list` 里所有启用的技能 |
| V1 / V3 / V5 / V6 | §12.1 | ✅（旧二进制上测的，见口径） |
| 协议（索引形状、签名、tar.gz、版本与吊销范围） | `packages/hub-protocol`（新） | ✅ |
| 下行通道（拉索引、验签、`sequence` 防回滚、缓存重验、下载、sha256 / 树哈希） | `services/hub-client`（新，**唯一为 Hub 出网的包**） | ✅ |
| 合并、本地重审（按 `rulesVersion` 比对）、5.4 更新判定、预算 | `services/catalog/src/hub.ts`（整目录不出网的扫描守着） | ✅ |
| 安装 / 静默更新 / 吊销 / 回滚 / 卸载；5.5 覆盖随包技能；HUB-Q3=B 的拉取时机 | `apps/desktop/src/main/hub-host.ts` | ✅ |
| 界面：来源筛选、状态卡、warning / caption、刷新、预算条；设置里的未登录开关 | `views/catalog.tsx` · `views/settings.tsx` | ✅（单测；**没做真实窗口验收**） |
| 官方源的地址与公钥 | `apps/desktop/src/main/hub-config.ts` | ⏳ H2：公钥列表是空的，地址由 `EVOWORK_HUB_ORIGIN` 给。两样都有之前**一个请求都不发** |
| 4.7 ① 策略包 `disableOfficialHub` | `packages/account` · `services/identity` · `apps/web` 策略页 · `hub-host.ts` | ✅ 2026-10-02（H6）。组织停用的条目记为 `revokedBy: 'organization'`：**不是**内容出了问题，所以组织重新打开后卡片转「需重新确认」，确认一次恢复；连接器的信任要重新给（K6） |
| 4.7 ② `EVOWORK_HUB_OFFICIAL=off` | `hub-config.ts` | ✅（H1） |
| 4.7 ③ 离线包 + 白名单 | `services/hub-client/src/bundle.ts` · `scripts/build-hub-bundle.mjs` | ✅ 2026-10-02（H6）。离线源用的是**同一个** hub-client，只是把 fetch 换成读目录：验签、`sequence`、sha256 原样跑，非 `bundle:` 地址一律失败（不出网）。官方源要另外发一份长有效期的 **`index.offline.json`**（H2 的发布流程要产出它）；没有时脚本退回在线索引并在 MANIFEST 里标出来。没写许可的条目不进离线包。白名单写坏 = 当作没有白名单（照样提示），不是「全删」 |
| G3 指令文本规则（诱导安装 · 下载即执行 · base64 · 收数据端点 · 凭据） | `services/catalog/src/audit.ts`（规则版本 `2026-10-02.2`） | ✅ 2026-10-02。规则只有这一份（HUB-Q9=A），管道引用它；诱导类的 finding 带 `lure`，管道见到直接拒收 |
| 企业私有源 | — | ⏳ 等 Q44；公钥由策略包下发（4.3），客户端的多源合并还没做 |

实现时定下的几处细节（文档原来没写到这么细）：

- **随包技能的版本**写在它的 `interface.json` 的 `version` 里；没写 = `0.0.0`，任何 Hub 版本都比它新（5.5）。现在 7 个随包技能都没写，所以 Hub 一旦发布同名技能就会生效，**App 升级后随包那份变新了也不会自动回到随包版本**，要 Hub 那边下架或用户卸载。随包技能真要被 Hub 覆盖之前，应当给它们补上版本号。
- **上游固定提交的条目**（HUB-Q5a=A）校验的是解开后 `subdir` 的**文件树哈希**（`package.treeSha256`），不是归档的 sha256：代码托管站重新压缩过归档，字节就不一样了。托管在我们 CDN 上的仍然先比归档的 sha256、再解包。
- 内容包用自己写的 tar 读取器解，**不调系统 `tar`**：符号链接、硬链接、`..`、绝对路径整包拒绝。
- 静默更新前**下载并本地重审**：云端说能力没扩大、本机审出来扩大了，这一版不装，卡片转「有更新，需重新确认」并写明多了什么。回滚之后同一版本也按这条挡住，不会下次刷新又被静默升回去。
- **离线包与 `EVOWORK_HUB_OFFICIAL=off` 同时设置时，离线包照常可用**：`off` 管的是「不向官方源发网络请求」，离线包不发请求。企业策略包的 `disableOfficialHub` 则连离线包一起停（那是「不要用外部内容」）。
- 连接器条目的内容包是 `connector.json`（远程：`transport` + `url`；stdio：`runtime` = `node` | `python` + 包内 `entry`）。stdio 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 跑。

## 14. 风险

| 风险 | 缓解 |
| --- | --- |
| 供应链投毒（ClawHavoc 那类） | 只从钉死的提交采集；G3 审指令文本；客户端本地再审一遍、结论不一致就拒装；能力扩大要重新确认；吊销随索引生效 |
| 签名私钥泄露 | 离线签名，CI 拿不到私钥；`kid` 轮换；发版从钉死列表里删除泄露的 `kid` |
| 许可误判 | 逐个技能核对；保留原 LICENSE 和修改说明；接到下架请求时走吊销 |
| 上游漂移 | 钉死提交；上游有更新时整条管道重跑，不做增量放行 |
| prompt 预算被挤爆 | CI 检查核心层成本；客户端超预算时给 warning |
| Hub 长成数据面（R12） | 只有下行；不回传装了什么；不带设备标识；K6 登记写死「带什么」 |
| 「套件」Tab 漏出 OpenAI 品牌 | §9：按路径过滤，守卫判这一类 |
| 离线环境的吊销滞后（HUB-Q11=A） | 离线索引有效期较长，吊销要等企业导入新包才生效。在 `MANIFEST.json` 里写明打包时间，插件页显示「离线内容，更新于 X」；有安全吊销时，主动通知企业客户重新打包 |
| 「套件」先装后审的空窗（HUB-Q8a=B） | **V6 证实预写无效**（内核装完无条件写启用，`core-plugins/src/manager.rs:2256`）：从 `plugin/install` 返回到我们写回 `enabled = false` 之间，恰好在这时开始的任务可能加载到这个插件。这段空窗**存在**，实现里只能把它压到「一次本机 RPC」那么短；审计不过立即卸载 |
| stdio 连接器以用户身份运行任意代码（HUB-Q6=B） | 一律 P2、输入名称确认；包内自带并钉死代码，不允许运行时拉包（HUB-Q6a=A）；任何更新都要重新确认（5.4）；吊销时立即从 `config.toml` 移除 |
| 没写许可的内容有版权风险（HUB-Q5） | HUB-Q5a=A：只做索引，不托管、不改写；接到下架请求时，下一份索引就吊销；上线前请法务确认 |

---

## 15. 外部参考

- [SKILL.md Open Standard Reaches 30+ AI Coding Tools](https://www.noqta.tn/en/news/skill-md-open-standard-30-ai-coding-tools-adoption-2026)
- [What Are Agent Skills?（Atlan）](https://atlan.com/know/ai-agent/ai-agent-skills/what-are-agent-skills/)
- [Hundreds of Malicious Skills Found in OpenClaw's ClawHub（eSecurity Planet）](https://esecurityplanet.com/threats/hundreds-of-malicious-skills-found-in-openclaws-clawhub)
- [341 OpenClaw skills distribute macOS malware via ClickFix instructions（CyberInsider）](https://cyberinsider.com/341-openclaw-skills-distribute-macos-malware-via-clickfix-instructions/)
- [Introducing skills（Vercel）](https://vercel.com/blog/introducing-skills)
- [anthropics/skills（DeepWiki）](https://deepwiki.com/anthropics/skills)
- [No License（choosealicense.com）](https://choosealicense.com/no-permission/)
- [GitHub Terms of Service D.5 · License Grant to Other Users（ConductAtlas 摘录）](https://conductatlas.com/platform/github/github-terms-of-service/provision/CA-P-036411/public-repository-forking-license-to-other-users/)

---

## 变更记录

| 版本 | 日期 | 内容 |
| --- | --- | --- |
| v0.1 | 2026-10-02 | 初稿：核对结果 HF1–HF13、协议、分层、管道、ChatGPT 生态的处理、先决修复、HUB-Q1–Q11 |
| v0.2 | 2026-10-02 | HUB-Q1=A、HUB-Q2=A、HUB-Q3=B 确认。按 Q3=B 改了 4.4（未登录、账号令牌）、4.6（触发、带什么）、5.6（设置开关与 caption）。发现 Q46 已被在线升级提案占用，并且 Q30 的规则两边要写同一条，§11 改为落笔时再分配编号、Q30 合写一次 |
| v0.3 | 2026-10-02 | HUB-Q4=A；HUB-Q5=A，另外没写许可的也收。因为没写许可在法律上是「保留所有权利」，新增 HUB-Q5a（建议只做索引、不托管不改写，同时自动请求授权，上线前法务确认），并同步改了 4.1、4.6、5.3、G2、7.2、7.4、§14 |
| v0.4 | 2026-10-02 | HUB-Q6=B：stdio 连接器也发，一律 P2。因此改了 4.2（stdio 包自带钉死的源码）、5.3（P2 输入名称确认，同时算作信任）、5.4（stdio 一律不静默更新）、§8（样本里 26 个远程、5 个 stdio）、§14；新增 HUB-Q6a（stdio 的代码形态，建议只允许包内源码）。HUB-Q7=A |
| v0.5 | 2026-10-02 | HUB-Q5a=A：没写许可的条目只做索引，不托管、不改写。不主动请求授权（C 不做），从 §14 删去了这一项；上游自己补上许可后，管道重跑时自然转为托管 |
| v0.6 | 2026-10-02 | HUB-Q6a=A：stdio 连接器只允许包内自带的 JS / Python 源码，禁止原生二进制和运行时拉包。改了 4.2、G3、§14 |
| v0.7 | 2026-10-02 | HUB-Q8=B：「套件」Tab 长期保留，新增 9.1（安装前审计、带 apps 的不可装、插件内 MCP 与 hooks 按 P2、工作区市场要传 cwds、计入预算）和 HUB-Q8a（git / npm 来源，建议不可装）。HUB-Q9=A：独立仓库；因此 4.1 的 `audit` 加了 `rulesVersion`，5.3 改为按规则版本比对 |
| v0.8 | 2026-10-02 | HUB-Q8a=B：git / npm 来源的套件插件先装后审。9.1 第 2 条写明顺序（预写停用 → 安装 → 审计 → 确认启用或卸载）；新增 §12 V6（预写停用是否生效、落盘目录怎么拿）、§14 一条风险、§11 的 K6 新增一条出网登记 |
| v0.9 | 2026-10-02 | HUB-Q10=A：本期只发自写专家，7.2 里「开源子代理集合」那一行改为本期不收 |
| v1.0 | 2026-10-02 | HUB-Q11=A，四处细节按建议定。新增 4.7（策略开关、部署环境变量、离线包、白名单），改了 4.6「不出网时」、§11（策略包字段）、§13（H6）、§14（离线环境吊销滞后）。**HUB-Q 全部确认**，下一步回写总纲 |
| v1.1 | 2026-10-02 | 回写总纲（v0.13）、05、11、CLAUDE.md §8、README §4（HF1–HF9 → F34–F42；后订正为 F36–F44，见 v1.5）。HUB-Q 保留自己的编号（同 CU-Q），不占 Q 号；§11 改为回写记录 |
| v1.2 | 2026-10-02 | §9 第 2 条（以及 05 §3.2）补一句：滤掉的是通道，不是内容；curated 内容经 Hub 收编或由用户自行安装 |
| v1.3 | 2026-10-02 | §3 写明 Hub 的形态：静态目录，类似 apt / rpm 仓库，没有 Web 界面，仓库是源头、CDN 目录是产物。`evowork-hub` 仓库已创建（公开），新增 7.5 写它的约束 |
| v1.4 | 2026-10-02 | H0 / H1 客户端实现（§13.1）；§12.1 记 V1 / V3 / V5 / V6 的结果；9.1 第 2 条与 §14 按 V6 订正（预写停用无效，改为装完立刻停用，空窗如实登记） |
| v1.5 | 2026-10-02 | H6 的客户端与管理端（策略包开关、离线包、白名单）；HF1–HF9 改登记为 F36–F44（原号与已有的 F34 / F35 撞了），F39–F43 与 F45 进漂移雷达；§12.1 补上在打补丁内核上的复测 |
