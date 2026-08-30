# 01 · Run Log 事件 schema

> 地基 A 的数据契约。[技术路线第三节](../next-gen-agent-platform-tech-roadmap.md) 只给了 12 个事件名，本文给出字段。
>
> **这是整套设计里唯一「必须一次做对」的东西**——POC 文档红线 3：字段先存个大概，半年后旧任务不可回放，审计价值归零，且早期 Log 是 Phase 4 自蒸馏的原料，补不回来。

---

## 一、三条设计前提

**① Log 是权威事实，不是日志。**
任务状态 = Log 的折叠结果。UI 看到的、报表算出来的、审计导出的，全部是同一条 Log 的不同投影。**不存在「另外一张表记成本」这种东西**——那正是 4.11② 批评 codex 的地方：回放、成本、审计三套数据对不上账。

**② 事件只增不改，压缩也是新事件。**
上下文压缩必须表达为 `context.compacted` 事件，原始事件永不删除或改写。这条与 codex 的 `Compacted` 直接对立，是有意为之：审计要的是原件。

**③ 内容与元数据分离存储。**（本文最重要的一条，见第三节）

---

## 二、存储形态

SQLite WAL，append-only。表结构就是最终结构：

```sql
CREATE TABLE run_events (
  run_id      TEXT    NOT NULL,
  seq         INTEGER NOT NULL,          -- 单 run 内从 0 单调递增
  kind        TEXT    NOT NULL,          -- 事件类型，见第四节
  schema_ver  INTEGER NOT NULL,          -- 事件级版本号，不是全局版本
  recorded_at TEXT    NOT NULL,          -- daemon 写入时刻。内核不可见（见第五节）
  actor       TEXT    NOT NULL,          -- kernel | runtime | gateway | executor | human:<id> | trigger:<id>
  payload     TEXT    NOT NULL,          -- JSON，只含元数据与 ref
  prev_hash   BLOB,                      -- [Phase 3] hash chain
  hash        BLOB,                      -- [Phase 3]
  PRIMARY KEY (run_id, seq)
) STRICT;

CREATE TABLE runs (                      -- 纯投影表，可从 run_events 全量重建
  run_id TEXT PRIMARY KEY, parent_run_id TEXT, workspace_id TEXT NOT NULL,
  principal TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, last_seq INTEGER NOT NULL,
  title TEXT, cost_micros INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE snapshots (                 -- 只是加速，删掉不影响正确性
  run_id TEXT NOT NULL, seq INTEGER NOT NULL,
  state_blob BLOB NOT NULL, state_hash BLOB NOT NULL,
  PRIMARY KEY (run_id, seq)
) STRICT;

CREATE TABLE blobs (                     -- 见第三节
  content_hash TEXT PRIMARY KEY,         -- sha256:<hex>
  size INTEGER NOT NULL, mime TEXT NOT NULL,
  path TEXT NOT NULL,                    -- 相对 blob 根目录
  class TEXT NOT NULL,                   -- metadata | content | artifact
  created_at TEXT NOT NULL, retain_until TEXT
) STRICT;
```

**`runs` 与 `snapshots` 都是可丢弃的派生数据**——这一点要在代码里用类型体现（`ProjectionTable` 标记），否则半年后一定会有人往 `runs` 里塞一个 Log 里没有的字段，那一刻 Log 就不再是权威事实了。

版本化：事件级 `schema_ver`。全局版本号是个陷阱——加一个字段就要全表升版，然后没人敢加字段。

---

## 三、内容与元数据分离（本文最重要的一条）

技术路线写过：「控制面存的是事件元数据，文件内容与执行产物仍留在执行面」。

**但按事件名直觉展开会立刻违反它**：`model.requested` 里的 messages 就是财务明细本身，`intent.declared` 的原文里有客户名和金额。这两个字段一旦直接进 `payload`，Phase 3 把 Run Log 镜像上云的那天，客户的应收明细就跟着上云了——而「数据不出内网」正是这个客户的准入条件。

所以：

> **`run_events.payload` 里只允许出现元数据与 `content_hash`。任何可能含业务内容的东西一律进 blob store，事件里只留引用。**

| 只能进 blob（`class = content`） | 可以进 payload（元数据） |
|---|---|
| 用户意图原文 | 意图的长度、语言、来源 |
| 模型请求的 messages 全文 | 消息条数、token 估算、request_digest |
| 模型响应原文 | usage、stop_reason、latency、response_hash |
| 工具入参中的业务值 | 工具名、参数结构指纹、目标资源标识 |
| 工具输出全文 | 状态、字节数、行数、产出的 cite id 列表 |
| 产物文件内容 | 路径、mime、size、content_hash |

**收益**：Phase 3 镜像上云时，`run_events` 表整表可以直接同步，blob 留本地。本地回放是全量的，云端回放退化为「决策链 + 成本 + 策略判定」——这恰好就是合规举证需要的东西，而它一个业务数字都不含。

**代价**：现在做为零（本来就要存 blob）；后补要改每一个事件的定义与所有读取方。

**Blob 形态（Q-03 已定）：文件系统 + content-addressed 目录，不塞进 SQLite。**

```
blobs/<hash[0:2]>/<hash[2:4]>/<hash>      # sha256 十六进制
```

`blobs` 表只是索引与保留期（`retain_until`），内容在文件里。理由：模型响应原文与 Excel 产物都可能到 MB 级，塞进 SQLite 会让 WAL 与备份都难受；而 content-addressed 让 Phase 3「事件表上云、blob 留本地」是一次目录级的划分，不需要逐字段挑。

---

## 四、事件目录（v1）

24 个事件。标 `[P2]` 的是留位，POC 不产生但字段必须在。

> 本节逐条列举为准。`intent.declared` 是 M1 实现时补入的第 25 条——原目录漏了它，但
> [06 §2](06-protocol.md) 的事件流示例用了它，[03 §3](03-kernel.md) 的 `RunState.intent`
> 也依赖它。定义见 `crates/evo-protocol/src/events/lifecycle.rs` 的 `IntentDeclared`。
>
> `budget.amended` 是 M2 接通预算闸门时补入的第 26 条（见 4.5 末尾的说明）。加上
> 它，`crates/evo-protocol/src/event.rs` 的 `EventBody` 现在是 27 个变体——比这里
> 列的多一个，因为 `run.spawned`/`run.joined` 两条 [P2] 还没进代码，而 `checkpoint`
> 在代码里算一个变体。两边的对照由该文件的
> `the_event_catalog_covers_every_kind_the_contract_lists` 逐条钉住：改了这份目录
> 就要改那份清单，反之亦然。

### 4.1 生命周期

```ts
// kind: "run.created"
{ run_id, parent_run_id?: string,          // [P2] 子 Agent
  workspace_id, principal: PrincipalRef,   // 谁的权限（Agent 权限只能是它的子集）
  trigger: { kind: "manual"|"schedule"|"webhook"|"file"|"condition", ref: string },
  budget: BudgetSpec,                      // token / 时长 / 金额 / 并发 / 递归深度
  labels: Record<string,string> }

// kind: "intent.declared"    // M1 实现补入，见本节开头的说明
{ intent_ref: BlobRef,        // 原文进 blob，事件里只留长度、语言与引用
  char_len: number, lang: string, source: string }

// kind: "run.suspended"  { reason: "awaiting_approval"|"awaiting_human"|"budget_exhausted"|"paused", detail_ref? }
// kind: "run.resumed"    { by: ActorRef, from_seq: number }
// kind: "run.completed"  { status: "ok"|"partial", summary_ref?: BlobRef, acceptance?: AcceptanceReport }
// kind: "run.failed"     { at_seq: number, error: { code, message_ref, retryable: boolean } }
// kind: "run.spawned"    [P2] { child_run_id, purpose, budget: BudgetSpec }
// kind: "run.joined"     [P2] { child_run_id, status, result_ref? }
```

### 4.2 确定性输入（见第五节）

```ts
// kind: "env.sampled"
{ turn: number,
  wall_clock_ms: number,      // 内核唯一的时间来源
  rng_seed: string,           // 内核唯一的随机数来源
  env: Record<string,string>, // 白名单内的环境变量快照
  model_route: { provider, model, params_digest } }
```

### 4.3 上下文与模型

```ts
// kind: "context.assembled"
{ turn, profile: string,      // "default" | "verifier" | ...  见 04 文档
  blocks: Array<{ cite_id, source, trust: "user_direct"|"org_trusted"|"untrusted",
                  scope, content_hash, span?, token_estimate }>,
  taint_level: "clean"|"tainted",   // blocks 中最高污点
  total_token_estimate: number }

// kind: "model.requested"
{ turn, provider, model, params: ModelParams,
  request_digest: string,     // 用于回放核对
  messages_ref: BlobRef }     // 全文进 blob

// kind: "model.responded"
{ turn, response_ref: BlobRef, response_hash: string,
  usage: { input, output, cache_read, cache_write },
  stop_reason, latency_ms }

// kind: "plan.step"          // runtime 从 model.responded 解析出的结构化决策
{ turn, intent: "tool_call"|"clarify"|"finish", rationale_ref?: BlobRef,
  taint_inherited: "clean"|"tainted",
  call?: { tool: ToolId, params_ref: BlobRef, params_digest: string } }

// kind: "context.compacted"  // 压缩是新事件，不改旧事件
{ from_seq, to_seq, summary_ref: BlobRef, summary_cite_id }
```

> `call` 是 `plan.step` 的 optional 新增字段（`schema_ver` 不升，符合第三节的变更规则，
> 见 [00 §3](00-index.md#三开发约定五条不可议价) 的「首次演练」记录）。它存在的原因是内核要发
> `RequestEffect`，而 `class` / `targets` / `egress` 来自工具 manifest——**内核看不到
> manifest**。因此 `plan.step` 只带工具名与参数引用，其余字段由 Gateway 在
> `tool.requested` 时从 manifest 补全。这与 [02 §1](02-effect-gateway.md)「由工具
> manifest 静态推导」不冲突，只是把「谁来推导」写明确了。实际类型见
> `crates/evo-protocol/src/events/model.rs` 的 `PlanStep` / `PlannedCall`。

### 4.4 副作用（详见 [02](02-effect-gateway.md)）

```ts
// kind: "tool.requested"     // effect 的声明，不是闭包
{ effect_id, turn, tool: ToolId, params_ref: BlobRef, params_digest,
  class: "read"|"write"|"external"|"compute",
  declared_targets: ResourceRef[], declared_egress: EgressRef[],
  reversible: boolean, cites_referenced: string[] }

// kind: "policy.evaluated"
{ effect_id, decision: "allow"|"deny"|"require_approval",
  rules_hit: string[], policy_ver: string, reason_code }

// kind: "impact.estimated"
{ effect_id, targets: Array<{ resource, op: "read"|"create"|"update"|"delete", detail_ref? }>,
  externals: EgressRef[], est_cost_micros?: number, precision: "exact"|"declared_only" }

// kind: "approval.requested" { approval_id, effect_id, risk: 1|2|3, impact_ref: BlobRef, expires_at_ms }
// kind: "approval.granted"   { approval_id, by: ActorRef, via: "ui"|"wecom_link", note_ref? }
// kind: "approval.denied"    { approval_id, by: ActorRef, reason_ref? }
// kind: "approval.expired"   { approval_id }

// kind: "effect.dispatched"  { effect_id, executor_id, lease_id, mode: "live"|"dry_run" }

// kind: "tool.result"
{ effect_id, status: "ok"|"error"|"dry_run"|"denied",
  output_ref?: BlobRef, output_digest?, bytes?, 
  taint: "clean"|"tainted",        // 有内容回流的返回一律 tainted；没有内容
                                   // 回流的（写成功、denied、dry_run）clean
  cites_produced: string[],
  actual_targets?: ResourceRef[],  // 实际触碰的，用于与 declared 比对（供应链行为异常告警）
  actual_egress?: EgressRef[] }
```

`actual_targets` / `actual_egress` 与 `declared_*` 的差异，就是功能清单「供应链管控：声明只读却在写文件即拦截」的数据基础。POC 期只记录不拦截。

### 4.5 记账、产物、检查点

```ts
// kind: "cost.charged"
{ effect_id?, turn?,
  unit: "input_token"|"output_token"|"cache_read"|"cache_write"|"seconds"|"call",
  quantity: number,
  unit_price_micros: number, amount_micros: number, currency: "CNY"|"USD",
  price_table_ver: string,          // 改价不能改历史账
  dimension: { principal, team?, run_id, skill?, tool? } }

// kind: "artifact.emitted"
{ artifact_id, path, mime, size, content_hash,
  cites: string[],                  // 该产物中数字的溯源锚点
  supersedes?: string }

// kind: "budget.amended"      // M2 接通预算闸门时补入，见本节末尾的说明
{ budget: BudgetSpec,        // 整体替换，不是增量
  by: ActorRef,              // 额度是钱，改过必须记名
  reason_ref?: BlobRef }     // 提额理由是自由文本，进 blob

// kind: "checkpoint"
{ checkpoint_id, state_hash: string, snapshot_ref?: string, reason: "periodic"|"pre_write"|"pre_approval" }

// kind: "clarification.requested" { question_ref: BlobRef, options: Array<{id, label, is_default}> }
// kind: "clarification.answered"  { by: ActorRef, option_id?, free_text_ref? }
```

> `checkpoint.snapshot_ref` 类型是 `Option<String>`，**不是** `BlobRef`。快照走的是
> `evo-runlog` 里独立的 `snapshots` 表（SQLite 内联存储，见 `crates/evo-runlog/src/schema.rs`
> 与 `snapshot.rs`），不进 blob store——blob store 是给「原文」用的 content-addressed 文件，
> 快照是「状态」，读写路径与保留策略都不一样。将来若要统一，得先想清楚快照的 GC 策略
> 是不是也要跟着 blob 的 `retain_until` 走；不要顺手把它改成 `BlobRef`。

**`budget.amended` 为什么必须是一条事件：** 原目录里没有它——原设计以为
「超限挂起、人提额续跑」（02 §7）不需要自己的事件。实际上不行：
`RunState::budget` 除了 `run.created` 没有任何写入方，提额只能靠调用方
绕过 Log 直接改内存里的状态字段，而那样的状态**在 Log 上推不出来**，
判据 3（回放结果与原始执行一致）当场不成立。没有它，`run.resumed` 之后
预算判定仍然为真，内核立刻再产出一次挂起，run 永远推不动——「人提额后
续跑」这条能力在代码里根本没有落点。

语义是**整体替换**：payload 里就是这条 run 从此刻起完整的 `BudgetSpec`。
两个理由——一、Log 是唯一权威事实，单独读出一条 `budget.amended` 就该能
回答「现在的额度是多少」，增量写法要求读者先把之前每一条都折叠一遍；
二、「把某个维度从有限改回不设限」（`Some` → `None`）用加法表达不出来。
它**只改上限、不碰已用量**：提额不是销账，`cost.charged` 这本账谁也不许
倒着写。

**`cost.charged` 的四个细节，每一个都是后补要命的：**

1. **金额算在我们这边。** 4.11② 实测确认 codex 的 `TokenUsage` 只有 token 数，金额来自 OpenAI 后端。换任何供应商都拿不到——所以定价表必须是产品自己的一张表，且版本化。
2. **micros 整数，不用浮点。** 财务客户，账要对得上。
3. **四维归因从第一天就带**，POC 只用得上 `principal` 与 `run_id`，另两维留空但字段在。
4. **`currency` 序列化为大写 `"CNY"` / `"USD"`，不是 `"cny"` / `"usd"`。** 这与本文
   其他枚举的 snake_case 风格不一致，是**有意的**——ISO 4217 标准货币代码本就大写，
   契约文档里写的也是大写代码。`Currency` 定义（`crates/evo-protocol/src/events/accounting.rs`）
   刻意不加 `rename_all`；不要为了风格统一给它加 `rename_all = "lowercase"`，那会让
   已经落盘的历史账目解不开。

---

## 五、时钟、随机数与模型响应

判据 3（回放结果与原始执行一致）成立与否全在这一节。

### 唯一机制：`env.sampled`

内核不能读时钟、随机数、env。它需要时，只能从 state 里读**最近一次 `env.sampled` 的值**。runtime 在每个 turn 开始前采样一次并写入 Log。

```
turn N 开始
  → runtime 采样 → 写 env.sampled { wall_clock_ms, rng_seed, env }
  → 内核 reduce，此后内核对时间的认知固定在这个值上
  → ...本 turn 的其余事件...
turn N+1 开始 → 重新采样
```

回放时不重新采样——重放同一批 `env.sampled` 事件，内核走过完全相同的路径。

工具执行期间的时间读取不受此约束：那发生在执行面，是 effect 的一部分，结果进 `tool.result`，内核只看结果。

> **采样粒度（Q-04 已定）：每 turn 一次。** 更细（每 effect 一次）会让 Log 变胖且没有实际收益；更粗（每 run 一次）会让长任务里的「现在几点」严重失真。
>
> 推论：**内核对时间的分辨率就是一个 turn。** 需要更细时间的东西一律走 effect，结果进 `tool.result`——这条要在 code review 时盯，它是判据 3 最常见的破口。

### 模型响应是事件

回放**不重新调模型**，直接读 `model.responded.response_ref`。`request_digest` 用于核对：回放时重建的请求指纹与原始不一致，说明装配器有非确定性，直接报错而不是继续。

### 自校验：`checkpoint.state_hash`

每个 `checkpoint` 事件带当时的 `state_hash`。回放到该 seq 时重算，不一致即 fail。

这条配上 [00 文档](00-index.md) CI 检查第 2 条，构成一个**自动的判据 3 检测器**——技术路线担心的「实现半年后才发现不通过」，在这个机制下变成当天发现。

---

## 六、Log 之上的投影

每一项都是查询，不是新存储。这张表是排期时的重要账：**A 类第 4/6/7/10 项加起来的增量开发量，主要在渲染，不在后端。**

| 投影 | 怎么算 | 对应 POC 项 |
|---|---|---|
| 执行历史列表 | `runs` 表 | A-6 |
| trace 时间线 | `run_events` 按 seq | A-3 / A-6 |
| 回放 | reduce 到任意 seq | A-6 / 演示时刻 4 |
| 成本报表 | `cost.charged` 按 dimension 聚合 | A-7 |
| 出口日志 | `tool.result.actual_egress` + proxy 记录 | A-10 / 演示时刻 1 |
| 影响预估面板 | `impact.estimated` | A-4 / 演示时刻 2 |
| 待审批队列 | `approval.requested` 未匹配 granted/denied | A-5 |
| 溯源面板 | `context.assembled.blocks` + `artifact.emitted.cites` | A-13 / 演示时刻 4 |
| **出内网内容清单** | `context.assembled.blocks` 的 source + token 汇总 | 演示时刻 1（[04 §3](04-context-memory.md)） |
| eval 用例 | 导出一条 run 的全部事件 + blob | 4.7 |
| 审计导出 | 事件表整表 + hash chain | Phase 3 |

---

## 七、待确认

| # | 问题 | 谁定 | 不定的后果 |
|:-:|---|:---:|---|
| ~~Q-01b~~ | ~~POC 现场用哪一家~~ | — | **已定：DeepSeek**。定价表结构见 [09 §3](09-model-plane.md) |
| Q-02 | Log 中留存的模型往来（含财务摘要）保留多久、谁能看、能否导出 | 客户 | 第三节的切分够不够用，取决于这个答案 |
| ~~Q-03~~ | ~~blob store 用文件还是 SQLite BLOB~~ | — | **已定：文件 + content-addressed**，见第三节 |
| ~~Q-04~~ | ~~`env.sampled` 采样粒度~~ | — | **已定：每 turn 一次**，见第五节 |
| Q-05 | 成本对客户呈现的口径：token / 人民币 / 两者；汇率从哪来、多久更新 | 客户 | 只剩呈现口径这一半；存储结构已定（记原币，折算放查询层，见 [09 §3](09-model-plane.md)） |
| ~~Q-06~~ | ~~快照频率、单库多 run 还是每 run 一库~~ | — | **已定：每 50 事件一快照；单库多 run**，见 [03 §5](03-kernel.md) |
| Q-06b | Log **保留期与归档**（Q-06 里未决的那半条） | 客户 | 取决于 Q-02 的答案，不阻塞 M1 |
| ~~Q-07~~ | ~~事件 schema 变更流程~~ | — | **已定**：PR 必须带版本处理、旧版解码测试、历史 Log 回放，见 [00 §3](00-index.md) |
