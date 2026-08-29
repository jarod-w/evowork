# M1 阶段 0 + 阶段 1：垂直切片实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用假模型 adapter 把一条完整的 turn 真正跑完——真写 SQLite、真落 blob、真走 Gateway 六步、真出 checkpoint——并让「回放比对 `state_hash`」与「删光快照结果不变」两条硬测试当场通过。

**Architecture:** 事件溯源。`evo-kernel` 是纯函数状态机（`reduce` / `decide` / `state_hash`），不碰 IO、时钟、随机数；`evo-daemon` 是唯一的组装点与唯一的 Run Log 写入者，它执行内核吐出的 `Command`，把结果作为 `Event` 追加回 Log 再喂给 `reduce`。事件 payload 只放元数据与 `content_hash`，业务内容一律进 content-addressed 的 blob store。

**Tech Stack:** Rust 1.95.0 / edition 2024、`rusqlite`（bundled SQLite，STRICT + WAL）、`ciborium`（canonical CBOR，用于 `state_hash`）、`sha2`、`serde` / `serde_json`、`tokio` + `async-trait`、`toml`、`clap`。

## Global Constraints

- 工具链固定 **1.95.0 / edition 2024**，`rust-toolchain.toml` 里写死版本号，不许写 `stable`
- **只有 `evo-daemon` 写 Run Log**。其他 crate 返回「要追加哪些事件」，由 daemon 落盘
- **组装只发生在 `evo-daemon`**。新增兄弟 crate 之间的依赖必须在 commit message 里说明为什么不能由 daemon 组装
- `evo-kernel` 只依赖 `evo-protocol` / `serde` / `ciborium` / `sha2`。**不得出现** `chrono` / `time` / `rand` / `getrandom` / `uuid` / `tokio` / `reqwest`
- `evo-kernel/src/lib.rs` 顶部必须有 `#![forbid(unsafe_code)]`
- `RunState` 内一律 `BTreeMap` / `BTreeSet`，**禁 `HashMap` / `HashSet`**
- `run_events.payload` 里只允许元数据与 `content_hash`。任何可能含业务内容的东西进 blob，事件里只留 `BlobRef`
- 事件 schema **只增不改**：加字段必须 optional，改语义必须升 `schema_ver` 并保留旧版解码
- `crates/` 与 `apps/` 里**不得出现客户专有名词**（`yonyou` / `u8` / `用友`）
- codex 上游 rev 冻结在 `c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3`，只 pin `rev`，**永不用 `branch = "main"`**
- `Cargo.lock` 进版本库
- 每个任务以一次 commit 收尾

---

## 文件结构

```
Cargo.toml                          workspace 定义与 workspace.dependencies
rust-toolchain.toml                 1.95.0 写死
clippy.toml                         disallowed-methods / disallowed-types
scripts/ci.sh                       八条 CI 检查的本地入口（阶段 1 先落 4 条）
crates/
  evo-protocol/src/
    lib.rs                          re-export
    ids.rs                          RunId / EffectId / CiteId / ToolId 等 newtype
    event.rs                        Event 信封 + EventBody 枚举 + kind 字符串
    events/lifecycle.rs             run.created / intent.declared / run.completed
    events/determinism.rs           env.sampled
    events/context.rs               context.assembled
    events/model.rs                 model.requested / model.responded / plan.step
    events/effect.rs                tool.requested / policy.evaluated / impact.estimated
                                    / effect.dispatched / tool.result
    events/accounting.rs            cost.charged / checkpoint
    blob.rs                         BlobRef / BlobClass
    effect.rs                       EffectRequest / EffectClass / ResourceRef / EgressRef
    budget.rs                       BudgetSpec / BudgetUsage
    taint.rs                        TaintLevel / TrustLevel
  evo-kernel/src/
    lib.rs                          #![forbid(unsafe_code)]，导出三个函数
    state.rs                        RunState + 子结构
    rng.rs                          DeterministicRng（splitmix64）
    reduce.rs                       reduce
    decide.rs                       decide + Command
    hash.rs                         state_hash（canonical CBOR + sha256）
  evo-runlog/src/
    lib.rs
    blobstore.rs                    content-addressed 文件存储
    schema.rs                       四张表的 DDL
    store.rs                        append / events / runs 投影
    snapshot.rs                     快照读写
    replay.rs                       回放器 + verify
  evo-context/src/lib.rs            最小装配器
  evo-policy/src/lib.rs             PolicyHook trait + HardcodedPolicy
  evo-gateway/src/
    lib.rs
    manifest.rs                     工具 manifest 加载
    pipeline.rs                     六步管线
    impact.rs                       ImpactEstimator
  evo-exec/src/lib.rs               Executor / Lease / WorkspaceHandle / Sandbox trait
  evo-exec-local/src/
    lib.rs
    workspace.rs                    ~/.evowork/workspaces/<run_id>/
    sandbox.rs                      WorkspaceOnlySandbox
    executor.rs                     LocalExecutor（fs.write）
  evo-model/src/
    lib.rs
    adapter.rs                      ModelAdapter trait + 请求/响应类型
    fixture.rs                      FixtureAdapter
    pricing.rs                      定价表 + cost.charged 计算
  evo-daemon/src/
    lib.rs
    clock.rs                        Clock trait + RealClock + FixedClock
    runtime.rs                      turn 循环驱动
  evo-cli/src/main.rs               replay --verify
  evo-memory/src/lib.rs             空壳
  evo-mcp/src/lib.rs                空壳
eval/cases/synthetic-01/            合成 Log + fixtures
```

---

### Task 0: 依赖可行性验证（写业务代码之前）

`codex-network-proxy` 用 `=0.3.0-alpha.4` 精确锁定整套 `rama-*`。在 Linux + rustc 1.95 上能不能编译，决定阶段 2 出口代理的形态。半小时买「不要在第二周才发现要重做」。

**Files:**
- Create: `/tmp/dep-probe/Cargo.toml`（临时，不进版本库）
- Create: `docs/superpowers/notes/2026-08-29-codex-dep-probe.md`

**Interfaces:**
- Consumes: 无
- Produces: 一份结论文档，阶段 2 的出口代理任务依赖它

- [ ] **Step 1: 建临时探针 crate**

```bash
mkdir -p /tmp/dep-probe/src && cd /tmp/dep-probe
cat > Cargo.toml <<'EOF'
[package]
name = "dep-probe"
version = "0.0.0"
edition = "2024"

[dependencies]
codex-network-proxy = { git = "https://github.com/openai/codex.git", rev = "c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3" }
codex-execpolicy    = { git = "https://github.com/openai/codex.git", rev = "c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3" }
EOF
echo 'fn main() {}' > src/main.rs
```

- [ ] **Step 2: 编译，记录结果**

Run: `cd /tmp/dep-probe && cargo build 2>&1 | tail -40`
Expected: 要么编译通过，要么给出明确的错误（版本冲突 / 平台门控 / 缺少系统库）。**两种结果都是有效产出**，不要为了让它过而改上游代码。

- [ ] **Step 3: 记录闭包基线**

Run: `python3 /root/develop/evowork/evowork/scripts/codex-closure.py /root/develop/evowork/codex/codex-rs codex-network-proxy codex-execpolicy`
Expected: 与 08 §1 的表一致（`codex-network-proxy` 闭包 3、`codex-execpolicy` 闭包 1）。不一致说明本地 checkout 的 rev 用错了。

- [ ] **Step 4: 写结论文档**

`docs/superpowers/notes/2026-08-29-codex-dep-probe.md` 必须回答三件事：① `cargo build` 是否通过，不通过时的确切错误；② 闭包数字是否与 08 §1 一致；③ 如果不通过，阶段 2 的出口代理改走哪条路（自写最小 forward proxy / 换实现 / 升 rev）。

- [ ] **Step 5: Commit**

```bash
cd /root/develop/evowork/evowork
git add docs/superpowers/notes/2026-08-29-codex-dep-probe.md
git commit -m "chore: codex 依赖在 Linux + rustc 1.95 上的可行性实测"
```

---

### Task 1: workspace 骨架与 lint 约束

**Files:**
- Create: `Cargo.toml`, `rust-toolchain.toml`, `clippy.toml`, `.gitignore`
- Create: `crates/{evo-protocol,evo-kernel,evo-runlog,evo-context,evo-policy,evo-gateway,evo-exec,evo-exec-local,evo-model,evo-daemon,evo-cli,evo-memory,evo-mcp}/Cargo.toml` 与 `src/lib.rs`
- Create: `scripts/ci.sh`

**Interfaces:**
- Consumes: 无
- Produces: 13 个可编译的 crate；`scripts/ci.sh` 供后续任务往里加检查

- [ ] **Step 1: 写 workspace 根文件**

`Cargo.toml`：

```toml
[workspace]
resolver = "3"
members = ["crates/*"]

[workspace.package]
version = "0.1.0"
edition = "2024"
license = "Apache-2.0"

[workspace.dependencies]
evo-protocol   = { path = "crates/evo-protocol" }
evo-kernel     = { path = "crates/evo-kernel" }
evo-runlog     = { path = "crates/evo-runlog" }
evo-context    = { path = "crates/evo-context" }
evo-policy     = { path = "crates/evo-policy" }
evo-gateway    = { path = "crates/evo-gateway" }
evo-exec       = { path = "crates/evo-exec" }
evo-exec-local = { path = "crates/evo-exec-local" }
evo-model      = { path = "crates/evo-model" }

serde       = { version = "1", features = ["derive"] }
serde_json  = "1"
ciborium    = "0.2"
sha2        = "0.10"
hex         = "0.4"
thiserror   = "2"
anyhow      = "1"
rusqlite    = { version = "0.32", features = ["bundled"] }
tokio       = { version = "1", features = ["rt-multi-thread", "macros", "fs", "process", "io-util"] }
async-trait = "0.1"
toml        = "0.8"
clap        = { version = "4", features = ["derive"] }
tempfile    = "3"

[workspace.lints.clippy]
disallowed_methods = "allow"
disallowed_types   = "allow"
```

> 版本号若解析失败，用 `cargo add` 取当前最新兼容版本，并把解析结果写回本文件。

`rust-toolchain.toml`：

```toml
[toolchain]
channel = "1.95.0"
components = ["clippy", "rustfmt", "rust-src"]
```

`clippy.toml`：

```toml
disallowed-methods = [
  "std::time::SystemTime::now",
  "std::time::Instant::now",
  "std::env::var",
  "std::env::vars",
]
disallowed-types = [
  "std::time::SystemTime",
  "std::time::Instant",
]
```

`.gitignore`：

```
/target
/blobs
*.sqlite
*.sqlite-wal
*.sqlite-shm
```

> **为什么 workspace 层把两个 lint 设成 `allow`**：`clippy.toml` 是 workspace 全局的，但 `evo-daemon` 必须读时钟。所以全局放行、**只在 `evo-kernel` 里 deny**。这样约束落在唯一需要它的 crate 上，而不是逼 daemon 到处写 `#[allow]`。

- [ ] **Step 2: 建 13 个 crate**

```bash
cd /root/develop/evowork/evowork
for c in evo-protocol evo-kernel evo-runlog evo-context evo-policy evo-gateway \
         evo-exec evo-exec-local evo-model evo-memory evo-mcp; do
  cargo new --lib "crates/$c" --vcs none
done
cargo new --lib crates/evo-daemon --vcs none
cargo new --bin crates/evo-cli --vcs none
```

每个 crate 的 `Cargo.toml` 改成继承 workspace：

```toml
[package]
name = "evo-protocol"
version.workspace = true
edition.workspace = true
license.workspace = true

[lints]
workspace = true

[dependencies]
serde.workspace = true
serde_json.workspace = true
```

`evo-kernel/Cargo.toml` 是唯一的例外，它自己把两个 lint 提回 deny：

```toml
[package]
name = "evo-kernel"
version.workspace = true
edition.workspace = true
license.workspace = true

[lints.clippy]
disallowed_methods = "deny"
disallowed_types   = "deny"

[dependencies]
evo-protocol.workspace = true
serde.workspace = true
ciborium.workspace = true
sha2.workspace = true
```

`evo-kernel/src/lib.rs` 顶部：

```rust
#![forbid(unsafe_code)]
```

`evo-memory/src/lib.rs` 与 `evo-mcp/src/lib.rs` 各放一行说明，标明是占位：

```rust
//! 空壳：M1 不实现。建 crate 是为了在依赖图上占住位置（Q-16：记忆建表不启用）。
```

- [ ] **Step 3: 编译**

Run: `cargo build --workspace`
Expected: 成功，13 个 crate 全部编译。

- [ ] **Step 4: 写 `scripts/ci.sh`（先落 4 条）**

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== fmt =="
cargo fmt --all -- --check

echo "== clippy =="
cargo clippy --workspace --all-targets -- -D warnings

echo "== test =="
cargo test --workspace

echo "== CI-1 内核依赖隔离 =="
tree=$(cargo tree -p evo-kernel --edges normal --prefix none)
for forbidden in chrono time rand getrandom uuid tokio reqwest; do
  if echo "$tree" | grep -qE "^${forbidden} v"; then
    echo "FAIL: evo-kernel 依赖了 $forbidden"; exit 1
  fi
done
echo "ok"

echo "== CI-4 客户名词隔离 =="
if grep -riE 'yonyou|用友' crates/ 2>/dev/null; then
  echo "FAIL: crates/ 里出现客户专有名词"; exit 1
fi
echo "ok"
```

> `u8` 不能直接 grep——它是 Rust 的基本类型，全仓都是。00 §4 检查 4 的这一项要在阶段 3 换成对标识符边界的匹配。此处先只查另外两个词，并在脚本里留这条注释。

- [ ] **Step 5: 跑 CI 脚本**

Run: `chmod +x scripts/ci.sh && ./scripts/ci.sh`
Expected: 五段全部 ok。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: workspace 骨架，13 个 crate 与内核 lint 约束"
```

---

### Task 2: `evo-protocol` — id、`BlobRef` 与污点等级

**Files:**
- Create: `crates/evo-protocol/src/ids.rs`, `blob.rs`, `taint.rs`
- Modify: `crates/evo-protocol/src/lib.rs`
- Test: 同文件内 `#[cfg(test)]`

**Interfaces:**
- Consumes: 无
- Produces: `RunId` / `EffectId` / `ApprovalId` / `CiteId` / `ToolId` / `LeaseId` / `ExecutorId`（均为 `String` newtype，实现 `Serialize` / `Deserialize` / `Ord` / `Display` / `From<&str>`）；`BlobRef { content_hash: String, size: u64, mime: String }`；`BlobClass { Metadata, Content, Artifact }`；`TaintLevel { Clean, Tainted }`；`TrustLevel { UserDirect, OrgTrusted, Untrusted }`

- [ ] **Step 1: 写失败的测试**

`crates/evo-protocol/src/ids.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn run_id_roundtrips_as_a_bare_string() {
        let id = RunId::from("r-001");
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"r-001\"");
        assert_eq!(serde_json::from_str::<RunId>(&json).unwrap(), id);
    }

    #[test]
    fn ids_are_ordered_so_btreemap_iteration_is_stable() {
        let mut v = vec![EffectId::from("e-2"), EffectId::from("e-1")];
        v.sort();
        assert_eq!(v[0].as_str(), "e-1");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-protocol`
Expected: FAIL，`cannot find type RunId in this scope`

- [ ] **Step 3: 实现**

`crates/evo-protocol/src/ids.rs`：

```rust
use serde::{Deserialize, Serialize};
use std::fmt;

macro_rules! string_id {
    ($($name:ident),* $(,)?) => {
        $(
            #[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
            #[serde(transparent)]
            pub struct $name(String);

            impl $name {
                pub fn as_str(&self) -> &str { &self.0 }
                pub fn into_inner(self) -> String { self.0 }
            }
            impl From<&str> for $name {
                fn from(s: &str) -> Self { Self(s.to_owned()) }
            }
            impl From<String> for $name {
                fn from(s: String) -> Self { Self(s) }
            }
            impl fmt::Display for $name {
                fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                    f.write_str(&self.0)
                }
            }
        )*
    };
}

string_id!(RunId, EffectId, ApprovalId, CiteId, ToolId, LeaseId, ExecutorId, ArtifactId, CheckpointId);
```

`crates/evo-protocol/src/blob.rs`：

```rust
use serde::{Deserialize, Serialize};

/// 指向 blob store 的引用。事件 payload 里只出现它，不出现内容本身。
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct BlobRef {
    /// "sha256:<hex>"
    pub content_hash: String,
    pub size: u64,
    pub mime: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlobClass {
    /// 元数据，可随事件表一起上云
    Metadata,
    /// 业务内容，永不出本地
    Content,
    /// 产物文件
    Artifact,
}
```

`crates/evo-protocol/src/taint.rs`：

```rust
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaintLevel {
    #[default]
    Clean,
    Tainted,
}

impl TaintLevel {
    /// 污点只升不降：任何一块 tainted，整体就是 tainted。
    pub fn join(self, other: Self) -> Self {
        if self == Self::Tainted || other == Self::Tainted { Self::Tainted } else { Self::Clean }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustLevel {
    UserDirect,
    OrgTrusted,
    Untrusted,
}

impl TrustLevel {
    pub fn taint(self) -> TaintLevel {
        match self {
            Self::UserDirect | Self::OrgTrusted => TaintLevel::Clean,
            Self::Untrusted => TaintLevel::Tainted,
        }
    }
}
```

`crates/evo-protocol/src/lib.rs`：

```rust
pub mod blob;
pub mod ids;
pub mod taint;

pub use blob::{BlobClass, BlobRef};
pub use ids::*;
pub use taint::{TaintLevel, TrustLevel};
```

- [ ] **Step 4: 补污点测试并跑全部**

在 `taint.rs` 里加：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taint_only_goes_up() {
        assert_eq!(TaintLevel::Clean.join(TaintLevel::Clean), TaintLevel::Clean);
        assert_eq!(TaintLevel::Clean.join(TaintLevel::Tainted), TaintLevel::Tainted);
        assert_eq!(TaintLevel::Tainted.join(TaintLevel::Clean), TaintLevel::Tainted);
    }

    #[test]
    fn untrusted_content_is_tainted() {
        assert_eq!(TrustLevel::Untrusted.taint(), TaintLevel::Tainted);
        assert_eq!(TrustLevel::UserDirect.taint(), TaintLevel::Clean);
    }
}
```

Run: `cargo test -p evo-protocol`
Expected: PASS，4 个测试

- [ ] **Step 5: Commit**

```bash
git add crates/evo-protocol
git commit -m "feat(protocol): id newtype、BlobRef 与污点等级"
```

---

### Task 3: `evo-protocol` — 事件信封与阶段 1 的 15 个事件

01 §4 的目录共 27 个 kind（文档里写的「24 个」是约数，实现时以 §4 的逐条列举为准）。**本任务只定义阶段 1 用得到的 15 个**，其余在阶段 2 补齐——但信封与 `schema_ver` 机制现在就要对。

两处对 01 §4 的**有意偏离**，理由见本计划开头，Task 16 负责回填文档：

1. 新增 `intent.declared`（06 §2 的事件流示例里有它，03 §3 的 `RunState.intent` 需要它，01 §4 漏了）
2. `plan.step` 增加 optional 字段 `call: Option<PlannedCall>`——内核要发 `RequestEffect`，必须从 `plan.step` 里拿到工具名与参数引用

**Files:**
- Create: `crates/evo-protocol/src/event.rs`, `src/events/mod.rs`, `src/events/lifecycle.rs`, `src/events/determinism.rs`, `src/events/context.rs`, `src/events/model.rs`, `src/events/effect.rs`, `src/events/accounting.rs`
- Create: `crates/evo-protocol/src/effect.rs`, `src/budget.rs`
- Modify: `crates/evo-protocol/src/lib.rs`

**Interfaces:**
- Consumes: Task 2 的 `RunId` / `EffectId` / `BlobRef` / `TaintLevel` / `TrustLevel`
- Produces:
  - `Event { run_id: RunId, seq: u64, recorded_at: String, actor: Actor, schema_ver: u32, body: EventBody }`
  - `EventBody`（internally tagged，tag 字段名 `"kind"`），`EventBody::kind(&self) -> &'static str`，`EventBody::schema_ver(&self) -> u32`
  - `Actor { Kernel, Runtime, Gateway, Executor, Human(String), Trigger(String) }`
  - `EffectClass { Read, Write, External, Compute }`、`ResourceRef`、`EgressRef`、`EffectRequest`
  - `BudgetSpec`、`BudgetUsage`
  - `PlannedCall { tool: ToolId, params_ref: BlobRef, params_digest: String }`

- [ ] **Step 1: 写失败的测试**

`crates/evo-protocol/src/event.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::determinism::EnvSampled;
    use std::collections::BTreeMap;

    fn sample_event() -> Event {
        Event {
            run_id: RunId::from("r-001"),
            seq: 3,
            recorded_at: "2026-08-29T10:00:00Z".to_owned(),
            actor: Actor::Runtime,
            schema_ver: 1,
            body: EventBody::EnvSampled(EnvSampled {
                turn: 0,
                wall_clock_ms: 1_756_461_600_000,
                rng_seed: "seed-0".to_owned(),
                env: BTreeMap::new(),
                model_route: ModelRoute {
                    provider: "fixture".to_owned(),
                    model: "fixture-v1".to_owned(),
                    params_digest: "d0".to_owned(),
                },
            }),
        }
    }

    #[test]
    fn kind_string_matches_the_catalog_in_doc_01() {
        assert_eq!(sample_event().body.kind(), "env.sampled");
    }

    #[test]
    fn body_serialises_with_the_kind_tag_inline() {
        let v = serde_json::to_value(&sample_event().body).unwrap();
        assert_eq!(v["kind"], "env.sampled");
        assert_eq!(v["wall_clock_ms"], 1_756_461_600_000u64);
    }

    #[test]
    fn body_roundtrips_through_the_payload_column() {
        let body = sample_event().body;
        let payload = serde_json::to_string(&body).unwrap();
        let back: EventBody = serde_json::from_str(&payload).unwrap();
        assert_eq!(back, body);
    }

    #[test]
    fn unknown_optional_fields_do_not_break_decoding() {
        // 红线 3：新增 optional 字段后，旧解码路径必须还能读新 payload。
        let payload = r#"{"kind":"plan.step","turn":0,"intent":"finish",
                          "taint_inherited":"clean","some_future_field":42}"#;
        let back: EventBody = serde_json::from_str(payload).unwrap();
        assert_eq!(back.kind(), "plan.step");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-protocol`
Expected: FAIL，`cannot find type Event in this scope`

- [ ] **Step 3: 实现事件信封**

`crates/evo-protocol/src/event.rs`：

```rust
use crate::events::accounting::{Checkpoint, CostCharged};
use crate::events::context::ContextAssembled;
use crate::events::determinism::{EnvSampled, ModelRoute};
use crate::events::effect::{
    EffectDispatched, ImpactEstimated, PolicyEvaluated, ToolRequested, ToolResult,
};
use crate::events::lifecycle::{IntentDeclared, RunCompleted, RunCreated};
use crate::events::model::{ModelRequested, ModelResponded, PlanStep};
use crate::ids::RunId;
use serde::{Deserialize, Serialize};

/// 谁产生了这条事件。对应 run_events.actor 列。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Actor {
    Kernel,
    Runtime,
    Gateway,
    Executor,
    Human(String),
    Trigger(String),
}

/// Run Log 里的一条事件。字段与 run_events 表逐列对应。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub run_id: RunId,
    pub seq: u64,
    /// daemon 写入时刻。内核不可见——reduce 不许读这个字段。
    pub recorded_at: String,
    pub actor: Actor,
    pub schema_ver: u32,
    pub body: EventBody,
}

/// 事件体。`kind` 标签内联，因此 payload 列可以整体反序列化回本枚举。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum EventBody {
    #[serde(rename = "run.created")]
    RunCreated(RunCreated),
    #[serde(rename = "intent.declared")]
    IntentDeclared(IntentDeclared),
    #[serde(rename = "env.sampled")]
    EnvSampled(EnvSampled),
    #[serde(rename = "context.assembled")]
    ContextAssembled(ContextAssembled),
    #[serde(rename = "model.requested")]
    ModelRequested(ModelRequested),
    #[serde(rename = "model.responded")]
    ModelResponded(ModelResponded),
    #[serde(rename = "plan.step")]
    PlanStep(PlanStep),
    #[serde(rename = "tool.requested")]
    ToolRequested(ToolRequested),
    #[serde(rename = "policy.evaluated")]
    PolicyEvaluated(PolicyEvaluated),
    #[serde(rename = "impact.estimated")]
    ImpactEstimated(ImpactEstimated),
    #[serde(rename = "effect.dispatched")]
    EffectDispatched(EffectDispatched),
    #[serde(rename = "tool.result")]
    ToolResult(ToolResult),
    #[serde(rename = "cost.charged")]
    CostCharged(CostCharged),
    #[serde(rename = "checkpoint")]
    Checkpoint(Checkpoint),
    #[serde(rename = "run.completed")]
    RunCompleted(RunCompleted),
}

impl EventBody {
    /// 写进 run_events.kind 列的字符串。必须与 01 §4 的目录逐字一致。
    pub fn kind(&self) -> &'static str {
        match self {
            Self::RunCreated(_) => "run.created",
            Self::IntentDeclared(_) => "intent.declared",
            Self::EnvSampled(_) => "env.sampled",
            Self::ContextAssembled(_) => "context.assembled",
            Self::ModelRequested(_) => "model.requested",
            Self::ModelResponded(_) => "model.responded",
            Self::PlanStep(_) => "plan.step",
            Self::ToolRequested(_) => "tool.requested",
            Self::PolicyEvaluated(_) => "policy.evaluated",
            Self::ImpactEstimated(_) => "impact.estimated",
            Self::EffectDispatched(_) => "effect.dispatched",
            Self::ToolResult(_) => "tool.result",
            Self::CostCharged(_) => "cost.charged",
            Self::Checkpoint(_) => "checkpoint",
            Self::RunCompleted(_) => "run.completed",
        }
    }

    /// 事件级版本号，不是全局版本号。加 optional 字段不升版；改语义必须升。
    pub fn schema_ver(&self) -> u32 {
        1
    }
}

pub use crate::events::determinism::ModelRoute as _ModelRouteReexportGuard;
```

> 最后那行 `pub use` 只是为了让测试里的 `ModelRoute` 可见；实现时直接在 `lib.rs` 统一 re-export 更干净，把它删掉并在 `lib.rs` 里 `pub use events::determinism::ModelRoute;`。

- [ ] **Step 4: 实现四个事件模块**

`crates/evo-protocol/src/events/lifecycle.rs`：

```rust
use crate::blob::BlobRef;
use crate::budget::BudgetSpec;
use crate::ids::RunId;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrincipalRef {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TriggerKind {
    Manual,
    Schedule,
    Webhook,
    File,
    Condition,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TriggerRef {
    pub kind: TriggerKind,
    pub reference: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunCreated {
    pub run_id: RunId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_run_id: Option<RunId>,
    pub workspace_id: String,
    pub principal: PrincipalRef,
    pub trigger: TriggerRef,
    pub budget: BudgetSpec,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
}

/// 意图声明。原文进 blob，事件里只留长度、语言与引用。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IntentDeclared {
    pub intent_ref: BlobRef,
    pub char_len: u64,
    pub lang: String,
    pub source: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletionStatus {
    Ok,
    Partial,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunCompleted {
    pub status: CompletionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary_ref: Option<BlobRef>,
}
```

`crates/evo-protocol/src/events/determinism.rs`：

```rust
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRoute {
    pub provider: String,
    pub model: String,
    pub params_digest: String,
}

/// 内核唯一的时间与随机数来源。每 turn 一次（Q-04）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvSampled {
    pub turn: u32,
    pub wall_clock_ms: u64,
    pub rng_seed: String,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub model_route: ModelRoute,
}
```

`crates/evo-protocol/src/events/context.rs`：

```rust
use crate::ids::CiteId;
use crate::taint::{TaintLevel, TrustLevel};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextBlock {
    pub cite_id: CiteId,
    pub source: String,
    pub trust: TrustLevel,
    pub scope: String,
    pub content_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<String>,
    pub token_estimate: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextAssembled {
    pub turn: u32,
    pub profile: String,
    pub blocks: Vec<ContextBlock>,
    /// blocks 中最高污点
    pub taint_level: TaintLevel,
    pub total_token_estimate: u64,
}
```

`crates/evo-protocol/src/events/model.rs`：

```rust
use crate::blob::BlobRef;
use crate::ids::ToolId;
use crate::taint::TaintLevel;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelParams {
    pub temperature: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelRequested {
    pub turn: u32,
    pub provider: String,
    pub model: String,
    pub params: ModelParams,
    /// 回放时重建请求并比对；不一致说明装配器有非确定性
    pub request_digest: String,
    /// messages 全文进 blob
    pub messages_ref: BlobRef,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    #[serde(default)]
    pub cache_read: u64,
    #[serde(default)]
    pub cache_write: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelResponded {
    pub turn: u32,
    pub response_ref: BlobRef,
    pub response_hash: String,
    pub usage: Usage,
    pub stop_reason: String,
    pub latency_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanIntent {
    ToolCall,
    Clarify,
    Finish,
}

/// runtime 从 model.responded 解析出的结构化决策。内核只吃这个，不碰模型原文。
///
/// `call` 是对 01 §4.3 的新增 optional 字段：内核要发 RequestEffect，
/// 必须从这里拿到工具名与参数引用（class / targets 由 Gateway 从 manifest 补全）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanStep {
    pub turn: u32,
    pub intent: PlanIntent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rationale_ref: Option<BlobRef>,
    pub taint_inherited: TaintLevel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub call: Option<PlannedCall>,
}

/// 内核能看到的「要调哪个工具」。不含 class / targets——那些来自 manifest，内核看不到。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlannedCall {
    pub tool: ToolId,
    pub params_ref: BlobRef,
    pub params_digest: String,
}
```

- [ ] **Step 5: 实现 effect 与 accounting 事件**

`crates/evo-protocol/src/effect.rs`：

```rust
use crate::blob::BlobRef;
use crate::ids::{CiteId, EffectId, RunId, ToolId};
use crate::taint::TaintLevel;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EffectClass {
    Read,
    Write,
    External,
    Compute,
}

impl EffectClass {
    /// dry-run 下是否降级为 record-only。Read / Compute 照常执行，否则预估不准。
    pub fn suppressed_in_dry_run(self) -> bool {
        matches!(self, Self::Write | Self::External)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResourceOp {
    Read,
    Create,
    Update,
    Delete,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct ResourceRef {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct EgressRef {
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

/// 能力令牌。POC 期只做 scope 字符串匹配（02 §2 步骤 ②）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityToken {
    pub subject: String,
    pub scopes: Vec<String>,
}

impl CapabilityToken {
    pub fn allows(&self, tool: &ToolId) -> bool {
        self.scopes.iter().any(|s| s == "*" || s == tool.as_str())
    }
}

/// Gateway 读得懂的「声明」，不是待执行的闭包（02 §1）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EffectRequest {
    pub effect_id: EffectId,
    pub run_id: RunId,
    pub turn: u32,
    pub tool: ToolId,
    pub params_ref: BlobRef,
    pub params_digest: String,

    // 以下由工具 manifest 静态推导，由 Gateway 在建请求时填入
    pub class: EffectClass,
    pub targets: Vec<ResourceRef>,
    pub egress: Vec<EgressRef>,
    pub reversible: bool,

    // 以下由 runtime 填入
    pub taint: TaintLevel,
    pub cites_referenced: Vec<CiteId>,
    pub capability: CapabilityToken,
}
```

`crates/evo-protocol/src/events/effect.rs`：

```rust
use crate::blob::BlobRef;
use crate::effect::{EffectClass, EgressRef, ResourceOp, ResourceRef};
use crate::ids::{CiteId, EffectId, ExecutorId, LeaseId, ToolId};
use crate::taint::TaintLevel;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolRequested {
    pub effect_id: EffectId,
    pub turn: u32,
    pub tool: ToolId,
    pub params_ref: BlobRef,
    pub params_digest: String,
    pub class: EffectClass,
    pub declared_targets: Vec<ResourceRef>,
    pub declared_egress: Vec<EgressRef>,
    pub reversible: bool,
    #[serde(default)]
    pub cites_referenced: Vec<CiteId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDecisionKind {
    Allow,
    Deny,
    RequireApproval,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyEvaluated {
    pub effect_id: EffectId,
    pub decision: PolicyDecisionKind,
    #[serde(default)]
    pub rules_hit: Vec<String>,
    pub policy_ver: String,
    pub reason_code: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ImpactTarget {
    pub resource: ResourceRef,
    pub op: ResourceOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail_ref: Option<BlobRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImpactPrecision {
    Exact,
    DeclaredOnly,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ImpactEstimated {
    pub effect_id: EffectId,
    pub targets: Vec<ImpactTarget>,
    #[serde(default)]
    pub externals: Vec<EgressRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub est_cost_micros: Option<u64>,
    pub precision: ImpactPrecision,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Live,
    DryRun,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EffectDispatched {
    pub effect_id: EffectId,
    pub executor_id: ExecutorId,
    pub lease_id: LeaseId,
    pub mode: ExecutionMode,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolResultStatus {
    Ok,
    Error,
    DryRun,
    Denied,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolResult {
    pub effect_id: EffectId,
    pub status: ToolResultStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_ref: Option<BlobRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    /// 外部返回一律 tainted
    pub taint: TaintLevel,
    #[serde(default)]
    pub cites_produced: Vec<CiteId>,
    /// 与 declared_targets 比对，供应链行为异常的数据基础。POC 期只记录不拦截。
    #[serde(default)]
    pub actual_targets: Vec<ResourceRef>,
    #[serde(default)]
    pub actual_egress: Vec<EgressRef>,
}
```

`crates/evo-protocol/src/events/accounting.rs`：

```rust
use crate::ids::{CheckpointId, EffectId, RunId, ToolId};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CostUnit {
    InputToken,
    OutputToken,
    CacheRead,
    CacheWrite,
    Seconds,
    Call,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Currency {
    CNY,
    USD,
}

/// 四维归因从第一天就带。POC 只用得上 principal 与 run_id，另两维留空。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CostDimension {
    pub principal: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    pub run_id: RunId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<ToolId>,
}

/// micros 整数，不用浮点——财务客户，账要对得上。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CostCharged {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect_id: Option<EffectId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<u32>,
    pub unit: CostUnit,
    pub quantity: u64,
    pub unit_price_micros: u64,
    pub amount_micros: u64,
    pub currency: Currency,
    /// 改价不能改历史账
    pub price_table_ver: String,
    pub dimension: CostDimension,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckpointReason {
    Periodic,
    PreWrite,
    PreApproval,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub checkpoint_id: CheckpointId,
    /// 回放到此 seq 时重算，不一致即 fail。判据 3 的自动检测器。
    pub state_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_ref: Option<String>,
    pub reason: CheckpointReason,
}
```

`crates/evo-protocol/src/budget.rs`：

```rust
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_amount_micros: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_wall_seconds: Option<u64>,
    /// [P2] 字段现在就在，M1 不读
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_concurrency: Option<u32>,
    /// [P2]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_recursion_depth: Option<u32>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetUsage {
    pub tokens: u64,
    pub amount_micros: u64,
    pub wall_ms: u64,
}
```

`crates/evo-protocol/src/events/mod.rs`：

```rust
pub mod accounting;
pub mod context;
pub mod determinism;
pub mod effect;
pub mod lifecycle;
pub mod model;
```

`crates/evo-protocol/src/lib.rs` 全文（删掉 Step 3 末尾那行临时 `pub use`）：

```rust
pub mod blob;
pub mod budget;
pub mod effect;
pub mod event;
pub mod events;
pub mod ids;
pub mod taint;

pub use blob::{BlobClass, BlobRef};
pub use budget::{BudgetSpec, BudgetUsage};
pub use effect::{
    CapabilityToken, EffectClass, EffectRequest, EgressRef, ResourceOp, ResourceRef,
};
pub use event::{Actor, Event, EventBody};
pub use events::accounting::{CheckpointReason, CostUnit, Currency};
pub use events::determinism::ModelRoute;
pub use events::effect::{ExecutionMode, ToolResultStatus};
pub use events::model::{PlanIntent, PlannedCall};
pub use ids::*;
pub use taint::{TaintLevel, TrustLevel};
```

- [ ] **Step 6: 跑测试**

Run: `cargo test -p evo-protocol && cargo clippy -p evo-protocol --all-targets -- -D warnings`
Expected: PASS，8 个测试

- [ ] **Step 7: Commit**

```bash
git add crates/evo-protocol
git commit -m "feat(protocol): 事件信封与阶段 1 的 15 个事件

plan.step 增加 optional 字段 call，intent.declared 补进目录——
两处对 01 §4 的偏离，理由见 docs/superpowers/plans，Task 16 回填文档。"
```

---

### Task 4: `evo-runlog` — content-addressed blob store

01 §3 那条最重要的规则的落点：业务内容只进这里，事件里只留 `BlobRef`。Phase 3 镜像上云时，事件表整表可同步、blob 留本地，靠的就是这个目录级切分。

**Files:**
- Create: `crates/evo-runlog/src/blobstore.rs`
- Modify: `crates/evo-runlog/src/lib.rs`, `crates/evo-runlog/Cargo.toml`

**Interfaces:**
- Consumes: `evo_protocol::{BlobClass, BlobRef}`
- Produces: `BlobStore::open(root: &Path) -> Result<BlobStore>`；`BlobStore::put(&self, class: BlobClass, mime: &str, bytes: &[u8]) -> Result<BlobRef>`；`BlobStore::get(&self, r: &BlobRef) -> Result<Vec<u8>>`；`BlobStore::path_of(&self, content_hash: &str) -> PathBuf`；错误类型 `RunLogError`

- [ ] **Step 1: 写失败的测试**

`crates/evo-runlog/src/blobstore.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use evo_protocol::BlobClass;

    #[test]
    fn put_then_get_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();
        let r = store.put(BlobClass::Content, "text/plain", b"hello").unwrap();
        assert_eq!(store.get(&r).unwrap(), b"hello");
        assert_eq!(r.size, 5);
        assert_eq!(r.mime, "text/plain");
    }

    #[test]
    fn same_content_gives_the_same_hash_and_is_written_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();
        let a = store.put(BlobClass::Content, "text/plain", b"same").unwrap();
        let b = store.put(BlobClass::Content, "text/plain", b"same").unwrap();
        assert_eq!(a.content_hash, b.content_hash);
    }

    #[test]
    fn layout_is_two_by_two_fanout() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();
        let r = store.put(BlobClass::Content, "text/plain", b"x").unwrap();
        let hex = r.content_hash.strip_prefix("sha256:").unwrap();
        let expected = dir.path().join(&hex[0..2]).join(&hex[2..4]).join(hex);
        assert!(expected.exists(), "blob 应落在 <h[0:2]>/<h[2:4]>/<h>");
    }

    #[test]
    fn missing_blob_reports_the_hash_it_looked_for() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::open(dir.path()).unwrap();
        let bogus = BlobRef {
            content_hash: "sha256:00".repeat(1) + &"ab".repeat(31),
            size: 1,
            mime: "text/plain".into(),
        };
        let err = store.get(&bogus).unwrap_err().to_string();
        assert!(err.contains("sha256:"), "错误信息里要带上找不到的 hash");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-runlog`
Expected: FAIL，`cannot find type BlobStore in this scope`

- [ ] **Step 3: 实现**

`crates/evo-runlog/Cargo.toml` 的 `[dependencies]`：

```toml
evo-protocol.workspace = true
serde.workspace = true
serde_json.workspace = true
sha2.workspace = true
hex.workspace = true
rusqlite.workspace = true
thiserror.workspace = true

[dev-dependencies]
tempfile.workspace = true
```

`crates/evo-runlog/src/blobstore.rs`：

```rust
use crate::RunLogError;
use evo_protocol::{BlobClass, BlobRef};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// 文件系统 + content-addressed（Q-03）。blobs 表只做索引与保留期，内容在这里。
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    pub fn open(root: &Path) -> Result<Self, RunLogError> {
        fs::create_dir_all(root)?;
        Ok(Self { root: root.to_path_buf() })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 落一份内容，返回引用。内容相同则复用同一份文件。
    ///
    /// `class` 目前只进 blobs 索引表（Task 5），不影响落盘路径——
    /// Phase 3 要「事件表上云、blob 留本地」，切分在目录级，不在 class 级。
    pub fn put(&self, _class: BlobClass, mime: &str, bytes: &[u8]) -> Result<BlobRef, RunLogError> {
        let hex_digest = hex::encode(Sha256::digest(bytes));
        let path = self.path_of_hex(&hex_digest);
        if !path.exists() {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            // 先写临时文件再 rename：同名 blob 并发写入时不会读到半截内容
            let tmp = path.with_extension("tmp");
            fs::write(&tmp, bytes)?;
            fs::rename(&tmp, &path)?;
        }
        Ok(BlobRef {
            content_hash: format!("sha256:{hex_digest}"),
            size: bytes.len() as u64,
            mime: mime.to_owned(),
        })
    }

    pub fn get(&self, r: &BlobRef) -> Result<Vec<u8>, RunLogError> {
        let path = self.path_of(&r.content_hash)?;
        fs::read(&path).map_err(|_| RunLogError::BlobNotFound(r.content_hash.clone()))
    }

    pub fn path_of(&self, content_hash: &str) -> Result<PathBuf, RunLogError> {
        let hex_digest = content_hash
            .strip_prefix("sha256:")
            .ok_or_else(|| RunLogError::BadBlobRef(content_hash.to_owned()))?;
        if hex_digest.len() < 4 {
            return Err(RunLogError::BadBlobRef(content_hash.to_owned()));
        }
        Ok(self.path_of_hex(hex_digest))
    }

    fn path_of_hex(&self, hex_digest: &str) -> PathBuf {
        self.root.join(&hex_digest[0..2]).join(&hex_digest[2..4]).join(hex_digest)
    }
}
```

`crates/evo-runlog/src/lib.rs`：

```rust
pub mod blobstore;

pub use blobstore::BlobStore;

#[derive(Debug, thiserror::Error)]
pub enum RunLogError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("blob not found: {0}")]
    BlobNotFound(String),
    #[error("malformed blob ref: {0}")]
    BadBlobRef(String),
    #[error("seq gap in run {run_id}: expected {expected}, got {got}")]
    SeqGap { run_id: String, expected: u64, got: u64 },
}
```

- [ ] **Step 4: 跑测试**

Run: `cargo test -p evo-runlog`
Expected: PASS，4 个测试

- [ ] **Step 5: Commit**

```bash
git add crates/evo-runlog
git commit -m "feat(runlog): content-addressed blob store"
```

---

### Task 5: `evo-runlog` — 四张表与事件追加

**Files:**
- Create: `crates/evo-runlog/src/schema.rs`, `crates/evo-runlog/src/store.rs`
- Modify: `crates/evo-runlog/src/lib.rs`
- Test: `crates/evo-runlog/tests/store.rs`

**Interfaces:**
- Consumes: Task 3 的 `Event` / `EventBody` / `Actor`；Task 4 的 `BlobStore`
- Produces:
  - `RunLog::open(db_path: &Path, blob_root: &Path) -> Result<RunLog>`
  - `RunLog::append(&mut self, run_id: &RunId, actor: Actor, recorded_at: &str, body: EventBody) -> Result<Event>` —— 自己分配 `seq`
  - `RunLog::events(&self, run_id: &RunId, from_seq: u64, to_seq: Option<u64>) -> Result<Vec<Event>>`
  - `RunLog::last_seq(&self, run_id: &RunId) -> Result<Option<u64>>`
  - `RunLog::blobs(&self) -> &BlobStore`
  - `RunLog::run_ids(&self) -> Result<Vec<RunId>>`

> **`recorded_at` 是入参，不是 `RunLog` 自己读时钟得来的。** 这样 `evo-runlog` 本身不依赖时钟，测试可以给固定值，而 01 §2「daemon 写入时刻」的语义由 daemon 提供 `Clock` 来满足（Task 12）。

- [ ] **Step 1: 写失败的测试**

`crates/evo-runlog/tests/store.rs`：

```rust
use evo_protocol::events::lifecycle::{
    CompletionStatus, PrincipalRef, RunCompleted, RunCreated, TriggerKind, TriggerRef,
};
use evo_protocol::{Actor, BudgetSpec, EventBody, RunId};
use evo_runlog::RunLog;

fn open() -> (tempfile::TempDir, RunLog) {
    let dir = tempfile::tempdir().unwrap();
    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    (dir, log)
}

fn run_created(run_id: &RunId) -> EventBody {
    EventBody::RunCreated(RunCreated {
        run_id: run_id.clone(),
        parent_run_id: None,
        workspace_id: "ws-1".into(),
        principal: PrincipalRef { kind: "user".into(), id: "u-1".into() },
        trigger: TriggerRef { kind: TriggerKind::Manual, reference: "cli".into() },
        budget: BudgetSpec::default(),
        labels: Default::default(),
    })
}

#[test]
fn seq_starts_at_zero_and_increases_by_one() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    let e0 = log.append(&r, Actor::Runtime, "2026-08-29T10:00:00Z", run_created(&r)).unwrap();
    let e1 = log
        .append(&r, Actor::Kernel, "2026-08-29T10:00:01Z",
                EventBody::RunCompleted(RunCompleted { status: CompletionStatus::Ok, summary_ref: None }))
        .unwrap();
    assert_eq!(e0.seq, 0);
    assert_eq!(e1.seq, 1);
}

#[test]
fn two_runs_share_one_database_with_independent_seq() {
    let (_d, mut log) = open();
    let a = RunId::from("r-a");
    let b = RunId::from("r-b");
    log.append(&a, Actor::Runtime, "t", run_created(&a)).unwrap();
    let first_of_b = log.append(&b, Actor::Runtime, "t", run_created(&b)).unwrap();
    assert_eq!(first_of_b.seq, 0, "单库多 run，seq 是 run 内单调（Q-06）");
}

#[test]
fn events_roundtrip_through_kind_and_payload_columns() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    let written = log.append(&r, Actor::Runtime, "2026-08-29T10:00:00Z", run_created(&r)).unwrap();
    let read = log.events(&r, 0, None).unwrap();
    assert_eq!(read.len(), 1);
    assert_eq!(read[0], written);
}

#[test]
fn events_can_be_read_as_a_half_open_range() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    for _ in 0..5 {
        log.append(&r, Actor::Runtime, "t", run_created(&r)).unwrap();
    }
    assert_eq!(log.events(&r, 1, Some(3)).unwrap().len(), 3, "[1, 3] 闭区间共 3 条");
    assert_eq!(log.last_seq(&r).unwrap(), Some(4));
}

#[test]
fn runs_projection_tracks_last_seq() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    log.append(&r, Actor::Runtime, "2026-08-29T10:00:00Z", run_created(&r)).unwrap();
    assert_eq!(log.run_ids().unwrap(), vec![r]);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-runlog --test store`
Expected: FAIL，`no function or associated item named 'open' found`

- [ ] **Step 3: 写表结构**

`crates/evo-runlog/src/schema.rs`：

```rust
/// 01 §2 的表结构，逐字落地。这就是最终结构，不是「先凑合」。
pub const DDL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS run_events (
  run_id      TEXT    NOT NULL,
  seq         INTEGER NOT NULL,
  kind        TEXT    NOT NULL,
  schema_ver  INTEGER NOT NULL,
  recorded_at TEXT    NOT NULL,
  actor       TEXT    NOT NULL,
  payload     TEXT    NOT NULL,
  prev_hash   BLOB,
  hash        BLOB,
  PRIMARY KEY (run_id, seq)
) STRICT;

-- 纯投影表，可从 run_events 全量重建
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, parent_run_id TEXT, workspace_id TEXT NOT NULL,
  principal TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, last_seq INTEGER NOT NULL,
  title TEXT, cost_micros INTEGER NOT NULL DEFAULT 0
) STRICT;

-- 只是加速，删掉不影响正确性（CI 检查 8 会验这一点）
CREATE TABLE IF NOT EXISTS snapshots (
  run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  state_blob BLOB NOT NULL, state_hash BLOB NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT;

CREATE TABLE IF NOT EXISTS blobs (
  content_hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL, mime TEXT NOT NULL,
  path TEXT NOT NULL,
  class TEXT NOT NULL,
  created_at TEXT NOT NULL, retain_until TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS idx_run_events_kind ON run_events(run_id, kind);
"#;
```

- [ ] **Step 4: 实现 store**

`crates/evo-runlog/src/store.rs`：

```rust
use crate::blobstore::BlobStore;
use crate::schema::DDL;
use crate::RunLogError;
use evo_protocol::{Actor, Event, EventBody, RunId};
use rusqlite::{params, Connection};
use std::path::Path;

pub struct RunLog {
    conn: Connection,
    blobs: BlobStore,
}

impl RunLog {
    pub fn open(db_path: &Path, blob_root: &Path) -> Result<Self, RunLogError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        conn.execute_batch(DDL)?;
        Ok(Self { conn, blobs: BlobStore::open(blob_root)? })
    }

    pub fn blobs(&self) -> &BlobStore {
        &self.blobs
    }

    pub fn last_seq(&self, run_id: &RunId) -> Result<Option<u64>, RunLogError> {
        let v: Option<i64> = self.conn.query_row(
            "SELECT MAX(seq) FROM run_events WHERE run_id = ?1",
            params![run_id.as_str()],
            |row| row.get(0),
        )?;
        Ok(v.map(|s| s as u64))
    }

    /// 追加一条事件。seq 由本函数分配，调用方不许自己算。
    pub fn append(
        &mut self,
        run_id: &RunId,
        actor: Actor,
        recorded_at: &str,
        body: EventBody,
    ) -> Result<Event, RunLogError> {
        let seq = self.last_seq(run_id)?.map_or(0, |s| s + 1);
        let event = Event {
            run_id: run_id.clone(),
            seq,
            recorded_at: recorded_at.to_owned(),
            actor,
            schema_ver: body.schema_ver(),
            body,
        };
        let payload = serde_json::to_string(&event.body)?;
        let actor_str = serde_json::to_string(&event.actor)?;
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO run_events (run_id, seq, kind, schema_ver, recorded_at, actor, payload)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                event.run_id.as_str(),
                event.seq as i64,
                event.body.kind(),
                event.schema_ver as i64,
                event.recorded_at,
                actor_str,
                payload
            ],
        )?;
        // runs 是投影表：只从事件推导，不接受任何 Log 里没有的字段。
        //
        // 阶段 1 只维护 run_id / 时间戳 / last_seq —— 这是 run_ids() 唯一用到的部分。
        // workspace_id / principal / status / cost_micros 要从 run.created、run.completed、
        // cost.charged 折叠出来，那是阶段 3 接 `run.list` / `cost.query` 时的事；
        // **在此之前不许有任何读取方依赖这几列**，否则它们会被当成真值。
        tx.execute(
            "INSERT INTO runs (run_id, parent_run_id, workspace_id, principal, status,
                               created_at, updated_at, last_seq, title, cost_micros)
             VALUES (?1, NULL, '', '', 'running', ?2, ?2, ?3, NULL, 0)
             ON CONFLICT(run_id) DO UPDATE SET updated_at = ?2, last_seq = ?3",
            params![event.run_id.as_str(), event.recorded_at, event.seq as i64],
        )?;
        tx.commit()?;
        Ok(event)
    }

    /// 读 [from_seq, to_seq] 闭区间；to_seq 为 None 时读到末尾。
    pub fn events(
        &self,
        run_id: &RunId,
        from_seq: u64,
        to_seq: Option<u64>,
    ) -> Result<Vec<Event>, RunLogError> {
        let upper = to_seq.map_or(i64::MAX, |s| s as i64);
        let mut stmt = self.conn.prepare(
            "SELECT seq, schema_ver, recorded_at, actor, payload FROM run_events
             WHERE run_id = ?1 AND seq >= ?2 AND seq <= ?3 ORDER BY seq",
        )?;
        let rows = stmt.query_map(params![run_id.as_str(), from_seq as i64, upper], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (seq, schema_ver, recorded_at, actor, payload) = row?;
            out.push(Event {
                run_id: run_id.clone(),
                seq: seq as u64,
                recorded_at,
                actor: serde_json::from_str(&actor)?,
                schema_ver: schema_ver as u32,
                body: serde_json::from_str(&payload)?,
            });
        }
        Ok(out)
    }

    pub fn run_ids(&self) -> Result<Vec<RunId>, RunLogError> {
        let mut stmt = self.conn.prepare("SELECT run_id FROM runs ORDER BY run_id")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        rows.map(|r| r.map(RunId::from).map_err(RunLogError::from)).collect()
    }
}
```

`lib.rs` 补 `pub mod schema; pub mod store; pub use store::RunLog;`

- [ ] **Step 5: 跑测试**

Run: `cargo test -p evo-runlog`
Expected: PASS，9 个测试（4 blob + 5 store）

- [ ] **Step 6: Commit**

```bash
git add crates/evo-runlog
git commit -m "feat(runlog): 四张表与事件追加，seq 由 store 分配"
```

---

### Task 6: `evo-kernel` — `RunState`、确定性 RNG 与 `state_hash`

判据 3 成立与否全在这个任务。**序列化用 canonical CBOR，不用 JSON**——`serde_json` 的 map 顺序依赖插入顺序，而 `state_hash` 不稳定是 03 §3 点名的「半年后才发现」那一类。

**Files:**
- Create: `crates/evo-kernel/src/state.rs`, `src/rng.rs`, `src/hash.rs`
- Modify: `crates/evo-kernel/src/lib.rs`, `crates/evo-kernel/Cargo.toml`

**Interfaces:**
- Consumes: `evo_protocol` 的全部类型
- Produces:
  - `RunState`（字段见 Step 3），`RunState::new(run_id: &RunId) -> RunState`
  - `RunStatus { Running, Suspended, Completed, Failed }`
  - `DeterministicRng { seed: u64, counter: u64 }`，`DeterministicRng::from_seed(&str) -> Self`，`next_u64(&mut self) -> u64`
  - `AwaitReason { Approval { approval_id, effect_id }, Clarification { question_id }, Human { step }, Budget, ExternalEvent { kind } }`
  - `EffectState { Requested, Dispatched, Settled }`
  - `state_hash(state: &RunState) -> [u8; 32]`，`state_hash_hex(state: &RunState) -> String`

- [ ] **Step 1: 写失败的测试**

`crates/evo-kernel/src/hash.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::RunState;
    use evo_protocol::RunId;

    #[test]
    fn hash_is_stable_across_calls() {
        let s = RunState::new(&RunId::from("r-1"));
        assert_eq!(state_hash(&s), state_hash(&s));
    }

    #[test]
    fn hash_changes_when_state_changes() {
        let a = RunState::new(&RunId::from("r-1"));
        let mut b = a.clone();
        b.turn = 1;
        assert_ne!(state_hash(&a), state_hash(&b));
    }

    #[test]
    fn map_insertion_order_does_not_affect_the_hash() {
        // BTreeMap 已经排序，这条测试防的是将来有人改成 HashMap
        let mut a = RunState::new(&RunId::from("r-1"));
        a.env.insert("A".into(), "1".into());
        a.env.insert("B".into(), "2".into());
        let mut b = RunState::new(&RunId::from("r-1"));
        b.env.insert("B".into(), "2".into());
        b.env.insert("A".into(), "1".into());
        assert_eq!(state_hash(&a), state_hash(&b));
    }

    #[test]
    fn hash_hex_is_64_chars() {
        let s = RunState::new(&RunId::from("r-1"));
        assert_eq!(state_hash_hex(&s).len(), 64);
    }
}
```

`crates/evo-kernel/src/rng.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_gives_the_same_sequence() {
        let mut a = DeterministicRng::from_seed("seed-0");
        let mut b = DeterministicRng::from_seed("seed-0");
        let sa: Vec<u64> = (0..5).map(|_| a.next_u64()).collect();
        let sb: Vec<u64> = (0..5).map(|_| b.next_u64()).collect();
        assert_eq!(sa, sb);
    }

    #[test]
    fn different_seeds_diverge() {
        let mut a = DeterministicRng::from_seed("seed-0");
        let mut b = DeterministicRng::from_seed("seed-1");
        assert_ne!(a.next_u64(), b.next_u64());
    }

    #[test]
    fn counter_advances_so_replay_can_be_verified() {
        let mut a = DeterministicRng::from_seed("seed-0");
        a.next_u64();
        assert_eq!(a.counter, 1);
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-kernel`
Expected: FAIL，`cannot find function state_hash in this scope`

- [ ] **Step 3: 实现 `RunState`**

`crates/evo-kernel/src/state.rs`：

```rust
use crate::rng::DeterministicRng;
use evo_protocol::blob::BlobRef;
use evo_protocol::budget::{BudgetSpec, BudgetUsage};
use evo_protocol::events::model::PlanStep;
use evo_protocol::ids::{ApprovalId, ArtifactId, CiteId, EffectId, RunId};
use evo_protocol::taint::TaintLevel;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    #[default]
    Running,
    Suspended,
    Completed,
    Failed,
}

/// 挂起原因。异步审批就住在这里——恢复 = 往 Log 追加一个事件（03 §4）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AwaitReason {
    Approval { approval_id: ApprovalId, effect_id: EffectId },
    Clarification { question_id: String },
    /// [P2] 人机混合队列
    Human { step: String },
    Budget,
    /// [P2] 条件触发
    ExternalEvent { kind: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffectState {
    Requested,
    Dispatched,
    Settled,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ArtifactRecord {
    pub artifact_id: ArtifactId,
    pub path: String,
    pub content_hash: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextRecord {
    pub turn: u32,
    pub profile: String,
    pub block_count: u64,
    pub taint_level: TaintLevel,
    pub total_token_estimate: u64,
}

/// 内核的全部状态。**全部有序容器**——HashMap 的迭代顺序会让 state_hash 不稳定。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunState {
    pub run_id: RunId,
    pub status: RunStatus,
    pub turn: u32,

    /// 只由 env.sampled 写入。内核想读时钟，只有这一个地方可读。
    pub clock_ms: u64,
    /// 同上，只由 env.sampled 写入
    pub rng: DeterministicRng,
    pub env: BTreeMap<String, String>,

    pub intent: Option<BlobRef>,
    pub context: Option<ContextRecord>,
    pub taint: TaintLevel,

    pub last_plan: Option<PlanStep>,
    pub pending_effects: BTreeMap<EffectId, EffectState>,
    pub awaiting: Option<AwaitReason>,

    pub budget: BudgetSpec,
    pub budget_used: BudgetUsage,
    pub artifacts: Vec<ArtifactRecord>,
    pub cites: BTreeSet<CiteId>,

    // —— turn 循环的进度标记：decide 靠它们判断这一 turn 走到哪了 ——
    pub env_sampled_turn: Option<u32>,
    pub context_turn: Option<u32>,
    pub plan_turn: Option<u32>,

    pub last_seq: u64,
    pub last_checkpoint_seq: Option<u64>,

    /// [P2] Fleet
    pub children: Vec<RunId>,
}

impl RunState {
    pub fn new(run_id: &RunId) -> Self {
        Self {
            run_id: run_id.clone(),
            status: RunStatus::Running,
            turn: 0,
            clock_ms: 0,
            rng: DeterministicRng::from_seed(""),
            env: BTreeMap::new(),
            intent: None,
            context: None,
            taint: TaintLevel::Clean,
            last_plan: None,
            pending_effects: BTreeMap::new(),
            awaiting: None,
            budget: BudgetSpec::default(),
            budget_used: BudgetUsage::default(),
            artifacts: Vec::new(),
            cites: BTreeSet::new(),
            env_sampled_turn: None,
            context_turn: None,
            plan_turn: None,
            last_seq: 0,
            last_checkpoint_seq: None,
            children: Vec::new(),
        }
    }

    /// 距上一个检查点过了多少事件。decide 用它决定要不要 Checkpoint。
    pub fn events_since_checkpoint(&self) -> u64 {
        match self.last_checkpoint_seq {
            None => self.last_seq + 1,
            Some(at) => self.last_seq.saturating_sub(at),
        }
    }
}
```

- [ ] **Step 4: 实现 RNG 与 hash**

`crates/evo-kernel/src/rng.rs`：

```rust
use serde::{Deserialize, Serialize};

/// 内核唯一的随机数来源。seed 只由 env.sampled 写入，算法是纯函数（splitmix64）。
///
/// 不引 `rand`：判据 3 要求内核里没有任何非确定性来源，而 `rand` 会把
/// `getrandom` 拖进依赖树（CI 检查 1 会直接 fail）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeterministicRng {
    pub seed: u64,
    pub counter: u64,
}

impl DeterministicRng {
    pub fn from_seed(seed: &str) -> Self {
        // FNV-1a：把任意字符串塌成 u64，纯函数，无依赖
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in seed.as_bytes() {
            h ^= u64::from(*b);
            h = h.wrapping_mul(0x1000_0000_01b3);
        }
        Self { seed: h, counter: 0 }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.counter = self.counter.wrapping_add(1);
        let mut z = self.seed.wrapping_add(self.counter.wrapping_mul(0x9e37_79b9_7f4a_7c15));
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }
}
```

`crates/evo-kernel/src/hash.rs`：

```rust
use crate::state::RunState;
use sha2::{Digest, Sha256};

/// 规范化序列化后 sha256。
///
/// 用 canonical CBOR 而不是 JSON：JSON 的 map 序列化顺序依赖插入顺序，
/// 而 state_hash 不稳定 = 判据 3 静默失效。CBOR 的 canonical 形式对 map key
/// 有确定的排序规则，嵌套结构一并覆盖。
pub fn state_hash(state: &RunState) -> [u8; 32] {
    let mut buf = Vec::new();
    ciborium::into_writer(state, &mut buf).expect("RunState 必须可序列化");
    Sha256::digest(&buf).into()
}

pub fn state_hash_hex(state: &RunState) -> String {
    state_hash(state).iter().map(|b| format!("{b:02x}")).collect()
}
```

`crates/evo-kernel/src/lib.rs`：

```rust
#![forbid(unsafe_code)]
//! 纯函数状态机。无 IO、无时钟、无随机数。
//!
//! 内核要知道时间，只能读 `RunState::clock_ms`，而它只由 `env.sampled` 事件写入。
//! **想读时钟都没有地方读**——这比在规范上禁止可靠。

pub mod hash;
pub mod rng;
pub mod state;

pub use hash::{state_hash, state_hash_hex};
pub use rng::DeterministicRng;
pub use state::{ArtifactRecord, AwaitReason, ContextRecord, EffectState, RunState, RunStatus};
```

- [ ] **Step 5: 跑测试与依赖检查**

Run: `cargo test -p evo-kernel && ./scripts/ci.sh`
Expected: 7 个测试 PASS；CI-1 内核依赖隔离通过（`cargo tree -p evo-kernel` 里没有 `rand` / `getrandom` / `uuid` / `tokio`）

- [ ] **Step 6: Commit**

```bash
git add crates/evo-kernel
git commit -m "feat(kernel): RunState、确定性 RNG 与 canonical CBOR 的 state_hash"
```

---

### Task 7: `evo-kernel` — `reduce`

**Files:**
- Create: `crates/evo-kernel/src/reduce.rs`
- Modify: `crates/evo-kernel/src/lib.rs`
- Test: `crates/evo-kernel/tests/reduce.rs`

**Interfaces:**
- Consumes: Task 6 的 `RunState`；Task 3 的 `Event` / `EventBody`
- Produces: `reduce(state: &RunState, event: &Event) -> RunState`；`fold(run_id: &RunId, events: &[Event]) -> RunState`

- [ ] **Step 1: 写失败的测试**

`crates/evo-kernel/tests/reduce.rs`：

```rust
use evo_kernel::{fold, reduce, RunState, RunStatus};
use evo_protocol::events::context::{ContextAssembled, ContextBlock};
use evo_protocol::events::determinism::{EnvSampled, ModelRoute};
use evo_protocol::events::lifecycle::{CompletionStatus, RunCompleted};
use evo_protocol::events::model::{PlanIntent, PlanStep};
use evo_protocol::{Actor, BlobRef, CiteId, Event, EventBody, RunId, TaintLevel, TrustLevel};

fn ev(seq: u64, body: EventBody) -> Event {
    Event {
        run_id: RunId::from("r-1"),
        seq,
        recorded_at: "2026-08-29T10:00:00Z".into(),
        actor: Actor::Runtime,
        schema_ver: 1,
        body,
    }
}

fn env_sampled(turn: u32, clock: u64) -> EventBody {
    EventBody::EnvSampled(EnvSampled {
        turn,
        wall_clock_ms: clock,
        rng_seed: "seed-0".into(),
        env: Default::default(),
        model_route: ModelRoute {
            provider: "fixture".into(),
            model: "fixture-v1".into(),
            params_digest: "d0".into(),
        },
    })
}

#[test]
fn env_sampled_is_the_only_way_the_clock_moves() {
    let s = RunState::new(&RunId::from("r-1"));
    assert_eq!(s.clock_ms, 0);
    let s = reduce(&s, &ev(0, env_sampled(0, 1_756_461_600_000)));
    assert_eq!(s.clock_ms, 1_756_461_600_000);
    assert_eq!(s.env_sampled_turn, Some(0));
}

#[test]
fn reduce_never_mutates_the_input_state() {
    let before = RunState::new(&RunId::from("r-1"));
    let after = reduce(&before, &ev(0, env_sampled(0, 42)));
    assert_eq!(before.clock_ms, 0, "入参必须原样不动");
    assert_eq!(after.clock_ms, 42);
}

#[test]
fn last_seq_follows_the_event() {
    let s = reduce(&RunState::new(&RunId::from("r-1")), &ev(7, env_sampled(0, 1)));
    assert_eq!(s.last_seq, 7);
}

#[test]
fn context_taint_is_carried_into_state() {
    let s = RunState::new(&RunId::from("r-1"));
    let s = reduce(&s, &ev(0, EventBody::ContextAssembled(ContextAssembled {
        turn: 0,
        profile: "default".into(),
        blocks: vec![ContextBlock {
            cite_id: CiteId::from("c-1"),
            source: "tool:web.fetch".into(),
            trust: TrustLevel::Untrusted,
            scope: "run".into(),
            content_hash: "sha256:ab".into(),
            span: None,
            token_estimate: 10,
        }],
        taint_level: TaintLevel::Tainted,
        total_token_estimate: 10,
    })));
    assert_eq!(s.taint, TaintLevel::Tainted);
    assert_eq!(s.context_turn, Some(0));
    assert!(s.cites.contains(&CiteId::from("c-1")));
}

#[test]
fn plan_step_records_the_turn_it_belongs_to() {
    let s = RunState::new(&RunId::from("r-1"));
    let s = reduce(&s, &ev(0, EventBody::PlanStep(PlanStep {
        turn: 0,
        intent: PlanIntent::Finish,
        rationale_ref: None,
        taint_inherited: TaintLevel::Clean,
        call: None,
    })));
    assert_eq!(s.plan_turn, Some(0));
}

#[test]
fn run_completed_stops_the_machine() {
    let s = RunState::new(&RunId::from("r-1"));
    let s = reduce(&s, &ev(0, EventBody::RunCompleted(RunCompleted {
        status: CompletionStatus::Ok,
        summary_ref: None,
    })));
    assert_eq!(s.status, RunStatus::Completed);
}

#[test]
fn fold_is_reduce_applied_in_order() {
    let events = vec![ev(0, env_sampled(0, 10)), ev(1, env_sampled(1, 20))];
    let s = fold(&RunId::from("r-1"), &events);
    assert_eq!(s.clock_ms, 20);
    assert_eq!(s.turn, 1, "env.sampled 的 turn 推进 state.turn");
}

#[test]
fn folding_the_same_events_twice_gives_the_same_state() {
    let events = vec![ev(0, env_sampled(0, 10)), ev(1, env_sampled(1, 20))];
    assert_eq!(fold(&RunId::from("r-1"), &events), fold(&RunId::from("r-1"), &events));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-kernel --test reduce`
Expected: FAIL，`unresolved import evo_kernel::reduce`

- [ ] **Step 3: 实现**

`crates/evo-kernel/src/reduce.rs`：

```rust
use crate::rng::DeterministicRng;
use crate::state::{ContextRecord, EffectState, RunState, RunStatus};
use evo_protocol::events::effect::ToolResultStatus;
use evo_protocol::ids::RunId;
use evo_protocol::{Event, EventBody};

/// 纯函数。入参只有 &RunState 与 &Event，两者都是纯数据。
///
/// 注意：**不许读 `event.recorded_at`**。那是 daemon 的写入时刻，
/// 内核对时间的唯一来源是 env.sampled（01 §5）。
pub fn reduce(state: &RunState, event: &Event) -> RunState {
    let mut s = state.clone();
    s.last_seq = event.seq;

    match &event.body {
        EventBody::RunCreated(e) => {
            s.budget = e.budget;
            s.status = RunStatus::Running;
        }
        EventBody::IntentDeclared(e) => {
            s.intent = Some(e.intent_ref.clone());
        }
        EventBody::EnvSampled(e) => {
            s.turn = e.turn;
            s.clock_ms = e.wall_clock_ms;
            s.rng = DeterministicRng::from_seed(&e.rng_seed);
            s.env = e.env.clone();
            s.env_sampled_turn = Some(e.turn);
        }
        EventBody::ContextAssembled(e) => {
            s.context = Some(ContextRecord {
                turn: e.turn,
                profile: e.profile.clone(),
                block_count: e.blocks.len() as u64,
                taint_level: e.taint_level,
                total_token_estimate: e.total_token_estimate,
            });
            s.taint = s.taint.join(e.taint_level);
            for b in &e.blocks {
                s.cites.insert(b.cite_id.clone());
            }
            s.context_turn = Some(e.turn);
        }
        EventBody::ModelRequested(_) => {}
        EventBody::ModelResponded(e) => {
            s.budget_used.tokens += e.usage.input + e.usage.output;
        }
        EventBody::PlanStep(e) => {
            s.taint = s.taint.join(e.taint_inherited);
            s.last_plan = Some(e.clone());
            s.plan_turn = Some(e.turn);
        }
        EventBody::ToolRequested(e) => {
            s.pending_effects.insert(e.effect_id.clone(), EffectState::Requested);
        }
        EventBody::PolicyEvaluated(_) | EventBody::ImpactEstimated(_) => {}
        EventBody::EffectDispatched(e) => {
            s.pending_effects.insert(e.effect_id.clone(), EffectState::Dispatched);
        }
        EventBody::ToolResult(e) => {
            s.pending_effects.insert(e.effect_id.clone(), EffectState::Settled);
            // 外部返回一律 tainted（02 §2 步骤 ③ 的前提）
            s.taint = s.taint.join(e.taint);
            for c in &e.cites_produced {
                s.cites.insert(c.clone());
            }
            if e.status == ToolResultStatus::Error {
                // 错误不终止 run，交给下一 turn 的模型处理
            }
            // 一个 effect 结算完，本 turn 结束，进入下一 turn
            if s.pending_effects.values().all(|v| *v == EffectState::Settled) {
                s.turn += 1;
            }
        }
        EventBody::CostCharged(e) => {
            s.budget_used.amount_micros += e.amount_micros;
        }
        EventBody::Checkpoint(_) => {
            s.last_checkpoint_seq = Some(event.seq);
        }
        EventBody::RunCompleted(_) => {
            s.status = RunStatus::Completed;
        }
    }
    s
}

/// 从空状态起把一串事件叠起来。回放就是它。
pub fn fold(run_id: &RunId, events: &[Event]) -> RunState {
    events.iter().fold(RunState::new(run_id), |s, e| reduce(&s, e))
}
```

`lib.rs` 补 `pub mod reduce; pub use reduce::{fold, reduce};`

- [ ] **Step 4: 跑测试**

Run: `cargo test -p evo-kernel`
Expected: PASS，15 个测试

- [ ] **Step 5: Commit**

```bash
git add crates/evo-kernel
git commit -m "feat(kernel): reduce 与 fold"
```

---

### Task 8: `evo-kernel` — `decide` 与 `Command`

内核唯一的输出通道。**一处对 03 §1 的有意偏离**：`Command::RequestEffect` 携带的是 `PlannedCall` 而不是完整的 `EffectRequest`——`class` / `targets` / `egress` / `reversible` 来自工具 manifest，内核看不到 manifest，由 Gateway 补全。

**Files:**
- Create: `crates/evo-kernel/src/decide.rs`
- Modify: `crates/evo-kernel/src/lib.rs`
- Test: `crates/evo-kernel/tests/decide.rs`

**Interfaces:**
- Consumes: Task 6 的 `RunState`；Task 3 的 `PlannedCall` / `CheckpointReason`
- Produces:
  - `Command { SampleEnv, AssembleContext { turn, profile }, CallModel { turn }, RequestEffect { call: PlannedCall }, AskClarification { question: String }, Checkpoint { reason }, Suspend { reason }, Complete { status } }`
  - `decide(state: &RunState) -> Vec<Command>`
  - `pub const CHECKPOINT_EVERY: u64 = 50;`

- [ ] **Step 1: 写失败的测试**

`crates/evo-kernel/tests/decide.rs`：

```rust
use evo_kernel::{decide, AwaitReason, Command, RunState, RunStatus, CHECKPOINT_EVERY};
use evo_protocol::events::model::{PlanIntent, PlanStep, PlannedCall};
use evo_protocol::{ApprovalId, BlobRef, EffectId, RunId, TaintLevel, ToolId};

fn base() -> RunState {
    RunState::new(&RunId::from("r-1"))
}

#[test]
fn a_fresh_run_samples_env_first() {
    assert_eq!(decide(&base()), vec![Command::SampleEnv]);
}

#[test]
fn after_env_comes_context() {
    let mut s = base();
    s.env_sampled_turn = Some(0);
    assert_eq!(
        decide(&s),
        vec![Command::AssembleContext { turn: 0, profile: "default".into() }]
    );
}

#[test]
fn after_context_comes_the_model() {
    let mut s = base();
    s.env_sampled_turn = Some(0);
    s.context_turn = Some(0);
    assert_eq!(decide(&s), vec![Command::CallModel { turn: 0 }]);
}

#[test]
fn a_tool_call_plan_becomes_a_request_effect() {
    let mut s = base();
    s.env_sampled_turn = Some(0);
    s.context_turn = Some(0);
    s.plan_turn = Some(0);
    let call = PlannedCall {
        tool: ToolId::from("fs.write"),
        params_ref: BlobRef { content_hash: "sha256:aa".into(), size: 2, mime: "application/json".into() },
        params_digest: "d1".into(),
    };
    s.last_plan = Some(PlanStep {
        turn: 0,
        intent: PlanIntent::ToolCall,
        rationale_ref: None,
        taint_inherited: TaintLevel::Clean,
        call: Some(call.clone()),
    });
    assert_eq!(decide(&s), vec![Command::RequestEffect { call }]);
}

#[test]
fn a_finish_plan_completes_the_run() {
    let mut s = base();
    s.env_sampled_turn = Some(0);
    s.context_turn = Some(0);
    s.plan_turn = Some(0);
    s.last_plan = Some(PlanStep {
        turn: 0,
        intent: PlanIntent::Finish,
        rationale_ref: None,
        taint_inherited: TaintLevel::Clean,
        call: None,
    });
    assert_eq!(decide(&s), vec![Command::Complete { status: RunStatus::Completed }]);
}

#[test]
fn suspension_silences_the_kernel() {
    // 挂起不是特殊状态机，就是 awaiting 有值时 decide 返回空（03 §4）
    let mut s = base();
    s.awaiting = Some(AwaitReason::Approval {
        approval_id: ApprovalId::from("a-1"),
        effect_id: EffectId::from("e-1"),
    });
    assert!(decide(&s).is_empty());
}

#[test]
fn a_completed_run_produces_no_commands() {
    let mut s = base();
    s.status = RunStatus::Completed;
    assert!(decide(&s).is_empty());
}

#[test]
fn a_checkpoint_is_due_every_fifty_events() {
    let mut s = base();
    s.last_seq = CHECKPOINT_EVERY;
    s.last_checkpoint_seq = None;
    let cmds = decide(&s);
    assert!(
        matches!(cmds.first(), Some(Command::Checkpoint { .. })),
        "检查点要排在本轮其余命令之前"
    );
}

#[test]
fn no_second_checkpoint_immediately_after_one() {
    let mut s = base();
    s.last_seq = CHECKPOINT_EVERY;
    s.last_checkpoint_seq = Some(CHECKPOINT_EVERY);
    assert!(!matches!(decide(&s).first(), Some(Command::Checkpoint { .. })));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-kernel --test decide`
Expected: FAIL，`unresolved import evo_kernel::Command`

- [ ] **Step 3: 实现**

`crates/evo-kernel/src/decide.rs`：

```rust
use crate::state::{AwaitReason, EffectState, RunState, RunStatus};
use evo_protocol::events::accounting::CheckpointReason;
use evo_protocol::events::model::{PlanIntent, PlannedCall};

/// 每 50 个事件一个检查点（Q-06），外加 pre_write / pre_approval 两个语义点。
pub const CHECKPOINT_EVERY: u64 = 50;

/// 内核唯一的输出通道。runtime 执行 Command，把结果作为 Event 写回 Log。
///
/// `RequestEffect` 带的是 PlannedCall 而非完整 EffectRequest：
/// class / targets / egress 来自工具 manifest，内核看不到 manifest，由 Gateway 补全。
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    SampleEnv,
    AssembleContext { turn: u32, profile: String },
    CallModel { turn: u32 },
    RequestEffect { call: PlannedCall },
    AskClarification { question: String },
    Checkpoint { reason: CheckpointReason },
    Suspend { reason: AwaitReason },
    Complete { status: RunStatus },
}

/// 纯函数：给定状态，内核说「接下来该做什么」，但不做。
pub fn decide(state: &RunState) -> Vec<Command> {
    if state.status != RunStatus::Running || state.awaiting.is_some() {
        return Vec::new();
    }

    let mut cmds = Vec::new();
    if state.events_since_checkpoint() >= CHECKPOINT_EVERY {
        cmds.push(Command::Checkpoint { reason: CheckpointReason::Periodic });
    }

    // 有 effect 还没结算，等执行面回流，不做新决策
    if state.pending_effects.values().any(|v| *v != EffectState::Settled) {
        return cmds;
    }

    let turn = state.turn;
    if state.env_sampled_turn != Some(turn) {
        cmds.push(Command::SampleEnv);
        return cmds;
    }
    if state.context_turn != Some(turn) {
        cmds.push(Command::AssembleContext { turn, profile: "default".to_owned() });
        return cmds;
    }
    if state.plan_turn != Some(turn) {
        cmds.push(Command::CallModel { turn });
        return cmds;
    }

    match state.last_plan.as_ref().map(|p| (p.intent, p.call.clone())) {
        Some((PlanIntent::ToolCall, Some(call))) => {
            cmds.push(Command::RequestEffect { call });
        }
        Some((PlanIntent::ToolCall, None)) => {
            // plan.step 说要调工具却没给 call —— runtime 解析出了问题
            cmds.push(Command::Complete { status: RunStatus::Failed });
        }
        Some((PlanIntent::Clarify, _)) => {
            cmds.push(Command::AskClarification { question: String::new() });
        }
        Some((PlanIntent::Finish, _)) | None => {
            cmds.push(Command::Complete { status: RunStatus::Completed });
        }
    }
    cmds
}
```

`lib.rs` 补 `pub mod decide; pub use decide::{decide, Command, CHECKPOINT_EVERY};`

- [ ] **Step 4: 跑测试**

Run: `cargo test -p evo-kernel && cargo clippy -p evo-kernel --all-targets -- -D warnings`
Expected: PASS，24 个测试

- [ ] **Step 5: Commit**

```bash
git add crates/evo-kernel
git commit -m "feat(kernel): decide 与 Command

RequestEffect 带 PlannedCall 而非完整 EffectRequest——内核看不到工具
manifest，class/targets 由 Gateway 补全。Task 16 回填 03 §1。"
```

---

### Task 9: `evo-context` — 最小装配器

M1 只做一件事：把 intent 原文包成一个 block。**字段必须齐全**，M2 换实现时换的是内部，不是调用点。

**Files:**
- Modify: `crates/evo-context/src/lib.rs`, `crates/evo-context/Cargo.toml`

**Interfaces:**
- Consumes: `evo_protocol::events::context::{ContextAssembled, ContextBlock}`；`BlobRef`
- Produces: `Assembler::new(profile: &str) -> Assembler`；`Assembler::assemble(&self, turn: u32, intent: &BlobRef, intent_text: &str) -> ContextAssembled`；`pub fn estimate_tokens(text: &str) -> u64`

- [ ] **Step 1: 写失败的测试**

`crates/evo-context/src/lib.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use evo_protocol::{BlobRef, TaintLevel, TrustLevel};

    fn intent_ref() -> BlobRef {
        BlobRef { content_hash: "sha256:ab".into(), size: 6, mime: "text/plain".into() }
    }

    #[test]
    fn user_intent_becomes_one_clean_block() {
        let a = Assembler::new("default");
        let c = a.assemble(0, &intent_ref(), "把账龄表做出来");
        assert_eq!(c.blocks.len(), 1);
        assert_eq!(c.blocks[0].trust, TrustLevel::UserDirect);
        assert_eq!(c.taint_level, TaintLevel::Clean, "用户直接输入不带污点");
        assert_eq!(c.profile, "default");
        assert_eq!(c.turn, 0);
    }

    #[test]
    fn the_block_cites_the_blob_not_the_text() {
        // 01 §3：事件里只留 content_hash，正文进 blob
        let a = Assembler::new("default");
        let c = a.assemble(0, &intent_ref(), "把账龄表做出来");
        assert_eq!(c.blocks[0].content_hash, "sha256:ab");
    }

    #[test]
    fn cite_ids_are_stable_for_the_same_turn_and_content() {
        // 回放要重建同一份上下文；cite_id 含随机数或时间就会破坏判据 3
        let a = Assembler::new("default");
        let one = a.assemble(0, &intent_ref(), "x");
        let two = a.assemble(0, &intent_ref(), "x");
        assert_eq!(one.blocks[0].cite_id, two.blocks[0].cite_id);
    }

    #[test]
    fn token_estimate_is_non_zero_for_non_empty_text() {
        assert!(estimate_tokens("把账龄表做出来") > 0);
        assert_eq!(estimate_tokens(""), 0);
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-context`
Expected: FAIL，`cannot find type Assembler in this scope`

- [ ] **Step 3: 实现**

`crates/evo-context/Cargo.toml` 的 `[dependencies]`：`evo-protocol.workspace = true`、`serde.workspace = true`

`crates/evo-context/src/lib.rs`：

```rust
//! 上下文装配。M1 只做最简形态：intent 原文一个 block。
//!
//! 04 的完整装配（口径库、记忆、污点传播、cite 校验）是 M2。
//! 这个 crate 在 M1 就建起来，是为了让 context.assembled 事件的字段
//! 从第一天起就被真的写过一遍——而不是等 M2 才第一次验证。

use evo_protocol::events::context::{ContextAssembled, ContextBlock};
use evo_protocol::{BlobRef, CiteId, TaintLevel, TrustLevel};

pub struct Assembler {
    profile: String,
}

impl Assembler {
    pub fn new(profile: &str) -> Self {
        Self { profile: profile.to_owned() }
    }

    /// 装配一个 turn 的上下文。
    ///
    /// `cite_id` 必须只由 turn 与内容决定——含时间或随机数就会让回放重建的
    /// 上下文与原始不一致，判据 3 当场失效。
    pub fn assemble(&self, turn: u32, intent: &BlobRef, intent_text: &str) -> ContextAssembled {
        let hex = intent.content_hash.strip_prefix("sha256:").unwrap_or(&intent.content_hash);
        let short = &hex[..hex.len().min(8)];
        let block = ContextBlock {
            cite_id: CiteId::from(format!("c-t{turn}-{short}")),
            source: "user_intent".to_owned(),
            trust: TrustLevel::UserDirect,
            scope: "run".to_owned(),
            content_hash: intent.content_hash.clone(),
            span: None,
            token_estimate: estimate_tokens(intent_text),
        };
        let total = block.token_estimate;
        ContextAssembled {
            turn,
            profile: self.profile.clone(),
            taint_level: block.trust.taint(),
            blocks: vec![block],
            total_token_estimate: total,
        }
    }
}

/// 粗估 token 数。M1 不接 tokenizer——这个数只进 payload 做统计，
/// 不参与计费（计费用模型返回的真实 usage），估偏了不会让账错。
pub fn estimate_tokens(text: &str) -> u64 {
    if text.is_empty() {
        return 0;
    }
    // 中文按字符、英文按 4 字符 1 token 粗算，取两者较大值保守估计
    let chars = text.chars().count() as u64;
    let bytes = text.len() as u64;
    chars.max(bytes / 4).max(1)
}

impl Default for Assembler {
    fn default() -> Self {
        Self::new("default")
    }
}
```

> `TaintLevel` 在本文件里通过 `block.trust.taint()` 用到，`use` 行保留即可；若 clippy 报未使用，删掉 `TaintLevel` 的 import。

- [ ] **Step 4: 跑测试**

Run: `cargo test -p evo-context`
Expected: PASS，4 个测试

- [ ] **Step 5: Commit**

```bash
git add crates/evo-context
git commit -m "feat(context): 最小装配器，字段齐全"
```

---

### Task 10: `evo-policy` — `PolicyHook` trait 与 TOML 实现

02 §2 那句「换 Cedar 时只实现一个新的 `PolicyHook`，Gateway 一行不动」的可执行形态。**trait 就是最终接口**，实现可以简陋。

**Files:**
- Modify: `crates/evo-policy/src/lib.rs`, `crates/evo-policy/Cargo.toml`
- Create: `crates/evo-policy/src/hardcoded.rs`
- Create: `config/policy.toml`

**Interfaces:**
- Consumes: `evo_protocol` 的 `EffectClass` / `TaintLevel` / `ToolId` / `ResourceRef`
- Produces:
  - `RiskLevel { L1, L2, L3 }`
  - `PolicyDecision { Allow, Deny { reason_code: String }, RequireApproval { risk: RiskLevel } }`
  - `PolicyContext { tool: ToolId, class: EffectClass, taint: TaintLevel, targets: Vec<ResourceRef>, reversible: bool }`
  - `trait PolicyHook { fn evaluate(&self, ctx: &PolicyContext) -> PolicyDecision; fn version(&self) -> &str; }`
  - `HardcodedPolicy::from_toml_str(s: &str) -> Result<HardcodedPolicy, PolicyError>`，`HardcodedPolicy::from_path(p: &Path) -> Result<...>`

- [ ] **Step 1: 写失败的测试**

`crates/evo-policy/src/hardcoded.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PolicyContext, PolicyDecision, PolicyHook, RiskLevel};
    use evo_protocol::{EffectClass, TaintLevel, ToolId};

    const POLICY: &str = r#"
version = "poc-1"

[[rule]]
id = "read-is-free"
class = "read"
decision = "allow"

[[rule]]
id = "external-needs-approval"
class = "external"
decision = "require_approval"
risk = "l3"

[[rule]]
id = "irreversible-write-needs-approval"
class = "write"
reversible = false
decision = "require_approval"
risk = "l2"
"#;

    fn ctx(tool: &str, class: EffectClass, reversible: bool) -> PolicyContext {
        PolicyContext {
            tool: ToolId::from(tool),
            class,
            taint: TaintLevel::Clean,
            targets: Vec::new(),
            reversible,
        }
    }

    #[test]
    fn reads_are_allowed() {
        let p = HardcodedPolicy::from_toml_str(POLICY).unwrap();
        assert_eq!(p.evaluate(&ctx("fs.read", EffectClass::Read, true)), PolicyDecision::Allow);
    }

    #[test]
    fn external_effects_require_l3_approval() {
        let p = HardcodedPolicy::from_toml_str(POLICY).unwrap();
        assert_eq!(
            p.evaluate(&ctx("wecom.send", EffectClass::External, false)),
            PolicyDecision::RequireApproval { risk: RiskLevel::L3 }
        );
    }

    #[test]
    fn reversible_writes_fall_through_to_allow() {
        let p = HardcodedPolicy::from_toml_str(POLICY).unwrap();
        assert_eq!(p.evaluate(&ctx("fs.write", EffectClass::Write, true)), PolicyDecision::Allow);
    }

    #[test]
    fn irreversible_writes_require_l2_approval() {
        let p = HardcodedPolicy::from_toml_str(POLICY).unwrap();
        assert_eq!(
            p.evaluate(&ctx("shell.exec", EffectClass::Write, false)),
            PolicyDecision::RequireApproval { risk: RiskLevel::L2 }
        );
    }

    #[test]
    fn version_goes_into_the_policy_evaluated_event() {
        let p = HardcodedPolicy::from_toml_str(POLICY).unwrap();
        assert_eq!(p.version(), "poc-1");
    }

    #[test]
    fn first_matching_rule_wins_and_is_reported() {
        let p = HardcodedPolicy::from_toml_str(POLICY).unwrap();
        let (decision, rules) = PolicyHook::evaluate_with_trace(&p, &ctx("fs.read", EffectClass::Read, true));
        assert_eq!(decision, PolicyDecision::Allow);
        assert_eq!(rules, vec!["read-is-free".to_owned()]);
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-policy`
Expected: FAIL，`cannot find type HardcodedPolicy in this scope`

- [ ] **Step 3: 实现 trait**

`crates/evo-policy/Cargo.toml` 的 `[dependencies]`：`evo-protocol.workspace = true`、`serde.workspace = true`、`toml.workspace = true`、`thiserror.workspace = true`

`crates/evo-policy/src/lib.rs`：

```rust
//! 策略钩子。**trait 是最终接口，实现是 POC 期的**。
//!
//! 换 Cedar / OPA 时只实现一个新的 PolicyHook，Gateway 一行不动。

pub mod hardcoded;

use evo_protocol::effect::{EffectClass, ResourceRef};
use evo_protocol::ids::ToolId;
use evo_protocol::taint::TaintLevel;
use serde::{Deserialize, Serialize};

pub use hardcoded::HardcodedPolicy;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskLevel {
    /// 可逆、仅本地、不对外 —— 直接执行，只留审计
    L1,
    /// 不可逆或影响面大，但不对外 —— 进审批队列，可批量放行
    L2,
    /// 对外发送 / 资金 / 生产系统写 —— 强制单条审批，不可批量放行
    L3,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyDecision {
    Allow,
    Deny { reason_code: String },
    RequireApproval { risk: RiskLevel },
}

#[derive(Clone, Debug)]
pub struct PolicyContext {
    pub tool: ToolId,
    pub class: EffectClass,
    pub taint: TaintLevel,
    pub targets: Vec<ResourceRef>,
    pub reversible: bool,
}

pub trait PolicyHook: Send + Sync {
    fn evaluate(&self, ctx: &PolicyContext) -> PolicyDecision;

    /// 判定 + 命中的规则 id，后者进 policy.evaluated.rules_hit。
    ///
    /// **带默认实现**：换 Cedar / OPA 时只需实现 `evaluate`，
    /// 诊断信息拿不到就留空，不给新实现增加必填项。
    fn evaluate_with_trace(&self, ctx: &PolicyContext) -> (PolicyDecision, Vec<String>) {
        (self.evaluate(ctx), Vec::new())
    }

    /// 进 policy.evaluated.policy_ver
    fn version(&self) -> &str;
}

#[derive(Debug, thiserror::Error)]
pub enum PolicyError {
    #[error("toml: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("unknown decision in rule {0}: {1}")]
    UnknownDecision(String, String),
}
```

- [ ] **Step 4: 实现 TOML 策略**

`crates/evo-policy/src/hardcoded.rs`：

```rust
use crate::{PolicyContext, PolicyDecision, PolicyError, PolicyHook, RiskLevel};
use evo_protocol::effect::EffectClass;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
struct PolicyFile {
    version: String,
    #[serde(default)]
    rule: Vec<Rule>,
}

#[derive(Debug, Deserialize)]
struct Rule {
    id: String,
    #[serde(default)]
    class: Option<EffectClass>,
    #[serde(default)]
    tool: Option<String>,
    #[serde(default)]
    reversible: Option<bool>,
    decision: String,
    #[serde(default)]
    risk: Option<RiskLevel>,
    #[serde(default)]
    reason_code: Option<String>,
}

impl Rule {
    fn matches(&self, ctx: &PolicyContext) -> bool {
        if let Some(c) = self.class
            && c != ctx.class
        {
            return false;
        }
        if let Some(t) = &self.tool
            && t != ctx.tool.as_str()
        {
            return false;
        }
        if let Some(r) = self.reversible
            && r != ctx.reversible
        {
            return false;
        }
        true
    }

    fn decision(&self) -> Result<PolicyDecision, PolicyError> {
        match self.decision.as_str() {
            "allow" => Ok(PolicyDecision::Allow),
            "deny" => Ok(PolicyDecision::Deny {
                reason_code: self.reason_code.clone().unwrap_or_else(|| self.id.clone()),
            }),
            "require_approval" => Ok(PolicyDecision::RequireApproval {
                risk: self.risk.unwrap_or(RiskLevel::L2),
            }),
            other => Err(PolicyError::UnknownDecision(self.id.clone(), other.to_owned())),
        }
    }
}

/// POC 期的策略实现：读一份 TOML，规则从上到下先命中先赢。
///
/// **分级规则放在这里，不硬编码在 Gateway**——换客户只换 TOML（02 §6）。
pub struct HardcodedPolicy {
    file: PolicyFile,
}

impl HardcodedPolicy {
    pub fn from_toml_str(s: &str) -> Result<Self, PolicyError> {
        Ok(Self { file: toml::from_str(s)? })
    }

    pub fn from_path(p: &Path) -> Result<Self, PolicyError> {
        Self::from_toml_str(&std::fs::read_to_string(p)?)
    }

}

impl PolicyHook for HardcodedPolicy {
    fn evaluate(&self, ctx: &PolicyContext) -> PolicyDecision {
        self.evaluate_with_trace(ctx).0
    }

    /// 规则从上到下先命中先赢，命中的规则 id 回填进 policy.evaluated.rules_hit。
    fn evaluate_with_trace(&self, ctx: &PolicyContext) -> (PolicyDecision, Vec<String>) {
        for rule in &self.file.rule {
            if rule.matches(ctx) {
                let decision = rule.decision().unwrap_or(PolicyDecision::Deny {
                    reason_code: "malformed_rule".to_owned(),
                });
                return (decision, vec![rule.id.clone()]);
            }
        }
        // 没有规则命中 = 放行。真正的兜底最严在 Gateway 的 manifest 缺失分支（02 §4）
        (PolicyDecision::Allow, Vec::new())
    }

    fn version(&self) -> &str {
        &self.file.version
    }
}
```

- [ ] **Step 5: 写 `config/policy.toml`**

内容与测试里的 `POLICY` 常量一致，加一行文件头注释：

```toml
# POC 期策略。02 §6 的高危分级口径待客户确认（Q-08），此处是占位的最小集合。
version = "poc-1"

[[rule]]
id = "read-is-free"
class = "read"
decision = "allow"

[[rule]]
id = "external-needs-approval"
class = "external"
decision = "require_approval"
risk = "l3"

[[rule]]
id = "irreversible-write-needs-approval"
class = "write"
reversible = false
decision = "require_approval"
risk = "l2"
```

- [ ] **Step 6: 跑测试**

Run: `cargo test -p evo-policy && cargo clippy -p evo-policy --all-targets -- -D warnings`
Expected: PASS，6 个测试

- [ ] **Step 7: Commit**

```bash
git add crates/evo-policy config/policy.toml
git commit -m "feat(policy): PolicyHook trait 与 TOML 实现"
```

---

### Task 11: `evo-exec` — 执行面接口

POC 期只有一种实现且与 daemon 同进程，**但 lease 机制现在就存在**——它现在是结构体传参，将来是一次 RPC 领取，调用点不变。

**Files:**
- Modify: `crates/evo-exec/src/lib.rs`, `crates/evo-exec/Cargo.toml`

**Interfaces:**
- Consumes: `evo_protocol` 的 `EffectRequest` / `ExecutionMode` / `ResourceRef` / `EgressRef` / `TaintLevel` / `CapabilityToken`
- Produces:
  - `WorkspaceHandle { pub fn path(&self) -> &Path; pub fn id(&self) -> &str }`（**不是 `PathBuf` 别名**，Fleet 期它会变成快照挂载点）
  - `EgressPolicy { pub allow: Vec<String>, pub proxy_addr: Option<String> }`
  - `Lease { lease_id, run_id, effect_id, expires_at_ms, workspace, egress_policy, capability }`
  - `DispatchedEffect { request: EffectRequest, params: serde_json::Value, mode: ExecutionMode }`
  - `EffectOutcome { status, output: Option<Vec<u8>>, output_mime: String, taint, actual_targets, actual_egress, error: Option<String> }`
  - `ExecutorCapabilities { classes: Vec<EffectClass>, has_network: bool, platform: String }`
  - `#[async_trait] trait Executor { fn id(&self) -> ExecutorId; fn capabilities(&self) -> ExecutorCapabilities; async fn execute(&self, lease: Lease, effect: DispatchedEffect) -> EffectOutcome; async fn heartbeat(&self, lease: &Lease) -> Result<(), ExecError>; }`
  - `#[async_trait] trait Sandbox { async fn spawn(&self, spec: &CommandSpec, ws: &WorkspaceHandle, egress: &EgressPolicy) -> Result<SandboxOutput, ExecError>; fn kind(&self) -> &'static str; }`
  - `CommandSpec { program: String, args: Vec<String>, env: BTreeMap<String, String> }`
  - `SandboxOutput { exit_code: i32, stdout: Vec<u8>, stderr: Vec<u8> }`

- [ ] **Step 1: 写失败的测试**

`crates/evo-exec/src/lib.rs` 末尾：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn workspace_handle_is_an_abstraction_not_a_path_alias() {
        // Fleet 期 WorkspaceHandle 会变成「某个 COW 快照的挂载点」。
        // 现在就要有 id，否则将来换实现要改所有调用点。
        let ws = WorkspaceHandle::new("r-1", PathBuf::from("/tmp/ws"));
        assert_eq!(ws.id(), "r-1");
        assert_eq!(ws.path(), std::path::Path::new("/tmp/ws"));
    }

    #[test]
    fn a_lease_carries_its_deadline_from_sampled_time_not_a_clock_read() {
        // expires_at_ms 来自 env.sampled，执行器不许自己读时钟
        let lease = Lease {
            lease_id: LeaseId::from("l-1"),
            run_id: RunId::from("r-1"),
            effect_id: EffectId::from("e-1"),
            expires_at_ms: 1_756_461_660_000,
            workspace: WorkspaceHandle::new("r-1", PathBuf::from("/tmp/ws")),
            egress_policy: EgressPolicy::deny_all(),
            capability: CapabilityToken { subject: "u-1".into(), scopes: vec!["*".into()] },
        };
        assert_eq!(lease.expires_at_ms, 1_756_461_660_000);
    }

    #[test]
    fn deny_all_egress_permits_nothing() {
        let p = EgressPolicy::deny_all();
        assert!(!p.permits("api.deepseek.com"));
    }

    #[test]
    fn allowlist_matches_exact_hosts_only() {
        let p = EgressPolicy { allow: vec!["api.deepseek.com".into()], proxy_addr: None };
        assert!(p.permits("api.deepseek.com"));
        assert!(!p.permits("evil-api.deepseek.com.attacker.net"),
                "后缀匹配会让 allowlist 形同虚设");
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-exec`
Expected: FAIL，`cannot find type WorkspaceHandle in this scope`

- [ ] **Step 3: 实现**

`crates/evo-exec/Cargo.toml` 的 `[dependencies]`：`evo-protocol.workspace = true`、`serde.workspace = true`、`serde_json.workspace = true`、`async-trait.workspace = true`、`thiserror.workspace = true`

`crates/evo-exec/src/lib.rs`：

```rust
//! 执行面接口。Executor 无状态，凭 lease 从 Gateway 领取 effect 执行。
//!
//! POC 期只有一种实现且与 daemon 同进程，**但 lease 机制现在就存在**——
//! 它现在是结构体传参，将来是一次 RPC 领取，调用点不变。

use async_trait::async_trait;
use evo_protocol::effect::{EffectClass, EffectRequest, EgressRef, ResourceRef};
use evo_protocol::events::effect::{ExecutionMode, ToolResultStatus};
use evo_protocol::ids::{EffectId, ExecutorId, LeaseId, RunId};
use evo_protocol::taint::TaintLevel;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

// 本 crate 的公开 API 里出现的 protocol 类型一并 re-export，
// 免得每个消费者都要同时依赖 evo-protocol 才能构造一个 Lease。
pub use evo_protocol::effect::CapabilityToken;

#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("lease expired: {0}")]
    LeaseExpired(String),
    #[error("path escapes the workspace: {0}")]
    PathEscape(String),
    #[error("blocked sensitive path: {0}")]
    SensitivePath(String),
    #[error("unknown tool: {0}")]
    UnknownTool(String),
    #[error("bad params: {0}")]
    BadParams(String),
}

/// 工作区句柄。**从第一天就是抽象，不是 PathBuf 别名**——
/// Fleet 期它会变成「某个 COW 快照的挂载点」。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceHandle {
    id: String,
    path: PathBuf,
}

impl WorkspaceHandle {
    pub fn new(id: &str, path: PathBuf) -> Self {
        Self { id: id.to_owned(), path }
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// 出口策略。allowlist 是配置，不是代码常量——
/// 开发期与交付形态用同一份代码、不同一份 allowlist（05 §4）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EgressPolicy {
    pub allow: Vec<String>,
    pub proxy_addr: Option<String>,
}

impl EgressPolicy {
    pub fn deny_all() -> Self {
        Self::default()
    }

    /// **精确匹配，不做后缀匹配。** 后缀匹配会让 `evil.deepseek.com.attacker.net`
    /// 通过 allowlist——演示时刻 1 打开出口日志时那就是事故。
    pub fn permits(&self, host: &str) -> bool {
        self.allow.iter().any(|h| h == host)
    }
}

#[derive(Clone, Debug)]
pub struct Lease {
    pub lease_id: LeaseId,
    pub run_id: RunId,
    pub effect_id: EffectId,
    /// 来自 env.sampled，不是执行器自己读时钟
    pub expires_at_ms: u64,
    pub workspace: WorkspaceHandle,
    pub egress_policy: EgressPolicy,
    pub capability: CapabilityToken,
}

#[derive(Clone, Debug)]
pub struct DispatchedEffect {
    pub request: EffectRequest,
    /// 参数正文。Gateway 从 blob 取出后传进来——执行面不直接碰 blob store。
    pub params: serde_json::Value,
    pub mode: ExecutionMode,
}

#[derive(Clone, Debug)]
pub struct EffectOutcome {
    pub status: ToolResultStatus,
    pub output: Option<Vec<u8>>,
    pub output_mime: String,
    pub taint: TaintLevel,
    /// 与 declared_targets 比对：声明只读却在写文件，就是供应链行为异常。
    /// POC 期只记录不拦截，但字段与比对代码现在就写。
    pub actual_targets: Vec<ResourceRef>,
    pub actual_egress: Vec<EgressRef>,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ExecutorCapabilities {
    pub classes: Vec<EffectClass>,
    pub has_network: bool,
    pub platform: String,
}

#[async_trait]
pub trait Executor: Send + Sync {
    fn id(&self) -> ExecutorId;
    fn capabilities(&self) -> ExecutorCapabilities;
    async fn execute(&self, lease: Lease, effect: DispatchedEffect) -> EffectOutcome;
    async fn heartbeat(&self, lease: &Lease) -> Result<(), ExecError>;
}

#[derive(Clone, Debug, Default)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct SandboxOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// 沙箱。**这是调用点，它现在就正确**——
/// macOS seatbelt 实现是同一个 trait 的第二个实现（08 §3）。
#[async_trait]
pub trait Sandbox: Send + Sync {
    async fn spawn(
        &self,
        spec: &CommandSpec,
        ws: &WorkspaceHandle,
        egress: &EgressPolicy,
    ) -> Result<SandboxOutput, ExecError>;

    /// 进 executor capabilities 与交付说明——「这台机器上跑的是哪种沙箱」必须可查。
    fn kind(&self) -> &'static str;
}
```

- [ ] **Step 4: 跑测试**

Run: `cargo test -p evo-exec && cargo clippy -p evo-exec --all-targets -- -D warnings`
Expected: PASS，4 个测试

- [ ] **Step 5: Commit**

```bash
git add crates/evo-exec
git commit -m "feat(exec): Executor / Lease / WorkspaceHandle / Sandbox 接口"
```

---

### Task 12: `evo-exec-local` — 工作区、Linux 沙箱与 `fs.write`

**Files:**
- Create: `crates/evo-exec-local/src/workspace.rs`, `src/sandbox.rs`, `src/executor.rs`
- Create: `crates/evo-exec-local/vendor/README.md`
- Modify: `crates/evo-exec-local/src/lib.rs`, `crates/evo-exec-local/Cargo.toml`

**Interfaces:**
- Consumes: Task 11 的全部 trait 与类型
- Produces:
  - `WorkspaceRoot::new(base: PathBuf)`，`WorkspaceRoot::ensure(&self, run_id: &RunId) -> Result<WorkspaceHandle, ExecError>`
  - `WorkspaceOnlySandbox::new()`，实现 `Sandbox`，`kind() == "workspace-only"`
  - `LocalExecutor::new(sandbox: Arc<dyn Sandbox>)`，实现 `Executor`，M1 支持工具 `fs.write`
  - `pub fn resolve_in_workspace(ws: &WorkspaceHandle, rel: &str) -> Result<PathBuf, ExecError>`
  - `pub const SENSITIVE_PREFIXES: &[&str]`

- [ ] **Step 1: 写失败的测试**

`crates/evo-exec-local/tests/executor.rs`：

```rust
use evo_exec::{
    CapabilityToken, DispatchedEffect, EffectOutcome, EgressPolicy, Executor, Lease,
    WorkspaceHandle,
};
use evo_exec_local::{resolve_in_workspace, LocalExecutor, WorkspaceOnlySandbox, WorkspaceRoot};
use evo_protocol::effect::{EffectClass, EffectRequest};
use evo_protocol::events::effect::{ExecutionMode, ToolResultStatus};
use evo_protocol::{BlobRef, EffectId, LeaseId, RunId, TaintLevel, ToolId};
use std::sync::Arc;

fn lease(ws: WorkspaceHandle) -> Lease {
    Lease {
        lease_id: LeaseId::from("l-1"),
        run_id: RunId::from("r-1"),
        effect_id: EffectId::from("e-1"),
        expires_at_ms: u64::MAX,
        workspace: ws,
        egress_policy: EgressPolicy::deny_all(),
        capability: CapabilityToken { subject: "u-1".into(), scopes: vec!["*".into()] },
    }
}

fn write_effect(path: &str, content: &str) -> DispatchedEffect {
    DispatchedEffect {
        request: EffectRequest {
            effect_id: EffectId::from("e-1"),
            run_id: RunId::from("r-1"),
            turn: 0,
            tool: ToolId::from("fs.write"),
            params_ref: BlobRef {
                content_hash: "sha256:aa".into(),
                size: 0,
                mime: "application/json".into(),
            },
            params_digest: "d".into(),
            class: EffectClass::Write,
            targets: Vec::new(),
            egress: Vec::new(),
            reversible: true,
            taint: TaintLevel::Clean,
            cites_referenced: Vec::new(),
            capability: CapabilityToken { subject: "u-1".into(), scopes: vec!["*".into()] },
        },
        params: serde_json::json!({ "path": path, "content": content }),
        mode: ExecutionMode::Live,
    }
}

async fn run(path: &str, content: &str) -> (tempfile::TempDir, EffectOutcome, WorkspaceHandle) {
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    let exec = LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()));
    let outcome = exec.execute(lease(ws.clone()), write_effect(path, content)).await;
    (dir, outcome, ws)
}

#[tokio::test]
async fn fs_write_lands_inside_the_workspace() {
    let (_d, outcome, ws) = run("report.txt", "hello").await;
    assert_eq!(outcome.status, ToolResultStatus::Ok);
    assert_eq!(std::fs::read_to_string(ws.path().join("report.txt")).unwrap(), "hello");
}

#[tokio::test]
async fn actual_targets_are_reported_for_supply_chain_comparison() {
    let (_d, outcome, _ws) = run("report.txt", "hello").await;
    assert_eq!(outcome.actual_targets.len(), 1);
    assert_eq!(outcome.actual_targets[0].kind, "file");
    assert!(outcome.actual_targets[0].id.ends_with("report.txt"));
}

#[tokio::test]
async fn a_path_escaping_the_workspace_is_refused() {
    let (_d, outcome, _ws) = run("../../etc/passwd", "x").await;
    assert_eq!(outcome.status, ToolResultStatus::Error);
    assert!(outcome.error.unwrap().contains("escapes the workspace"));
}

#[tokio::test]
async fn an_absolute_path_is_refused() {
    let (_d, outcome, _ws) = run("/etc/passwd", "x").await;
    assert_eq!(outcome.status, ToolResultStatus::Error);
}

#[test]
fn sensitive_paths_are_blocked_even_when_they_resolve_inside() {
    // 这几个路径不在策略的可及范围内——策略可以放宽目录权限，
    // 但它们是硬拦截（05 §3 最后一行）
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let ws = root.ensure(&RunId::from("r-1")).unwrap();
    std::fs::create_dir_all(ws.path().join(".ssh")).unwrap();
    let err = resolve_in_workspace(&ws, ".ssh/id_rsa").unwrap_err();
    assert!(err.to_string().contains("sensitive"));
}

#[test]
fn each_run_gets_its_own_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let root = WorkspaceRoot::new(dir.path().to_path_buf());
    let a = root.ensure(&RunId::from("r-a")).unwrap();
    let b = root.ensure(&RunId::from("r-b")).unwrap();
    assert_ne!(a.path(), b.path());
    assert!(a.path().is_dir() && b.path().is_dir());
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-exec-local`
Expected: FAIL，`unresolved import evo_exec_local::LocalExecutor`

- [ ] **Step 3: 实现工作区与路径解析**

`crates/evo-exec-local/Cargo.toml` 的 `[dependencies]`：`evo-exec.workspace = true`、`evo-protocol.workspace = true`、`serde_json.workspace = true`、`async-trait.workspace = true`、`tokio.workspace = true`
`[dev-dependencies]`：`tempfile.workspace = true`、`tokio = { workspace = true, features = ["macros", "rt-multi-thread"] }`

`crates/evo-exec-local/src/workspace.rs`：

```rust
use evo_exec::{ExecError, WorkspaceHandle};
use evo_protocol::ids::RunId;
use std::path::{Component, Path, PathBuf};

/// 硬拦截的路径片段。**不是策略可放宽项**——
/// 策略引擎可以放宽目录权限，但这几个不在策略的可及范围内（05 §3）。
pub const SENSITIVE_PREFIXES: &[&str] = &[".ssh", ".aws", ".gnupg", ".config/gcloud", "Library/Keychains"];

/// 每个 run 一个工作区：~/.evowork/workspaces/<run_id>/
pub struct WorkspaceRoot {
    base: PathBuf,
}

impl WorkspaceRoot {
    pub fn new(base: PathBuf) -> Self {
        Self { base }
    }

    pub fn ensure(&self, run_id: &RunId) -> Result<WorkspaceHandle, ExecError> {
        let path = self.base.join(run_id.as_str());
        std::fs::create_dir_all(&path)?;
        // canonicalize 之后再交出去：后续的越界判断依赖一个已解析的真实路径
        let path = path.canonicalize()?;
        Ok(WorkspaceHandle::new(run_id.as_str(), path))
    }
}

/// 把工具给的相对路径解析成工作区内的绝对路径，越界即拒。
///
/// 不用 `canonicalize` 做校验：目标文件还不存在时它会失败。
/// 这里在**词法层**消解 `..`，再比对前缀——对尚不存在的路径同样成立。
pub fn resolve_in_workspace(ws: &WorkspaceHandle, rel: &str) -> Result<PathBuf, ExecError> {
    let candidate = Path::new(rel);
    if candidate.is_absolute() {
        return Err(ExecError::PathEscape(rel.to_owned()));
    }

    let mut stack: Vec<String> = Vec::new();
    for comp in candidate.components() {
        match comp {
            Component::Normal(c) => stack.push(c.to_string_lossy().into_owned()),
            Component::CurDir => {}
            Component::ParentDir => {
                if stack.pop().is_none() {
                    return Err(ExecError::PathEscape(rel.to_owned()));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(ExecError::PathEscape(rel.to_owned()));
            }
        }
    }

    let joined = stack.join("/");
    for prefix in SENSITIVE_PREFIXES {
        if joined == *prefix || joined.starts_with(&format!("{prefix}/")) {
            return Err(ExecError::SensitivePath(joined));
        }
    }

    Ok(ws.path().join(joined))
}
```

- [ ] **Step 4: 实现沙箱与 executor**

`crates/evo-exec-local/src/sandbox.rs`：

```rust
use async_trait::async_trait;
use evo_exec::{CommandSpec, EgressPolicy, ExecError, Sandbox, SandboxOutput, WorkspaceHandle};
use tokio::process::Command;

/// Linux 开发机上的沙箱实现：工作区级隔离 + 强制走 proxy。
///
/// **不做内核级隔离**——那是 macOS seatbelt 实现的事（08 §3）。
/// 但行为语义与 seatbelt 版一致（同一张隔离矩阵，05 §3），
/// 因此沙箱行为的测试可以复用：换实现时换的是隔离手段，不是断言。
pub struct WorkspaceOnlySandbox;

impl WorkspaceOnlySandbox {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WorkspaceOnlySandbox {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Sandbox for WorkspaceOnlySandbox {
    async fn spawn(
        &self,
        spec: &CommandSpec,
        ws: &WorkspaceHandle,
        egress: &EgressPolicy,
    ) -> Result<SandboxOutput, ExecError> {
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args);
        cmd.current_dir(ws.path());
        // 子进程继承同一 profile 与 proxy 设置（05 §3）
        cmd.env_clear();
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        if let Some(addr) = &egress.proxy_addr {
            cmd.env("HTTP_PROXY", addr);
            cmd.env("HTTPS_PROXY", addr);
            cmd.env("http_proxy", addr);
            cmd.env("https_proxy", addr);
            // 没有它，很多客户端会绕过 proxy 直连
            cmd.env("NO_PROXY", "");
        }
        let out = cmd.output().await?;
        Ok(SandboxOutput {
            exit_code: out.status.code().unwrap_or(-1),
            stdout: out.stdout,
            stderr: out.stderr,
        })
    }

    fn kind(&self) -> &'static str {
        "workspace-only"
    }
}
```

`crates/evo-exec-local/src/executor.rs`：

```rust
use crate::workspace::resolve_in_workspace;
use async_trait::async_trait;
use evo_exec::{
    DispatchedEffect, EffectOutcome, ExecError, Executor, ExecutorCapabilities, Lease, Sandbox,
};
use evo_protocol::effect::{EffectClass, ResourceRef};
use evo_protocol::events::effect::ToolResultStatus;
use evo_protocol::ids::ExecutorId;
use evo_protocol::taint::TaintLevel;
use std::sync::Arc;

pub struct LocalExecutor {
    sandbox: Arc<dyn Sandbox>,
}

impl LocalExecutor {
    pub fn new(sandbox: Arc<dyn Sandbox>) -> Self {
        Self { sandbox }
    }

    async fn run_fs_write(
        &self,
        lease: &Lease,
        effect: &DispatchedEffect,
    ) -> Result<Vec<ResourceRef>, ExecError> {
        let path = effect.params.get("path").and_then(|v| v.as_str())
            .ok_or_else(|| ExecError::BadParams("missing /path".into()))?;
        let content = effect.params.get("content").and_then(|v| v.as_str())
            .ok_or_else(|| ExecError::BadParams("missing /content".into()))?;
        let target = resolve_in_workspace(&lease.workspace, path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&target, content)?;
        Ok(vec![ResourceRef {
            kind: "file".to_owned(),
            id: target.to_string_lossy().into_owned(),
        }])
    }
}

#[async_trait]
impl Executor for LocalExecutor {
    fn id(&self) -> ExecutorId {
        ExecutorId::from("local")
    }

    fn capabilities(&self) -> ExecutorCapabilities {
        ExecutorCapabilities {
            classes: vec![EffectClass::Read, EffectClass::Write, EffectClass::Compute],
            has_network: false,
            platform: format!("{}:{}", std::env::consts::OS, self.sandbox.kind()),
        }
    }

    async fn execute(&self, lease: Lease, effect: DispatchedEffect) -> EffectOutcome {
        let result = match effect.request.tool.as_str() {
            "fs.write" => self.run_fs_write(&lease, &effect).await,
            other => Err(ExecError::UnknownTool(other.to_owned())),
        };
        match result {
            Ok(actual_targets) => EffectOutcome {
                status: ToolResultStatus::Ok,
                output: None,
                output_mime: "application/octet-stream".to_owned(),
                taint: TaintLevel::Clean,
                actual_targets,
                actual_egress: Vec::new(),
                error: None,
            },
            Err(e) => EffectOutcome {
                status: ToolResultStatus::Error,
                output: None,
                output_mime: "text/plain".to_owned(),
                taint: TaintLevel::Clean,
                actual_targets: Vec::new(),
                actual_egress: Vec::new(),
                error: Some(e.to_string()),
            },
        }
    }

    async fn heartbeat(&self, _lease: &Lease) -> Result<(), ExecError> {
        Ok(())
    }
}
```

`crates/evo-exec-local/src/lib.rs`：

```rust
pub mod executor;
pub mod sandbox;
pub mod workspace;

pub use executor::LocalExecutor;
pub use sandbox::WorkspaceOnlySandbox;
pub use workspace::{resolve_in_workspace, WorkspaceRoot, SENSITIVE_PREFIXES};
```

- [ ] **Step 5: 建 vendor 目录占位并说明**

`crates/evo-exec-local/vendor/README.md`：

```markdown
# 受控 vendor

本目录存放 codex 上游代码的受控副本。**目录内不做任何修改**——
需要适配就在外面包一层。改了 vendor 目录就是借错了层（08 §3 规则 4）。

## 当前状态

M1 阶段 0/1 期间本目录为空：开发机是 Linux，macOS seatbelt 子集
（`codex-seatbelt/`）无法编译与实测，按已定的「接口先行」方案推迟到
拿到 macOS 真机后再同步。

`Sandbox` trait 与 `WorkspaceOnlySandbox` 已就位，seatbelt 实现是同一个
trait 的第二个实现，接入时不动调用点。

## 同步

同步由 `scripts/sync-codex-vendor.sh` 一条命令完成，不是手工拷贝。
每个子目录带一个 `UPSTREAM` 文件，记录来源 repo、rev、路径、同步日期与
Apache-2.0 声明。CI 检查 6 校验本目录与上游 pin 住的 rev 逐字节一致。

上游 rev（POC 期冻结）：`c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3`
```

- [ ] **Step 6: 跑测试**

Run: `cargo test -p evo-exec-local && cargo clippy -p evo-exec-local --all-targets -- -D warnings`
Expected: PASS，6 个测试

- [ ] **Step 7: Commit**

```bash
git add crates/evo-exec-local
git commit -m "feat(exec-local): 工作区隔离、Linux 沙箱与 fs.write"
```

---

### Task 13: `evo-model` — adapter 接口、`FixtureAdapter` 与定价表

**金额算在我们这边**（01 §4.5 细节 1）：codex 的 `TokenUsage` 只有 token 数，金额来自 OpenAI 后端，换任何供应商都拿不到。所以定价表必须是我们自己的一张表，且版本化——**改价不能改历史账**。

**Files:**
- Create: `crates/evo-model/src/adapter.rs`, `src/fixture.rs`, `src/pricing.rs`
- Modify: `crates/evo-model/src/lib.rs`, `crates/evo-model/Cargo.toml`
- Create: `config/pricing.toml`

**Interfaces:**
- Consumes: `evo_protocol` 的 `Usage` / `ModelParams` / `CostCharged` / `CostUnit` / `Currency` / `CostDimension`
- Produces:
  - `ModelRequest { messages: Vec<Message>, params: ModelParams }`，`Message { role: String, content: String }`
  - `ModelResponse { text: String, usage: Usage, stop_reason: String, latency_ms: u64 }`
  - `#[async_trait] trait ModelAdapter { fn provider(&self) -> &str; fn model(&self) -> &str; async fn call(&self, req: &ModelRequest) -> Result<ModelResponse, ModelError>; }`
  - `pub fn request_digest(req: &ModelRequest) -> String`
  - `FixtureAdapter::from_json_str(s: &str) -> Result<FixtureAdapter, ModelError>`，`FixtureAdapter::from_path(&Path)`
  - `PriceTable::from_toml_str(s: &str)`，`PriceTable::charges(&self, provider, model, usage, dimension, turn) -> Vec<CostCharged>`

- [ ] **Step 1: 写失败的测试**

`crates/evo-model/tests/model.rs`：

```rust
use evo_model::{request_digest, FixtureAdapter, Message, ModelAdapter, ModelRequest, PriceTable};
use evo_protocol::events::accounting::{CostDimension, CostUnit, Currency};
use evo_protocol::events::model::{ModelParams, Usage};
use evo_protocol::RunId;

const FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    { "text": "{\"intent\":\"tool_call\",\"tool\":\"fs.write\"}",
      "usage": { "input": 120, "output": 40, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 12 },
    { "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 200, "output": 10, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 9 }
  ]
}"#;

const PRICING: &str = r#"
version = "poc-1"
currency = "CNY"

[[model]]
provider = "fixture"
model = "fixture-v1"
input_micros_per_token = 1
output_micros_per_token = 2
cache_read_micros_per_token = 0
cache_write_micros_per_token = 0
"#;

fn req() -> ModelRequest {
    ModelRequest {
        messages: vec![Message { role: "user".into(), content: "做账龄表".into() }],
        params: ModelParams { temperature: 0.0, max_tokens: None },
    }
}

#[tokio::test]
async fn fixture_returns_responses_in_order() {
    let a = FixtureAdapter::from_json_str(FIXTURES).unwrap();
    assert_eq!(a.provider(), "fixture");
    let first = a.call(&req()).await.unwrap();
    assert!(first.text.contains("tool_call"));
    let second = a.call(&req()).await.unwrap();
    assert!(second.text.contains("finish"));
}

#[tokio::test]
async fn running_out_of_fixtures_is_an_error_not_a_silent_repeat() {
    let a = FixtureAdapter::from_json_str(FIXTURES).unwrap();
    a.call(&req()).await.unwrap();
    a.call(&req()).await.unwrap();
    assert!(a.call(&req()).await.is_err(), "用尽 fixture 必须报错，否则回放会静默走偏");
}

#[test]
fn request_digest_is_stable_and_content_sensitive() {
    let a = request_digest(&req());
    assert_eq!(a, request_digest(&req()));
    let mut other = req();
    other.messages[0].content = "换个说法".into();
    assert_ne!(a, request_digest(&other));
}

#[test]
fn pricing_produces_one_charge_per_non_zero_unit() {
    let t = PriceTable::from_toml_str(PRICING).unwrap();
    let usage = Usage { input: 120, output: 40, cache_read: 0, cache_write: 0 };
    let dim = CostDimension {
        principal: "u-1".into(), team: None, run_id: RunId::from("r-1"), skill: None, tool: None,
    };
    let charges = t.charges("fixture", "fixture-v1", &usage, &dim, Some(0));
    assert_eq!(charges.len(), 2, "cache 用量为 0 时不产生记账行");
    let input = charges.iter().find(|c| c.unit == CostUnit::InputToken).unwrap();
    assert_eq!(input.quantity, 120);
    assert_eq!(input.unit_price_micros, 1);
    assert_eq!(input.amount_micros, 120);
    assert_eq!(input.currency, Currency::CNY);
    assert_eq!(input.price_table_ver, "poc-1", "改价不能改历史账，版本号必须落进事件");
}

#[test]
fn amounts_are_integers_so_the_books_balance() {
    let t = PriceTable::from_toml_str(PRICING).unwrap();
    let usage = Usage { input: 3, output: 7, cache_read: 0, cache_write: 0 };
    let dim = CostDimension {
        principal: "u-1".into(), team: None, run_id: RunId::from("r-1"), skill: None, tool: None,
    };
    let total: u64 = t.charges("fixture", "fixture-v1", &usage, &dim, None)
        .iter().map(|c| c.amount_micros).sum();
    assert_eq!(total, 3 * 1 + 7 * 2);
}

#[test]
fn an_unknown_model_yields_no_charges_rather_than_a_wrong_number() {
    let t = PriceTable::from_toml_str(PRICING).unwrap();
    let usage = Usage { input: 10, output: 10, cache_read: 0, cache_write: 0 };
    let dim = CostDimension {
        principal: "u-1".into(), team: None, run_id: RunId::from("r-1"), skill: None, tool: None,
    };
    assert!(t.charges("openai", "gpt-9", &usage, &dim, None).is_empty());
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-model`
Expected: FAIL，`unresolved import evo_model::FixtureAdapter`

- [ ] **Step 3: 实现 adapter 与 fixture**

`crates/evo-model/Cargo.toml` 的 `[dependencies]`：`evo-protocol.workspace = true`、`serde.workspace = true`、`serde_json.workspace = true`、`sha2.workspace = true`、`hex.workspace = true`、`toml.workspace = true`、`async-trait.workspace = true`、`thiserror.workspace = true`
`[dev-dependencies]`：`tokio = { workspace = true, features = ["macros", "rt-multi-thread"] }`

`crates/evo-model/src/adapter.rs`：

```rust
use async_trait::async_trait;
use evo_protocol::events::model::{ModelParams, Usage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelRequest {
    pub messages: Vec<Message>,
    pub params: ModelParams,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ModelResponse {
    pub text: String,
    pub usage: Usage,
    pub stop_reason: String,
    pub latency_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum ModelError {
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("toml: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("fixture exhausted after {0} responses")]
    FixtureExhausted(usize),
}

#[async_trait]
pub trait ModelAdapter: Send + Sync {
    fn provider(&self) -> &str;
    fn model(&self) -> &str;
    async fn call(&self, req: &ModelRequest) -> Result<ModelResponse, ModelError>;
}

/// 进 model.requested.request_digest。回放时重建请求并比对——
/// 不一致说明装配器有非确定性，直接报错而不是继续（01 §5）。
pub fn request_digest(req: &ModelRequest) -> String {
    let canonical = serde_json::to_vec(req).expect("ModelRequest 必须可序列化");
    format!("sha256:{}", hex::encode(Sha256::digest(&canonical)))
}
```

`crates/evo-model/src/fixture.rs`：

```rust
use crate::adapter::{ModelAdapter, ModelError, ModelRequest, ModelResponse};
use async_trait::async_trait;
use serde::Deserialize;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Debug, Deserialize)]
struct FixtureFile {
    provider: String,
    model: String,
    responses: Vec<ModelResponse>,
}

/// M1 的模型实现：从文件读固定响应，按调用顺序返回。
///
/// 回放本来就不重新调模型（01 §5），所以判据 3 的验证一点不打折。
/// 真 DeepSeek / GPT adapter 是 M2 的事（09）。
pub struct FixtureAdapter {
    file: FixtureFile,
    cursor: AtomicUsize,
}

impl FixtureAdapter {
    pub fn from_json_str(s: &str) -> Result<Self, ModelError> {
        Ok(Self { file: serde_json::from_str(s)?, cursor: AtomicUsize::new(0) })
    }

    pub fn from_path(p: &Path) -> Result<Self, ModelError> {
        Self::from_json_str(&std::fs::read_to_string(p)?)
    }
}

#[async_trait]
impl ModelAdapter for FixtureAdapter {
    fn provider(&self) -> &str {
        &self.file.provider
    }

    fn model(&self) -> &str {
        &self.file.model
    }

    async fn call(&self, _req: &ModelRequest) -> Result<ModelResponse, ModelError> {
        let i = self.cursor.fetch_add(1, Ordering::SeqCst);
        // 用尽即报错，绝不循环复用：静默重复会让「跑通了」变成假象
        self.file
            .responses
            .get(i)
            .cloned()
            .ok_or(ModelError::FixtureExhausted(self.file.responses.len()))
    }
}
```

- [ ] **Step 4: 实现定价表**

`crates/evo-model/src/pricing.rs`：

```rust
use crate::adapter::ModelError;
use evo_protocol::events::accounting::{CostCharged, CostDimension, CostUnit, Currency};
use evo_protocol::events::model::Usage;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Deserialize)]
struct PriceEntry {
    provider: String,
    model: String,
    input_micros_per_token: u64,
    output_micros_per_token: u64,
    #[serde(default)]
    cache_read_micros_per_token: u64,
    #[serde(default)]
    cache_write_micros_per_token: u64,
}

#[derive(Debug, Deserialize)]
struct PriceFile {
    version: String,
    currency: Currency,
    #[serde(default, rename = "model")]
    models: Vec<PriceEntry>,
}

/// 产品自己的定价表，版本化。
///
/// 金额算在我们这边：codex 的 TokenUsage 只有 token 数，金额来自后端，
/// 换任何供应商都拿不到（01 §4.5）。
pub struct PriceTable {
    file: PriceFile,
}

impl PriceTable {
    pub fn from_toml_str(s: &str) -> Result<Self, ModelError> {
        Ok(Self { file: toml::from_str(s)? })
    }

    pub fn from_path(p: &Path) -> Result<Self, ModelError> {
        Self::from_toml_str(&std::fs::read_to_string(p)?)
    }

    pub fn version(&self) -> &str {
        &self.file.version
    }

    /// 一次模型往返产生的全部记账行。用量为 0 的单位不产生记账行。
    ///
    /// **micros 整数，不用浮点**——财务客户，账要对得上。
    pub fn charges(
        &self,
        provider: &str,
        model: &str,
        usage: &Usage,
        dimension: &CostDimension,
        turn: Option<u32>,
    ) -> Vec<CostCharged> {
        let Some(e) = self
            .file
            .models
            .iter()
            .find(|e| e.provider == provider && e.model == model)
        else {
            // 表里没有就不出账，而不是按 0 出一笔「看起来对」的账
            return Vec::new();
        };

        let rows = [
            (CostUnit::InputToken, usage.input, e.input_micros_per_token),
            (CostUnit::OutputToken, usage.output, e.output_micros_per_token),
            (CostUnit::CacheRead, usage.cache_read, e.cache_read_micros_per_token),
            (CostUnit::CacheWrite, usage.cache_write, e.cache_write_micros_per_token),
        ];

        rows.into_iter()
            .filter(|(_, qty, _)| *qty > 0)
            .map(|(unit, quantity, unit_price_micros)| CostCharged {
                effect_id: None,
                turn,
                unit,
                quantity,
                unit_price_micros,
                amount_micros: quantity * unit_price_micros,
                currency: self.file.currency,
                price_table_ver: self.file.version.clone(),
                dimension: dimension.clone(),
            })
            .collect()
    }
}
```

`crates/evo-model/src/lib.rs`：

```rust
pub mod adapter;
pub mod fixture;
pub mod pricing;

pub use adapter::{request_digest, Message, ModelAdapter, ModelError, ModelRequest, ModelResponse};
pub use fixture::FixtureAdapter;
pub use pricing::PriceTable;
```

`config/pricing.toml` 内容与测试里的 `PRICING` 常量一致，文件头加一行：

```toml
# POC 期定价表。Q-05（对客户呈现的口径与汇率来源）未定，此处记原币，折算放查询层。
```

- [ ] **Step 5: 跑测试**

Run: `cargo test -p evo-model && cargo clippy -p evo-model --all-targets -- -D warnings`
Expected: PASS，6 个测试

- [ ] **Step 6: Commit**

```bash
git add crates/evo-model config/pricing.toml
git commit -m "feat(model): adapter 接口、FixtureAdapter 与版本化定价表"
```

---

### Task 14: `evo-gateway` — 工具 manifest 与六步管线

02 那条判据的落点：**新接入一个工具，不改任何治理代码，它自动获得 dry-run、影响预估、审计、记账、限流。**

阶段 1 实现步骤 ①②③④⑥ 与 record-only 的 dry-run 降级；步骤 ⑤ 预算闸门与审批挂起留到阶段 2。**污点检查（③）在策略求值（④）之前**——这条不是顺序偏好，是结构约束：策略可以放宽目录权限，不能放宽「不可信内容不得触发提权动作」。

**Files:**
- Create: `crates/evo-gateway/src/manifest.rs`, `src/impact.rs`, `src/pipeline.rs`
- Modify: `crates/evo-gateway/src/lib.rs`, `crates/evo-gateway/Cargo.toml`
- Create: `config/tools.toml`

**Interfaces:**
- Consumes: Task 10 的 `PolicyHook` / `PolicyContext` / `PolicyDecision`；Task 3 的事件类型
- Produces:
  - `ToolManifest { name: String, class: EffectClass, reversible: bool, targets: Vec<TargetSpec>, egress: Vec<EgressRef>, preview: Option<String> }`
  - `TargetSpec { FromParam { pointer: String, kind: String, op: ResourceOp }, Literal { id: String, kind: String, op: ResourceOp } }`
  - `ManifestRegistry::from_toml_str(s: &str)`，`ManifestRegistry::get(&self, tool: &ToolId) -> Option<&ToolManifest>`，`ManifestRegistry::strictest_default() -> ToolManifest`
  - `Gateway::new(policy: Box<dyn PolicyHook>, manifests: ManifestRegistry)`
  - `Gateway::admit(&self, req: AdmitRequest) -> GatewayVerdict`
  - `AdmitRequest { effect_id, run_id, turn, call: PlannedCall, params: serde_json::Value, taint, cites_referenced, capability, mode }`
  - `GatewayVerdict { events: Vec<EventBody>, action: GatewayAction }`
  - `GatewayAction { Dispatch(EffectRequest), DryRun { request: EffectRequest }, Deny { reason_code: String }, AwaitApproval { risk: RiskLevel, request: EffectRequest } }`

> **Gateway 不写 Log。** 它返回「要追加哪些事件」，由 daemon 落盘——这是「只有 evo-daemon 写 Run Log」在类型上的形态。

- [ ] **Step 1: 写失败的测试**

`crates/evo-gateway/tests/pipeline.rs`：

```rust
use evo_gateway::{AdmitRequest, Gateway, GatewayAction, ManifestRegistry};
use evo_policy::{HardcodedPolicy, RiskLevel};
use evo_protocol::effect::CapabilityToken;
use evo_protocol::events::effect::{ExecutionMode, PolicyDecisionKind, ToolResultStatus};
use evo_protocol::events::model::PlannedCall;
use evo_protocol::{BlobRef, EffectClass, EffectId, EventBody, RunId, TaintLevel, ToolId};

const TOOLS: &str = r#"
[[method]]
name = "fs.write"
class = "write"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "update" }]

[[method]]
name = "fs.read"
class = "read"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "read" }]
"#;

const POLICY: &str = r#"
version = "poc-1"

[[rule]]
id = "read-is-free"
class = "read"
decision = "allow"

[[rule]]
id = "external-needs-approval"
class = "external"
decision = "require_approval"
risk = "l3"
"#;

fn gateway() -> Gateway {
    Gateway::new(
        Box::new(HardcodedPolicy::from_toml_str(POLICY).unwrap()),
        ManifestRegistry::from_toml_str(TOOLS).unwrap(),
    )
}

fn admit(tool: &str, taint: TaintLevel, mode: ExecutionMode) -> AdmitRequest {
    AdmitRequest {
        effect_id: EffectId::from("e-1"),
        run_id: RunId::from("r-1"),
        turn: 0,
        call: PlannedCall {
            tool: ToolId::from(tool),
            params_ref: BlobRef {
                content_hash: "sha256:aa".into(), size: 2, mime: "application/json".into(),
            },
            params_digest: "d1".into(),
        },
        params: serde_json::json!({ "path": "report.txt", "content": "x" }),
        taint,
        cites_referenced: Vec::new(),
        capability: CapabilityToken { subject: "u-1".into(), scopes: vec!["*".into()] },
        mode,
    }
}

fn kinds(v: &[EventBody]) -> Vec<&'static str> {
    v.iter().map(|e| e.kind()).collect()
}

#[test]
fn every_step_writes_an_event_so_the_gateway_itself_is_replayable() {
    let verdict = gateway().admit(admit("fs.write", TaintLevel::Clean, ExecutionMode::Live));
    assert_eq!(
        kinds(&verdict.events),
        vec!["tool.requested", "policy.evaluated", "impact.estimated"]
    );
}

#[test]
fn manifest_fields_are_filled_by_the_gateway_not_the_tool() {
    let verdict = gateway().admit(admit("fs.write", TaintLevel::Clean, ExecutionMode::Live));
    let GatewayAction::Dispatch(req) = verdict.action else { panic!("应当派发") };
    assert_eq!(req.class, EffectClass::Write);
    assert!(req.reversible);
    assert_eq!(req.targets.len(), 1, "targets 从 /path 静态提取");
    assert_eq!(req.targets[0].id, "report.txt");
}

#[test]
fn the_rule_that_decided_is_named_in_the_event() {
    let verdict = gateway().admit(admit("fs.read", TaintLevel::Clean, ExecutionMode::Live));
    let pe = verdict.events.iter().find(|e| e.kind() == "policy.evaluated").unwrap();
    let EventBody::PolicyEvaluated(pe) = pe else { unreachable!() };
    assert_eq!(pe.rules_hit, vec!["read-is-free".to_owned()],
               "审计要能回答「凭哪条规则放的行」");
    assert_eq!(pe.policy_ver, "poc-1");
}

#[test]
fn impact_is_estimated_unconditionally_not_only_in_dry_run() {
    // 02 §2 细节 2：影响预估是审计与审批材料的一部分，正常模式下也要有
    let verdict = gateway().admit(admit("fs.write", TaintLevel::Clean, ExecutionMode::Live));
    assert!(verdict.events.iter().any(|e| e.kind() == "impact.estimated"));
}

#[test]
fn a_tool_with_no_manifest_gets_the_strictest_treatment() {
    // 忘记写 manifest 的后果是「多问一次人」，不是「静默漏掉治理」（02 §4）
    let verdict = gateway().admit(admit("mcp:unknown/do_thing", TaintLevel::Clean, ExecutionMode::Live));
    let GatewayAction::AwaitApproval { risk, request } = verdict.action else {
        panic!("无 manifest 必须要求审批")
    };
    assert_eq!(risk, RiskLevel::L3);
    assert_eq!(request.class, EffectClass::External);
    assert!(!request.reversible);
}

#[test]
fn tainted_context_forces_approval_even_when_policy_would_allow() {
    // 03 在 04 之前：策略不能放行污点检查（02 §2 细节 1）
    let verdict = gateway().admit(admit("fs.write", TaintLevel::Tainted, ExecutionMode::Live));
    assert!(matches!(verdict.action, GatewayAction::AwaitApproval { .. }));
    let pe = verdict.events.iter().find(|e| e.kind() == "policy.evaluated").unwrap();
    let EventBody::PolicyEvaluated(pe) = pe else { unreachable!() };
    assert_eq!(pe.decision, PolicyDecisionKind::RequireApproval);
    assert_eq!(pe.reason_code, "taint_gate");
}

#[test]
fn a_tainted_read_is_still_allowed() {
    // 污点闸门只挡 class != Read 的动作
    let verdict = gateway().admit(admit("fs.read", TaintLevel::Tainted, ExecutionMode::Live));
    assert!(matches!(verdict.action, GatewayAction::Dispatch(_)));
}

#[test]
fn dry_run_suppresses_writes_and_produces_a_tool_result() {
    let verdict = gateway().admit(admit("fs.write", TaintLevel::Clean, ExecutionMode::DryRun));
    assert!(matches!(verdict.action, GatewayAction::DryRun { .. }));
    let tr = verdict.events.iter().find(|e| e.kind() == "tool.result").unwrap();
    let EventBody::ToolResult(tr) = tr else { unreachable!() };
    assert_eq!(tr.status, ToolResultStatus::DryRun);
}

#[test]
fn dry_run_still_executes_reads_or_the_estimate_would_be_wrong() {
    let verdict = gateway().admit(admit("fs.read", TaintLevel::Clean, ExecutionMode::DryRun));
    assert!(matches!(verdict.action, GatewayAction::Dispatch(_)),
            "Read 在 dry-run 下照常执行（02 §1）");
}

#[test]
fn judgement_one_a_brand_new_tool_gets_governance_for_free() {
    // 02 那条判据：新接入一个工具，不改任何治理代码，它自动获得
    // dry-run、影响预估、审计。这里的 "report.render" 只在 manifest 里
    // 声明了一行，Gateway 不认识它，治理照样生效。
    const WITH_NEW_TOOL: &str = r#"
[[method]]
name = "report.render"
class = "write"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "create" }]
"#;
    let gw = Gateway::new(
        Box::new(HardcodedPolicy::from_toml_str(POLICY).unwrap()),
        ManifestRegistry::from_toml_str(WITH_NEW_TOOL).unwrap(),
    );

    // 审计：三个事件一个不少
    let live = gw.admit(admit("report.render", TaintLevel::Clean, ExecutionMode::Live));
    assert_eq!(
        kinds(&live.events),
        vec!["tool.requested", "policy.evaluated", "impact.estimated"]
    );
    // 影响预估：targets 从参数静态提取，工具作者没写一行治理代码
    let ie = live.events.iter().find(|e| e.kind() == "impact.estimated").unwrap();
    let EventBody::ImpactEstimated(ie) = ie else { unreachable!() };
    assert_eq!(ie.targets.len(), 1);

    // dry-run：工具完全不知道自己在 dry-run 下
    let dry = gw.admit(admit("report.render", TaintLevel::Clean, ExecutionMode::DryRun));
    assert!(matches!(dry.action, GatewayAction::DryRun { .. }));
}

#[test]
fn a_capability_that_does_not_cover_the_tool_denies_the_effect() {
    let mut req = admit("fs.write", TaintLevel::Clean, ExecutionMode::Live);
    req.capability = CapabilityToken { subject: "u-1".into(), scopes: vec!["fs.read".into()] };
    let verdict = gateway().admit(req);
    let GatewayAction::Deny { reason_code } = verdict.action else { panic!("应当拒绝") };
    assert_eq!(reason_code, "capability_scope");
    assert!(verdict.events.iter().any(|e| e.kind() == "policy.evaluated"),
            "被拒绝的调用是审计里最有价值的记录，必须写事件（02 §2 细节 3）");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-gateway`
Expected: FAIL，`unresolved import evo_gateway::Gateway`

- [ ] **Step 3: 实现 manifest**

`crates/evo-gateway/Cargo.toml` 的 `[dependencies]`：`evo-protocol.workspace = true`、`evo-policy.workspace = true`、`serde.workspace = true`、`serde_json.workspace = true`、`toml.workspace = true`、`thiserror.workspace = true`

> `evo-gateway` 依赖 `evo-policy` 是 00 §2 依赖图上明确允许的一条（`evo-gateway ← protocol + policy`）。

`crates/evo-gateway/src/manifest.rs`：

```rust
use evo_protocol::effect::{EffectClass, EgressRef, ResourceOp, ResourceRef};
use evo_protocol::ids::ToolId;
use serde::Deserialize;
use std::collections::BTreeMap;

/// 目标资源怎么从参数里静态提取。工具作者写的是**声明**，不是治理代码。
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum TargetSpec {
    /// JSON Pointer 指向参数里的某个字段
    FromParam { from_param: String, kind: String, op: ResourceOp },
    Literal { literal: String, kind: String, op: ResourceOp },
}

impl TargetSpec {
    pub fn resolve(&self, params: &serde_json::Value) -> Option<(ResourceRef, ResourceOp)> {
        match self {
            Self::FromParam { from_param, kind, op } => {
                let v = params.pointer(from_param)?.as_str()?;
                Some((ResourceRef { kind: kind.clone(), id: v.to_owned() }, *op))
            }
            Self::Literal { literal, kind, op } => {
                Some((ResourceRef { kind: kind.clone(), id: literal.clone() }, *op))
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct ToolManifest {
    pub name: String,
    pub class: EffectClass,
    #[serde(default)]
    pub reversible: bool,
    #[serde(default)]
    pub targets: Vec<TargetSpec>,
    #[serde(default)]
    pub egress: Vec<EgressRef>,
    /// 声明了 preview 的工具在 dry-run 下能给出精确 diff（降级第 1 级）。
    /// 阶段 1 只读这个字段决定 precision，不真的调 preview。
    #[serde(default)]
    pub preview: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ManifestFile {
    #[serde(default, rename = "method")]
    methods: Vec<ToolManifest>,
}

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("toml: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub struct ManifestRegistry {
    by_name: BTreeMap<String, ToolManifest>,
}

impl ManifestRegistry {
    pub fn from_toml_str(s: &str) -> Result<Self, ManifestError> {
        let file: ManifestFile = toml::from_str(s)?;
        Ok(Self {
            by_name: file.methods.into_iter().map(|m| (m.name.clone(), m)).collect(),
        })
    }

    pub fn from_path(p: &std::path::Path) -> Result<Self, ManifestError> {
        Self::from_toml_str(&std::fs::read_to_string(p)?)
    }

    pub fn get(&self, tool: &ToolId) -> Option<&ToolManifest> {
        self.by_name.get(tool.as_str())
    }

    /// 未提供 manifest 的工具按最严处理：External + 不可逆 + 需审批。
    ///
    /// **这个默认值是有意选成最严的**：忘记写 manifest 的后果是「多问一次人」，
    /// 不是「静默漏掉治理」。反过来设默认值是这类系统最常见的失误（02 §4）。
    pub fn strictest_default(tool: &ToolId) -> ToolManifest {
        ToolManifest {
            name: tool.as_str().to_owned(),
            class: EffectClass::External,
            reversible: false,
            targets: Vec::new(),
            egress: Vec::new(),
            preview: None,
        }
    }
}
```

- [ ] **Step 4: 实现影响预估与六步管线**

`crates/evo-gateway/src/impact.rs`：

```rust
use crate::manifest::ToolManifest;
use evo_protocol::events::effect::{ImpactEstimated, ImpactPrecision, ImpactTarget};
use evo_protocol::ids::EffectId;

/// 三级降级（02 §3）。第 2、3 级不阻塞接入——
/// 如果只有实现了 preview 的工具才能接入，门槛会高到没人接，
/// 最后一定有人加个后门绕过 Gateway。
pub fn estimate(
    effect_id: &EffectId,
    manifest: &ToolManifest,
    params: &serde_json::Value,
) -> ImpactEstimated {
    let targets: Vec<ImpactTarget> = manifest
        .targets
        .iter()
        .filter_map(|t| t.resolve(params))
        .map(|(resource, op)| ImpactTarget { resource, op, detail_ref: None })
        .collect();

    // 阶段 1 不真的调 preview：声明了 preview 的工具在阶段 2 才走第 1 级。
    // 此处按 targets 能否静态提取区分第 2、3 级——两级的 precision 都是 declared_only。
    ImpactEstimated {
        effect_id: effect_id.clone(),
        targets,
        externals: manifest.egress.clone(),
        est_cost_micros: None,
        precision: ImpactPrecision::DeclaredOnly,
    }
}
```

`crates/evo-gateway/src/pipeline.rs`：

```rust
use crate::impact::estimate;
use crate::manifest::ManifestRegistry;
use evo_policy::{PolicyContext, PolicyDecision, PolicyHook, RiskLevel};
use evo_protocol::effect::{CapabilityToken, EffectClass, EffectRequest};
use evo_protocol::events::effect::{
    ExecutionMode, PolicyDecisionKind, PolicyEvaluated, ToolRequested, ToolResult, ToolResultStatus,
};
use evo_protocol::events::model::PlannedCall;
use evo_protocol::ids::{CiteId, EffectId, RunId};
use evo_protocol::taint::TaintLevel;
use evo_protocol::EventBody;

pub struct AdmitRequest {
    pub effect_id: EffectId,
    pub run_id: RunId,
    pub turn: u32,
    pub call: PlannedCall,
    /// 参数正文。daemon 从 blob 取出后传进来。
    pub params: serde_json::Value,
    pub taint: TaintLevel,
    pub cites_referenced: Vec<CiteId>,
    pub capability: CapabilityToken,
    pub mode: ExecutionMode,
}

pub enum GatewayAction {
    Dispatch(EffectRequest),
    DryRun { request: EffectRequest },
    Deny { reason_code: String },
    AwaitApproval { risk: RiskLevel, request: EffectRequest },
}

/// Gateway 的产出：要追加哪些事件，以及接下来做什么。
///
/// **Gateway 不写 Log**——由 daemon 落盘。这是「只有 evo-daemon 写 Run Log」
/// 在类型上的形态。
pub struct GatewayVerdict {
    pub events: Vec<EventBody>,
    pub action: GatewayAction,
}

pub struct Gateway {
    policy: Box<dyn PolicyHook>,
    manifests: ManifestRegistry,
}

impl Gateway {
    pub fn new(policy: Box<dyn PolicyHook>, manifests: ManifestRegistry) -> Self {
        Self { policy, manifests }
    }

    /// 六步管线。每一步产出一个事件——**「Gateway 做了什么」本身可回放、可举证**，
    /// 而不是一堆日志行。每一步失败也要先写事件再返回。
    pub fn admit(&self, req: AdmitRequest) -> GatewayVerdict {
        let mut events = Vec::new();

        // 无 manifest 即最严
        let manifest = match self.manifests.get(&req.call.tool) {
            Some(m) => m.clone(),
            None => ManifestRegistry::strictest_default(&req.call.tool),
        };

        let targets: Vec<_> = manifest
            .targets
            .iter()
            .filter_map(|t| t.resolve(&req.params))
            .map(|(r, _)| r)
            .collect();

        let request = EffectRequest {
            effect_id: req.effect_id.clone(),
            run_id: req.run_id.clone(),
            turn: req.turn,
            tool: req.call.tool.clone(),
            params_ref: req.call.params_ref.clone(),
            params_digest: req.call.params_digest.clone(),
            class: manifest.class,
            targets: targets.clone(),
            egress: manifest.egress.clone(),
            reversible: manifest.reversible,
            taint: req.taint,
            cites_referenced: req.cites_referenced.clone(),
            capability: req.capability.clone(),
        };

        events.push(EventBody::ToolRequested(ToolRequested {
            effect_id: request.effect_id.clone(),
            turn: request.turn,
            tool: request.tool.clone(),
            params_ref: request.params_ref.clone(),
            params_digest: request.params_digest.clone(),
            class: request.class,
            declared_targets: request.targets.clone(),
            declared_egress: request.egress.clone(),
            reversible: request.reversible,
            cites_referenced: request.cites_referenced.clone(),
        }));

        let mut push_policy = |events: &mut Vec<EventBody>, decision, rules, reason: &str| {
            events.push(EventBody::PolicyEvaluated(PolicyEvaluated {
                effect_id: req.effect_id.clone(),
                decision,
                rules_hit: rules,
                policy_ver: self.policy.version().to_owned(),
                reason_code: reason.to_owned(),
            }));
        };

        // ① 身份解析 + ② 能力校验：权限只能收窄
        if !req.capability.allows(&request.tool) {
            push_policy(&mut events, PolicyDecisionKind::Deny, Vec::new(), "capability_scope");
            return GatewayVerdict {
                events,
                action: GatewayAction::Deny { reason_code: "capability_scope".to_owned() },
            };
        }

        // ③ 污点检查 —— **在 ④ 之前，且不可被策略放行**
        let taint_gate = req.taint == TaintLevel::Tainted && request.class != EffectClass::Read;

        // ④ 策略求值
        let ctx = PolicyContext {
            tool: request.tool.clone(),
            class: request.class,
            taint: req.taint,
            targets,
            reversible: request.reversible,
        };
        let (policy_decision, rules_hit) = self.policy.evaluate_with_trace(&ctx);

        let decision = if taint_gate {
            // 结构性闸门：策略说 Allow 也要审批
            PolicyDecision::RequireApproval { risk: RiskLevel::L2 }
        } else {
            policy_decision
        };
        let reason = if taint_gate { "taint_gate" } else { "policy" };

        match &decision {
            PolicyDecision::Deny { reason_code } => {
                push_policy(&mut events, PolicyDecisionKind::Deny, rules_hit, reason_code);
                return GatewayVerdict {
                    events,
                    action: GatewayAction::Deny { reason_code: reason_code.clone() },
                };
            }
            PolicyDecision::RequireApproval { .. } => {
                push_policy(&mut events, PolicyDecisionKind::RequireApproval, rules_hit, reason);
            }
            PolicyDecision::Allow => {
                push_policy(&mut events, PolicyDecisionKind::Allow, rules_hit, reason);
            }
        }

        // ⑥ 影响预估 —— **无条件执行，不只在 dry-run 时执行**
        events.push(EventBody::ImpactEstimated(estimate(
            &req.effect_id,
            &manifest,
            &req.params,
        )));

        if let PolicyDecision::RequireApproval { risk } = decision {
            return GatewayVerdict { events, action: GatewayAction::AwaitApproval { risk, request } };
        }

        // dry-run：Write / External 降级为 record-only，Read / Compute 照常执行
        if req.mode == ExecutionMode::DryRun && request.class.suppressed_in_dry_run() {
            events.push(EventBody::ToolResult(ToolResult {
                effect_id: req.effect_id.clone(),
                status: ToolResultStatus::DryRun,
                output_ref: None,
                bytes: None,
                taint: TaintLevel::Clean,
                cites_produced: Vec::new(),
                actual_targets: Vec::new(),
                actual_egress: Vec::new(),
            }));
            return GatewayVerdict { events, action: GatewayAction::DryRun { request } };
        }

        GatewayVerdict { events, action: GatewayAction::Dispatch(request) }
    }
}
```

`crates/evo-gateway/src/lib.rs`：

```rust
pub mod impact;
pub mod manifest;
pub mod pipeline;

pub use manifest::{ManifestError, ManifestRegistry, TargetSpec, ToolManifest};
pub use pipeline::{AdmitRequest, Gateway, GatewayAction, GatewayVerdict};
```

- [ ] **Step 5: 写 `config/tools.toml`**

```toml
# 内置工具 manifest。与代码同仓，编译期校验（02 §4）。
# 未在此列出的工具按最严处理：External + 不可逆 + 需审批。

[[method]]
name = "fs.write"
class = "write"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "update" }]

[[method]]
name = "fs.read"
class = "read"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "read" }]
```

- [ ] **Step 6: 跑测试**

Run: `cargo test -p evo-gateway && cargo clippy -p evo-gateway --all-targets -- -D warnings`
Expected: PASS，11 个测试

- [ ] **Step 7: Commit**

```bash
git add crates/evo-gateway config/tools.toml
git commit -m "feat(gateway): 工具 manifest 与六步管线

污点检查排在策略求值之前且不可被策略放行；无 manifest 即最严。
Gateway 返回待追加事件，不自己写 Log。"
```

---

### Task 15: `evo-runlog` — 快照存储

**快照只是加速，删掉不影响正确性。** 这一点要在类型上体现：`SnapshotStore` 只认字节，不认 `RunState`——它不知道自己存的是什么，也就无从往里塞一个 Log 里没有的状态。

> **对 00 §2 的一处偏离**：00 把「回放器」列在 `evo-runlog` 里，但依赖方向表写的是 `evo-runlog ← protocol`——回放需要 `evo-kernel::fold`，放进 runlog 就成了兄弟 crate 依赖。因此**存储留在 `evo-runlog`，回放器放 `evo-daemon`**（Task 17），`evo-cli` 依赖 daemon 取用（Task 18）。这样「组装只发生在 evo-daemon」一条不破。Task 20 回填 00。

**Files:**
- Create: `crates/evo-runlog/src/snapshot.rs`
- Modify: `crates/evo-runlog/src/lib.rs`
- Test: `crates/evo-runlog/tests/snapshot.rs`

**Interfaces:**
- Consumes: Task 5 的 `RunLog`
- Produces:
  - `RunLog::put_snapshot(&mut self, run_id: &RunId, seq: u64, state_blob: &[u8], state_hash: &[u8]) -> Result<()>`
  - `RunLog::snapshot_at_or_before(&self, run_id: &RunId, seq: u64) -> Result<Option<Snapshot>>`
  - `Snapshot { pub seq: u64, pub state_blob: Vec<u8>, pub state_hash: Vec<u8> }`
  - `RunLog::clear_snapshots(&mut self) -> Result<usize>` —— CI 检查 8 用
  - `RunLog::snapshot_count(&self) -> Result<usize>`

- [ ] **Step 1: 写失败的测试**

`crates/evo-runlog/tests/snapshot.rs`：

```rust
use evo_protocol::RunId;
use evo_runlog::RunLog;

fn open() -> (tempfile::TempDir, RunLog) {
    let dir = tempfile::tempdir().unwrap();
    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    (dir, log)
}

#[test]
fn a_snapshot_can_be_read_back_verbatim() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    log.put_snapshot(&r, 50, b"state-bytes", b"hash-bytes").unwrap();
    let s = log.snapshot_at_or_before(&r, 50).unwrap().unwrap();
    assert_eq!(s.seq, 50);
    assert_eq!(s.state_blob, b"state-bytes");
    assert_eq!(s.state_hash, b"hash-bytes");
}

#[test]
fn lookup_returns_the_nearest_snapshot_not_a_later_one() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    log.put_snapshot(&r, 50, b"a", b"h1").unwrap();
    log.put_snapshot(&r, 100, b"b", b"h2").unwrap();
    assert_eq!(log.snapshot_at_or_before(&r, 99).unwrap().unwrap().seq, 50);
    assert_eq!(log.snapshot_at_or_before(&r, 100).unwrap().unwrap().seq, 100);
    assert!(log.snapshot_at_or_before(&r, 49).unwrap().is_none());
}

#[test]
fn snapshots_of_different_runs_do_not_bleed() {
    let (_d, mut log) = open();
    log.put_snapshot(&RunId::from("r-a"), 50, b"a", b"h").unwrap();
    assert!(log.snapshot_at_or_before(&RunId::from("r-b"), 50).unwrap().is_none());
}

#[test]
fn clear_snapshots_wipes_them_all() {
    let (_d, mut log) = open();
    log.put_snapshot(&RunId::from("r-a"), 50, b"a", b"h").unwrap();
    log.put_snapshot(&RunId::from("r-b"), 50, b"b", b"h").unwrap();
    assert_eq!(log.snapshot_count().unwrap(), 2);
    assert_eq!(log.clear_snapshots().unwrap(), 2);
    assert_eq!(log.snapshot_count().unwrap(), 0);
}

#[test]
fn writing_the_same_seq_twice_overwrites_rather_than_erroring() {
    let (_d, mut log) = open();
    let r = RunId::from("r-1");
    log.put_snapshot(&r, 50, b"first", b"h1").unwrap();
    log.put_snapshot(&r, 50, b"second", b"h2").unwrap();
    assert_eq!(log.snapshot_at_or_before(&r, 50).unwrap().unwrap().state_blob, b"second");
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-runlog --test snapshot`
Expected: FAIL，`no method named put_snapshot found`

- [ ] **Step 3: 给 `RunLog` 加两个 crate 内访问器**

`snapshot.rs` 是 `store.rs` 的兄弟模块，拿不到私有的 `conn` 字段。在 `crates/evo-runlog/src/store.rs` 的 `impl RunLog` 末尾补上：

```rust
    pub(crate) fn conn(&self) -> &Connection {
        &self.conn
    }

    pub(crate) fn conn_mut(&mut self) -> &mut Connection {
        &mut self.conn
    }
```

> 这两个访问器**放在首次使用它们的任务里**，不提前到 Task 5——提前声明会在 Task 5 到 Task 14 之间一直是 dead code，而唯一能让 `clippy -D warnings` 过的办法是加 `#[allow(dead_code)]`，那等于用掩盖换取一个没人用的 API。

- [ ] **Step 4: 实现快照存储**

`crates/evo-runlog/src/snapshot.rs`：

```rust
use crate::store::RunLog;
use crate::RunLogError;
use evo_protocol::ids::RunId;
use rusqlite::{params, OptionalExtension};

/// 快照的内容对 store 是不透明的字节。
///
/// **故意不认 RunState**：快照只是加速，删掉不影响正确性。
/// store 不知道自己存的是什么，也就无从往里塞一个 Log 里没有的状态——
/// 那一刻快照会从加速器变成第二份权威事实（03 §5）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub seq: u64,
    pub state_blob: Vec<u8>,
    pub state_hash: Vec<u8>,
}

impl RunLog {
    pub fn put_snapshot(
        &mut self,
        run_id: &RunId,
        seq: u64,
        state_blob: &[u8],
        state_hash: &[u8],
    ) -> Result<(), RunLogError> {
        self.conn_mut().execute(
            "INSERT INTO snapshots (run_id, seq, state_blob, state_hash) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(run_id, seq) DO UPDATE SET state_blob = ?3, state_hash = ?4",
            params![run_id.as_str(), seq as i64, state_blob, state_hash],
        )?;
        Ok(())
    }

    pub fn snapshot_at_or_before(
        &self,
        run_id: &RunId,
        seq: u64,
    ) -> Result<Option<Snapshot>, RunLogError> {
        let row = self
            .conn()
            .query_row(
                "SELECT seq, state_blob, state_hash FROM snapshots
                 WHERE run_id = ?1 AND seq <= ?2 ORDER BY seq DESC LIMIT 1",
                params![run_id.as_str(), seq as i64],
                |row| {
                    Ok(Snapshot {
                        seq: row.get::<_, i64>(0)? as u64,
                        state_blob: row.get(1)?,
                        state_hash: row.get(2)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn snapshot_count(&self) -> Result<usize, RunLogError> {
        let n: i64 = self.conn().query_row("SELECT COUNT(*) FROM snapshots", [], |r| r.get(0))?;
        Ok(n as usize)
    }

    /// CI 检查 8 用：删光快照后回放结果必须不变。
    pub fn clear_snapshots(&mut self) -> Result<usize, RunLogError> {
        Ok(self.conn_mut().execute("DELETE FROM snapshots", [])?)
    }
}
```

`lib.rs` 补 `pub mod snapshot; pub use snapshot::Snapshot;`

- [ ] **Step 5: 跑测试**

Run: `cargo test -p evo-runlog`
Expected: PASS，14 个测试

- [ ] **Step 6: Commit**

```bash
git add crates/evo-runlog
git commit -m "feat(runlog): 快照存储，内容对 store 不透明"
```

---

### Task 16: `evo-daemon` — 时钟与 turn 循环

**唯一的组装点，唯一写 Run Log 的进程。** 阶段 1 只出一个 `run_once` 驱动函数，HTTP / WS 是阶段 3。

**Files:**
- Create: `crates/evo-daemon/src/clock.rs`, `src/config.rs`, `src/runtime.rs`
- Modify: `crates/evo-daemon/src/lib.rs`, `crates/evo-daemon/Cargo.toml`
- Test: `crates/evo-daemon/tests/turn_loop.rs`

**Interfaces:**
- Consumes: 前面全部 crate
- Produces:
  - `trait Clock { fn now_ms(&self) -> u64; fn now_rfc3339(&self) -> String; fn seed(&self) -> String }`
  - `RealClock`、`FixedClock::new(start_ms: u64)`（每次调用 +1000ms，序列确定）
  - `DaemonConfig { workspace_root, blob_root, db_path, principal, policy, tools, pricing, egress, profile }`
  - `Runtime::new(config, clock: Arc<dyn Clock>, model: Arc<dyn ModelAdapter>, executor: Arc<dyn Executor>) -> Result<Runtime>`
  - `Runtime::run_once(&mut self, run_id: &RunId, intent_text: &str) -> Result<RunState, DaemonError>`
  - `pub fn parse_plan(text: &str) -> Result<ParsedPlan, DaemonError>`，`ParsedPlan { intent: PlanIntent, tool: Option<String>, params: serde_json::Value }`

> **模型输出解析在 runtime，不在内核（Q-12）。** 解析要容忍模型输出的各种形态，是最容易引入非确定性（正则、时间、随机重试）的地方，把它关在内核外面，内核的确定性好守得多。

- [ ] **Step 1: 写失败的测试**

`crates/evo-daemon/tests/turn_loop.rs`：

```rust
use evo_daemon::{DaemonConfig, FixedClock, Runtime};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_kernel::RunStatus;
use evo_model::FixtureAdapter;
use evo_protocol::RunId;
use evo_runlog::RunLog;
use std::sync::Arc;

const FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    { "text": "{\"intent\":\"tool_call\",\"tool\":\"fs.write\",\"params\":{\"path\":\"report.txt\",\"content\":\"账龄表\"}}",
      "usage": { "input": 120, "output": 40, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 12 },
    { "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 200, "output": 10, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 9 }
  ]
}"#;

fn setup(dir: &std::path::Path) -> Runtime {
    let config = DaemonConfig::for_test(dir);
    Runtime::new(
        config,
        Arc::new(FixedClock::new(1_756_461_600_000)),
        Arc::new(FixtureAdapter::from_json_str(FIXTURES).unwrap()),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )
    .unwrap()
}

#[tokio::test]
async fn a_full_turn_writes_the_event_sequence_from_doc_03() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    let run_id = RunId::from("r-1");
    let state = rt.run_once(&run_id, "把账龄表做出来").await.unwrap();
    assert_eq!(state.status, RunStatus::Completed);

    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    let kinds: Vec<&str> = log.events(&run_id, 0, None).unwrap()
        .iter().map(|e| e.body.kind()).collect();
    assert_eq!(kinds, vec![
        "run.created", "intent.declared",
        "env.sampled", "context.assembled",
        "model.requested", "model.responded", "cost.charged", "cost.charged", "plan.step",
        "tool.requested", "policy.evaluated", "impact.estimated",
        "checkpoint", "effect.dispatched", "tool.result",
        "env.sampled", "context.assembled",
        "model.requested", "model.responded", "cost.charged", "cost.charged", "plan.step",
        "run.completed",
    ]);
}

#[tokio::test]
async fn the_side_effect_really_happened() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    rt.run_once(&RunId::from("r-1"), "把账龄表做出来").await.unwrap();
    let written = dir.path().join("workspaces").join("r-1").join("report.txt");
    assert_eq!(std::fs::read_to_string(written).unwrap(), "账龄表");
}

#[tokio::test]
async fn business_content_never_lands_in_the_event_payload() {
    // 01 §3：payload 里只允许元数据与 content_hash
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    let run_id = RunId::from("r-1");
    rt.run_once(&run_id, "客户甲欠款 123456 元").await.unwrap();

    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    for e in log.events(&run_id, 0, None).unwrap() {
        let payload = serde_json::to_string(&e.body).unwrap();
        assert!(!payload.contains("123456"), "业务数字漏进了 {} 的 payload", e.body.kind());
        assert!(!payload.contains("客户甲"), "客户名漏进了 {} 的 payload", e.body.kind());
    }
}

#[tokio::test]
async fn the_intent_text_is_retrievable_from_the_blob_store() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    let run_id = RunId::from("r-1");
    let state = rt.run_once(&run_id, "客户甲欠款 123456 元").await.unwrap();

    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    let intent = state.intent.expect("intent 应当在 state 里");
    let text = String::from_utf8(log.blobs().get(&intent).unwrap()).unwrap();
    assert_eq!(text, "客户甲欠款 123456 元", "原文进 blob，不是丢掉");
}

#[tokio::test]
async fn cost_is_charged_from_our_own_price_table() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    let run_id = RunId::from("r-1");
    let state = rt.run_once(&run_id, "x").await.unwrap();
    // (120*1 + 40*2) + (200*1 + 10*2) = 200 + 220
    assert_eq!(state.budget_used.amount_micros, 420);
}

#[tokio::test]
async fn two_runs_share_one_database() {
    let dir = tempfile::tempdir().unwrap();
    let mut rt = setup(dir.path());
    rt.run_once(&RunId::from("r-1"), "x").await.unwrap();
    let log = RunLog::open(&dir.path().join("runlog.sqlite"), &dir.path().join("blobs")).unwrap();
    assert_eq!(log.run_ids().unwrap().len(), 1);
}

#[test]
fn plan_parsing_lives_in_the_runtime_not_the_kernel() {
    use evo_daemon::parse_plan;
    use evo_protocol::events::model::PlanIntent;
    let p = parse_plan(r#"{"intent":"tool_call","tool":"fs.write","params":{"path":"a"}}"#).unwrap();
    assert_eq!(p.intent, PlanIntent::ToolCall);
    assert_eq!(p.tool.as_deref(), Some("fs.write"));
}

#[test]
fn unparseable_model_output_is_an_error_not_a_guess() {
    use evo_daemon::parse_plan;
    assert!(parse_plan("我觉得应该写个文件").is_err());
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-daemon`
Expected: FAIL，`unresolved import evo_daemon::Runtime`

- [ ] **Step 3: 实现时钟与配置**

`crates/evo-daemon/Cargo.toml` 的 `[dependencies]`：全部 `evo-*`（除 `evo-memory` / `evo-mcp`）加 `serde`、`serde_json`、`ciborium`、`hex`、`tokio`、`async-trait`、`thiserror`
`[dev-dependencies]`：`tempfile.workspace = true`、`tokio = { workspace = true, features = ["macros", "rt-multi-thread"] }`

`crates/evo-daemon/src/clock.rs`：

```rust
/// daemon 是唯一允许读时钟的地方。内核通过 env.sampled 间接看到时间。
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
    fn now_rfc3339(&self) -> String;
    /// 每 turn 的 rng seed。内核唯一的随机数来源。
    fn seed(&self) -> String;
}

pub struct RealClock;

impl Clock for RealClock {
    fn now_ms(&self) -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn now_rfc3339(&self) -> String {
        // 不引 chrono：daemon 只需要一个可读的时间戳字符串，
        // 而 recorded_at 从不参与任何计算（内核读不到它）。
        format!("epoch-ms:{}", self.now_ms())
    }

    fn seed(&self) -> String {
        format!("seed:{}", self.now_ms())
    }
}

/// 测试用。每次调用推进 1000ms，序列确定——
/// 没有它，端到端测试的 Log 每次都不一样，回放对不上就无从判断是谁的错。
pub struct FixedClock {
    start_ms: u64,
    ticks: std::sync::atomic::AtomicU64,
}

impl FixedClock {
    pub fn new(start_ms: u64) -> Self {
        Self { start_ms, ticks: std::sync::atomic::AtomicU64::new(0) }
    }
}

impl Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        let n = self.ticks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.start_ms + n * 1000
    }

    fn now_rfc3339(&self) -> String {
        format!("epoch-ms:{}", self.start_ms)
    }

    fn seed(&self) -> String {
        "seed-fixed".to_owned()
    }
}
```

> `RealClock` 里用了 `SystemTime::now`——workspace 层已把 `disallowed_methods` 设为 `allow`，只有 `evo-kernel` deny，所以这里不需要 `#[allow]`。**如果哪天有人把 workspace 层改成 deny，这里会立刻编译失败——那是正确的信号，说明约束跑到了不该管的地方。**

`crates/evo-daemon/src/config.rs`：

```rust
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct DaemonConfig {
    pub db_path: PathBuf,
    pub blob_root: PathBuf,
    pub workspace_root: PathBuf,
    pub principal: String,
    pub policy_toml: String,
    pub tools_toml: String,
    pub pricing_toml: String,
    pub context_profile: String,
    /// 出口 allowlist。**是配置不是常量**：开发期与交付形态用同一份代码、
    /// 不同一份 allowlist（05 §4）。
    pub egress_allow: Vec<String>,
    pub proxy_addr: Option<String>,
}

impl DaemonConfig {
    /// 测试用：全部落在一个临时目录下，策略/工具/定价读仓库里的 config/。
    pub fn for_test(dir: &Path) -> Self {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        Self {
            db_path: dir.join("runlog.sqlite"),
            blob_root: dir.join("blobs"),
            workspace_root: dir.join("workspaces"),
            principal: "u-test".to_owned(),
            policy_toml: std::fs::read_to_string(repo.join("config/policy.toml")).unwrap(),
            tools_toml: std::fs::read_to_string(repo.join("config/tools.toml")).unwrap(),
            pricing_toml: std::fs::read_to_string(repo.join("config/pricing.toml")).unwrap(),
            context_profile: "default".to_owned(),
            egress_allow: Vec::new(),
            proxy_addr: None,
        }
    }
}
```

> `config/pricing.toml` 里的 `provider = "fixture"` 条目是测试依赖的。Task 13 写这个文件时就要包含它——真实供应商的价格在 M2（09）补。

- [ ] **Step 4: 实现 turn 循环**

`crates/evo-daemon/src/runtime.rs`：

```rust
use crate::clock::Clock;
use crate::config::DaemonConfig;
use evo_context::Assembler;
use evo_exec::{
    CapabilityToken, DispatchedEffect, EgressPolicy, Executor, Lease, WorkspaceHandle,
};
use evo_exec_local::WorkspaceRoot;
use evo_gateway::{AdmitRequest, Gateway, GatewayAction, ManifestRegistry};
use evo_kernel::{decide, reduce, state_hash, Command, RunState};
use evo_model::{request_digest, Message, ModelAdapter, ModelRequest, PriceTable};
use evo_policy::HardcodedPolicy;
use evo_protocol::events::accounting::{CheckpointReason, Checkpoint, CostDimension};
use evo_protocol::events::effect::{
    EffectDispatched, ExecutionMode, ToolResult, ToolResultStatus,
};
use evo_protocol::events::lifecycle::{
    CompletionStatus, IntentDeclared, PrincipalRef, RunCompleted, RunCreated, TriggerKind,
    TriggerRef,
};
use evo_protocol::events::model::{
    ModelParams, ModelRequested, ModelResponded, PlanIntent, PlanStep, PlannedCall,
};
use evo_protocol::events::determinism::{EnvSampled, ModelRoute};
use evo_protocol::{
    Actor, BlobClass, BlobRef, BudgetSpec, CheckpointId, EffectClass, EffectId, EventBody, LeaseId,
    RunId,
};
use evo_runlog::RunLog;
use std::sync::Arc;

#[derive(Debug, thiserror::Error)]
pub enum DaemonError {
    #[error("runlog: {0}")]
    RunLog(#[from] evo_runlog::RunLogError),
    #[error("model: {0}")]
    Model(#[from] evo_model::ModelError),
    #[error("policy: {0}")]
    Policy(#[from] evo_policy::PolicyError),
    #[error("manifest: {0}")]
    Manifest(#[from] evo_gateway::ManifestError),
    #[error("exec: {0}")]
    Exec(#[from] evo_exec::ExecError),
    #[error("model output is not a plan: {0}")]
    UnparseablePlan(String),
    #[error("effect was denied: {0}")]
    Denied(String),
    #[error("turn limit exceeded: {0}")]
    TurnLimit(u32),
    #[error("snapshot is undecodable at seq {seq}: {detail}")]
    SnapshotDecode { seq: u64, detail: String },
    #[error("not implemented in phase 1: {0}")]
    NotImplemented(&'static str),
}

/// runtime 从模型输出里解析出的结构化决策。
///
/// **解析在这里，不在内核（Q-12）**：它是最容易引入非确定性
/// （正则、时间、随机重试）的地方，关在内核外面，内核的确定性好守得多。
#[derive(Clone, Debug, PartialEq)]
pub struct ParsedPlan {
    pub intent: PlanIntent,
    pub tool: Option<String>,
    pub params: serde_json::Value,
}

pub fn parse_plan(text: &str) -> Result<ParsedPlan, DaemonError> {
    let v: serde_json::Value = serde_json::from_str(text)
        .map_err(|_| DaemonError::UnparseablePlan(text.chars().take(60).collect()))?;
    let intent = match v.get("intent").and_then(|i| i.as_str()) {
        Some("tool_call") => PlanIntent::ToolCall,
        Some("clarify") => PlanIntent::Clarify,
        Some("finish") => PlanIntent::Finish,
        _ => return Err(DaemonError::UnparseablePlan(text.chars().take(60).collect())),
    };
    Ok(ParsedPlan {
        intent,
        tool: v.get("tool").and_then(|t| t.as_str()).map(str::to_owned),
        params: v.get("params").cloned().unwrap_or(serde_json::json!({})),
    })
}

/// 单 run 最多跑多少 turn。防的是 fixture 或模型让循环停不下来。
const MAX_TURNS: u32 = 64;

pub struct Runtime {
    config: DaemonConfig,
    clock: Arc<dyn Clock>,
    model: Arc<dyn ModelAdapter>,
    executor: Arc<dyn Executor>,
    log: RunLog,
    gateway: Gateway,
    assembler: Assembler,
    pricing: PriceTable,
    workspaces: WorkspaceRoot,
}

impl Runtime {
    pub fn new(
        config: DaemonConfig,
        clock: Arc<dyn Clock>,
        model: Arc<dyn ModelAdapter>,
        executor: Arc<dyn Executor>,
    ) -> Result<Self, DaemonError> {
        let log = RunLog::open(&config.db_path, &config.blob_root)?;
        let gateway = Gateway::new(
            Box::new(HardcodedPolicy::from_toml_str(&config.policy_toml)?),
            ManifestRegistry::from_toml_str(&config.tools_toml)?,
        );
        let pricing = PriceTable::from_toml_str(&config.pricing_toml)?;
        let assembler = Assembler::new(&config.context_profile);
        let workspaces = WorkspaceRoot::new(config.workspace_root.clone());
        Ok(Self { config, clock, model, executor, log, gateway, assembler, pricing, workspaces })
    }

    /// 唯一写 Run Log 的地方。写完立刻 reduce——state 永远是 Log 的折叠结果。
    fn emit(&mut self, state: &RunState, actor: Actor, body: EventBody) -> Result<RunState, DaemonError> {
        let recorded_at = self.clock.now_rfc3339();
        let event = self.log.append(&state.run_id, actor, &recorded_at, body)?;
        Ok(reduce(state, &event))
    }

    pub async fn run_once(
        &mut self,
        run_id: &RunId,
        intent_text: &str,
    ) -> Result<RunState, DaemonError> {
        let mut state = RunState::new(run_id);

        state = self.emit(&state, Actor::Runtime, EventBody::RunCreated(RunCreated {
            run_id: run_id.clone(),
            parent_run_id: None,
            workspace_id: run_id.as_str().to_owned(),
            principal: PrincipalRef { kind: "user".into(), id: self.config.principal.clone() },
            trigger: TriggerRef { kind: TriggerKind::Manual, reference: "cli".into() },
            budget: BudgetSpec::default(),
            labels: Default::default(),
        }))?;

        // 意图原文进 blob，事件里只留引用与长度（01 §3）
        let intent_ref = self.log.blobs().put(
            BlobClass::Content, "text/plain", intent_text.as_bytes(),
        )?;
        state = self.emit(&state, Actor::Runtime, EventBody::IntentDeclared(IntentDeclared {
            intent_ref: intent_ref.clone(),
            char_len: intent_text.chars().count() as u64,
            lang: "zh".to_owned(),
            source: "cli".to_owned(),
        }))?;

        loop {
            if state.turn > MAX_TURNS {
                return Err(DaemonError::TurnLimit(MAX_TURNS));
            }
            let commands = decide(&state);
            if commands.is_empty() {
                break;
            }
            for cmd in commands {
                state = self.execute_command(state, cmd, &intent_ref, intent_text).await?;
            }
        }
        Ok(state)
    }

    async fn execute_command(
        &mut self,
        state: RunState,
        cmd: Command,
        intent_ref: &BlobRef,
        intent_text: &str,
    ) -> Result<RunState, DaemonError> {
        match cmd {
            Command::SampleEnv => {
                let body = EventBody::EnvSampled(EnvSampled {
                    turn: state.turn,
                    wall_clock_ms: self.clock.now_ms(),
                    rng_seed: self.clock.seed(),
                    env: Default::default(),
                    model_route: ModelRoute {
                        provider: self.model.provider().to_owned(),
                        model: self.model.model().to_owned(),
                        params_digest: "default".to_owned(),
                    },
                });
                self.emit(&state, Actor::Runtime, body)
            }

            Command::AssembleContext { turn, .. } => {
                let assembled = self.assembler.assemble(turn, intent_ref, intent_text);
                self.emit(&state, Actor::Runtime, EventBody::ContextAssembled(assembled))
            }

            Command::CallModel { turn } => self.call_model(state, turn).await,

            Command::RequestEffect { call } => self.request_effect(state, call).await,

            Command::Checkpoint { reason } => self.checkpoint(state, reason),

            Command::Complete { .. } => self.emit(
                &state,
                Actor::Kernel,
                EventBody::RunCompleted(RunCompleted {
                    status: CompletionStatus::Ok,
                    summary_ref: None,
                }),
            ),

            Command::AskClarification { .. } => {
                Err(DaemonError::NotImplemented("clarification.requested 属阶段 2"))
            }
            Command::Suspend { .. } => {
                Err(DaemonError::NotImplemented("run.suspended 属阶段 2"))
            }
        }
    }

    async fn call_model(&mut self, state: RunState, turn: u32) -> Result<RunState, DaemonError> {
        let mut state = state;
        let request = ModelRequest {
            messages: vec![Message { role: "user".into(), content: String::new() }],
            params: ModelParams { temperature: 0.0, max_tokens: None },
        };
        // messages 全文进 blob
        let messages_ref = self.log.blobs().put(
            BlobClass::Content,
            "application/json",
            &serde_json::to_vec(&request.messages).expect("messages 可序列化"),
        )?;
        state = self.emit(&state, Actor::Runtime, EventBody::ModelRequested(ModelRequested {
            turn,
            provider: self.model.provider().to_owned(),
            model: self.model.model().to_owned(),
            params: request.params.clone(),
            request_digest: request_digest(&request),
            messages_ref,
        }))?;

        let response = self.model.call(&request).await?;
        let response_ref = self.log.blobs().put(
            BlobClass::Content, "text/plain", response.text.as_bytes(),
        )?;
        let response_hash = response_ref.content_hash.clone();
        state = self.emit(&state, Actor::Runtime, EventBody::ModelResponded(ModelResponded {
            turn,
            response_ref,
            response_hash,
            usage: response.usage,
            stop_reason: response.stop_reason.clone(),
            latency_ms: response.latency_ms,
        }))?;

        let dimension = CostDimension {
            principal: self.config.principal.clone(),
            team: None,
            run_id: state.run_id.clone(),
            skill: None,
            tool: None,
        };
        for charge in self.pricing.charges(
            self.model.provider(), self.model.model(), &response.usage, &dimension, Some(turn),
        ) {
            state = self.emit(&state, Actor::Runtime, EventBody::CostCharged(charge))?;
        }

        let parsed = parse_plan(&response.text)?;
        let call = match (&parsed.intent, &parsed.tool) {
            (PlanIntent::ToolCall, Some(tool)) => {
                let params_bytes = serde_json::to_vec(&parsed.params).expect("params 可序列化");
                let params_ref = self.log.blobs().put(
                    BlobClass::Content, "application/json", &params_bytes,
                )?;
                let params_digest = params_ref.content_hash.clone();
                Some(PlannedCall {
                    tool: evo_protocol::ToolId::from(tool.as_str()),
                    params_ref,
                    params_digest,
                })
            }
            _ => None,
        };
        self.emit(&state, Actor::Runtime, EventBody::PlanStep(PlanStep {
            turn,
            intent: parsed.intent,
            rationale_ref: None,
            taint_inherited: state.taint,
            call,
        }))
    }

    async fn request_effect(
        &mut self,
        state: RunState,
        call: PlannedCall,
    ) -> Result<RunState, DaemonError> {
        let mut state = state;
        let effect_id = EffectId::from(format!("{}-e{}", state.run_id, state.last_seq));
        let params: serde_json::Value =
            serde_json::from_slice(&self.log.blobs().get(&call.params_ref)?)
                .unwrap_or(serde_json::json!({}));

        let verdict = self.gateway.admit(AdmitRequest {
            effect_id: effect_id.clone(),
            run_id: state.run_id.clone(),
            turn: state.turn,
            call,
            params: params.clone(),
            taint: state.taint,
            cites_referenced: state.cites.iter().cloned().collect(),
            capability: CapabilityToken {
                subject: self.config.principal.clone(),
                scopes: vec!["*".to_owned()],
            },
            mode: ExecutionMode::Live,
        });

        for body in verdict.events {
            state = self.emit(&state, Actor::Gateway, body)?;
        }

        let request = match verdict.action {
            GatewayAction::Dispatch(req) => req,
            GatewayAction::DryRun { .. } => return Ok(state),
            GatewayAction::Deny { reason_code } => return Err(DaemonError::Denied(reason_code)),
            GatewayAction::AwaitApproval { .. } => {
                // 阶段 2：写 approval.requested 并挂起。阶段 1 的工具都不触发它。
                return Err(DaemonError::Denied("approval_required".to_owned()));
            }
        };

        // pre_write 语义检查点（03 §5）：不可逆动作之前留一个可回滚的锚点
        if request.class == EffectClass::Write || request.class == EffectClass::External {
            state = self.checkpoint(state, CheckpointReason::PreWrite)?;
        }

        let workspace: WorkspaceHandle = self.workspaces.ensure(&state.run_id)?;
        let lease = Lease {
            lease_id: LeaseId::from(format!("{effect_id}-l")),
            run_id: state.run_id.clone(),
            effect_id: effect_id.clone(),
            // 来自 env.sampled 的 clock_ms，不是执行器自己读时钟
            expires_at_ms: state.clock_ms + 60_000,
            workspace,
            egress_policy: EgressPolicy {
                allow: self.config.egress_allow.clone(),
                proxy_addr: self.config.proxy_addr.clone(),
            },
            capability: request.capability.clone(),
        };

        state = self.emit(&state, Actor::Gateway, EventBody::EffectDispatched(EffectDispatched {
            effect_id: effect_id.clone(),
            executor_id: self.executor.id(),
            lease_id: lease.lease_id.clone(),
            mode: ExecutionMode::Live,
        }))?;

        let outcome = self
            .executor
            .execute(lease, DispatchedEffect { request, params, mode: ExecutionMode::Live })
            .await;

        let (output_ref, bytes) = match &outcome.output {
            Some(b) => (
                Some(self.log.blobs().put(BlobClass::Content, &outcome.output_mime, b)?),
                Some(b.len() as u64),
            ),
            None => (None, None),
        };

        self.emit(&state, Actor::Executor, EventBody::ToolResult(ToolResult {
            effect_id,
            status: outcome.status,
            output_ref,
            bytes,
            taint: outcome.taint,
            cites_produced: Vec::new(),
            actual_targets: outcome.actual_targets,
            actual_egress: outcome.actual_egress,
        }))
    }

    /// 写一个检查点：先算当前 state 的 hash 进事件，再存快照。
    ///
    /// 顺序不能反——事件里的 state_hash 是**写检查点之前**的状态，
    /// 回放到该 seq 时重算的也是同一个状态。
    fn checkpoint(
        &mut self,
        state: RunState,
        reason: CheckpointReason,
    ) -> Result<RunState, DaemonError> {
        let hash = state_hash(&state);
        let body = EventBody::Checkpoint(Checkpoint {
            checkpoint_id: CheckpointId::from(format!("{}-cp{}", state.run_id, state.last_seq)),
            state_hash: hex::encode(hash),
            snapshot_ref: None,
            reason,
        });
        let new_state = self.emit(&state, Actor::Kernel, body)?;

        let mut blob = Vec::new();
        ciborium::into_writer(&state, &mut blob).expect("RunState 可序列化");
        self.log.put_snapshot(&new_state.run_id, new_state.last_seq, &blob, &hash)?;
        Ok(new_state)
    }
}
```

`crates/evo-daemon/src/lib.rs`：

```rust
//! 唯一的组装点，唯一写 Run Log 的进程。
//!
//! 阶段 1 只出 turn 循环驱动；HTTP /v1/rpc 与 WS /v1/events 是阶段 3。

pub mod clock;
pub mod config;
pub mod runtime;

pub use clock::{Clock, FixedClock, RealClock};
pub use config::DaemonConfig;
pub use runtime::{parse_plan, DaemonError, ParsedPlan, Runtime};
```

- [ ] **Step 5: 跑测试**

Run: `cargo test -p evo-daemon`
Expected: PASS，8 个测试。事件序列断言与 03 §6 的 turn 序列逐条一致。

- [ ] **Step 6: 全量回归**

Run: `./scripts/ci.sh`
Expected: 全部通过

- [ ] **Step 7: Commit**

```bash
git add crates/evo-daemon
git commit -m "feat(daemon): 时钟抽象与 turn 循环，一条 run 端到端跑通"
```

---

### Task 17: `evo-daemon` — 回放器与自校验

判据 3 的自动检测器。**这是本计划最重要的一个任务**——它把「内核里悄悄读了时钟」从半年后被发现变成当天被发现。

**Files:**
- Create: `crates/evo-daemon/src/replay.rs`
- Modify: `crates/evo-daemon/src/lib.rs`
- Test: `crates/evo-daemon/tests/replay.rs`

**Interfaces:**
- Consumes: Task 15 的快照存储；`evo_kernel::{fold, reduce, state_hash}`
- Produces:
  - `replay_to(log: &RunLog, run_id: &RunId, to_seq: Option<u64>, use_snapshots: bool) -> Result<RunState, DaemonError>`
  - `verify(log: &RunLog, run_id: &RunId) -> Result<VerifyReport, DaemonError>`
  - `VerifyReport { pub run_id: RunId, pub checkpoints_checked: usize, pub mismatches: Vec<Mismatch>, pub final_state_hash: String }`
  - `Mismatch { pub seq: u64, pub expected: String, pub actual: String }`
  - `VerifyReport::is_ok(&self) -> bool`

- [ ] **Step 1: 写失败的测试**

`crates/evo-daemon/tests/replay.rs`：

```rust
use evo_daemon::{replay_to, verify, DaemonConfig, FixedClock, Runtime};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_kernel::state_hash;
use evo_model::FixtureAdapter;
use evo_protocol::RunId;
use evo_runlog::RunLog;
use std::sync::Arc;

const FIXTURES: &str = r#"{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    { "text": "{\"intent\":\"tool_call\",\"tool\":\"fs.write\",\"params\":{\"path\":\"report.txt\",\"content\":\"账龄表\"}}",
      "usage": { "input": 120, "output": 40, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 12 },
    { "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 200, "output": 10, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop", "latency_ms": 9 }
  ]
}"#;

async fn produce_a_run(dir: &std::path::Path) -> RunId {
    let mut rt = Runtime::new(
        DaemonConfig::for_test(dir),
        Arc::new(FixedClock::new(1_756_461_600_000)),
        Arc::new(FixtureAdapter::from_json_str(FIXTURES).unwrap()),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )
    .unwrap();
    let run_id = RunId::from("r-1");
    rt.run_once(&run_id, "把账龄表做出来").await.unwrap();
    run_id
}

fn open(dir: &std::path::Path) -> RunLog {
    RunLog::open(&dir.join("runlog.sqlite"), &dir.join("blobs")).unwrap()
}

#[tokio::test]
async fn every_checkpoint_hash_matches_on_replay() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = produce_a_run(dir.path()).await;
    let report = verify(&open(dir.path()), &run_id).unwrap();
    assert!(report.is_ok(), "不一致的检查点：{:?}", report.mismatches);
    assert!(report.checkpoints_checked >= 1, "至少要有一个检查点被校验到");
}

#[tokio::test]
async fn deleting_every_snapshot_does_not_change_the_result() {
    // CI 检查 8（Q-06）。没有它，早晚有人往快照里塞一个 Log 里没有的状态。
    let dir = tempfile::tempdir().unwrap();
    let run_id = produce_a_run(dir.path()).await;

    let with_snapshots = replay_to(&open(dir.path()), &run_id, None, true).unwrap();

    let mut log = open(dir.path());
    assert!(log.snapshot_count().unwrap() > 0, "先确认真的有快照可删");
    log.clear_snapshots().unwrap();
    let without = replay_to(&log, &run_id, None, false).unwrap();

    assert_eq!(with_snapshots, without);
    assert_eq!(state_hash(&with_snapshots), state_hash(&without));
}

#[tokio::test]
async fn replay_is_pure_and_repeatable() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = produce_a_run(dir.path()).await;
    let log = open(dir.path());
    let a = replay_to(&log, &run_id, None, false).unwrap();
    let b = replay_to(&log, &run_id, None, false).unwrap();
    assert_eq!(state_hash(&a), state_hash(&b));
}

#[tokio::test]
async fn replay_to_an_earlier_seq_stops_there() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = produce_a_run(dir.path()).await;
    let log = open(dir.path());
    let partial = replay_to(&log, &run_id, Some(2), false).unwrap();
    assert_eq!(partial.last_seq, 2);
    assert_ne!(partial.status, replay_to(&log, &run_id, None, false).unwrap().status);
}

#[tokio::test]
async fn a_tampered_checkpoint_hash_is_caught() {
    // 把某个 checkpoint 的 state_hash 改掉，verify 必须报出来——
    // 否则这道防线是摆设
    let dir = tempfile::tempdir().unwrap();
    let run_id = produce_a_run(dir.path()).await;
    let db = dir.path().join("runlog.sqlite");
    let conn = rusqlite::Connection::open(&db).unwrap();
    conn.execute(
        "UPDATE run_events SET payload = replace(payload, '\"state_hash\":\"', '\"state_hash\":\"ff')
         WHERE kind = 'checkpoint'",
        [],
    )
    .unwrap();
    drop(conn);

    let report = verify(&open(dir.path()), &run_id).unwrap();
    assert!(!report.is_ok());
    assert_eq!(report.mismatches.len(), report.checkpoints_checked);
}
```

`crates/evo-daemon/Cargo.toml` 的 `[dev-dependencies]` 补 `rusqlite.workspace = true`。

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-daemon --test replay`
Expected: FAIL，`unresolved import evo_daemon::verify`

- [ ] **Step 3: 实现**

`crates/evo-daemon/src/replay.rs`：

```rust
use crate::runtime::DaemonError;
use evo_kernel::{reduce, state_hash, RunState};
use evo_protocol::ids::RunId;
use evo_protocol::EventBody;
use evo_runlog::RunLog;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mismatch {
    pub seq: u64,
    pub expected: String,
    pub actual: String,
}

#[derive(Clone, Debug)]
pub struct VerifyReport {
    pub run_id: RunId,
    pub checkpoints_checked: usize,
    pub mismatches: Vec<Mismatch>,
    pub final_state_hash: String,
}

impl VerifyReport {
    pub fn is_ok(&self) -> bool {
        self.mismatches.is_empty()
    }
}

/// 回放到某个 seq。**不重新调模型、不重新执行 effect**——
/// 直接重放同一批事件，内核走过完全相同的路径。
///
/// `use_snapshots` 只影响从哪里起步，不影响结果。这一点由
/// 「删光快照结果不变」那条测试保证。
pub fn replay_to(
    log: &RunLog,
    run_id: &RunId,
    to_seq: Option<u64>,
    use_snapshots: bool,
) -> Result<RunState, DaemonError> {
    let target = match to_seq {
        Some(s) => s,
        None => log.last_seq(run_id)?.unwrap_or(0),
    };

    let (mut state, from_seq) = if use_snapshots {
        match log.snapshot_at_or_before(run_id, target)? {
            Some(snap) => {
                let restored: RunState = ciborium::from_reader(snap.state_blob.as_slice())
                    .map_err(|e| DaemonError::SnapshotDecode {
                        seq: snap.seq,
                        detail: e.to_string(),
                    })?;
                // 快照存的是「写检查点之前」的状态，所以要从该 seq 起重放
                (restored, snap.seq)
            }
            None => (RunState::new(run_id), 0),
        }
    } else {
        (RunState::new(run_id), 0)
    };

    for event in log.events(run_id, from_seq, Some(target))? {
        state = reduce(&state, &event);
    }
    Ok(state)
}

/// 全量重放，在每个 checkpoint 处比对 state_hash。
///
/// 不一致就是内核有非确定性，当天暴露（03 §2 防线 4）。
pub fn verify(log: &RunLog, run_id: &RunId) -> Result<VerifyReport, DaemonError> {
    let mut state = RunState::new(run_id);
    let mut checkpoints_checked = 0usize;
    let mut mismatches = Vec::new();

    for event in log.events(run_id, 0, None)? {
        if let EventBody::Checkpoint(cp) = &event.body {
            // 事件里的 hash 是「写这条 checkpoint 之前」的状态
            let actual = hex::encode(state_hash(&state));
            checkpoints_checked += 1;
            if actual != cp.state_hash {
                mismatches.push(Mismatch {
                    seq: event.seq,
                    expected: cp.state_hash.clone(),
                    actual,
                });
            }
        }
        state = reduce(&state, &event);
    }

    Ok(VerifyReport {
        run_id: run_id.clone(),
        checkpoints_checked,
        mismatches,
        final_state_hash: hex::encode(state_hash(&state)),
    })
}
```

`lib.rs` 补 `pub mod replay; pub use replay::{replay_to, verify, Mismatch, VerifyReport};`

> **快照起点的一个陷阱**：`checkpoint` 那条事件本身也要被重放（它会更新 `last_checkpoint_seq`），所以快照恢复后是从 `snap.seq` 开始重放，**包含**那一条 checkpoint 事件，而不是从 `snap.seq + 1`。写错这一处，「删快照结果不变」那条测试会立刻挂——这正是它存在的意义。

- [ ] **Step 4: 跑测试**

Run: `cargo test -p evo-daemon`
Expected: PASS，13 个测试

- [ ] **Step 5: Commit**

```bash
git add crates/evo-daemon
git commit -m "feat(daemon): 回放器与 checkpoint 自校验"
```

---

### Task 18: `evo-cli` — `replay --verify`

03 §2 里那条命令的落地：`cargo run -p evo-cli -- replay --verify eval/cases/*/runlog.sqlite`

**Files:**
- Modify: `crates/evo-cli/src/main.rs`, `crates/evo-cli/Cargo.toml`
- Test: `crates/evo-cli/tests/cli.rs`

**Interfaces:**
- Consumes: Task 17 的 `verify` / `replay_to`
- Produces: 二进制 `evo-cli`，子命令 `replay`，参数 `--verify`、`--drop-snapshots`、`<db_path>...`；退出码 0 = 全通过，1 = 有不一致

- [ ] **Step 1: 写失败的测试**

`crates/evo-cli/tests/cli.rs`：

```rust
use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_evo-cli"))
}

#[test]
fn replay_verify_on_a_missing_file_fails_loudly() {
    let out = bin().args(["replay", "--verify", "/nonexistent/runlog.sqlite"]).output().unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("/nonexistent/runlog.sqlite"));
}

#[test]
fn replay_verify_needs_at_least_one_path() {
    let out = bin().args(["replay", "--verify"]).output().unwrap();
    assert!(!out.status.success());
}
```

> 端到端的「跑通一条真 Log」由 Task 19 的 `eval/run.sh` 覆盖——那里有真实的 sqlite 可用。此处只测 CLI 的错误路径，避免在单元测试里重造一条 run。

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test -p evo-cli`
Expected: FAIL，二进制不接受 `replay` 子命令

- [ ] **Step 3: 实现**

`crates/evo-cli/Cargo.toml` 的 `[dependencies]`：`evo-daemon.workspace = true`、`evo-runlog.workspace = true`、`evo-protocol.workspace = true`、`clap.workspace = true`

> `evo-cli` 经 `evo-daemon` 取用回放器，而不是自己组装 kernel + runlog——**组装只发生在 evo-daemon** 这条因此没有第二个例外。
> workspace 的 `[workspace.dependencies]` 需要补一行 `evo-daemon = { path = "crates/evo-daemon" }`。

`crates/evo-cli/src/main.rs`：

```rust
use clap::{Parser, Subcommand};
use evo_daemon::{replay_to, verify};
use evo_runlog::RunLog;
use std::path::PathBuf;
use std::process::ExitCode;

#[derive(Parser)]
#[command(name = "evo-cli", about = "evowork 运维命令")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// 重放 Run Log，在每个 checkpoint 处比对 state_hash
    Replay {
        /// 比对 checkpoint 的 state_hash，不一致则退出码为 1
        #[arg(long)]
        verify: bool,
        /// 先删光快照再回放。用于验证「快照可丢弃」（CI 检查 8）
        #[arg(long)]
        drop_snapshots: bool,
        /// 一个或多个 runlog.sqlite
        #[arg(required = true)]
        paths: Vec<PathBuf>,
    },
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Commands::Replay { verify: do_verify, drop_snapshots, paths } => {
            let mut failed = false;
            for path in &paths {
                if !path.exists() {
                    eprintln!("找不到 Run Log：{}", path.display());
                    failed = true;
                    continue;
                }
                let blob_root = path.parent().unwrap_or(std::path::Path::new(".")).join("blobs");
                let mut log = match RunLog::open(path, &blob_root) {
                    Ok(l) => l,
                    Err(e) => {
                        eprintln!("打不开 {}：{e}", path.display());
                        failed = true;
                        continue;
                    }
                };
                if drop_snapshots {
                    match log.clear_snapshots() {
                        Ok(n) => println!("{}：删除 {n} 个快照", path.display()),
                        Err(e) => {
                            eprintln!("{}：删快照失败 {e}", path.display());
                            failed = true;
                            continue;
                        }
                    }
                }
                let run_ids = match log.run_ids() {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("{}：读 run 列表失败 {e}", path.display());
                        failed = true;
                        continue;
                    }
                };
                for run_id in run_ids {
                    if do_verify {
                        match verify(&log, &run_id) {
                            Ok(report) if report.is_ok() => println!(
                                "OK   {} {run_id}  checkpoints={} final={}",
                                path.display(),
                                report.checkpoints_checked,
                                &report.final_state_hash[..16]
                            ),
                            Ok(report) => {
                                failed = true;
                                for m in &report.mismatches {
                                    eprintln!(
                                        "FAIL {} {run_id} seq={} 期望 {} 实得 {}",
                                        path.display(), m.seq, m.expected, m.actual
                                    );
                                }
                            }
                            Err(e) => {
                                failed = true;
                                eprintln!("FAIL {} {run_id}：{e}", path.display());
                            }
                        }
                    } else {
                        match replay_to(&log, &run_id, None, !drop_snapshots) {
                            Ok(state) => println!(
                                "{} {run_id}  status={:?} turn={} last_seq={}",
                                path.display(), state.status, state.turn, state.last_seq
                            ),
                            Err(e) => {
                                failed = true;
                                eprintln!("FAIL {} {run_id}：{e}", path.display());
                            }
                        }
                    }
                }
            }
            if failed { ExitCode::from(1) } else { ExitCode::SUCCESS }
        }
    }
}
```

- [ ] **Step 4: 跑测试**

Run: `cargo test -p evo-cli`
Expected: PASS，2 个测试

- [ ] **Step 5: Commit**

```bash
git add crates/evo-cli Cargo.toml
git commit -m "feat(cli): replay --verify 与 --drop-snapshots"
```

---

### Task 19: `eval/cases/synthetic-01` 与两条硬测试进 CI

Q-13 要求「回放自校验 M1 内进 CI，先用合成 Log 也要跑」。本任务把它兑现在**第一周**。

**Files:**
- Create: `crates/evo-cli/src/bin/mkcase.rs`（生成合成用例的小工具）
- Create: `eval/cases/synthetic-01/case.yaml`, `eval/cases/synthetic-01/fixtures.json`
- Create: `eval/run.sh`
- Create: `eval/.gitignore`
- Modify: `scripts/ci.sh`

**Interfaces:**
- Consumes: Task 16 的 `Runtime`；Task 18 的 CLI
- Produces: `eval/run.sh` 一条命令跑全集；`scripts/ci.sh` 新增检查 2 与检查 8

> **`runlog.sqlite` 与 `blobs/` 不进 git**（Q-27：eval 冻结快照存 blob store，git 里只放 `case.yaml` / `truth/` / `rules.lock`）。用例由 `mkcase` 在 CI 里当场生成——阶段 1 的合成用例是可重建的，真实冻结用例是 M2 的事。

- [ ] **Step 1: 写用例定义**

`eval/cases/synthetic-01/case.yaml`：

```yaml
# 阶段 1 的合成用例。目的只有一个：让回放自校验在有真实用例之前就跑起来。
# 真实冻结用例（含 truth/ 与 rules.lock）是 M2 的事（07）。
id: synthetic-01
description: 一条两 turn 的 run，第一 turn 调 fs.write，第二 turn 结束
run_id: r-synthetic-01
intent: 把账龄表做出来
clock_start_ms: 1756461600000
fixtures: fixtures.json
expect:
  turns: 2
  checkpoints_at_least: 1
  artifacts:
    - report.txt
```

`eval/cases/synthetic-01/fixtures.json`：

```json
{
  "provider": "fixture",
  "model": "fixture-v1",
  "responses": [
    {
      "text": "{\"intent\":\"tool_call\",\"tool\":\"fs.write\",\"params\":{\"path\":\"report.txt\",\"content\":\"账龄表\"}}",
      "usage": { "input": 120, "output": 40, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop",
      "latency_ms": 12
    },
    {
      "text": "{\"intent\":\"finish\"}",
      "usage": { "input": 200, "output": 10, "cache_read": 0, "cache_write": 0 },
      "stop_reason": "stop",
      "latency_ms": 9
    }
  ]
}
```

`eval/.gitignore`：

```
cases/*/runlog.sqlite
cases/*/runlog.sqlite-*
cases/*/blobs/
cases/*/workspaces/
```

- [ ] **Step 2: 写生成器**

`crates/evo-cli/src/bin/mkcase.rs`：

```rust
//! 从 case.yaml + fixtures.json 生成一条 Run Log，供回放自校验使用。
//!
//! 阶段 1 的合成用例是可重建的，所以 sqlite 不进 git。
//! M2 的真实冻结用例走 blob store（Q-27）。

use evo_daemon::{DaemonConfig, FixedClock, Runtime};
use evo_exec_local::{LocalExecutor, WorkspaceOnlySandbox};
use evo_model::FixtureAdapter;
use evo_protocol::RunId;
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn field<'a>(yaml: &'a str, key: &str) -> Option<&'a str> {
    yaml.lines()
        .find_map(|l| l.strip_prefix(&format!("{key}:")))
        .map(str::trim)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let case_dir = PathBuf::from(
        std::env::args().nth(1).ok_or("用法: mkcase <case_dir>")?,
    );
    let yaml = std::fs::read_to_string(case_dir.join("case.yaml"))?;
    let run_id = RunId::from(field(&yaml, "run_id").ok_or("case.yaml 缺 run_id")?);
    let intent = field(&yaml, "intent").ok_or("case.yaml 缺 intent")?.to_owned();
    let clock_start: u64 = field(&yaml, "clock_start_ms")
        .ok_or("case.yaml 缺 clock_start_ms")?
        .parse()?;
    let fixtures_name = field(&yaml, "fixtures").unwrap_or("fixtures.json");

    // 重新生成前先清干净，否则 seq 会接在上一次后面
    for p in ["runlog.sqlite", "runlog.sqlite-wal", "runlog.sqlite-shm"] {
        let _ = std::fs::remove_file(case_dir.join(p));
    }
    for d in ["blobs", "workspaces"] {
        let _ = std::fs::remove_dir_all(case_dir.join(d));
    }

    let mut config = DaemonConfig::for_test(&case_dir);
    config.principal = "u-eval".to_owned();
    let fixtures = std::fs::read_to_string(case_dir.join(fixtures_name))?;

    let mut rt = Runtime::new(
        config,
        Arc::new(FixedClock::new(clock_start)),
        Arc::new(FixtureAdapter::from_json_str(&fixtures)?),
        Arc::new(LocalExecutor::new(Arc::new(WorkspaceOnlySandbox::new()))),
    )?;
    let state = rt.run_once(&run_id, &intent).await?;
    println!(
        "{}: status={:?} turn={} last_seq={}",
        case_dir.display(), state.status, state.turn, state.last_seq
    );
    Ok(())
}
```

`crates/evo-cli/Cargo.toml` 补 `evo-exec-local.workspace = true`、`evo-model.workspace = true`、`tokio.workspace = true`，并在 `[workspace.dependencies]` 里补 `evo-model` / `evo-exec-local` 的 path 项（Task 1 已列，确认存在即可）。

> `DaemonConfig::for_test` 在 Task 16 里读的是 `CARGO_MANIFEST_DIR/../..` 下的 `config/`。`mkcase` 属于 `evo-cli`，`CARGO_MANIFEST_DIR` 是 `crates/evo-cli`，`../..` 同样指向仓库根，路径成立。

- [ ] **Step 3: 写 `eval/run.sh`**

```bash
#!/usr/bin/env bash
# 一条命令跑全集。阶段 1 只有一条合成用例，跑的是回放自校验。
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build -p evo-cli --bins

for case_dir in eval/cases/*/; do
  echo "== 生成 ${case_dir} =="
  ./target/debug/mkcase "$case_dir"
done

echo "== 回放自校验（带快照）=="
./target/debug/evo-cli replay --verify eval/cases/*/runlog.sqlite

echo "== 回放自校验（删光快照）=="
./target/debug/evo-cli replay --verify --drop-snapshots eval/cases/*/runlog.sqlite

echo "全部通过"
```

- [ ] **Step 4: 手动跑一遍**

Run: `chmod +x eval/run.sh && ./eval/run.sh`
Expected: 两轮校验都输出 `OK ... checkpoints=1 final=...`，最后打印「全部通过」

- [ ] **Step 5: 把两条硬测试挂进 CI**

在 `scripts/ci.sh` 的 `CI-4` 之后追加：

```bash
echo "== CI-2 回放自校验 + CI-8 快照可丢弃 =="
./eval/run.sh
echo "ok"

echo "== CI-3 治理旁路 =="
# evo-exec* 与 evo-mcp 只允许被 evo-daemon（组装点）依赖
for c in evo-exec evo-exec-local evo-mcp; do
  offenders=$(grep -rl "^${c}\.workspace = true" crates/*/Cargo.toml \
              | grep -v "crates/evo-daemon/Cargo.toml" \
              | grep -v "crates/${c}/Cargo.toml" \
              | grep -v "crates/evo-exec-local/Cargo.toml" || true)
  if [ -n "$offenders" ]; then
    echo "FAIL: $c 被 evo-daemon 之外的 crate 依赖：$offenders"; exit 1
  fi
done
echo "ok"
```

> `evo-exec-local` 依赖 `evo-exec` 是允许的（它就是 exec 的实现），所以上面把它排除在外。`evo-cli` 依赖的是 `evo-daemon` 而不是 exec，因此不触发这条。

- [ ] **Step 6: 跑全量 CI**

Run: `./scripts/ci.sh`
Expected: 全部 ok，包含 CI-2 / CI-3 / CI-8

- [ ] **Step 7: Commit**

```bash
git add eval crates/evo-cli scripts/ci.sh
git commit -m "test: 合成用例 synthetic-01，回放自校验与快照可丢弃进 CI"
```

---

### Task 20: 回填契约文档的三处偏离

**红线 3 的精神是「不许后补字段」。** 实现里定下的偏离必须当场写回契约文档，否则半年后没人知道 `plan.step.call` 是从哪来的。

**Files:**
- Modify: `docs/design/01-run-log.md`（§4.1 补 `intent.declared`；§4.3 补 `plan.step.call`）
- Modify: `docs/design/03-kernel.md`（§1 的 `Command::RequestEffect` 签名）
- Modify: `docs/design/00-index.md`（§2 仓库结构：回放器归属）

**Interfaces:**
- Consumes: Task 3、Task 8、Task 15 里记录的三处偏离
- Produces: 契约文档与实现一致；无代码产出

- [ ] **Step 1: 回填 01 §4.1，新增 `intent.declared`**

在 `run.created` 之后插入：

```ts
// kind: "intent.declared"
{ intent_ref: BlobRef,        // 原文进 blob（见第三节）
  char_len: number, lang: string, source: string }
```

并在该节开头那句「24 个事件」旁加一行说明：本节逐条列举为准，`intent.declared` 是 M1 实现时补入的第 25 条——[06 §2](06-protocol.md) 的事件流示例与 [03 §3](03-kernel.md) 的 `RunState.intent` 都依赖它，原目录漏了。

- [ ] **Step 2: 回填 01 §4.3，`plan.step` 增加 `call`**

把 `plan.step` 改为：

```ts
// kind: "plan.step"          // runtime 从 model.responded 解析出的结构化决策
{ turn, intent: "tool_call"|"clarify"|"finish", rationale_ref?: BlobRef,
  taint_inherited: "clean"|"tainted",
  call?: { tool: ToolId, params_ref: BlobRef, params_digest: string } }
```

并在下面补一段：

> `call` 是 optional 新增字段（`schema_ver` 不升，符合本文第三节的变更规则）。它存在的原因是内核要发 `RequestEffect`，而 `class` / `targets` / `egress` 来自工具 manifest——**内核看不到 manifest**。因此 `plan.step` 只带工具名与参数引用，其余字段由 Gateway 在 `tool.requested` 时从 manifest 补全。这与 [02 §1](02-effect-gateway.md)「由工具 manifest 静态推导」不冲突，只是把「谁来推导」写明确了。

- [ ] **Step 3: 回填 03 §1，改 `Command::RequestEffect` 签名**

```rust
pub enum Command {
    SampleEnv,
    AssembleContext { turn: u32, profile: ContextProfile },
    CallModel { turn: u32 },
    RequestEffect { call: PlannedCall },   // 不是完整 EffectRequest，见下
    AskClarification { question: ClarificationSpec },
    Checkpoint { reason: CheckpointReason },
    Suspend { reason: SuspendReason },
    Complete { status: RunStatus },
}
```

在该枚举下补一句：

> `RequestEffect` 带的是 `PlannedCall`（工具名 + 参数引用 + 指纹）而非完整 `EffectRequest`：`class` / `targets` / `egress` / `reversible` 由 Gateway 从工具 manifest 推导，内核看不到 manifest。**内核少知道一样东西，确定性就少一个破口。**

- [ ] **Step 4: 回填 00 §2，回放器的归属**

把仓库结构里的这两行改为：

```
│   ├── evo-runlog/               # SQLite 事件存储、快照存储
...
│   ├── evo-daemon/               # 唯一组装点，唯一写 Run Log 的进程；回放器在此
```

并在「依赖方向」那段下面补一句：

> 回放器需要 `evo-kernel::fold`，放进 `evo-runlog` 会形成兄弟 crate 依赖（`runlog → kernel`），与本节的依赖方向冲突。因此**存储在 `evo-runlog`，回放在 `evo-daemon`**，`evo-cli` 经 daemon 取用。这样「组装只发生在 `evo-daemon`」没有第二个例外。

- [ ] **Step 5: 记下这次就是 schema 变更流程的第一次演练**

在 `docs/design/00-index.md` 第三节「事件 schema 变更流程」下补一行：

> 首次演练：M1 阶段 1 给 `plan.step` 加了 optional 字段 `call`。三条要求逐条兑现——
> ① `schema_ver` 不升（新增 optional 字段）；② 旧版解码路径由
> `evo-protocol` 的 `unknown_optional_fields_do_not_break_decoding` 覆盖；
> ③ `eval/cases/synthetic-01` 的回放在 CI 里通过。**这条流程是可执行的，不是口号。**

- [ ] **Step 6: 确认文档与实现一致**

Run: `grep -n "intent.declared\|params_digest\|PlannedCall" docs/design/01-run-log.md docs/design/03-kernel.md`
Expected: 三处回填都能查到

- [ ] **Step 7: Commit**

```bash
git add docs/design
git commit -m "doc: 回填 M1 实现中定下的三处契约偏离

01 §4.1 补 intent.declared；01 §4.3 plan.step 增加 optional 的 call；
03 §1 RequestEffect 改带 PlannedCall；00 §2 回放器归属改到 evo-daemon。"
```

---

## 阶段 1 完成检查

全部满足才能进阶段 2：

- [ ] `cargo test --workspace` 全绿
- [ ] `./scripts/ci.sh` 全过（含 CI-1 / CI-2 / CI-3 / CI-4 / CI-8）
- [ ] `./eval/run.sh` 两轮校验都通过——**带快照与不带快照结果一致**
- [ ] `cargo tree -p evo-kernel` 里没有 `chrono` / `time` / `rand` / `getrandom` / `uuid` / `tokio` / `reqwest`
- [ ] 一条 run 的事件序列与 [03 §6](../../design/03-kernel.md) 逐条一致
- [ ] Log 的 payload 里查不到任何业务内容（业务数字、客户名），原文能从 blob store 取回
- [ ] Task 0 的依赖探测结论已写进 `docs/superpowers/notes/`，阶段 2 的出口代理路径据此确定
- [ ] 三处契约偏离已回填 `docs/design/`
- [ ] 判据 1 的三项（dry-run / 影响预估 / 审计）有测试守着；**记账那一项在阶段 2 补**——阶段 1 的工具都不产生费用，没有可断言的对象

## 阶段 1 明确不做

留给阶段 2 / 3，不要在本计划里顺手做掉：

| 项 | 归属 |
|---|---|
| 24 事件全集与旧版解码路径 | 阶段 2 |
| 审批挂起与恢复（`approval.*` / `run.suspended`） | 阶段 2 |
| dry-run 第 1 级（调 preview）与预算闸门 | 阶段 2 |
| `codex-network-proxy` 子进程与出口记账 | 阶段 2 |
| 判据 1 的「记账」一项（工具级 `cost.charged`） | 阶段 2 |
| `shell.exec` 工具 | 阶段 2 |
| `runs` 投影表的 status / principal / cost_micros 三列 | 阶段 3（接 `run.list` / `cost.query` 时） |
| HTTP `/v1/rpc`、WS `/v1/events`、ts-rs 导出 | 阶段 3 |
| CI 检查 5 / 6 / 7、GitHub Actions | 阶段 3 |
| macOS seatbelt 实现 | 拿到真机后 |
