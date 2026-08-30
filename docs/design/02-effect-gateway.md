# 02 · Effect Gateway 与 dry-run

> 地基 B。治理层与安全层的全部 P0 都落在这一个组件上。
>
> 它对不对，只有一条判据（技术路线第七节判据 1 / POC 自检第 3 条）：
>
> > **新接入一个工具，不改任何治理代码，它自动获得 dry-run、影响预估、审计、记账、限流。工具作者不写一行相关代码。**
>
> 做不到，说明 Gateway 做成了一个转发函数——那是红线 2 的另一种形式。

---

## 一、这条判据只有一种实现方式

先说结论，因为它决定了后面所有接口的形状：

> **Effect 必须是一个可被 Gateway 读懂的「声明」，不能是一个待执行的闭包。**

如果 effect 是 `Box<dyn FnOnce() -> Result<T>>`，Gateway 除了「调用它 / 不调用它」什么都做不了：它算不出影响面、给不出 dry-run、判不了策略。于是 dry-run 只能由每个工具自己实现——这正是技术路线点名的反模式，也是 4.11② 观察到的 codex 的现状（`apply_patch` 的 diff 是单工具特性，全仓没有跨工具统一的 dry-run）。

反过来，只要 effect 是一个带类型的**描述**，六步管线里的每一步都能在不认识具体工具的前提下工作。

```rust
pub struct EffectRequest {
    pub effect_id: EffectId,
    pub run_id: RunId,
    pub turn: u32,
    pub tool: ToolId,            // "fs.write" | "shell.exec" | "mcp:<server>/<method>"
    pub params: JsonValue,

    // —— 以下全部由工具 manifest 静态推导，不由工具代码运行时计算 ——
    pub class: EffectClass,      // Read | Write | External | Compute
    pub targets: Vec<ResourceRef>,
    pub egress: Vec<EgressRef>,
    pub reversible: bool,

    // —— 由 runtime 填入 ——
    pub taint: TaintLevel,       // 本次上下文的污点等级
    pub cites_referenced: Vec<CiteId>,
    pub capability: CapabilityToken,
}
```

`class` 的语义：

| class | 含义 | dry-run 下的行为 |
|---|---|---|
| `Read` | 无副作用的读 | **照常执行**（否则预估不准） |
| `Write` | 改变本地或外部状态 | 降级为 record-only 或 preview |
| `External` | 对外发送 / 触达他人 | 降级为 record-only，且**永不自动放行** |
| `Compute` | 纯计算，无 IO | 照常执行 |

---

## 二、六步管线

技术路线画的那条管线，逐步落到接口上。每一步产出一个 Run Log 事件——**这样「Gateway 做了什么」本身是可回放、可举证的**，而不是一堆日志行。

```
tool.requested (事件已写入 Log)
   │
   ├─ ① 身份解析     principal = run.principal ∩ capability.subject
   ├─ ② 能力校验     capability.allows(tool, targets)?          权限只能收窄
   ├─ ③ 污点检查     taint == Tainted && class != Read → 强制审批
   ├─ ④ 策略求值     PolicyHook::evaluate(ctx)                  → policy.evaluated
   ├─ ⑥ 影响预估     ImpactEstimator::estimate(effect)          → impact.estimated
   ├─ ⑤ 预算闸门     token / 时长 / 金额 / 并发 / 递归深度
   │                 （求值次序上在 ⑥ 之后，见下方细节 4）
   │
   ├─ decision == RequireApproval → approval.requested，run 挂起
   ├─ mode == DryRun && class ∈ {Write, External} → 不派发，直接产出 tool.result{status:"dry_run"}
   └─ 否则 → effect.dispatched → 执行面
   │
   └─ 回流：tool.result + cost.charged
```

三个不可让步的细节：

1. **③ 在 ④ 之前。** 污点检查是结构性的，不允许被策略放行——策略可以放宽目录权限，不能放宽「不可信内容不得触发提权动作」。这是技术路线地基 C 那条「提示注入防护必须是结构性的，不能是嘱托性的」在 Gateway 里的落点。
2. **⑥ 无条件执行，不只在 dry-run 时执行。** 影响预估是审计与审批材料的一部分，正常模式下也要有。
3. **每一步失败都写事件再返回。** 「被拒绝的调用」是审计里最有价值的记录，不能只在内存里 return。
4. **⑤ 的求值次序在 ⑥ 之后，编号不变。** 预算闸门有两类判据：「已经花光了没有」（`used >= max`，三个维度各判各的）与「按影响预估这一次会不会打穿」（`used + est_cost > max`，即预扣）。后一类的输入 `est_cost_micros` 就是 ⑥ 的产出，而 ⑥ 按细节 2 必须无条件执行。把 ⑤ 排在 ⑥ 前面只有两种收场：要么 ⑥ 变成有条件的（破细节 2——一次被预算拦下的调用照样该留下影响预估，那是人决定要不要提额时唯一的材料），要么预扣那一半永远读不到值，闸门只剩一半。挪的只是求值次序，判定方向不变：③④ 收紧出来的结论已经落定，⑤ 只会在它之上再加严，从不放宽。实现见 `crates/evo-gateway/src/pipeline.rs` 的 `budget_gate`。

   ⑤ 也排在审批分支**之前**：没钱就是没钱，先请人批一个注定跑不动的动作是在浪费人的注意力，而审批疲劳会让所有审批一起贬值。

### POC 期各步的实现程度

| 步 | POC 期 | 将来换什么 | 换的时候动调用点吗 |
|:-:|---|---|:---:|
| ① 身份 | 单用户，`principal` 来自 daemon 配置 | SSO / IAM | 否 |
| ② 能力 | `CapabilityToken` 结构存在，只做 scope 字符串匹配 | macaroon / biscuit 可衰减令牌 | 否 |
| ③ 污点 | **完整实现**（结构性，不能糊） | — | — |
| ④ 策略 | `HardcodedPolicy` 读一个 TOML | Cedar / OPA | 否 |
| ⑤ 预算 | token + 金额 + 时长三维全部通电；并发与递归深度留字段 | 加维度 | 否 |
| ⑥ 预估 | 见第三节 | 提高精度 | 否 |
| 记账 | **完整实现** | — | — |

策略钩子的接口就是最终接口：

```rust
pub trait PolicyHook: Send + Sync {
    fn evaluate(&self, ctx: &PolicyContext) -> PolicyDecision;
    fn version(&self) -> &str;          // 进 policy.evaluated.policy_ver
}
pub enum PolicyDecision { Allow, Deny { reason_code: String }, RequireApproval { risk: RiskLevel } }
```

换 Cedar 时只实现一个新的 `PolicyHook`,Gateway 一行不动。这是 0.2 白名单第一行的可执行形态。

---

## 三、dry-run 是执行策略，不是工具特性

Gateway 有一个 `ExecutionMode`：

```rust
pub enum ExecutionMode { Live, DryRun }
```

它挂在 run 上（整个 run 干运行）或挂在单个 effect 上（某一步先预览）。工具**完全不知道**自己在 dry-run 下——这正是判据 1 的要求。

### 三级降级

| 级别 | 条件 | dry-run 产出 | 精度 |
|:-:|---|---|---|
| 1 | 工具 manifest 声明了 `preview` 方法 | 调 preview，得到精确 diff / 将写入的记录清单 | `exact` |
| 2 | 未声明 preview，但 targets 可从参数静态提取 | 「将触碰这些资源」清单，无内容级 diff | `declared_only` |
| 3 | targets 无法静态提取（`shell.exec` 一类） | 「将在沙箱工作区内执行，出口受白名单约束」+ 命令原文 | `declared_only` |

**第 2、3 级不阻塞接入**，这一点很重要：如果只有实现了 preview 的工具才能接入，接入门槛会高到没人接，最后一定有人加个后门绕过 Gateway。优雅降级是这个设计能被遵守的前提。

对应 4.4② 的用友回写 dry-run：用友 MCP Server 把 `create_voucher` 声明为 `Write` 并实现 `preview`，返回将写入的凭证清单、科目、金额、影响期间。**产品主干零特化**——演示时刻 2 那一幕，在产品侧是「一个第三方工具声明了 preview」而已。

> **注意 Read 在 dry-run 下照常执行**：它会真的调模型、真的花钱。这是设计选择（不执行读就估不出影响），但要在 UI 上说明，也要在演示前跟客户讲清楚。**Q-09**

---

## 四、工具 manifest：判据 1 的实现机制

Gateway 能对任何工具算出 `class` / `targets` / `egress`，靠的是注册时的一份 manifest。工具作者写的是**声明**，不是治理代码。

```toml
# 内置工具示例
[[method]]
name = "fs.write"
class = "write"
reversible = true
targets = [{ from_param = "/path", kind = "file", op = "update" }]   # JSON Pointer
preview = "fs.write.preview"

[[method]]
name = "shell.exec"
class = "write"
reversible = false
targets = [{ literal = "sandbox:workspace", kind = "workspace", op = "update" }]
egress  = [{ via = "proxy" }]         # 出口不可静态知晓，交给 proxy 兜底
```

| manifest 来源 | 怎么得到 |
|---|---|
| 内置工具 | 与代码同仓，编译期校验 |
| MCP server | MCP 的 tool 描述**不含**这些字段。由 daemon 侧一个 `mcp-manifest.toml` 补齐；未提供 manifest 的 server，**其全部方法默认按 `External` + 不可逆 + 需审批处理** | 
| skill / 流程库 | 同 MCP |

那个默认值是有意选成最严的：**忘记写 manifest 的后果是「多问一次人」，不是「静默漏掉治理」。** 反过来设默认值是这类系统最常见的失误。

**Q-11 已定**：MCP server 的 manifest 由 daemon 侧维护（与 server 实现同目录，但由我们写），默认最严。**M2 期要观察一件事**：默认最严会不会导致演示中频繁弹审批。若确实频繁，正确的解法是补 manifest，不是放宽默认值。

---

## 五、静态分析管不住的部分：沙箱与出口代理是兜底面

`shell.exec` 的 targets 无法静态提取——Agent 会执行任意命令、装依赖、起子进程。这不是设计缺陷，是必然。

处理方式是**把治理面下沉一层**：

| 管不住的 | 谁兜底 |
|---|---|
| 命令会读写哪些文件 | 沙箱：进程只能看到 run 的工作目录 + 只读的系统路径 |
| 命令会连哪些网络 | 本地 forward proxy：默认拒绝，全量记账，子进程强制走 `HTTP(S)_PROXY` |
| 命令会不会提权 | 沙箱原语（`sandbox-exec` / landlock / AppContainer） |

技术路线那句「网络出口必须在 proxy 层管控，不能在 SDK 层拦截」，在这里得到解释：**SDK 层拦截只能管住 Gateway 认识的调用，而 shell 类工具恰好是 Gateway 认不出的那一类。**

这条要主动讲给客户的安全评审，不要等被问穿：**声明式治理管住能静态分析的部分，沙箱与出口代理管住剩下的部分，两者合起来没有缝。** **Q-10**

---

## 六、高危分级与审批

```rust
pub enum RiskLevel { L1, L2, L3 }
```

| 级 | 判据 | 处理 |
|:-:|---|---|
| L1 | 可逆、仅本地、不对外 | 直接执行，只留审计 |
| L2 | 不可逆或影响面大，但不对外 | 进审批队列，可批量放行 |
| L3 | 对外发送 / 资金 / 生产系统写 / 不可逆且不可预演 | 强制单条审批，**不可批量放行** |

分级规则**放在策略钩子里**，不硬编码在 Gateway。这样换客户只换 TOML。

POC 期的实际情况（4.9）：整个 POC 系统不对外发出任何一条消息，唯一的写是本地文件，唯一的外发是企业微信内部推送。所以 L3 在 POC 期只有一个实例——**用友回写的 dry-run 预览**（它本身不写，但要走完整审批流以演示机制）。

审批的异步性由 Log 承载，不需要额外机制：`approval.requested` → run 挂起 → 人在 UI 或点企业微信里的链接放行 → `approval.granted` → run 从检查点续跑。

> POC 期审批入口是「企业微信推消息附链接 → 点开回到 UI 批准」，不做公网回调。理由见 POC 文档 4.9：不要为了一个 webhook 入口把控制面搬上云。

---

## 七、预算闸门

```rust
pub struct BudgetSpec {
    pub max_tokens: Option<u64>,
    pub max_amount_micros: Option<u64>,
    pub max_wall_seconds: Option<u64>,
    pub max_concurrency: Option<u32>,      // [P2]
    pub max_recursion_depth: Option<u32>,  // [P2]
}
```

超限行为是**挂起**（`run.suspended { reason: "budget_exhausted" }`），不是失败、不是静默继续。人可以提额续跑。这条是功能清单原话「超限自动挂起而非静默烧钱」。

**闸门有两道，分工不同，谁也替代不了谁：**

| | 在哪 | 拦什么 | 判据 |
|---|---|---|---|
| turn 级 | `evo_kernel::decide` 的 `budget_exhausted` | 这条 run 还能不能开始下一步 | `used >= max`，三维独立 |
| effect 级 | 本文档第二节的 ⑤，`evo_gateway` 的 `budget_gate` | 这一次工具调用会不会打穿额度 | 同上，外加预扣 `used + est_cost > max` |

内核看不到 manifest 与影响预估（它连 `est_cost_micros` 都拿不到），Gateway 不驱动 turn 循环——两道必须各写各的。

判据用 `>=` 而不是 `>`：**正好花到上限时余额是 0**，再放行一次动作必然超支；`>` 把上限读成了「可以花到、并且可以再多花一次」。

**提额靠一条 `budget.amended` 事件**（01 §4.5），不是改配置、更不是改内存里的状态字段——`DaemonConfig.budget` 只决定新 run 的起点，改它对已经在跑的 run 无效，它们的额度活在各自的 Log 里。续跑需要两条事件：先 `budget.amended` 抬高上限（否则判定仍然为真，内核立刻再挂一次），再 `run.resumed` 清空挂起。

**记账项：模型调用这一侧还没有预扣。** ⑤ 的预扣只覆盖 effect（而且只在拿得到 `est_cost_micros` 时生效）；模型调用的计费发生在调用**之后**（`cost.charged`），调用之前无从知道这次会花多少 token。所以即便闸门活着，最坏情况仍会超支整整一次模型调用的成本，上界是「一次调用」。真正的预扣要一套「预留 → 结算/释放」事件，留给后续。

子 run 的预算从父 run 扣，且不能超过父 run 剩余——[P2]，但字段现在就在。

---

## 八、这一个组件兑现了哪些 POC 项

排期时必须这样算账，否则 Gateway 会被当成「没有用户价值」砍掉——那正是红线 2。

| POC 项 | 在 Gateway 上是什么 | 增量工作 |
|---|---|---|
| A-4 干运行 + 影响预估 | `ExecutionMode` + `ImpactEstimator` | 渲染 |
| A-5 高危确认（异步） | `RequireApproval` + 两个事件 | 渲染 |
| A-7 成本归因 | 记账步 | 聚合查询 + 渲染 |
| A-10 出口白名单 | 第五节的 proxy 兜底 | 配置 + 日志展示 |
| 放权分级 | 策略钩子的 TOML | 配置 |
| 触发限流熔断 | 预算闸门的另一组维度 | 配置 |

---

## 九、待确认

| # | 问题 | 谁定 | 备注 |
|:-:|---|:---:|---|
| Q-08 | 高危分级的具体口径：哪些动作 L2、哪些 L3、审批人是谁 | 客户 | |
| Q-09 | dry-run 下只读动作照常执行会产生真实模型费用，能否接受 | 客户 | |
| Q-10 | 安全评审能否接受「shell 类工具由沙箱 + 出口代理兜底」这套说法 | 客户 | |
| ~~Q-11~~ | ~~manifest 由谁维护；「无 manifest 即最严」会不会频繁弹审批~~ | — | **已定：daemon 侧维护、默认最严**。弹审批频率在 M2 观察，解法是补 manifest 而非放宽默认值 |
