# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

当前状态与未做事项见 [`docs/STATUS.md`](docs/STATUS.md)。契约见 [`docs/design/`](docs/design/00-index.md)（00 是索引，含仓库结构、依赖方向、CI 清单、待确认问题）。

Cursor 侧的仓级约定正文是 [`.cursorrules`](.cursorrules)，Agent 模式靠
[`.cursor/rules/`](.cursor/rules/) 加载（`00-core.mdc` 用 `@.cursorrules`
把正文拉进上下文，其余按路径挂分册）。与本文件说的是同一套，不要在那边
另写一份「更强」的保证。

---

## 常用命令

### 收尾必跑

```bash
./scripts/ci.sh                          # 唯一入口，全段绿才算完
ALLOW_SKIP_FRONTEND=1 ./scripts/ci.sh    # 只在没装 node/pnpm 的机器上（交付机）显式跳过前端段
```

`ci.sh` 按顺序跑：CI-10 跟踪状态 → fmt → fmt(src-tauri) → 前端 build/tsc/lint/test →
产物纯净性 → clippy → test → CI-1 → CI-4 → CI-9 → CI-2+CI-8（`eval/run.sh`）→ CI-3。

`ALLOW_SKIP_FRONTEND` **只在工具缺失时才有意义**；工具齐备时它不起作用，不能拿它当
「跳过前端检查」的开关。不设它而工具缺失是硬失败——跳过必须显式，不能静默。

### Rust

```bash
cargo fmt --all                                        # 只覆盖根 workspace
(cd apps/ui/src-tauri && cargo fmt --all)              # src-tauri 是独立 workspace 根，上一条到不了它
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

cargo test -p evo-daemon --test taint_gate             # 单个集成测试文件
cargo test -p evo-kernel reduce                        # 按名字过滤
cargo test -p evo-gateway --test pipeline -- --nocapture
```

集成测试在 `crates/*/tests/`，单元测试在 `#[cfg(test)] mod tests` 里。

### 前端（`apps/ui/`）

```bash
pnpm install --frozen-lockfile
pnpm dev                                   # vite
pnpm build                                 # tsc -b && vite build
pnpm exec tsc -b --noEmit                  # -b 不能省，见下方「永远不会失败的检查」
pnpm lint                                  # oxlint
pnpm test                                  # vitest run
pnpm exec vitest run src/platform/browser.test.ts
```

### eval / 回放

```bash
./eval/run.sh                                          # 三轮回放 + 与 case.yaml 钉住的期望比对

cargo build -p evo-cli --bins
./target/debug/mkcase eval/cases/synthetic-01          # 从 case.yaml + fixtures.json 重建 runlog.sqlite
./target/debug/evo-cli replay --verify eval/cases/*/runlog.sqlite
./target/debug/evo-cli replay --drop-snapshots eval/cases/*/runlog.sqlite
```

合成用例的 `runlog.sqlite` 不进 git，每次由 `mkcase` 重建。

### 单独跑的检查

```bash
./scripts/check-entry-chunk-purity.sh    # 需要先 pnpm build 产出 dist/
./scripts/verify-tauri-config.sh         # tauri.conf.json5 能否反序列化 + 窗口 label 对得上
./scripts/verify-tauri-permissions.sh    # capabilities/default.json 的权限标识符对着锁定版本核实
python3 scripts/codex-closure.py <codex-rs 路径> <crate 名>...   # CI-7，尚无调用方与基线
```

---

## 架构

### 一句话

**Run Log 是权威事实，任务状态是 Log 的折叠结果。**不存在「另外一张表记成本」这种东西——
UI 看到的、报表算出的、审计导出的，是同一条 Log 的不同投影。

### 主循环

```
Event ──▶ reduce ──▶ RunState ──▶ decide ──▶ Command ──▶ runtime 执行 ──▶ Event ──▶ …
         (纯函数)                 (纯函数)              (evo-daemon)
```

`reduce` / `decide` / `state_hash` 是 `evo-kernel` 导出的全部内容。内核**无 IO、无时钟、
无随机数**：想读时间只能读 `RunState::clock_ms`，而它只由 `env.sampled` 事件写入——
想读时钟都没有地方读。这条由 `clippy.toml` 的 `disallowed-methods`/`disallowed-types`
加 CI-1 的 `cargo tree` 检查守着。

回放是同一个 `fold`：快照只是加速，删光后结果必须一字不差（CI-8）。

### 13 个 crate 与依赖方向

```
evo-protocol   ← 谁都依赖它；它不依赖任何 evo-*    事件 schema、ID、blob ref、budget、taint
evo-kernel     ← protocol                          reduce / decide / state_hash / fold
evo-runlog     ← protocol                          SQLite 事件存储、快照、content-addressed blob
evo-context    ← protocol                          上下文装配、污点传播、cite
evo-memory     ← 尚无依赖（lib.rs 为空）             记忆 + 口径库，POC 期建表不启用
evo-policy     ← protocol                          PolicyHook trait + config/policy.toml
evo-gateway    ← protocol + policy                 六步管线
evo-exec       ← protocol                          Executor / Lease / Sandbox / WorkspaceHandle 接口
evo-exec-local ← exec + protocol                   本地沙箱执行器
evo-model      ← protocol                          模型 adapter + 定价表
evo-mcp        ← 尚无依赖（lib.rs 为空）             MCP client，未开始
evo-daemon     ← 上面除 memory / mcp 之外的全部      唯一组装点、唯一写 Run Log 的进程、回放器
evo-cli        ← daemon                            replay 命令 + mkcase
```

**组装只发生在 `evo-daemon`。** 新增一条兄弟 crate 之间的依赖，要在 PR 描述里说明为什么
不能由 daemon 组装。CI-3 机器执行这一条：`evo-exec` / `evo-exec-local` / `evo-mcp` /
`evo-runlog` 只允许被 `evo-daemon` 依赖（唯一例外：`evo-exec-local → evo-exec`）。

回放器住在 `evo-daemon/src/replay.rs` 而不是 `evo-runlog`，正是因为它要 `evo-kernel::fold`，
放进 runlog 就会造出一条 `evo-runlog → evo-kernel` 的兄弟依赖。

### Effect Gateway 六步管线

`crates/evo-gateway/src/pipeline.rs::admit`。**任何工具调用只有这一个出口**，包括内置工具。

| 步 | 内容 | 现状 |
|:-:|---|---|
| ① | 身份解析 | `CapabilityToken.subject` 全仓无读者——不是弱实现，是不存在 |
| ② | 能力校验 | `allows()` 本身对，但 daemon 两个构造点写死 `scopes: ["*"]` |
| ③ | **污点闸门** | 在 ④ 之前，且不可被策略放宽 |
| ④ | 策略求值 | `config/policy.toml`，先命中先赢 |
| ⑥ | 影响预估 | 无条件执行、无条件落事件 |
| ⑤ | **预算闸门** | 提到 ⑥ 后面，无条件执行 |

`admit` 是纯函数：不持有 run 状态、不做 IO。要 preview 就返回 `NeedPreview { pending }`
让 daemon 去问 executor，再从 `admit_with_preview` 续跑。

关键不变式：`tighten(decision, floor)` —— **闸门只收紧不放宽**。manifest 缺失 → 最严默认
（External + 不可逆 + 需审批）；污点未清 → 至少 L2。`tighten` 对 `Deny` 原样返回。

### 事件 schema

`crates/evo-protocol/src/event.rs` 的 `event_body!` 宏统一生成变体列表、`kind()`、
`schema_ver()`、测试样本表。**新增变体不写 `sample =` 就编译不过。**

三条硬约束：只增不改；新增字段必须 optional；改语义必须升 `schema_ver` 并保留旧版解码。
任何事件结构体都**不得**加 `#[serde(deny_unknown_fields)]`——
`all_27_variants_tolerate_unknown_optional_fields` 对全部变体穷尽验证这一条。

改 `evo-protocol` 的事件定义，PR 必须同时含：① `schema_ver` 处理 ② 旧版解码路径与测试
③ `eval/cases/` 里至少一条历史 Log 回放通过。缺一条合不进去。

### 桌面外壳（`apps/ui/`）

Vite + React。`src/platform/` 是**唯一**允许出现 `@tauri-apps/`、`ipcRenderer`、`__TAURI`
的目录（CI-9），浏览器与 Tauri 两套实现同时在；`src/daemon/` 的 `daemonClient` 是 UI 访问
daemon 的唯一模块；`src-tauri/` 是约 200 行零业务逻辑的壳，用空 `[workspace]` 把自己隔离成
独立 workspace 根（避免根 workspace 的 `cargo clippy --workspace` 拉进 GTK 依赖链）。

`src-tauri/capabilities/` 缺失时**不报任何错**：Tauri 2 会静默解析出空权限集，编译不报、
启动不报，只在真机上第一次调用桌面能力时以 `command not allowed` 拒绝。

### 配置

`config/policy.toml`（策略规则，先命中先赢）、`config/tools.toml`（工具 manifest，未列出的
按最严处理）、`config/pricing.toml`（定价表）。三份都由 `DaemonConfig` 以字符串读入。

---

## Conventions

### Commit messages

Git commit messages **must be written in English**, including subject and body.

Keep the existing prefix style: `doc:`, `feat:`, `fix:`, etc.

```
doc: tighten the demo-moment-1 narrative (closes Q-29)
```

The whole history is English. The Chinese subjects that predated this convention
were rewritten on 2026-08-29 (main) and 2026-08-30 (the M2 and desktop-shell
branches, on merge).

Documents themselves (everything under `docs/`) stay in Chinese.

### 每个任务的收尾条件

- `cargo fmt --all`
- `./scripts/ci.sh` 全段绿——**不是** `cargo test -p <crate>`。曾有连续四个任务只跑单 crate 测试，攒出三个 crate 的 fmt 漂移
- 改了 `Cargo.toml` 依赖必须一并提交 `Cargo.lock`
- 一个逻辑改动一次 commit

### 绝不 `git add -A`

`apps/ui/` 的 `.gitignore` 只在桌面外壳分支上被跟踪，在别的分支上 `apps/ui/node_modules`
是未忽略的未跟踪文件。一次 `git add -A` 曾把 3781 个文件、150 万行扫进提交，
最后靠 `filter-branch` 重写 13 个 commit 才清掉。

CI-10 现在会拦住这类误提交，但它是最后一道，不是第一道。

---

## 三条不可议价的工程约定

这三条是本项目反复付出代价换来的。它们**优先于**「让测试变绿」这个目标。

### 一、新增的检查必须被证明能失败

本项目已抓到**七处**「永远不会失败的检查」：

| 检查 | 为什么永远绿 |
|---|---|
| CI-3 治理旁路 | grep 只覆盖点分写法，漏掉混合写法 |
| `verify()` | 没有 checkpoint 时返回成功 |
| `eval/run.sh` | 从不读快照，且哈希只打印不比较 |
| CI-9 外壳隔离 | 只匹配 `@tauri-apps/api`，而 Tauri 2 的插件包名没有一个含 `api` |
| bundle 纯度 | `grep -c "tauri-apps" dist/` —— 压缩产物不保留 npm scope，恒为 0 |
| 前端类型检查 | `tsc --noEmit` 缺 `-p`/`-b`，实际编译 0 个文件 |
| CI-3（第二次） | `grep -v evo-exec-local` 无条件写在循环体内，把该 crate 从四条检查里全免 |

**要求**：新增或修改任何检查，必须构造一个具体的违规输入，实测它会红，再恢复确认复绿。
三段输出都要留证。**答不出「什么输入能让它红」的检查，等于没有这条检查。**

两个已经骗过我们的陷阱：

- 交互式 shell 的 `grep` 是 `.gitignore`-aware 的包装，与脚本里跑的 `grep` 行为不同。
  **一律调真实的 `./scripts/ci.sh`，不要在命令行手工重现脚本里的 grep。**
- 修完之后，拿修好的检查当靶子再打一轮。两条检查这样各又抓出三条绕法。

### 二、测试要断行为，不断中间状态

澄清死循环之所以漏掉：测试断了「`pending_question` 被清空」，没断「清空之后 `decide`
真的往前走」。于是「答了问题但运行卡死」通过了全部测试。

同一个坑的三个变体，都在本仓出现过：

1. **测试断中间字段**——如上。
2. **测试把 bug 当成期望行为编码进去**——daemon 里真有一条，修复时它会变红，
   那正是它该有的反应，不要把它改绿。
3. **测试切在缺陷的上游**——接通污点闸门时**没有任何现有测试变红**，因为仅有的
   三条污点断言都是把 `Tainted` 直接注入 `AdmitRequest`，测的是 bug 上面那一层，
   永远红不了。

**要求**：修 bug 时，先写一条在**未修**代码上会红的测试，把红的输出留证，再修。
「我加了测试且它绿」不算。

### 三、注释不要宣称代码做不到的事

M2 终审在一条分支上数出**十处**「注释断言了一件代码不做的事」。举两个：

- `runtime.rs` 的注释说「被拒绝的 effect 会被标成 `EffectState::Denied`」——
  这个机制不存在，于是 `resume()` 把它当成已批准直接执行（红线 1 破口）。
- `reduce.rs` 的注释说「外部返回一律 tainted」——而三个执行出口全部写死 `Clean`，
  污点闸门恒为 false。

它们的共同形状是：**结构先写对、注释先写足、测试断中间字段——三样互相印证，
唯独没有一样碰到真实输入边界。**

**要求**：写下「本层保证 X」之前，问一句代码在哪一行做了 X。做不到就改成
「本层**不**保证 X，见 <位置>」——过强的声明比没有声明更危险，它会让下一个人
不去检查。

---

## 结构优于纪律

能让错误**写不出来**的结构，优于要求人记住的纪律。本仓已有的例子：

- `tighten(decision, floor)` —— 「闸门只收紧不放宽」曾被写坏三次，抽出这个函数后
  「放宽」无法表达。
- `event_body!` 宏 —— 新增事件变体不写 `sample =` 就编译不过。
- `admit_with_preview` 改成关联函数（**待做**）—— 收 `&self` 却不用，
  「不许重新求值」目前只有注释挡着；去掉 `&self`，重新求值即成编译错误。

评审时如果发现「这里靠约定」，先想一想能不能改成「这里靠类型」。

---

## eval 钉住的哈希

`eval/cases/synthetic-01/case.yaml` 里的 `final_state_hash` 是判据 3 的锚点。

它**可以**变——`RunState` 形状一变，哈希必然跟着变。但每次变更必须：

1. 在一个**只含本次改动**的工作区上重新生成
2. 逐条核对新旧事件 kind 序列的差异**是本次有意引入的**
3. 按该文件里现有注释的格式，写清楚变了什么、为什么变、以及**哪些没变**

**绝不能不加说明就换掉这个值。** 现有的三段注释是范例。

## CI 检查编号跨分支唯一

设计文档 00 §4 的清单靠编号索引。并行分支各自新增检查时会撞号——
`m1-desktop-shell` 的 CI-9 与 M2 分支的构建产物检查就撞过，后者改成了 CI-10。

新增检查前，先看一眼其他未合并分支占用了哪些号。10 条里已实现 8 条
（缺 CI-6 vendor、CI-7 依赖闭包），逐条状态见 `docs/STATUS.md`。
