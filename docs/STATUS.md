# 项目状态

> 截至 2026-08-30。`main` = `0d4c982`，114 次提交，254 个测试通过，`./scripts/ci.sh` 全段绿。
>
> 这份文档记录**当前真实状态**与**未做事项**。它的编写前提是：
> 「结构写好了」不等于「接通了」，「测试绿了」不等于「检查有效」。
> 下面每一条未做项都标注了**它今天会怎么坏**，而不只是「还没做」。

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

设计文档 00 §4 列了 10 条，已实现 7 条。

| # | 检查 | 状态 |
|---|---|---|
| 1 | 内核依赖隔离 | ✅ |
| 2 | 回放自校验 | ✅ |
| 3 | 治理旁路 | ✅ |
| 4 | 客户名词隔离 | ✅ |
| 5 | 协议同步（ts-rs ↔ `packages/protocol`） | ❌ `packages/` 尚不存在，随协议层一起做 |
| 6 | vendor 未被修改 | ❌ `crates/evo-exec-local/vendor/` 目前只有 README，无内容可校 |
| 7 | 上游依赖闭包 | ⚠️ **`scripts/codex-closure.py` 已写好，但没有任何脚本调用它，也没有基线文件** |
| 8 | 快照可丢弃 | ✅ |
| 9 | 外壳不渗进业务代码 | ✅ |
| 10 | 构建产物/依赖目录未被跟踪 | ✅ |

另有非编号段：`fmt`、`fmt (src-tauri)`、前端构建与类型检查、产物纯净性、`clippy`、`test`。

---

## 二、未做事项（按优先级）

优先级判据：**能不能在演示现场变成事故** > **防线是否靠纪律而非机制** > **检查能不能发现问题** > **文档是否与代码一致** > **尚未开始的功能**。

---

### P0 — 会在演示现场变成事故

#### 1. 澄清答案从未进入模型请求

`crates/evo-daemon/src/runtime.rs:787` 构造的 `ModelRequest` 里 `content` 是**空字符串**。整条链路（答案 → blob → 装配 → `context.assembled` 事件）都是通的，模型收到的始终是空。

**今天为什么不暴露**：fixture 模型不看输入。相关测试断的是事件里的 blocks 内容（中间字段），所以必绿。

**换成真实 adapter 那一刻**：人回答「否，再等等」与回答「是，立即发起」对模型输入毫无区别——A-12 澄清追问整条能力是空的。而那时演示已经在跑。

#### 2. Effect 完全不出账

`pricing.toml` 只给模型定价，`CostCharged` 全仓只有 `call_model` 一个产生点，`EffectOutcome` 没有任何成本字段。

**后果**：一次 `shell.exec` 调外部收费 API 烧的钱，金额维度一分不涨。**预算闸门刚刚接通，但它看不见工具那一侧的账**——「别静默烧钱」这条能力只覆盖了模型侧。A-7 成本归因同理。

#### 3. 沙箱无超时、stdout 无上限

- `crates/evo-exec-local/src/sandbox.rs:137` 的 `cmd.output().await` 无界。`Lease.expires_at_ms` 有人写、**零读者**。一条 `sh -c 'sleep infinity'` 就是 daemon 永久挂死。
- stdout 无上限，且随后 `executor.rs:131-135` 做 `from_utf8_lossy` + `json!` + `to_vec`，同一份数据在内存里三份，最后整个进 blob store。实测捕获过 100MB。一条命令就能撑爆 daemon 和 Run Log。

#### 4. 审批永不过期

`ApprovalRequested.expires_at_ms` 被写入（`runtime.rs:1020`），**全仓无人读取**。`approval.expired` 零产生者，`reduce` 里对应的处理分支是死代码。

**后果**：一条 L3 审批 30 天后被人点开链接批准，`decide_approval` 照收，`resume` 照派发——一条早该过期的对外发送被执行。

---

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

#### 12. eval 用例里一个治理事件都没有

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
| `02-effect-gateway.md:124` + `impact.rs:33` | 审批卡文案「将在沙箱工作区内执行，出口受白名单约束」 | 两半都不成立。UI 还没做，做的时候不能照抄 |

---

### P4 — 写了没接线的字段与死代码

这些今天都不产生错误结果，但都属于「看起来对、从没被执行过」。**新增任何一条前，先确认它有读者。**

| 位置 | 情况 |
|---|---|
| `EgressPolicy::permits()` + `DaemonConfig.egress_allow` | 唯一调用者是它自己的单元测试。没有 proxy 进程，`proxy_addr: None` |
| `ExecutorCapabilities` | 零消费者。一个 class=External 的 effect 会被派到自称做不了 External 的 executor 上 |
| `PolicyContext.taint` / `.targets` | 老实填了，但 `Rule` 只有 class/tool/reversible 三个条件字段，`matches` 完全不看这两个。今天写不出「对某目录的写要审批」这类规则 |
| `Lease.expires_at_ms` | 零读者（见 P0-3） |
| `BudgetSpec.max_concurrency` / `max_recursion_depth` | 零读取方 |
| `Command::AskClarification { question }` | 恒发空串，唯一消费方直接丢弃。两条内核测试还在断这个空占位——断言的是「占位符仍然是空的」 |
| `reduce` 忽略 `ContextCompacted` / `ArtifactEmitted` | 今天二者无产生方，尚不构成投影缺口；等哪个切片开始写 `artifact.emitted`，它会静默不进状态 |
| `AwaitReason::Human`、`SuspendReason::Paused`、`CompletionStatus::Partial`、`Checkpoint.snapshot_ref`、`RunState::children`、`RunFailed.at_seq` | 死变体/死字段，均有注释 |
| `reduce.rs:91-93` | 空的 `if e.status == ToolResultStatus::Error {}`，只有注释没有语句 |

---

### P5 — 已知缺陷，暂缓

| 位置 | 内容 |
|---|---|
| `replay.rs` | **解不开**的快照仍报错而非降级。按「快照可丢弃」的同一逻辑它也该降级——现在损坏一个 blob 会让整条 run 无法恢复。修 BL-2 时只堵了信任漏洞 |
| `runtime.rs` | `resume()` 仍能恢复**终态** run。被拒的 run 被 resume 会一路跑到 `run.completed`（effect 保持 denied 不会执行，红线守住了），但「Failed 的 run 能被复活」本身可疑 |
| `runtime.rs:405-435` | `answer_clarification` 不校验 `option_id` 属于本题选项。传了过期/拼错的 id，事件照写、run 照跑，而摘要里没有「选择：…」一行——人以为自己回答了，系统当作没选 |
| `runtime.rs` | 被人驳回 / 尚在等审批的 run 一个 checkpoint 都没有，`verify` 报 VACUOUS 并让 CLI 非 0 退出。网关自动 Deny 那条路径专门补了检查点，人工驳回这条没有——**审计价值最高的那类 run 恰恰是唯一验不了的** |
| `reduce.rs:125-134` | `RunSuspended{AwaitingApproval}` 取 `pending_approvals` 的 `.next_back()`（字典序最大），注释却说「取出当前唯一一条」。今天恰好只有一条；一旦支持并发 effect 就会指错。同处用 `.expect()`，顺序异常的 Log 会让**回放 panic** 而不是报错 |
| `pipeline.rs` | dry-run 的 `mode` 没有持久化，审批往返后必然降级成 Live。今天不爆是因为 `ExecutionMode::DryRun` 在生产代码里零构造点 |
| `impact.rs` | 「估不出影响面」与「没有影响面」在 Log 里不可区分（`ImpactPrecision` 缺 `Unknown` 一档）。审批人看到 `targets: []` 时没有任何信号能区分「不知道」和「没有」——把未知当安全 |
| `decide.rs` | 模型侧无预扣：token 数要等响应才知道，真预扣需要「预留→结算/释放」事件加失败对账加回放语义 |
| 沙箱 | `spec.env` 只有 PATH 一个键受保护（`LD_PRELOAD`/`BASH_ENV` 原样透传）；`program_allowed` 放行任意路径下的同名程序；resolve 与 write 之间的并发 TOCTOU；工作区内的 bind mount |
| 预算 | 提额没有任何界面；子 run 预算未实现；⑤的预扣半边在 daemon 里今天走不到（没有工具声明 `preview`） |
| 污点 | 一级 dry-run 的 preview 输出没有污点判定；模型输出本身不是污点源；`start()` 收裸 `&str`，无法把 intent 声明为不可信——而粘贴进来的外部文本正是首要注入向量；`cites_produced` 恒空 |
| daemon | 崩溃残留的 `Dispatched` effect 只能让 run 失败，无法与执行器实际做了什么对账 |

---

### P6 — 尚未开始的功能

按计划顺序。前三项是 M2 剩余范围，其余按依赖排。

| 项 | 状态 | 阻塞 |
|---|---|---|
| **协议层**：HTTP `/v1/rpc` + WS `/v1/events` + `ts-rs` 生成 `packages/protocol` + CI-5 | 未开始 | 无。**事件集已随 M2 稳定，这是当初把它排在治理面之后的原因**——协议只生成一次 |
| **真 DeepSeek adapter** | 未开始 | key 已到位，排在协议层之后 |
| **用友 MCP Server（A-9）** | 未开始 | 账号已到位，排在协议层之后 |
| **UI 本体** | 未开始 | 桌面外壳只交付了 platform 层与 `daemonClient`，没有应用界面 |
| A-13 溯源引用 | 未开始 | 等用友 MCP 接上（`cite` 锚点已在事件里，但没有真实单据可引） |
| A-11 口径库 | 未开始 | 财务的历史成品表未到位。机制与内容一起做，避免机制与真实条目形状对不上 |
| A-10 出口代理子进程 | 未开始 | 属 M3。注意 P4 里的出口 allowlist 死代码在等它 |
| CI-6 vendor 检查 | 未开始 | `vendor/` 目前为空——开发机是 Linux，macOS seatbelt 子集尚未 vendor |
| 真机跑通 | 未开始 | 装机三前提（Q-31）未确认 |

---

## 三、贯穿性经验

这三条是本项目反复付出代价换来的，写在这里是因为**它们决定了上面每一条该怎么修**。

**其一，检查必须被证明能失败。** 本项目已抓到**七处**「永远不会失败的检查」：grep 语法只覆盖点分写法漏掉混合写法；`verify()` 在无 checkpoint 时空过；`eval/run.sh` 从不读快照且哈希只打印不比较；CI-9 只匹配 `@tauri-apps/api`；`grep -c "tauri-apps" dist/`（压缩产物已去掉 npm scope）；`tsc --noEmit` 缺 `-p`/`-b` 实际编译 0 个文件；CI-3 无条件豁免 `evo-exec-local`。**新增任何检查，必须构造反例实测它会红。**

**其二，测试要断行为，不断中间字段。** 澄清死循环之所以漏掉，是因为测试断了「`pending_question` 被清空」而没断「清空之后 `decide` 真的往前走」。同一个坑还有两个变体：**测试把 bug 当成期望行为编码进去**（daemon 里真的有一条）；**测试切在缺陷的上游**——接通污点闸门时没有任何现有测试变红，因为仅有的三条污点断言都是把 `Tainted` 直接注入 `AdmitRequest`，测的是 bug 上面那一层，永远红不了。

**其三，注释不要宣称代码做不到的事。** M2 终审在一条分支上数出十处。它们的共同形状是：结构先写对、注释先写足、测试断中间字段——三样互相印证，唯独没有一样碰到真实输入边界。
