# 项目状态

> 截至 2026-08-31。档三（UI 本体：Inbox / 时间线 / 审批卡 / 产物区 / 成本）
> 已落地。本次 `./scripts/ci.sh` 全段绿。
>
> 这份文档记录**当前真实状态**与**未做事项**。它的编写前提是：
> 「结构写好了」不等于「接通了」，「测试绿了」不等于「检查有效」。
> 下面每一条未做项都标注了**它今天会怎么坏**，而不只是「还没做」。
>
> **2026-08-30 增补**：路线已按「优先看到 UI」重排，见 §三。那一节**只改顺序**——
> §四 的优先级判据、条目编号与每一条的措辞一概不动。
>
> **2026-09-01 增补**：`apps/ui/src-tauri` 在这台 Mac 上**第一次被编译**，并打出了
> `.app` 与未签名的 `.dmg`。§二 那条「从未编译过」作废；§四 P6 打包一行的四个缺口
> 逐条重写（两条消掉、两条仍在），另有**三条本次新发现**，其中最要紧的一条升为
> **P0-17**——产物连不上 daemon（**同日修完**，改法与验到哪一步见该条）。打包本身**没有**改动任何构建配置：用 `pnpm dlx` 临时拉
> CLI 做的，`package.json` / `pnpm-lock.yaml` / `Cargo.lock` 一个都没动。随后按 P2 #14
> 补了 `apps/ui/src-tauri/.gitignore` 的 `/gen/schemas`（第一道防线，CI-10 那半仍未做）。

---

## 一、已完成

### 里程碑

| | 内容 | 合并点 |
|---|---|---|
| M1 阶段 0+1 | 13 crate 工作区、事件协议、Run Log 与内容寻址 blob 存储、确定性内核（reduce/decide/fold）、上下文装配、策略钩子、工作区隔离与 Linux 沙箱的本地执行、带版本价格表的模型适配器、网关六步流水线、daemon turn 循环、带检查点自校验的回放器 | `72a2499` |
| M1 桌面外壳 | `apps/ui` 的外壳无关平台接口、浏览器与 Tauri 2 两套实现、`daemonClient`、最小 Tauri 能力授权、前端接入 ci.sh | `0d4c982` |
| M2 治理面 | 治理事件目录、内核的挂起/恢复/审批/预算语义、挂起与拒绝从 `Err` 改为 Log 事件、网关审批材料与 dry-run 三级降级、`shell.exec` 接入沙箱、**污点与预算两道闸门接通** | `8c089d3` |

### M2 全分支终审

三个维度并行终审，查出 **11 条阻断，全部关闭**：

| 类别 | 内容 |
|---|---|
| 红线破口 | 被网关拒绝的 effect 一次 `resume` 就会被真的执行；快照未验自身哈希即被信任，且 `resume` 用它驱动真实执行 |
| 工作区逃逸 | 硬链接写出工作区；工作区根本身可创建到 base 之外 |
| 事实断链 | 无终结事件的 run 被报成 `Completed`；非网关故障从不落 `run.failed` |
| 死检查 | CI-3 把 `evo-exec-local` 从四条检查里全免；eval 钉住的哈希对 Agent 实际做了什么不敏感 |
| 不通电 | 污点闸门恒 `false`；预算闸门第⑤步不存在 |

### CI 检查清单实现情况

设计文档 00 §4 列了 10 条，已实现 8 条。

| # | 检查 | 状态 |
|---|---|---|
| 1 | 内核依赖隔离 | ✅ |
| 2 | 回放自校验 | ✅ |
| 3 | 治理旁路 | ✅ |
| 4 | 客户名词隔离 | ✅ |
| 5 | 协议同步（ts-rs ↔ `packages/protocol`） | ✅ |
| 6 | vendor 未被修改 | ❌ `crates/evo-exec-local/vendor/` 目前只有 README，无内容可校 |
| 7 | 上游依赖闭包 | ⚠️ **`scripts/codex-closure.py` 已写好，但没有任何脚本调用它，也没有基线文件** |
| 8 | 快照可丢弃 | ✅ |
| 9 | 外壳不渗进业务代码 | ✅ |
| 10 | 构建产物/依赖目录未被跟踪 | ✅（扫描面漏掉 `apps/ui/src-tauri/gen/`，见 P2 #14） |

另有非编号段：`fmt`、`fmt (src-tauri)`、前端构建与类型检查、产物纯净性、`clippy`、`test`。

---

## 二、开发与交付环境（2026-08-30 核实，2026-09-01 复核并增补打包两行）

之前多份文档——包括本文 §四 P6 的 CI-6 一行，以及
`docs/superpowers/notes/2026-08-29-tauri-linux-probe.md`、
`docs/superpowers/notes/2026-08-29-desktop-shell-status.md` 整篇——都建立在
「开发机是 Linux」这个前提上。**这个前提已经不成立。** 本次逐条实测：

| 项 | 实测结果 |
|---|---|
| 机器 | macOS 26.6.2 / Apple Silicon |
| 前端工具链 | node 24.19、pnpm 11.24，`apps/ui/node_modules` 已安装 |
| Rust 主 workspace | **已在这台 Mac 上编译过**——`target/debug/` 下有 `evo-cli`、`mkcase` |
| `apps/ui/src-tauri` | **已编译**（2026-09-01 首次）：`cargo check --locked` exit 0、零 warning、零改动。08-30 那条「那约 200 行 Rust 至今没有被任何编译器看过一次」自此作废。连 Cargo.toml 里预告「最可能需要小修」的 `MacosLauncher::LaunchAgent` 签名也原样通过 |
| `src-tauri/Cargo.lock` | 已是跨平台解析（`objc2`/`wry`/`gtk` 同时在内，`tauri` 钉 2.11.5）。**2026-09-01 首次 Mac 构建没有改动它**（`--locked` 通过），因此不存在需要一并提交的锁文件漂移 |
| 打包产物 | **已打出**（2026-09-01）：`apps/ui/src-tauri/target/release/bundle/` 下 `macos/evowork.app` 与 `dmg/evowork_0.1.0_aarch64.dmg`（3.2 MB）。dmg 内容正确（`evowork.app` + `Applications` 符号链接）。**未签名**：只有 linker 给的 adhoc 签名（`codesign -dv` 显示 `adhoc,linker-signed`、`TeamIdentifier=not set`），`spctl -a` 评估不通过。**本机双击能打开**（已实测：窗口起来了，进程没崩）——因为本地产物没有 quarantine 标记；一旦经下载/传输带上 quarantine 交到客户机器，弹的就是 POC 4.10② 要避免的那个「无法验证开发者」框。**仅 arm64** |
| 签名身份 | `security find-identity -v -p codesigning` → **0 valid identities**（2026-09-01 复核仍是 0）。Apple Developer Program 组织账号仍未申请。`xcrun notarytool` 本机有（CLT 自带），缺的只有证书与 `APPLE_*` 凭据 |
| 浏览器入口 | `dist/` 起静态服务、Chrome headless 截图确认可打开。当时页面是探针页；档三之后主界面是 Inbox / 时间线 / 审批 / 产物 / 成本 |

两条直接后果：

1. **CI-6 的推迟理由失效了。** 「开发机是 Linux 所以 macOS seatbelt 子集无法 vendor 与实测」
   这句话现在为假——机器就是 macOS。它从「结构性做不到」变成「还没排期」，见 §四 P6。
2. **`src-tauri` 那条「未验」已消掉（2026-09-01）。** 它当时被判为「唯一挡在 `.app`/`.dmg`
   之前的自有工作」，这个判断偏乐观了一点——编译与打包都一次通过，但打通之后露出了
   三条原先看不见的缺口（§四 P6 打包一行的⑤⑥⑦），其中 ⑦ 不是打包问题而是产品问题，
   已升为 **P0-17：打出来的产物连不上 daemon**（当天已修，见该条）。
   现在挡在「可交付的 dmg」之前的是两类：签名公证（等 Apple 账号）＋ 那三条。

---

## 三、当前路线：UI 优先（2026-08-30 决定）

> **决定**：把「能看见界面」提到协议层之后的第一顺位，**早于**真 DeepSeek adapter 与用友 MCP
> Server。理由是产品形态需要先被看见——客户已明确桌面客户端形态是验收条件（POC 4.10②），
> 而今天能打开的只有一个探针页。
>
> **这一节只改顺序，不改判据。** §四 的优先级判据原样成立；下面挑出来的条目全部是
> **因为 UI 会把它们变成用户可见的错误**才提前，不是因为它们的性质变了。**P0 四条一条都没有下沉。**
>
> **这个顺序的代价，先写在这里**：UI 先于真 adapter 意味着界面上跑的仍是 fixture 模型——
> 演示时它展示的是**形态**，不是**能力**。这是可以接受的（形态本身就是验收条件），但
> 对外说明时不能把两者混为一谈。

### 今天的界面是什么

`apps/ui` 的主页面是 `src/App.tsx`：左侧 Inbox（澄清卡 + **全部**未决审批卡 + 预算提额卡）与
任务列表，右侧选中 run 的时间线 / 审批 / 产物 / 成本。时间线可筛治理事件与检查点。底部 status bar 仍是
platform 与 daemon 连接探针。UI 经 `subscribeAll` 吃事件流，状态是 `applyEvent`
的折叠结果，不轮询。没起 daemon 或没带 token 时 Inbox 为空、status bar 为
`not connected`——这还是预期。

### 档一：硬前置（已落地）

**协议层**（§四 P6 第 1 项）四件事都已接通：

1. **`evo-daemon` 二进制**：`cargo run -p evo-daemon` 起常驻进程（默认 `127.0.0.1:4477`）。首次启动把共享 token 写进 `{data_dir}/client.toml`（默认 `~/.evowork/client.toml`）。
2. **HTTP `POST /v1/rpc`**：实现 `run.create` / `run.get` / `run.list` / `run.events` / `run.resume` / `approval.decide` / `clarification.answer` / `blob.get` / `cost.query` / `tool.list` / `tool.manifest` / `policy.get`。06 §3 其余方法返回 `not implemented`（`-32601`）。`GET /v1/hello` 做版本协商。认证是 `Authorization: Bearer`。
3. **WS `/v1/events?token=`**：`subscribe` / `subscribe_all`，`from_seq` 续订，积压回放后 `caught_up`，随后实时推送。事件体就是 Log 里的 `Event`，不另做 DTO。
4. **`packages/protocol`**：`ts-rs` 从 `evo-protocol` 生成，CI-5（`scripts/check-protocol-sync.sh`）比对生成物与已提交内容。手写的 `apps/ui/src/daemon/types.ts` 已删除，`daemonClient` 改从 `@evowork/protocol` 取类型。

同期修了 **P0-16**（`subscribe()` 重连风暴）：指数退避（200ms 起，封顶 10s）+ 20 次上限。

探针接上跑着的 daemon 之后，`hello()` 不再是必然的 `(Failed to fetch)`——要的是 `~/.evowork/client.toml` 里的 token（或 `VITE_DAEMON_TOKEN`）。没起 daemon 时 status bar 仍显示 not connected，这还是预期。

### 档二：界面每一块各自的接线（已落地）

下面四条接线外加「多条待审批并列」已接通，档三把它们画成了界面。
接通的意思仍是：产生方、reduce/读者、以及一条在未修代码上会红的行为测试
都在。预算提额与回放/审计（含人工驳回、等审批的 checkpoint）是档二表里
原先标「收尾」的两项，现已接通。

| 界面区块 | 接线 | 仍缺的（档三 / 收尾） |
|---|---|---|
| 决策 Inbox / 澄清卡 | `AskClarification` 携带 `PlannedClarification`；模型请求 messages 与装配器同源（P0-1）；`option_id` 不在选项里则拒写事件 | **卡片 UI 已做**。选项文案经 `blob.get` 取 `prompt_ref` |
| 审批卡 | `ImpactPrecision::Unknown`：无 preview 且 0 个 target 时不再发 `DeclaredOnly` + 空清单 | **卡片 UI 已做**。Unknown 画成「影响未知」，不画成「无影响」，也不发明沙箱/白名单句 |
| 多条待审批并列 | `reduce` 不再 `.expect()`；`resume` 在台账非空时不写 `run.resumed` | **列出全部未决**：Inbox 与 run 面板都按 `pending_approvals` 全量渲染，不看 `awaiting` 那一个 |
| 产物区（预览 / diff） | 成功的 `fs.write` 发 `artifact.emitted`；`reduce` 折进 `RunState::artifacts` | **预览 / diff UI 已做**。正文经 `blob.get`；有 `supersedes` 时做行 diff |
| 成本视图 | 已执行的工具可按 `[[tool]]` 出账；执行器 `cost_micros` 优先于表。生产表仍不定价本地工具 | **成本 UI 已做**。折叠 `cost.charged`，不轮询 `cost.query` |
| 预算提额 | RPC `budget.amend` → `Runtime::amend_budget` → `budget.amended`；挂在预算上则续跑。Inbox 与 run 面板在 `budget_exhausted` 时画提额卡 | 子 run 预算与 ⑤ 的预扣半边仍未做（P5） |
| 回放 / 审计视图 | 等审批与人工驳回都会先写 `checkpoint`（`PreApproval`），`verify` 不再 VACUOUS。时间线可筛治理事件 / 检查点 | 审批卡「已过期」已做（P0-4） |

### 档三：这次明确推迟的

§四 的 **P1 全部十条**（结构收口）、**P2 的 11 / 13 / 14 / 15**、**P3 除审批卡那行外的九处**
注释订正，以及 P5 的沙箱 / 污点 / `replay.rs` 三组——UI 一行都不碰它们。

**推迟不是取消，代价记在这里**：P1 那批的共同形状是「今天不出错，只差一次顺手的编辑」，
而接下来几周恰恰会有大量顺手的编辑发生在 daemon 与 gateway 上。其中两条成本低到不该排队，
建议随手做掉：**P1-7**（`admit_with_preview` 改成关联函数，**一行**）与
**P1-8**（`config/policy.toml` 末尾加一条兜底 deny，**一条规则**）。

**两条 P0 此前不因 UI 优先而下沉，现已修**：P0-3（沙箱超时与 stdout 上限）与 P0-4（审批过期）。P0-4 修完后界面上的「已过期」状态一并落地，不必为此返工。

### 顺序

1. **档一（已落地）**：daemon 二进制 + 两个入口 + `packages/protocol`（含 CI-5）+ P0-16 重连退避
2. **档二（已落地）**：Inbox / 审批卡 / 产物区 / 成本四条接线 + 多条待审批并列 + 预算提额入口 + 人工驳回/等审批的 checkpoint 与审计筛选。
3. **UI 本体（已落地）**：Inbox → 时间线 → 审批卡 → 产物区 → 成本
4. **收尾（已落地）**：预算提额入口、人工驳回路径的 checkpoint、P0-4「已过期」状态

一条独立于以上四步、随时可插的：**在 macOS 上第一次编译 `src-tauri`**（见 §二）。
它不依赖任何一步，却能消掉「那 200 行 Rust 从没被编译器看过」这个最大的单点未知。
**2026-09-01 已做**，并顺带把 `.app` 与未签名 `.dmg` 一起打了出来。该未知消掉了；
它换来的三条新缺口见 §四 P6 打包一行与 P0-17。

---

## 四、未做事项（按优先级）

优先级判据：**能不能在演示现场变成事故** > **防线是否靠纪律而非机制** > **检查能不能发现问题** > **文档是否与代码一致** > **尚未开始的功能**。

条目编号（1–16）按**新增顺序**追加，**不随优先级重排**——重排会让所有既有引用失效，
理由与 `event_body!` 的「只增不改」同源。所以新补的第 16 条排在 P0 末尾而不是插进中间。

---

### P0 — 会在演示现场变成事故

#### 1. 澄清答案从未进入模型请求（**已修**，UI 档二同交）

此前 `call_model` 构造的 `ModelRequest.messages` 是一条空的 user 消息。
整条链路（答案 → blob → 装配 → `context.assembled`）是通的，模型收到的始终是空。

**现况**：messages 与装配器同一批来源、同一顺序（intent、已回答澄清摘要、
工具返回）。行为测试断的是第二次 `model.requested` 的 blob 里含被选中选项
文案与自由文本，不是 `context.assembled.blocks`。`AskClarification` 携带
`PlannedClarification`；非法 `option_id` 拒写事件。

#### 2. Effect 完全不出账（**已修**，UI 档二同交）

此前 `pricing.toml` 只给模型定价，`CostCharged` 全仓只有 `call_model` 一个产生点，
`EffectOutcome` 没有任何成本字段。

**现况**：已执行的工具（Ok / Error，不是 Denied / DryRun）可以出账。执行器
`cost_micros` 优先；否则查 `[[tool]]` 的 `call_micros`。未定价不让 run 失败。
生产 `config/pricing.toml` **没有**给本地工具编单价——测试用测试表给
`fs.write` 定价，断言 `budget_used` 含那一笔。

#### 3. 沙箱无超时、stdout 无上限（**已修**）

此前 `sandbox.rs` 的 `cmd.output().await` 无界。`Lease.expires_at_ms` 有人写、**零读者**。一条 `sh -c 'sleep infinity'` 就是 daemon 永久挂死。stdout 无上限，随后 `from_utf8_lossy` + `json!` + `to_vec` 同一份数据在内存里三份，实测捕获过 100MB。

**现况**：执行面用 `expires_at_ms - issued_at_ms` 得到剩余窗口（不读墙钟），封顶 60s；剩余 0 不 spawn。stdout/stderr 各自 1MiB 上限，触顶杀进程组（含 `sh -c` 的孙子）。行为测试断的是 `sleep` 在租约窗口内被杀掉、已过期租约不 spawn、2MiB 输出带 `truncated: true` 且不超过上限。

#### 4. 审批永不过期（**已修**）

此前 `ApprovalRequested.expires_at_ms` 被写入，**全仓无人读取**。`approval.expired` 零产生者，`reduce` 里对应的处理分支是死代码。一条 L3 审批 30 天后被人点开链接批准，`decide_approval` 照收，`resume` 照派发。

**现况**：`resume` 与 `decide_approval` 在动作前对照 daemon `Clock` 扫过期，过期落 `approval.expired`（不写 granted/denied），`reduce` 把 effect 标成 `Denied`，不派发。UI 在墙钟已过截止时画「已过期」并禁用批准/驳回，不等那条事件。比对用 daemon 时钟而不是内核 `clock_ms`（挂起期间内核时钟冻结）。

#### 16. `daemonClient.subscribe()` 的重连是一场风暴（**已修**，UI 档一同交）

> 本条 2026-08-30 随「UI 优先」补入，同日在档一落地时修掉。

此前 `ws.onclose` 直接重连，无退避、无重试上限。对着拒绝连接的 daemon 实测约 50 毫秒内 40 次（约 800 次/秒），无限持续，且每个 `subscribe()` 独立计数。

**现况**：指数退避（200ms 起、封顶 10s）+ 20 次上限；`unsubscribe()` 取消已排队的重连。只按实际收到的 `event` 帧推进 `from_seq`（`caught_up` 不再误推进）。前端测试覆盖退避加倍、触顶停连、unsubscribe 不重连。

#### 17. 打包出来的桌面产物连不上 daemon（**已修，2026-09-01**；剩一条未验）

> 本条 2026-09-01 随「第一次在 macOS 上打出 `.app`/`.dmg`」发现（§二、§四 P6 ⑦），
> 当天修完。排 P0 的理由是「判据的第一条就是能不能在演示现场变成事故」：
> 客户双击拿到的是一个永远空着的窗口。

**当天的复现（三条，都是实测）**：

1. 4477 上没有进程在听 → `lsof -nP -iTCP:4477 -sTCP:LISTEN` 空，UI status bar
   报 `(Load failed)`——那是 WebKit 的网络层失败文案，不是 401。
2. 起了 daemon 也连不上：产物里烧进去的是空 token。
   `evo-daemon --token demo-token-abc` 起着时，`Authorization: Bearer `（空）
   → **401**；带对的 token → **200** `{"op":"hello","protocol_ver":"1.0",…}`。
3. 界面里没有任何填 URL / token 的入口，装完之后没有补救手段。

另外顺手量到两条：daemon 只听 IPv4（`http://[::1]:4477` 直接 refused，而 UI 连的是
`localhost`），以及那句提示 `（VITE_DAEMON_TOKEN 或 client.toml）` 在说谎——
全仓没有任何一行 UI 代码读过 `client.toml`，只有 daemon 在写它。

**选的是第 2 条修法（界面加设置入口 + 读 client.toml）**，不是 sidecar。理由：
改动小得多，且不必把「拉起一个业务进程」塞进外壳的生命周期
（`src-tauri/src/main.rs` 的「零业务逻辑」不用重新界定）。代价照旧：
客户仍要自己先起一个 daemon 进程——这条**没有**被这次修复消掉。

落地：

| 位置 | 做了什么 |
|---|---|
| `apps/ui/src/daemon/config.ts`（新） | 设置解析，纯逻辑无 IO。四个来源按 `saved` → `build-time` → `client-toml` → 默认 取先命中；url/token **成对**取，不跨来源拼字段 |
| `apps/ui/src/workspace/DaemonSettings.tsx`（新） | 设置面板。未连接时**强制展开**在主区域第一块，连上后收进 header 的「设置」按钮 |
| `Platform` 第 6 个方法 `readClientToml` | 读 `~/.evowork/client.toml`。桌面走 fs 插件，浏览器 `supports()` 报 false 且调用即抛 |
| `capabilities/default.json` | 新增 `fs:allow-read-text-file`，**带一条只含单个文件名的 command scope** |
| `scripts/verify-tauri-permissions.sh` | 认识带 scope 的对象形 permission（旧版会把它打成 `[object Object]`，报一条指错地方的 FAIL） |
| `StatusBar` | 能力清单加了编译期穷尽检查，漏一个 `Platform` 方法直接编译不过 |

默认 URL 从 `http://localhost:4477` 改成 `http://127.0.0.1:4477`，对应上面量到的
IPv4-only。那句说谎的提示改成了指向设置面板。

**Platform 的 5 方法上限被突破成 6，这是有意的**，理由写在
`platform/index.ts` 的注释里：读固定路径的文件是原生能力，浏览器结构上做不到，
它就该在这个接口后面。没有为了让「5」这个数字看着还成立而另开一个
`platform/clientToml.ts`——那样只会让注释里的 5 名义上为真，同时把外壳替换时
要重写的适配器从一个变成两个，而这正是这条上限要保护的性质。

**验到哪一步**：

- ✅ 131 条前端测试通过（原 96）。新增的行为测试在**未修**代码上会红：把
  `buildTimeConfig()` 恢复成旧的「无条件返回一对设置」，12 条里 3 条变红，
  其中包括「桌面上零操作从 client.toml 取到 token」那条。
- ✅ 四条新增/改动的检查都构造过违规输入实测变红再复绿：scope 被简化成裸字符串
  （capabilities 测试红）、授权被删（红）、加一条带 scope 的孤儿授权（红——**这个形状在改动前是看不见的**，因为断言拿对象和字符串比）、
  `StatusBar` 的能力清单漏一项（`tsc` 报 `Type '"readClientToml"' does not satisfy the constraint 'never'`）。
  `verify-tauri-permissions.sh` 也验了两种：对象形里放错标识符、以及既不是字符串也没有
  `identifier` 的元素——都 exit 1。
- ⚠️ **真机 IPC 往返：有间接证据，没有直接确认。** 修完后重新打了 `.app`
  （Rust 侧 `--locked` 通过，`Cargo.lock` / `package.json` 一个没动），在
  `~/.evowork/client.toml` 里放好 token 后双击运行，观察到
  `lsof -nP -iTCP:4477` 出现**两条 ESTABLISHED**——来自
  `com.apple.WebKit.Networking`（不是 app 进程本身，这一点第一次查漏了）。
  客户端只在 `hello()` resolve 之后才调 `subscribeAll` 开 WS，所以「有一条稳定的
  WS 挂着」与「401」是互斥的：这基本等于说 scope 生效、token 读到了、`hello` 回了 200。
  **但没有拿到直接确认**：原计划用一个记录 `Authorization` 头的探针来看清它到底发了
  什么，那一步没做完；也没能截到界面（本机 `screencapture` 没有屏幕录制权限）。
  scope 本身仍只有静态核对（标识符对着 `tauri-plugin-fs` 2.5.1 的
  `permissions/*.toml`、路径对着测试）。
  **要补的一步**：把 `client.toml` 的 `url` 指向一个记录请求头的端口，跑一次
  `.app`，确认 `GET /v1/hello` 带的是 `Bearer <client.toml 里那串>`。

**仍然没做**：外壳不带 daemon。客户机器上要么自己起一个 `evo-daemon`，
要么把 daemon 做成 sidecar（当时的第 1 条修法，未采纳，未排期）。
这条 dmg 现在能证明「打开之后有东西」的前提是「本机已经有一个 daemon 在跑」。


### P1 — 防线靠纪律而非机制

这一类今天都不出错，但都只差一次「顺手的编辑」就会破。本项目已验证的经验是：**能让错误写不出来的结构，优于要求人记住的纪律**（`tighten()` 就是这么来的）。

#### 5. `WorkspaceHandle::new` 是 `pub`

整条工作区边界建立在「每个 handle 都来自 `ensure`」上，而支撑这个前提的**只是「目前恰好只有一个调用点」，不是类型系统**。封口要改 `evo-exec`。

#### 6. `Executor` trait 层没有污点约束

污点判定表住在 `evo-exec-local` 里。第二个 executor（MCP）返回 `Clean` 没有任何东西拦得住，而污点闸门刚刚成为提示注入的唯一结构性防线。

#### 7. `PendingAdmit` 的「不许重新求值」只有注释挡着

`crates/evo-gateway/src/pipeline.rs:331` 的 `admit_with_preview(&self, ...)` 收了 `&self` 却一次都没用，而 `self.policy`/`self.manifests` 就在作用域里。**修法是一行**：改成关联函数 `pub fn admit_with_preview(pending: PendingAdmit, ...)`，重新求值即成编译错误。

#### 8. 无规则命中 = Allow，且 `config/policy.toml` 没有兜底 deny

`crates/evo-policy/src/hardcoded.rs:169`。一个 class=compute 的新工具会走到这条 Allow 上，且因 manifest 存在也不触发 L3 闸门，直接派发。加一条末尾兜底 deny 即可。

#### 9. 内核确定性 lint 只装在 `evo-kernel` 一个 crate 上

根 `Cargo.toml:36-37` 把 `disallowed_methods`/`disallowed_types` 设为 `allow`，`evo-kernel` 单独覆盖成 `deny`，而 `evo-protocol` 用 `[lints] workspace = true` 继承的是 allow。

**已实测**：同一段 `SystemTime::now()` 塞进 `evo-kernel` 报 3 个 error，塞进 `evo-protocol` 全 workspace 零告警。而 `BudgetSpec::default()` 这类内核天天在用的构造就住在 protocol 里。

#### 10. 六步流水线的①②两步在生产配置下形同虚设

- ①身份解析：`CapabilityToken.subject` 全仓**从不被读取**，`admit()` 里没有一行涉及 principal。不是弱实现，是不存在。
- ②能力校验：`allows()` 本身是对的且有真会红的测试，但 daemon 的两个构造点都写死 `scopes: vec!["*"]`，`allows` 对 `"*"` 无条件放行。

---

### P2 — 检查发现不了问题

#### 11. CI-7 的脚本存在但从没被跑过

`scripts/codex-closure.py` 写好了、docstring 写明「每次升级上游 rev 后重跑，与基线比对」，但**没有任何脚本调用它，也没有基线文件**。

#### 12. eval 用例里一个治理事件都没有（UI 档二：回放 / 审计视图的配套检查）

`eval/cases/synthetic-01/case.yaml` 是 `run.created … run.completed`，无审批/澄清/挂起/驳回。`casegen.rs` 也无法在 case.yaml 里表达「批准/驳回/回答」。

**后果**：CI-2/CI-8 那套三路回放哈希比对（唯一真正消费 snapshots 表的检查）**完全不覆盖 M2 新增的四条治理路径**。终审手工验过这些路径当前可回放，但这条检查一天不覆盖它们，下一次改 `reduce` 时就没有东西挡着。

#### 13. `expect.artifacts` 断言对内容无感

已实现「文件必须存在」，所以改目标文件名会红。但**改文件内容仍然全绿**——存在性断言对内容按定义无感。要堵只能钉**强制**的内容摘要（做成可选的话立刻又是一条「删掉钉子等于关掉检查」）。

相关：多余产物无人管；多条 artifacts 里删掉其中一条（列表仍非空）静默失效；「哪些 case 必须存在」本身没钉子。

#### 14. 几条检查的扫描面不足

| 检查 | 缺口 |
|---|---|
| CI-4 客户名词 | 只扫 `crates/ apps/`。`config/` 与 `eval/` 都是随产品走的文件，已实测把 `用友` 写进 `config/tools.toml` 全绿 |
| CI-1 内核依赖 | 只看 `--edges normal`。给 evo-kernel 加 `[dev-dependencies] chrono` 全绿（影响有限：`--all-targets` 的 clippy 会拦住测试里读时钟） |
| CI-3 治理旁路 | 剩下的绕法全在「不经过 Cargo.toml」这一维：`evo-daemon` 的 `pub use evo_runlog::RunLog` 再导出（这条边界实际靠的是 evo-daemon 的 API 表面），以及 `#[path]`/`include!` |
| CI-10 构建产物 | 名字白名单只有 `node_modules` / `target` / `dist` / `.pnpm` 四个，**不含 `gen`**。2026-09-01 首次构建 `src-tauri` 后新出现 `apps/ui/src-tauri/gen/schemas/*.json`（Tauri codegen 产物），当时也没有任何 `.gitignore` 覆盖它——**两道防线同时漏**（`.gitignore` 是第一道、CI-10 是最后一道，见 ci.sh 里那段注释）。**已实测**：把这 4 个文件 `git add` 之后跑真实 `./scripts/ci.sh`，CI-10 照样打印 `ok`。第一道**已补**：`apps/ui/src-tauri/.gitignore` 加了 `/gen/schemas`（窄化到 `schemas` 而不是整个 `/gen`，因为 Tauri 移动端的 `gen/android`、`gen/apple` 是**该**进版本库的）。**最后一道仍漏**：CI-10 白名单补 `gen` 这半没做——按「新增的检查必须被证明能失败」，它要先构造反例实测会红 |

#### 15. 三条缺失或无效的测试

- **「内核不读 `recorded_at`」没有任何测试。**`reduce` 确实一次都没碰它，但没有一条测试喂两份只有 `recorded_at` 不同的事件流去断哈希相同。有人在 `reduce` 里加一句解时间的代码，全套测试 + eval 全绿。
- **「map 顺序不影响哈希」是抛硬币。**`hash.rs:43-52` 用两个 2 元素 map 断言哈希相同。实测同进程内建两个 2 元素 `HashMap`，6 次里有 2 次迭代顺序相同——真改成 HashMap，这条测试约三分之一概率照样绿，而 `state_hash` 已经跨进程不稳定了。
- **`loop_iteration_limit` 没有测试**（要 10000 次空转才触发）。它与已被测试的 `turn_limit` 共享代码形状与 helper。

---

### P3 — 声明强于代码（订正文档与注释）

M2 终审在这条分支上数出**十处**「注释宣称了一件代码不做的事」，八处已随修复订正。剩余：

| 位置 | 宣称 | 实际 |
|---|---|---|
| `sandbox.rs:6` | 「工作区级隔离 + 强制走 proxy」 | 两半都不成立。`1d4f111` 改的是它下面的正文，标题句原样留着 |
| `sandbox.rs:14-16` | 「行为语义与 seatbelt 版一致（同一张隔离矩阵，05 §3）」 | 与它上面两行刚加的「这三类问题在 Linux 上都没有被挡住」直接矛盾。05 §3 五行矩阵里「文件写仅工作区」「网络全部经 proxy」「敏感目录硬拦截」三行现在都不成立 |
| `sandbox.rs:36-41` | 白名单的口子「需要模型先调一层解释器」 | **不需要**。`cat`/`cp`/`mv`/`mkdir`/`find` 全在名单里且全接绝对路径，已实测直接读出工作区外文件 |
| `workspace.rs:5-13` | `SENSITIVE_PREFIXES` 是 05 §3「敏感目录硬拦截」的落地 | 挡的是**工作区里的** `.ssh`（每 run 新建的空目录），不是用户的 `~/.ssh`。且大小写敏感，`.SSH` 一次 shift 绕过 |
| `evo-exec/lib.rs:109-111` | 「比对代码现在就写」 | 不存在，一行都没有。且 `shell.exec` 的 `actual_targets` 是 `declared_targets` 的副本，比对恒相等 |
| `executor.rs:157-161` | `actual_egress`（实际出口） | 填的是 manifest 声明的出口。而本分支已实测 curl 不走 proxy——写进 Run Log 的是一条比事实强的审计记录 |
| `executor.rs:184` | `has_network: false` | `shell.exec` 经 `sh -c curl` 有网络（实测 200） |
| `lifecycle.rs:97-99` | `from_seq`「回放时用它核对恢复点」 | `reduce`/`replay`/`verify` 都不读 |
| `pipeline.rs:38-43` | `impact_ref` 走 blob 是「按红线①」 | 01 §3 表格明确把「目标资源标识」列在可进 payload 那一列，且同一个值已作为 `impact.estimated` 完整落盘。理由写错了，blob 是重复存储 |
| `02-effect-gateway.md` + `impact.rs` | 审批卡文案「将在沙箱工作区内执行，出口受白名单约束」 | **源头已订正**（档二）：第 3 级现在是 `unknown`，注释明确两半都不成立。UI 做审批卡时仍不能发明这句 |

---

### P4 — 写了没接线的字段与死代码

这些今天都不产生错误结果，但都属于「看起来对、从没被执行过」。**新增任何一条前，先确认它有读者。**

| 位置 | 情况 |
|---|---|
| `EgressPolicy::permits()` + `DaemonConfig.egress_allow` | 唯一调用者是它自己的单元测试。没有 proxy 进程，`proxy_addr: None` |
| `ExecutorCapabilities` | 零消费者。一个 class=External 的 effect 会被派到自称做不了 External 的 executor 上 |
| `PolicyContext.taint` / `.targets` | 老实填了，但 `Rule` 只有 class/tool/reversible 三个条件字段，`matches` 完全不看这两个。今天写不出「对某目录的写要审批」这类规则 |
| `Lease.expires_at_ms` | **已接线**（P0-3）：与 `issued_at_ms` 相减得到 spawn 超时，封顶 60s |
| `BudgetSpec.max_concurrency` / `max_recursion_depth` | 零读取方 |
| `Command::AskClarification` | **已接线**（档二）：携带 `PlannedClarification`，与 `RequestEffect` 的 `call` 对称。Clarify 却没给 clarification → `Complete { Failed }` |
| `reduce` 忽略 `ContextCompacted` | 今天无产生方，尚不构成投影缺口 |
| `ArtifactEmitted` / `RunState::artifacts` | **已接线**（档二）：成功的 `fs.write` 发 `artifact.emitted`，`reduce` `push` 进 `artifacts`。渲染仍是档三 |
| `AwaitReason::Human`、`SuspendReason::Paused`、`CompletionStatus::Partial`、`Checkpoint.snapshot_ref`、`RunState::children`、`RunFailed.at_seq` | 死变体/死字段，均有注释 |
| `reduce.rs:91-93` | 空的 `if e.status == ToolResultStatus::Error {}`，只有注释没有语句 |

---

### P5 — 已知缺陷，暂缓

| 位置 | 内容 |
|---|---|
| `replay.rs` | **解不开**的快照仍报错而非降级。按「快照可丢弃」的同一逻辑它也该降级——现在损坏一个 blob 会让整条 run 无法恢复。修 BL-2 时只堵了信任漏洞 |
| `runtime.rs` | `resume()` 仍能恢复**终态** run。被拒的 run 被 resume 会一路跑到 `run.completed`（effect 保持 denied 不会执行，红线守住了），但「Failed 的 run 能被复活」本身可疑 |
| `runtime.rs` | **【UI 档二，已修】**`answer_clarification` 校验 `option_id` 属于本题选项。拼错的 id 返回错误、不写事件、run 仍挂起 |
| `runtime.rs` | **【UI 档二，已修】**被人驳回 / 尚在等审批的 run 此前一个 checkpoint 都没有，`verify` 报 VACUOUS。现与网关自动 Deny 同构：`AwaitApproval` 与人工驳回都先写 `PreApproval` 检查点 |
| `reduce.rs` + `resume()` | **【UI 档二，已修】**`RunSuspended{AwaitingApproval}` 不再 `.expect()`；台账空则 `awaiting` 为 None。`resume` 在 `pending_approvals` 非空时不写 `run.resumed` |
| `pipeline.rs` | dry-run 的 `mode` 没有持久化，审批往返后必然降级成 Live。今天不爆是因为 `ExecutionMode::DryRun` 在生产代码里零构造点 |
| `impact.rs` | **【UI 档二，已修】**无 preview 且 0 个 target 时发 `ImpactPrecision::Unknown`，不再是 `DeclaredOnly` + 空清单 |
| `decide.rs` | 模型侧无预扣：token 数要等响应才知道，真预扣需要「预留→结算/释放」事件加失败对账加回放语义 |
| 沙箱 | `spec.env` 只有 PATH 一个键受保护（`LD_PRELOAD`/`BASH_ENV` 原样透传）；`program_allowed` 放行任意路径下的同名程序；resolve 与 write 之间的并发 TOCTOU；工作区内的 bind mount |
| 预算 | **【UI 档二，已修】**提额入口：RPC `budget.amend` + Inbox/run 面板提额卡，走 `budget.amended` 后续跑。子 run 预算未实现；⑤的预扣半边在 daemon 里今天走不到（没有工具声明 `preview`） |
| 污点 | 一级 dry-run 的 preview 输出没有污点判定；模型输出本身不是污点源；`start()` 收裸 `&str`，无法把 intent 声明为不可信——而粘贴进来的外部文本正是首要注入向量；`cites_produced` 恒空 |
| daemon | 崩溃残留的 `Dispatched` effect 只能让 run 失败，无法与执行器实际做了什么对账 |

---

### P6 — 尚未开始的功能

按计划顺序。**顺序已按 §三「UI 优先」重排：UI 本体从第 4 项提到第 2 项，排到真 DeepSeek
adapter 与用友 MCP 之前。** 其余按依赖排。

| 项 | 状态 | 阻塞 |
|---|---|---|
| **协议层**：**daemon 二进制** + HTTP `/v1/rpc` + WS `/v1/events` + `ts-rs` 生成 `packages/protocol` + CI-5 | **已落地**（档一） | `cargo run -p evo-daemon`；token 在 `{data_dir}/client.toml`。未接线的 RPC 方法返回 `not implemented`。`run.create mode=dry_run` 同样未实现 |
| **UI 本体** | **已落地**（档三） | Inbox / 时间线 / 审批卡 / 产物区 / 成本 / 预算提额。事件流投影，不轮询。`blob.get` 取澄清文案与产物正文。`budget.amend` 提额。时间线可筛治理事件与检查点。审批卡含「已过期」（P0-4） |
| **真 DeepSeek adapter** | 未开始 | key 已到位。原「排在协议层之后」→ **现排在 UI 之后**。P0-1 已在档二接通，真 adapter 落地时模型会看见澄清答案 |
| **用友 MCP Server（A-9）** | 未开始 | 账号已到位。原「排在协议层之后」→ **现排在 UI 之后**。它是第二个 executor，落地时 P1-6（`Executor` trait 层没有污点约束）必须一并做 |
| A-13 溯源引用 | 未开始 | 等用友 MCP 接上（`cite` 锚点已在事件里，但没有真实单据可引） |
| A-11 口径库 | 未开始 | 财务的历史成品表未到位。机制与内容一起做，避免机制与真实条目形状对不上 |
| A-10 出口代理子进程 | 未开始 | 属 M3。注意 P4 里的出口 allowlist 死代码在等它 |
| **桌面外壳打包（`.app` / `.dmg`）** | **本机已能打出未签名产物**（2026-09-01 实测，见 §二） | 原四个缺口：**②③ 已消**、**①④ 仍在**；另有 **⑤⑥⑦ 三条本次新发现**。逐条见下表 |
| CI-6 vendor 检查 | 未开始 | `vendor/` 目前为空。原先的理由「开发机是 Linux，macOS seatbelt 子集无法编译与实测」**已失效**——机器就是 macOS（§二）。现在缺的只是排期 |
| 真机跑通 | 未开始 | 装机三前提（Q-31）未确认 |

#### 打包七条缺口逐条（2026-09-01 实测后重写）

复现命令：仓里目前**没有**能打包的命令，本次是
`cd apps/ui && pnpm dlx @tauri-apps/cli@2.11.4 build`（见 ①）。全程 release 编译约 2 分钟。

| # | 缺口 | 状态 |
|:-:|---|---|
| ① | `@tauri-apps/cli` 未安装、`apps/ui/package.json` 无 `tauri` script | **仍在**。`pnpm tauri build` 这条命令依然不存在。本次用 `pnpm dlx @tauri-apps/cli@2.11.4` 绕过——npm 上 latest 是 2.11.4，与 `Cargo.lock` 锁的 `tauri` 2.11.5 混用**没有**报版本告警。修法是加 devDependency + script + `pnpm-lock.yaml` |
| ② | `src-tauri` 从未编译过 | **已消**。`cargo check --locked` exit 0、零 warning、锁文件零改动（§二） |
| ③ | 无 `icon.icns`，Tauri 是否从 PNG 生成 icns 未验证 | **已验证：会生成**。bundler 自己产出 `evowork.icns`（29808 字节）放进 `evowork.app/Contents/Resources/`，不需要预置 `.icns`。**但**那 4 张 PNG 仍是纯色占位，生成出来的就是个纯色方块——图标本身仍缺真实素材 |
| ④ | `identifier` 是占位 `com.evowork.desktop` | **仍在**，且**必须在第一次签名之前**换成组织真实域名（理由见 `tauri.conf.json5` 顶部注释：它牵动 keychain 项与更新/自启插件的键，不是一次 find-and-replace）。已实测这个占位值原样进了产物：`evowork.app/Contents/Info.plist` 的 `CFBundleIdentifier` 就是它 |
| ⑤ | 只装了 `aarch64-apple-darwin` | **新发现**。产物名就写着 `evowork_0.1.0_aarch64.dmg`，`lipo -info` 是 thin arm64——**Intel Mac 打不开**。要 universal 得先 `rustup target add x86_64-apple-darwin`，再按 `universal-apple-darwin` 打。客户机器的芯片是哪种，目前文档里没有记录 |
| ⑥ | `verify-tauri-config.sh` / `verify-tauri-permissions.sh` 没有调用方 | **新发现**。两个脚本都在，`ci.sh` 一个都不跑，等于「写了检查但没有装上」。本次手工跑 permissions：9 条标识符全 ok。注意这是在 `cargo fetch --locked` 之后跑的——在此之前本机没有 plugin 源码缓存（`cargo fetch --offline` 直接报 `no matching package named tauri-plugin-autostart`），脚本会逐条 FAIL 在「registry 缓存里没有该版本」上，而不是真在核对标识符。既然现在本机能编译 src-tauri 了，接进 `ci.sh` 的结构性障碍已消失——但新增/接入检查要先按「必须被证明能失败」造反例 |
| ⑦ | 产物连不上 daemon | **新发现，已升 P0-17，当天已修**（界面加设置入口 + 读 `client.toml`）。这条不是打包问题，是「双击能打开」与「打开之后有东西」之间的差距。剩下的是外壳仍不带 daemon——客户机器上要自己起一个 |

签名与公证仍另等 Apple 账号（§二）。**⑦ 不解决，打包做完了也只是一个能双击的空窗口。**

---

## 五、贯穿性经验

这三条是本项目反复付出代价换来的，写在这里是因为**它们决定了上面每一条该怎么修**。

**其一，检查必须被证明能失败。** 本项目已抓到**七处**「永远不会失败的检查」：grep 语法只覆盖点分写法漏掉混合写法；`verify()` 在无 checkpoint 时空过；`eval/run.sh` 从不读快照且哈希只打印不比较；CI-9 只匹配 `@tauri-apps/api`；`grep -c "tauri-apps" dist/`（压缩产物已去掉 npm scope）；`tsc --noEmit` 缺 `-p`/`-b` 实际编译 0 个文件；CI-3 无条件豁免 `evo-exec-local`。**新增任何检查，必须构造反例实测它会红。**

**其二，测试要断行为，不断中间字段。** 澄清死循环之所以漏掉，是因为测试断了「`pending_question` 被清空」而没断「清空之后 `decide` 真的往前走」。同一个坑还有两个变体：**测试把 bug 当成期望行为编码进去**（daemon 里真的有一条）；**测试切在缺陷的上游**——接通污点闸门时没有任何现有测试变红，因为仅有的三条污点断言都是把 `Tainted` 直接注入 `AdmitRequest`，测的是 bug 上面那一层，永远红不了。

**其三，注释不要宣称代码做不到的事。** M2 终审在一条分支上数出十处。它们的共同形状是：结构先写对、注释先写足、测试断中间字段——三样互相印证，唯独没有一样碰到真实输入边界。
