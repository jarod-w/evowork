# M2 治理面补宽 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 A-4（干运行 + 影响预估）、A-5（高危确认，异步不阻塞）、A-2 的命令执行部分、A-12（澄清式追问）做出来，并把事件目录补齐到全集。

**Architecture:** 核心是一次**控制流反转**——挂起与拒绝从「`Err` 掀翻 turn 循环」改成「往 Log 追加一个事件」。挂起后 `reduce` 置 `awaiting`，`decide` 自然返回空，循环干净结束；恢复 = 往 Log 追加 `approval.granted` 等事件后重新驱动。这不是加两个事件，是把 `runtime.rs` 的控制流重构一遍。

**Tech Stack:** 沿用现有栈（Rust 1.95 / edition 2024、rusqlite、ciborium、tokio）。本切片不引入新依赖。

## Global Constraints

- **只有 `evo-daemon` 写 Run Log**；组装只发生在 `evo-daemon`
- **内核不得依赖时钟、随机数、env、文件、网络**；`evo-kernel` 只依赖 `evo-protocol` / `serde` / `ciborium` / `sha2`
- **事件 schema 只增不改**：加字段必须 optional，改语义必须升 `schema_ver` 并保留旧版解码。新增变体必须在 `event_body!` 宏里给出 `sample =`，否则编译不过
- **任何工具调用只有 Gateway 一个出口**
- **闸门只收紧不放宽**：所有对策略判定的调整必须经 `tighten(decision, floor)`，`admit` 里不得出现硬编码的 `RequireApproval { risk: ... }`
- `RunState` 内一律 `BTreeMap` / `BTreeSet`
- 金额一律 micros 整数
- `crates/` 与 `apps/` 里不得出现客户专有名词（`yonyou` / `用友`）
- 改了 `Cargo.toml` 依赖必须一并提交 `Cargo.lock`
- **收尾条件**：`cargo fmt --all`，`./scripts/ci.sh` 全段绿
- 每个任务以一次 commit 收尾

## 本次不做（写清楚，免得被当成遗漏）

| 项 | 为什么 |
|---|---|
| HTTP `/v1/rpc` + WS `/v1/events` + `ts-rs` 生成 `packages/protocol` | 下一个切片。**先让事件集稳定下来，协议只生成一次**——否则本切片每加一个事件都要冲刷生成物 |
| 真 DeepSeek adapter | key 已到位，但排在协议层之后；本切片继续用 `FixtureAdapter`，回放本来就不重调模型 |
| 用友 MCP Server（A-9） | 账号已到位，排在协议层之后 |
| A-11 口径库的**内容** | 财务的历史成品表尚未到位。**机制**（口径以文件维护、被上下文装配读取）可以做，但装不满，文档说「装不满则护城河无演示」——本切片连机制也不做，留给拿到素材那一刻一起做，避免机制与真实条目形状对不上 |
| A-13 溯源引用 | `cite` 锚点已在事件里，但没有真实单据可引；等用友 MCP 接上一起做 |
| 出口代理子进程（A-10） | 属 M3 |
| 真机跑通 | 装机三前提（Q-31）未确认 |

---

## 一处必须先定的设计：挂起与恢复的形状

现在的 `run_once(run_id, intent_text)` 有三个问题，它们互相纠缠，必须一起解：

1. **挂起与拒绝是 `Err`**，直接 `?` 掀翻 turn 循环。后果实测过：一条被 Gateway 拒的 run 停在 `impact.estimated`，**没有任何终结事件，`status` 永远是 `Running`**，而且因为没有 checkpoint，`verify` 对它只会报 VACUOUS——既关不掉也验不了
2. **`run_once` 无法从 Log 恢复**：它无条件 `RunState::new()` 起步、无条件发 `run.created` + `intent.declared`
3. **`intent_text` 是函数参数**，一路穿进 `execute_command`。恢复时没有这个参数——意图必须从 `state.intent` 指向的 blob 里取

**定下来的形状：**

```rust
pub enum RunOutcome {
    Completed(RunState),
    Suspended { state: RunState, reason: AwaitReason },
    Failed { state: RunState, error: String },
}

impl Runtime {
    /// 起一条新 run：建 state、发 run.created + intent.declared，然后驱动到停。
    pub async fn start(&mut self, run_id: &RunId, intent_text: &str) -> Result<RunOutcome, DaemonError>;

    /// 从 Log 恢复一条已存在的 run，继续驱动到停。
    /// 意图从 state.intent 指向的 blob 取，不从参数取。
    pub async fn resume(&mut self, run_id: &RunId) -> Result<RunOutcome, DaemonError>;

    /// 人做出审批决定：往 Log 追加 approval.granted / approval.denied，然后 resume。
    pub async fn decide_approval(
        &mut self, run_id: &RunId, approval_id: &ApprovalId,
        granted: bool, by: Actor, note: Option<&str>,
    ) -> Result<RunOutcome, DaemonError>;

    /// 人回答澄清：追加 clarification.answered，然后 resume。
    pub async fn answer_clarification(
        &mut self, run_id: &RunId, question_id: &str,
        option_id: Option<&str>, free_text: Option<&str>, by: Actor,
    ) -> Result<RunOutcome, DaemonError>;
}
```

**两条不可让步：**

- **`start` 与 `resume` 共用同一个驱动循环**。不许出现两份 turn 循环——那是两套语义迟早分叉的经典形态。差别只在「循环之前怎么拿到 state」
- **挂起路径上一个 `Err` 都不许有**。Gateway 说要审批 → 追加 `approval.requested` + `run.suspended` → `reduce` 置 `awaiting` → `decide` 返回空 → 循环自然结束 → 返回 `Suspended`。`Err` 只留给真正的故障（IO 失败、模型解析不出来、预算表查不到）

> `Command::Suspend` 到这一步才有真正的使用者：**预算超限**由内核 `decide` 判出并发 `Suspend`，而审批挂起是 daemon 依 Gateway 判定发起的。两条路径都落到同一个 `run.suspended` 事件上。

---

### Task 1: 事件目录补齐到全集

**Files:**
- Modify: `crates/evo-protocol/src/event.rs`（`event_body!` 宏调用）
- Modify / Create: `crates/evo-protocol/src/events/lifecycle.rs`, `events/approval.rs`, `events/clarification.rs`, `events/artifact.rs`, `events/context.rs`

**Interfaces:**
- Produces（在现有 15 个之上新增 9 个）：
  - `run.suspended` → `RunSuspended { reason: SuspendReason, detail_ref: Option<BlobRef> }`，`SuspendReason { AwaitingApproval, AwaitingHuman, BudgetExhausted, Paused }`
  - `run.resumed` → `RunResumed { by: Actor, from_seq: u64 }`
  - `run.failed` → `RunFailed { at_seq: u64, error: ErrorDetail }`，`ErrorDetail { code: String, message_ref: Option<BlobRef>, retryable: bool }`
  - `approval.requested` → `ApprovalRequested { approval_id, effect_id, risk: RiskLevel, impact_ref: Option<BlobRef>, expires_at_ms: u64 }`
  - `approval.granted` → `ApprovalGranted { approval_id, by: Actor, via: ApprovalVia, note_ref: Option<BlobRef> }`，`ApprovalVia { Ui, WecomLink }`
  - `approval.denied` → `ApprovalDenied { approval_id, by: Actor, reason_ref: Option<BlobRef> }`
  - `approval.expired` → `ApprovalExpired { approval_id }`
  - `clarification.requested` → `ClarificationRequested { question_id: String, question_ref: BlobRef, options: Vec<ClarificationOption> }`，`ClarificationOption { id, label, is_default }`
  - `clarification.answered` → `ClarificationAnswered { question_id, by: Actor, option_id: Option<String>, free_text_ref: Option<BlobRef> }`

- [ ] **Step 1: 先写失败的测试**

在 `event.rs` 的测试模块里，现有那条覆盖全部变体的未知字段容忍测试会自动扩展到新变体（宏生成样本表）。另外加一条：

```rust
#[test]
fn the_event_catalog_covers_every_kind_the_contract_lists() {
    // 契约文档 01 §4 的事件目录。新增事件必须同步这份清单——
    // 它是「实现有没有偏离契约」的唯一可执行对照物。
    let expected = [
        "run.created", "intent.declared", "run.suspended", "run.resumed",
        "run.completed", "run.failed",
        "env.sampled", "context.assembled", "context.compacted",
        "model.requested", "model.responded", "plan.step",
        "tool.requested", "policy.evaluated", "impact.estimated",
        "approval.requested", "approval.granted", "approval.denied", "approval.expired",
        "effect.dispatched", "tool.result",
        "cost.charged", "artifact.emitted", "checkpoint",
        "clarification.requested", "clarification.answered",
    ];
    let actual: std::collections::BTreeSet<&str> =
        all_event_bodies().iter().map(|b| b.kind()).collect();
    let expected_set: std::collections::BTreeSet<&str> = expected.into_iter().collect();
    assert_eq!(actual, expected_set, "事件目录与契约文档 01 §4 不一致");
}
```

> `context.compacted` 与 `artifact.emitted` 本切片不产生（压缩属后续、产物区属 UI 切片），但**字段必须在**——这是红线 3 的要求，事件目录一次定完，不许后补。`run.spawned` / `run.joined` 标 `[P2]`，本次**不加**（子 Agent 属 Phase 2，加了就是给没有消费方的东西定 schema）。

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-protocol`
Expected: FAIL，缺 9 个 kind

- [ ] **Step 3: 实现**

按 `event_body!` 宏现有的形状加 9 行，每行给出 `sample =`。新结构体分文件放（approval / clarification 各一个新文件，其余进现有文件），照现有文件的注释风格：**每个字段为什么在、为什么是这个类型**。

特别注意：
- `ApprovalRequested.expires_at_ms` 来自 `env.sampled` 的 `wall_clock_ms` + 有效期，**不是执行器自己读时钟**
- 所有可能含业务内容的字段（审批备注、拒绝理由、澄清问题与自由文本）一律 `BlobRef`，不进 payload

- [ ] **Step 4: 跑测试与 CI**

Run: `cargo test -p evo-protocol && ./scripts/ci.sh`
Expected: 全绿。事件目录测试通过，未知字段容忍测试自动覆盖到 24 个变体

- [ ] **Step 5: Commit**

---

### Task 2: 内核——挂起、恢复与预算闸门

**Files:**
- Modify: `crates/evo-kernel/src/reduce.rs`, `src/decide.rs`, `src/state.rs`
- Test: `crates/evo-kernel/tests/suspend_resume.rs`

**Interfaces:**
- Consumes: Task 1 的 9 个新事件
- Produces:
  - `reduce` 处理全部 9 个新事件；`awaiting` 由 `run.suspended` 置、由 `run.resumed` 清
  - `RunState` 新增 `pending_approvals: BTreeMap<ApprovalId, EffectId>`、`pending_question: Option<String>`
  - `decide` 在预算超限时产出 `Command::Suspend { reason: AwaitReason::Budget }`

- [ ] **Step 1: 先写失败的测试**

`crates/evo-kernel/tests/suspend_resume.rs` 至少覆盖：

1. `run.suspended` 后 `awaiting` 有值、`decide` 返回空
2. `run.resumed` 后 `awaiting` 清空、`decide` 重新有输出
3. `approval.requested` → `approval.granted` → `run.resumed` 这条链走完后，`pending_approvals` 为空且 run 可继续
4. `approval.denied` 之后 run 不能继续跑那个 effect（判断怎么表达最贴切并说明理由）
5. **预算超限产出 `Suspend` 而不是 `Complete`**：`budget_used.amount_micros` 超过 `budget.max_amount_micros` 时 `decide` 返回 `Command::Suspend { reason: Budget }`
6. **超限行为是挂起而不是失败、也不是静默继续**——这是功能清单原话「超限自动挂起而非静默烧钱」。人提额后可续跑
7. `clarification.requested` → `clarification.answered` 的同构链路

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

注意几处：
- `reduce` 仍然**不许读 `event.recorded_at`**
- `awaiting` 的清空只由 `run.resumed` 负责——不要让 `approval.granted` 直接清空它。**恢复是一个显式事件**，否则「谁能往 Log 里追加事件谁就能恢复任务」这条推论会失去唯一的落点
- 预算判断放 `decide`，用 `state.budget` 与 `state.budget_used` 比较。**只在 `budget` 里对应字段是 `Some` 时才判**——`None` 表示不设限，不是设成 0

- [ ] **Step 4: 跑测试与 CI**

Run: `cargo test -p evo-kernel && ./scripts/ci.sh`

- [ ] **Step 5: Commit**

---

### Task 3: `runtime.rs` 控制流重构——挂起是事件，不是 `Err`

**这是本切片最大的一个任务，也是风险最高的一个。** 终审的原话：按「重构 `runtime.rs` 的控制流」估，不要按「加两个事件」估。

**Files:**
- Modify: `crates/evo-daemon/src/runtime.rs`
- Test: `crates/evo-daemon/tests/suspend_resume.rs`

**Interfaces:**
- Produces：`RunOutcome`、`Runtime::start` / `resume` / `decide_approval` / `answer_clarification`（签名见本文开头「一处必须先定的设计」一节，逐字照抄）

- [ ] **Step 1: 先写失败的测试**

`crates/evo-daemon/tests/suspend_resume.rs`，用 `FixtureAdapter` 构造场景：

1. **被拒的 run 有终结事件**：让 Gateway 拒掉一个 effect，断言 Log 末尾有 `run.failed`（不是停在 `impact.estimated`）、`RunState::status` 是 `Failed`、**且有 checkpoint 所以 `verify` 不报 VACUOUS**
2. **审批挂起是干净的**：让 Gateway 判 `RequireApproval`，断言 `start` 返回 `Suspended`、Log 里有 `approval.requested` + `run.suspended`、`status` 是 `Suspended`、**没有任何 `Err`**
3. **批准后续跑**：接上一条，调 `decide_approval(granted = true)`，断言 Log 里追加了 `approval.granted` + `run.resumed`，run 继续跑到 `run.completed`，且**那个 effect 真的被执行了**（不只是状态变了）
4. **驳回后不执行**：同样场景 `granted = false`，断言 effect **没有被执行**（去工作区看文件在不在），run 有终结事件
5. **`resume` 从 Log 恢复**：`start` 挂起后**丢弃 `Runtime` 实例、新建一个**，只用 `run_id` 调 `resume`，断言它能接着跑完——这条证明恢复真的走 Log，不靠内存里残留的状态
6. **意图从 blob 取而不是从参数取**：接上一条，断言恢复后的 turn 里 `context.assembled` 的内容与原始一致
7. **澄清挂起与回答**：同构的一条链
8. **`start` 与 `resume` 共用一个驱动循环**：这条不好直接断言，请在报告里说明你是怎么保证的（例如：两者都调同一个私有 `drive(state) -> RunOutcome`）

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

拆解建议（你可以用更好的，但要满足上面两条不可让步）：

```rust
// 唯一的驱动循环。start 与 resume 都收敛到它。
async fn drive(&mut self, mut state: RunState) -> Result<RunOutcome, DaemonError>;

// start: RunState::new + 发 run.created/intent.declared + drive
// resume: 从 Log 折叠出 state（复用 replay 那套）+ 发 run.resumed + drive
```

`intent_text` 不再是参数。`execute_command` 需要它时从 `state.intent`（一个 `BlobRef`）去 blob store 取。

Gateway 判定的三条分支各自的落法：
- `Dispatch` → 照旧
- `DryRun` → 追加 Gateway 给的 `tool.result{dry_run}`，**继续循环**（不是终止）
- `Deny` → 追加 `run.failed`，**在此之前先下一个 checkpoint**（否则这条 run 没有可校验的锚点），返回 `Failed`
- `AwaitApproval` → 追加 `approval.requested` + `run.suspended`，返回 `Suspended`

`Command::Suspend`（预算超限，内核发的）→ 追加 `run.suspended`，返回 `Suspended`。
`Command::AskClarification` → 把问题正文落 blob，追加 `clarification.requested` + `run.suspended`，返回 `Suspended`。

**`DaemonError::NotImplemented` 用完就删**——本任务之后 `AskClarification` 与 `Suspend` 都有真实现了，那个变体如果还剩别的使用者就留着，没有就删掉。留一个没人构造的错误变体，下一个人会以为还有没做完的分支。

- [ ] **Step 4: 跑测试与 CI**

Run: `cargo test --workspace && ./scripts/ci.sh`
Expected: 全绿。**注意 `eval/cases/synthetic-01` 的 `final=` 哈希**——本任务改的是控制流不是事件语义，正常路径产出的事件序列应当**不变**，哈希应当仍是 `77401e4472012524`。**变了就说明行为变了**，停下来查清楚再继续，不要直接改 `case.yaml` 里钉住的期望值

- [ ] **Step 5: Commit**

---

### Task 4: Gateway——审批路径与 dry-run 三级降级

**Files:**
- Modify: `crates/evo-gateway/src/pipeline.rs`, `src/impact.rs`, `src/manifest.rs`
- Modify: `config/tools.toml`
- Test: `crates/evo-gateway/tests/dry_run.rs`

**Interfaces:**
- Produces：
  - `GatewayAction::AwaitApproval` 带上构造 `approval.requested` 所需的一切（`risk`、`impact_ref` 的素材、有效期）
  - dry-run 三级降级：`ImpactPrecision::Exact`（工具声明了 `preview` 且真的调了）/ `DeclaredOnly`（targets 可静态提取）/ `DeclaredOnly` + 命令原文（提取不出来的，如 `shell.exec`）

- [ ] **Step 1: 先写失败的测试**

三级降级各一条，外加：

- **`Read` 在 dry-run 下照常执行**（回归）——不执行读就估不出影响
- **`External` 在 dry-run 下永不自动放行**
- **第 2、3 级不阻塞接入**：一个既没有 `preview`、targets 也提取不出来的工具，仍然能通过 Gateway 拿到完整治理（只是 `precision` 是 `DeclaredOnly`）。**这条是判据 1 的延伸**：如果只有实现了 preview 的工具才能接入，门槛会高到没人接，最后一定有人加后门绕过 Gateway

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

第 1 级要调工具的 `preview` 方法，而 **Gateway 按设计不持有任何执行句柄**（它只产出「要追加哪些事件」，不做 IO）。这是一处真实的设计张力，终审已经点过。

**两条路，选一条并在报告里说明理由与代价：**
- **两段式准入**：`admit` 在需要 preview 时返回 `GatewayAction::NeedPreview { request }`，daemon 去调 executor 拿到 preview 结果，再调一次 `admit_with_preview(...)`
- **把 `estimate` 移出 Gateway**：由 daemon 负责影响预估，Gateway 只做前五步

我倾向前者（Gateway 不持句柄这条性质值得保住，它是「Gateway 可回放、可举证」的基础），但你判断后自己定。

- [ ] **Step 4: 跑测试与 CI**

- [ ] **Step 5: Commit**

---

### Task 5: `shell.exec` 与 `Sandbox::spawn` 接线

**Files:**
- Modify: `crates/evo-exec-local/src/executor.rs`, `src/sandbox.rs`
- Modify: `config/tools.toml`
- Test: `crates/evo-exec-local/tests/shell_exec.rs`

**Interfaces:**
- Produces：`LocalExecutor` 支持 `shell.exec`；`Sandbox::spawn` 从死代码变成有真实使用者

- [ ] **Step 1: 先解决 PATH 这个安全决策**

`WorkspaceOnlySandbox::spawn` 里有 `cmd.env_clear()`，之后只注入 `CommandSpec` 给的环境变量与 proxy 设置。**于是子进程没有 `PATH`，任何非绝对路径的程序名都会 spawn 失败。**

这不是 bug，是一个**没做的安全决策**：透传调用方的 `PATH`（方便，但把宿主机上任意可执行文件带进沙箱），还是给一份固定白名单（严，但要维护）？

**请先在报告里写出你的选择与理由，再动手。** 判断依据：这个产品的卖点之一是「文件读写与命令执行不出本机，是可验证的承诺」，而沙箱在 Linux 上是唯一的隔离边界（macOS 上将来有 seatbelt 兜底，这里没有）。

- [ ] **Step 2: 先写失败的测试**

至少覆盖：
- 跑一条简单命令、拿到 stdout / exit code
- **工作区隔离**：命令的 cwd 是工作区，写到工作区外的尝试被挡住
- **`env_clear` 生效**：宿主机上设的某个环境变量在子进程里看不到
- **proxy 注入**：`HTTP_PROXY` / `HTTPS_PROXY` 大小写两套 + `NO_PROXY=""` 都在
- **PATH 按你 Step 1 的决定生效**，并有对应的负面测试（白名单外的程序跑不起来 / 或透传下能跑起来，取决于你选哪个）
- `actual_targets` 与 `actual_egress` 如实回报（`shell.exec` 的 targets 静态提取不出来，所以是空——但**字段与比对代码要在**）

- [ ] **Step 3: 实现**

`config/tools.toml` 里给 `shell.exec` 的 manifest：`class = "write"`、`reversible = false`、`targets = [{ literal = "sandbox:workspace", kind = "workspace", op = "update" }]`、`egress = [{ via = "proxy" }]`。

> `reversible = false` + `class = write` 意味着它会命中策略里那条 `irreversible-write-needs-approval`——**这是对的**，`shell.exec` 本来就该每次问人。不要为了演示顺畅去放宽它。

- [ ] **Step 4: 跑测试与 CI**

- [ ] **Step 5: Commit**

---

### Task 6: 澄清式追问端到端（A-12）

**Files:**
- Modify: `crates/evo-daemon/src/runtime.rs`（`parse_plan` 认 `clarify`）
- Test: `crates/evo-daemon/tests/clarification.rs`

- [ ] **Step 1: 先写失败的测试**

用一个产出 `{"intent":"clarify","question":"...","options":[...]}` 的 fixture：

1. run 挂起在 `clarification.requested` + `run.suspended`
2. `answer_clarification` 追加 `clarification.answered` + `run.resumed` 后跑完
3. **答案真的影响了后续**：断言回答之后装配进上下文的内容含那个答案（否则这个功能是个摆设）
4. **带默认选项**：`options` 里 `is_default` 的那一项能被识别（一键回答的前提）
5. 问题正文与自由文本答案**都在 blob 里，不在 payload**

- [ ] **Step 2–5**: 同前，实现 → 测试 → CI → commit

---

## 完成检查

- [ ] `cargo test --workspace` 全绿
- [ ] `./scripts/ci.sh` 全段绿
- [ ] `eval/cases/synthetic-01` 的 `final=` 哈希**仍是 `77401e4472012524`**（正常路径行为未变）
- [ ] 事件目录 24 个 kind，与契约文档 01 §4 一致，有测试守着
- [ ] 挂起路径上没有任何 `Err`；被拒 / 挂起的 run 都有终结事件或 `awaiting`，没有一条会停在半路且 `status` 永远 `Running`
- [ ] `start` 与 `resume` 共用同一个驱动循环（报告里说明怎么保证的）
- [ ] `DaemonError::NotImplemented` 若已无使用者则已删除
- [ ] `Sandbox::spawn` 有真实使用者；PATH 的安全决策已明确记录
- [ ] dry-run 三级降级各有测试；第 2、3 级不阻塞接入
