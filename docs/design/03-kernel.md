# 03 · 内核状态机与回放

> 地基 A 的行为部分。[01](01-run-log.md) 定义存什么，本文定义怎么算。

---

## 一、内核的形状

```rust
// evo-kernel —— 整个 crate 只导出这几个东西
pub fn reduce(state: &RunState, event: &Event) -> RunState;
pub fn decide(state: &RunState) -> Vec<Command>;
pub fn state_hash(state: &RunState) -> [u8; 32];
```

- `reduce` 纯函数，无 IO
- `decide` 也是纯函数：给定状态，内核说「接下来该做什么」，但不做
- runtime 执行 `Command`，把结果作为 `Event` 写回 Log，再喂给 `reduce`

```
  ┌─────────────────────────────────────────┐
  │              evo-daemon (runtime)        │
  │                                          │
  │   Event ──▶ reduce ──▶ RunState          │
  │                          │               │
  │                       decide             │
  │                          │               │
  │                      Command             │
  │                          │               │
  │        ┌─────────────────┴──────────┐    │
  │        ▼         ▼        ▼         ▼    │
  │     采样env   装配上下文  调模型   发effect │
  │        └─────────────────┬──────────┘    │
  │                          ▼               │
  │                    写 Run Log ───────────┘
  └─────────────────────────────────────────┘
```

`Command` 是内核唯一的输出通道：

```rust
pub enum Command {
    SampleEnv,
    AssembleContext { turn: u32, profile: ContextProfile },
    CallModel { turn: u32 },
    RequestEffect { effect: EffectRequest },
    AskClarification { question: ClarificationSpec },
    Checkpoint { reason: CheckpointReason },
    Suspend { reason: SuspendReason },
    Complete { status: RunStatus },
}
```

**模型响应的解析放在 runtime，不放在内核。** 内核只吃已经结构化的 `plan.step` 事件。理由：解析要容忍模型输出的各种形态，是最容易引入非确定性（正则、时间、随机重试）的地方，把它关在内核外面，内核的确定性就好守得多。代价是 `plan.step` 的 schema 要足够表达；这个代价可以接受。**（Q-12 已定：解析在 runtime。）**

---

## 二、确定性怎么被强制

技术路线第七节：「第 3 条最容易在实现半年后才发现不通过——因为内核里悄悄读了时钟或随机数。」

四道防线，从弱到强：

### 防线 1 · 依赖隔离

`evo-kernel` 的 `Cargo.toml` 只依赖 `evo-protocol` 与 `serde`。CI 检查 `cargo tree -p evo-kernel` 不含：`chrono` / `time` / `std::time` 相关 / `rand` / `getrandom` / `uuid` / `tokio` / `reqwest` / 任何 IO crate。

### 防线 2 · lint

```toml
# clippy.toml
disallowed-methods = [
  "std::time::SystemTime::now", "std::time::Instant::now",
  "std::env::var", "std::env::vars",
]
disallowed-types = ["std::time::SystemTime", "std::time::Instant"]
```

`evo-kernel/src/lib.rs` 顶部加 `#![forbid(unsafe_code)]`。

### 防线 3 · 内核拿不到这些东西

最有效的一道其实不是检查，是**结构**：`reduce` 的入参只有 `&RunState` 与 `&Event`，两者都是纯数据。内核要知道时间，只能读 `state.clock_ms`，而它只由 `env.sampled` 事件写入（[01 第五节](01-run-log.md)）。

> **想读时钟都没有地方读**——这和 POC 文档 4.10③ 选 Tauri 的理由是同一个逻辑：让错误的做法在结构上不可能，比让它在规范上被禁止可靠得多。

### 防线 4 · 回放自校验（唯一能证明它真的成立的一道）

每个 `checkpoint` 事件带 `state_hash`。CI 对 `eval/cases/` 里的每条历史 Log 全量重放，在每个 checkpoint 处比对 hash。

```
cargo run -p evo-cli -- replay --verify eval/cases/*/runlog.sqlite
```

不一致就是内核有非确定性，当天暴露。

**Q-13 已定：M1 内就进 CI**，不等真实用例——M1 期先用合成 Log 也要跑起来。等到有真实用例才做，等于把这道防线推迟到最需要它的那段时间之后。

---

## 三、RunState

```rust
pub struct RunState {
    pub run_id: RunId,
    pub status: RunStatus,          // Running | Suspended | Completed | Failed
    pub turn: u32,

    pub clock_ms: u64,              // 只由 env.sampled 写入
    pub rng: DeterministicRng,      // seed 只由 env.sampled 写入
    pub env: BTreeMap<String,String>,

    pub intent: IntentRef,
    pub context: Option<AssembledContextRef>,
    pub taint: TaintLevel,

    pub pending_effects: BTreeMap<EffectId, EffectState>,
    pub awaiting: Option<AwaitReason>,      // 挂起原因；异步审批就住在这里

    pub budget_used: BudgetUsage,
    pub artifacts: Vec<ArtifactRef>,
    pub cites: BTreeSet<CiteId>,

    pub acceptance: Option<AcceptanceCriteria>,   // [P2] 验收前置
    pub children: Vec<RunId>,                     // [P2] Fleet
}
```

两个约定：

- **全部用有序容器**（`BTreeMap` / `BTreeSet`，不用 `HashMap`）。`HashMap` 的迭代顺序在 Rust 里随机化，会让 `state_hash` 不稳定——这是最典型的「半年后才发现」。
- **`state_hash` 用规范化序列化**（字段顺序固定的 JSON 或 CBOR）再 sha256。

---

## 四、挂起与恢复

挂起不是特殊状态机，就是 `awaiting: Some(...)` 时 `decide` 返回空。

```rust
pub enum AwaitReason {
    Approval { approval_id: ApprovalId, effect_id: EffectId },
    Clarification { question_id: String },
    Human { step: String },          // [P2] 人机混合队列
    Budget,
    ExternalEvent { kind: String },  // [P2] 条件触发
}
```

恢复 = 往 Log 里追加一个事件（`approval.granted` / `clarification.answered` / `run.resumed`），reduce 之后 `awaiting` 清空，`decide` 重新有输出。

**「跨设备接管」在这个设计里不是功能，是这条机制的直接推论**：谁能往 Log 里追加事件，谁就能恢复任务。POC 期就是同一个 daemon 的两个 UI 连接（电脑 + 手机浏览器）。

---

## 五、检查点、回放与 fork

| 能力 | 实现 |
|---|---|
| 检查点 | `checkpoint` 事件 + 可选快照。快照只是加速 |
| 断点续跑 | 从最近快照 reduce 到 `last_seq`，继续 `decide` |
| 回放（只读） | 从 seq 0 reduce 到目标 seq，**不重新调模型、不重新执行 effect** |
| time-travel 重跑 | 回放到 seq N，然后 `run.forked_from { source_run_id, at_seq }` 开一条新 run，从 N 之后重新决策 |

**快照策略（Q-06 已定）：每 50 个事件一个，外加 `pre_write` / `pre_approval` 两个语义点。单库多 run，不按 run 分库。**

快照全部可删除，且这一点是**硬测试**：CI 里有一条「删掉所有快照后回放结果不变」（[00 §4](00-index.md) 检查 8）。没有这条，半年后一定会有人往快照里塞一个 Log 里没有的状态，那一刻快照就从加速器变成了第二份权威事实。

`run.forked_from` 属于 [P2]，但事件与字段现在就留着——它是「回滚到任一检查点重跑」的承载物，也是 4.7 eval 重放的机制（把历史 run fork 出来换个模型再跑一遍）。

---

## 六、Turn 循环

一个正常 turn 的事件序列，可以直接当作实现的验收用例：

```
env.sampled            ← runtime 采样
context.assembled      ← 装配器
model.requested        ← adapter
model.responded
cost.charged           (×N: input/output/cache)
plan.step              ← runtime 解析
tool.requested         ← 内核 decide 出的 RequestEffect
policy.evaluated       ┐
impact.estimated       ├ Gateway 六步
[approval.requested]   ┘
effect.dispatched
tool.result
cost.charged           (若 effect 有计费)
checkpoint             (周期性)
```

一个 run 的事件量估算：单 turn 约 10–14 条，一次账龄任务预计 20–40 turn → **单 run 300–600 条事件**。SQLite 完全无压力，也印证技术路线第八节「单任务事件量小，需要的是事务与查询，不是吞吐，不要起步就上 Kafka」。

---

## 七、待确认

**本文无待确认项，以下为已定决策备查。**

| # | 决策 | 结论 |
|:-:|---|---|
| ~~Q-12~~ | ~~模型输出解析放内核还是 runtime~~ | **runtime**。内核只吃结构化 `plan.step` |
| ~~Q-13~~ | ~~回放自校验进 CI 的时点~~ | **M1 内**，先用合成 Log 也要跑起来 |
| ~~Q-06~~ | ~~快照频率、「删掉快照结果不变」是否作为硬测试~~ | **每 50 事件；是**，见第五节 |
