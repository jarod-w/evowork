# M1 地基实现设计

> 日期：2026-08-29
> 上游契约：[docs/design/](../../design/00-index.md) 全组，尤其 01 / 02 / 03 / 05 / 06 / 08
> 本文回答的是：**这些契约在两周内按什么顺序、以什么实现程度落地。**
>
> 契约本身不在本文重复。本文只写「实现选择」与「M1 的边界」，凡与 `docs/design/` 冲突的以 `docs/design/` 为准。

---

## 零、三条前置事实

开工前已确认，其中两条与既有文档不一致，本文按新事实写：

| # | 事实 | 影响 |
|:-:|---|---|
| 1 | 开发机是 **Linux x86_64**，交付机是 macOS（Q-21） | 05/08 的 seatbelt 沙箱在开发期无法编译与实测。处理见第四节 |
| 2 | 本地 codex checkout HEAD 为 `0ae94fdd`，但文档 pin 的 `c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3` **在本地仓库中存在** | git rev 依赖可直接按文档 pin，无须改 rev |
| 3 | 工具链 rustc / cargo **1.95.0**，edition 2024，已装 clippy + rustfmt + rust-src | 与上游 `rust-toolchain.toml` 一致 |

三条已定的实现边界（本次会话拍板）：

- **沙箱**：接口先行，Linux 侧做工作区级实现，macOS seatbelt 留到能上真机
- **切法**：垂直切片，先跑通一个完整 turn
- **模型**：M1 只用可录制的 `FixtureAdapter`，真 DeepSeek/GPT adapter 属 M2（09）

---

## 一、crate 边界

00 的 13 个 crate，M1 实建 11 个、留空壳 2 个（`evo-memory` / `evo-mcp`）。空壳指有 `Cargo.toml` 与 `lib.rs` 但无实现——**建了才能在依赖图上占住位置**，依赖方向的约束从第一天生效。

| crate | M1 实现程度 | 依赖 |
|---|---|---|
| `evo-protocol` | 24 个事件全集 + Gateway 类型 + RPC 类型 + ts-rs 导出 | — |
| `evo-kernel` | `reduce` / `decide` / `state_hash` 完整 | protocol, serde |
| `evo-runlog` | 四表 + content-addressed blob store + 快照 + 回放器 | protocol |
| `evo-context` | 最小装配：intent 原文包成一个 block，字段齐全 | protocol |
| `evo-policy` | `PolicyHook` trait + 读 TOML 的 `HardcodedPolicy` | protocol |
| `evo-gateway` | 六步管线 + `ImpactEstimator` + manifest + dry-run 三级降级 | protocol, policy |
| `evo-exec` | `Executor` / `Lease` / `WorkspaceHandle` / `Sandbox` trait | protocol |
| `evo-exec-local` | 工作区隔离 + 出口代理子进程 + Linux 沙箱；vendor 目录就位 | exec |
| `evo-model` | `ModelAdapter` trait + `FixtureAdapter` + 定价表 | protocol |
| `evo-daemon` | 唯一组装点；HTTP `/v1/rpc` + WS `/v1/events` | 全部 |
| `evo-cli` | `replay --verify` | protocol, runlog, kernel |
| `evo-memory` | 空壳 | protocol |
| `evo-mcp` | 空壳 | protocol, exec |

### 一处对 00 的偏离：`evo-context` 从 M2 提到 M1

00 把 04（上下文/记忆）标为 M2。但垂直切片必须产出真的 `context.assembled` 事件，否则 01 §4.3 的字段（`cite_id` / `trust` / `taint_level`）在 M1 结束时一次都没被写过，M2 接手时等于从零验证。

替代方案是在 daemon 里塞一个临时装配器——**那就是调用点错位**，违反 00 零章的判据。因此 M1 建 `evo-context` crate，只放最简实现：一个 block，`source = "user_direct"`，`trust = UserDirect`，`taint_level = Clean`。M2 在同一个调用点上换实现。

`evo-memory` 保持空壳（Q-16：建表不启用）。

---

## 二、三个阶段

### 阶段 0 · 依赖可行性验证（半小时，必须先做）

`codex-network-proxy` 用 `=0.3.0-alpha.4` 精确锁定整套 `rama-*`（08 §2）。**在写任何业务代码之前**，建一个最小 crate 拉这条 git rev 依赖并 `cargo build`，确认它在 Linux + rustc 1.95 上能编译。

不通过的话阶段 2 的出口代理形态要改（自己写一个最小 forward proxy，或改用其他实现），越早知道越好。这半小时买的是「不要在第二周才发现要重做」。

同时验证 `codex-execpolicy` 的可编译性（闭包只有 1 个 util，风险低但顺手验掉）。

### 阶段 1 · 一条 turn 真的跑完（约 4 天）

产出：workspace 骨架 + `evo-protocol` / `evo-kernel` / `evo-runlog` / `evo-context` / `evo-policy` / `evo-gateway` / `evo-exec` / `evo-exec-local` / `evo-model` / `evo-cli` 的最小实现，`evo-daemon` 此阶段只出一个 `run_once` 驱动函数（尚无 HTTP）。用 `FixtureAdapter` 跑完 03 §6 那串事件序列，落进真 SQLite 与真 blob 目录。

```
env.sampled → context.assembled → model.requested → model.responded
→ cost.charged → plan.step → tool.requested → policy.evaluated
→ impact.estimated → effect.dispatched → tool.result → checkpoint
→ run.completed
```

**收尾条件是两条硬测试当场绿：**

1. `replay --verify` 全量重放，在每个 `checkpoint` 处比对 `state_hash` 一致
2. 删光 `snapshots` 表后再回放一遍，结果逐字段一致

Q-13 要求「M1 内进 CI」，本阶段即兑现——**第一周，不是第二周**。这两条是判据 3 唯一的自动检测器，越早接上，「内核里悄悄读了时钟」的暴露窗口越短。

### 阶段 2 · 治理面补宽（约 5 天）

| 项 | 内容 | 契约出处 |
|---|---|---|
| 事件全集 | 24 个 kind 全部定义；`schema_ver` 旧版解码路径与测试 | 01 §4 / 00 §3 |
| 审批异步流 | `approval.requested/granted/denied/expired` + `run.suspended/resumed`；恢复 = 往 Log 追加事件 | 02 §6 / 03 §4 |
| dry-run | `ExecutionMode` 挂 run 或挂 effect；三级降级（preview / declared_only / 命令原文） | 02 §3 |
| 预算闸门 | token + 金额 + 时长；超限挂起而非失败。并发与递归深度留字段 | 02 §7 |
| manifest | 内置工具 TOML 编译期校验；**无 manifest 即 External + 不可逆 + 需审批** | 02 §4 |
| 污点检查 | 排在策略求值**之前**，结构性不可被策略放行 | 02 §2 |
| 出口代理 | `codex-network-proxy` 起独立子进程；allowlist 命中与拒绝**双向记账**，回填 `actual_egress` | 05 §4 |
| 供应链比对 | `actual_targets` / `actual_egress` 与 `declared_*` 比对，**只记录不拦截** | 01 §4.4 / 05 §1 |

### 阶段 3 · 协议与 CI 全量（约 3 天）

- `POST /v1/rpc`：M1 实现 `run.create` / `run.get` / `run.list` / `run.events` / `approval.decide` / `cost.query`；其余方法定义在 protocol 中但返回 `not_implemented`
- `ws /v1/events`：`subscribe` 带 `from_seq` 续订、`caught_up`、`subscribe_all`
- 认证：`Authorization: Bearer <token>`，daemon 首次启动生成写配置文件（Q-22）
- 版本协商：`hello` 帧；主版本不匹配降级只读，次版本正常（Q-23）
- ts-rs 导出到 `packages/protocol`，CI 检查生成结果与已提交内容一致
- 八条 CI 检查全部可执行

**M1 不做 UI。** `apps/ui` 不建。06 §6 那两个调用点（`daemonClient` / `platform`）属 M2。

---

## 三、确定性：三个实现选择

### 3.1 `state_hash` 用 canonical CBOR，不用 JSON

`RunState` 序列化后 sha256。序列化格式定为 **canonical CBOR（`ciborium`）**，不用 `serde_json`。

理由：`serde_json` 的 map 序列化顺序依赖插入顺序。`RunState` 自己的字段可以靠 `BTreeMap` 保证有序，但 `payload` 里嵌的 `serde_json::Value` 救不了——而 01 §4 的每个事件 payload 都是 `Value`。这正是 03 §3 点名的「半年后才发现 `state_hash` 不稳定」那一类。

CBOR canonical 形式对 map key 有确定的排序规则，嵌套结构一并覆盖。

### 3.2 四道防线照 03 §2 落

- **依赖隔离**：`evo-kernel` 的 `Cargo.toml` 只有 `evo-protocol` + `serde` + `ciborium` + `sha2`。CI 检查 `cargo tree -p evo-kernel` 不含 `chrono` / `time` / `rand` / `getrandom` / `uuid` / `tokio` / `reqwest`
- **lint**：`clippy.toml` 的 `disallowed-methods`（`SystemTime::now` / `Instant::now` / `env::var` / `env::vars`）与 `disallowed-types`（`SystemTime` / `Instant`）
- **结构**：`reduce(&RunState, &Event) -> RunState` 入参全是纯数据。内核要知道时间只能读 `state.clock_ms`，而它只由 `env.sampled` 写入
- **回放自校验**：阶段 1 即接上

### 3.3 有序容器

`RunState` 内一律 `BTreeMap` / `BTreeSet`，禁 `HashMap` / `HashSet`。这条进 code review checklist。

---

## 四、沙箱与出口在 Linux 上的形态

### 4.1 已定：接口先行

| 层 | M1 落地 |
|---|---|
| `trait Sandbox`（在 `evo-exec`） | **完整定义**。`spawn` 接受 profile 起进程——这是调用点，它现在就正确 |
| Linux 实现 `WorkspaceOnlySandbox` | cwd 限定在 `~/.evowork/workspaces/<run_id>/`；注入 `HTTP(S)_PROXY`；`~/.ssh` `~/.aws` 等敏感路径在 executor 层硬拦截。**不做内核级隔离** |
| macOS 实现 | **M1 不做**。留到能上真机 |
| vendor 目录 | `crates/evo-exec-local/vendor/codex-seatbelt/` + `UPSTREAM` + `scripts/sync-codex-vendor.sh` + CI 逐字节检查**全部就位**（这几样在 Linux 上照样跑） |
| 出口代理 | **不打折**。`codex-network-proxy` 跨平台，allowlist、记账、拒绝路径在 Linux 上完整验证 |

`WorkspaceOnlySandbox` 与将来的 seatbelt 版**行为语义一致**（同一张隔离矩阵，见 05 §3），因此沙箱行为的测试可以复用——换实现时换的是隔离手段，不是断言。

### 4.2 M1 结束时必须明说的一条「未验」

> **seatbelt profile 的真机行为在 M1 期未经验证。**

这条写进 M1 交付说明。08 §3 说得很清楚：seatbelt 策略写错不报错、只静默放行——所以「没验过」和「验过了」之间的差距，比通常的功能验证大得多。不能含糊过去。

### 4.3 出口 allowlist

M1 期 allowlist 里只有开发期需要的条目。05 §4 那句「开发期与交付形态用同一份代码、不同一份 allowlist」在 M1 就要成立：allowlist 是配置文件，不是代码常量。

---

## 五、测试策略

TDD：每条契约先写测试。三组核心测试对应三条判据。

### 5.1 回放自校验（判据 3）

`eval/cases/synthetic-01/` 放一条合成 Log（阶段 1 的 turn 序列导出）。全量重放，比对每个 `checkpoint` 的 `state_hash`。

```
cargo run -p evo-cli -- replay --verify eval/cases/*/runlog.sqlite
```

### 5.2 快照可丢弃（00 §4 检查 8）

同一条 Log 删光 `snapshots` 表再放一遍，结果逐字段一致。

没有这条，早晚有人往快照里塞一个 Log 里没有的状态——那一刻快照就从加速器变成第二份权威事实。

### 5.3 判据 1：新工具零治理代码

注册一个测试专用的假工具，**不写一行治理相关代码**，断言它自动获得：

- dry-run（`class = Write` 时产出 `tool.result{status:"dry_run"}`，不派发）
- 影响预估（`impact.estimated` 事件存在）
- 审计（`tool.requested` / `policy.evaluated` 全部落 Log）
- 记账（`cost.charged`）

这一条挂了就说明 Gateway 做成了转发函数（02 §一），比任何 code review 都靠谱。

### 5.4 schema 变更防线（00 §3）

阶段 2 起，改 `evo-protocol` 事件定义的 PR 必须带：`schema_ver` 处理、旧版解码测试、`eval/cases/` 历史 Log 回放通过。M1 内至少构造一次「加一个 optional 字段」的演练，证明这条流程真的可执行。

---

## 六、CI：八条检查落成 `scripts/ci.sh`

| # | 检查 | M1 实现 |
|:-:|---|---|
| 1 | 内核不读时钟/随机数/env | `clippy.toml` + `cargo tree -p evo-kernel` 禁用清单 |
| 2 | 回放自校验 | `evo-cli replay --verify` 跑 `eval/cases/` 全部 |
| 3 | 治理旁路 | 检查 `evo-exec*` / `evo-mcp` 只被 `evo-daemon` 依赖 |
| 4 | 客户名词隔离 | `grep -riE 'yonyou\|u8\|用友' crates/ apps/` 为空 |
| 5 | 协议同步 | `ts-rs` 生成结果与 `packages/protocol` 一致 |
| 6 | vendor 未被修改 | vendor 目录与上游 pin rev 逐字节一致 |
| 7 | 上游依赖闭包 | `scripts/codex-closure.py` 输出与基线一致 |
| 8 | 快照可丢弃 | 删快照后回放结果不变 |

**写成本地可跑的 `scripts/ci.sh`，再包一层 GitHub Actions。** 理由：daemon 要交付到客户机器上，那台机器上出问题时能直接跑同一个脚本，而不是「在 CI 上是好的」。

---

## 七、M1 的完成定义

全部满足才算完成：

1. `cargo test --workspace` 全绿
2. `scripts/ci.sh` 八条全过
3. 一条 run 能通过 HTTP `/v1/rpc` 创建、经 WS `/v1/events` 观察到全部事件、在 SQLite 里留下完整 Log、被 `replay --verify` 校验通过
4. 审批挂起与恢复走通一次（`approval.requested` → 挂起 → `approval.decide` → 续跑）
5. dry-run 下 `class = Write` 的 effect 不派发但产出完整的预估与审计事件
6. 出口代理拒绝一次未在 allowlist 中的请求，且该拒绝在 Log 里有记录
7. 交付说明中明确列出「seatbelt 真机未验」这一条

---

## 八、M1 明确不做

| 项 | 归属 |
|---|---|
| UI（`apps/ui`） | M2 |
| 真模型 adapter（DeepSeek / GPT） | M2（09） |
| MCP client 与用友 MCP server | M2（07） |
| 记忆启用 | 不启用（Q-16），仅建表 |
| 口径库、eval 真值集 | M2（07） |
| macOS seatbelt 实现 | 拿到真机后 |
| hash chain（`prev_hash` / `hash`） | Phase 3，字段留位 |
| 子 Agent（`run.spawned` / `run.joined`） | P2，字段留位 |
