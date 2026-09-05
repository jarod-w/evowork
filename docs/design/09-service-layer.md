# 09 · 服务层 · 协议适配 · 本机数据模型

> 上游：[总纲 §4.1 / D3 / D5 / D6 / D9](../evowork-on-codex-design.md)· K2 · Q1=A
> 这一层在总纲里只有分层图和几句话。它是前端与内核之间唯一的粘合层，也是 Q1=A 之后所有"本机常驻"职责的宿主。

## 1. 进程模型

Q1=A 下所有东西都在用户机器上。进程边界的划分原则：**崩溃域隔离** —— 内核崩溃不该带走调度器，调度器崩溃不该带走 UI。

```
┌─ evowork-desktop（Electron / Tauri 主进程）────────────────────┐
│  · 窗口与渲染进程（UI，L4）                                     │
│  · 本机服务宿主（L3，同进程内的模块，不再拆进程）                 │
│      scheduler · ingest · artifacts · policy · index           │
│  · 生命周期：随 App 启动/退出；可配置"关闭窗口后保持后台运行"     │
└───────┬────────────────────────────────┬───────────────────────┘
        │ stdio JSON-RPC v2              │ 子进程 / 本机 IPC
┌───────▼──────────────┐   ┌─────────────▼──────────────────────┐
│ codex-app-server     │   │ 解析运行时（Python，按需）            │
│ （内核，L1，常驻 1 个）│   │ 产物渲染（Python，按需）              │
└──────────────────────┘   │ MCP servers（browser 等，按需）      │
                           └────────────────────────────────────┘
```

| 决策                      | 理由                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 本机服务**不单独拆进程**  | 五个服务加起来的状态很小（一个 sqlite + 几个 watcher），拆进程会带来 IPC、崩溃恢复、双向同步三份复杂度，收益为零 |
| app-server **常驻单实例** | 复用同一进程可省启动开销（总纲 D5 原话）；多任务并行靠内核自身的 ThreadManager，不靠多进程                       |
| 后台常驻可关              | 调度需要常驻（D5），但用户必须能选择不常驻。关闭常驻时明确提示"定时任务将不再执行"                               |
| 批处理用 `codex exec`     | 与常驻实例互不干扰（总纲 D5）                                                                                    |

**app-server 崩溃恢复**：监控子进程退出 → 指数退避重启（1s/2s/4s，上限 30s）→ 重启后对所有打开的 thread 做 `thread/resume` + `thread/items/list` 补齐 → UI 顶部显示一次「执行内核已重启，会话已恢复」。**不静默重启**（用户需要知道刚才那个中断的任务发生了什么）。

---

## 2. 边界纪律（K2）

> 前端与服务层只说 app-server JSON-RPC v2；不链接 Rust、不调 SDK 内部、不读内核的 sqlite/rollout 文件。

三条容易被破的地方，明确禁止：

| 诱惑                                    | 为什么会想破                                          | 必须怎么做                                                           |
| --------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| 直接读内核的 thread sqlite 来做状态筛选 | `thread/list` 没有状态过滤（README F8），直接读表最快 | ❌ 禁止。用自己的投影表（§4.1）。内核的表结构不是契约，rebase 就会碎 |
| 直接读 rollout JSONL 做全文搜索         | `thread/searchOccurrences` 是实验方法                 | ❌ 禁止。用实验方法 + 适配层兜底（§3.3）                             |
| 直接读 `CODEX_HOME/memories` 文件       | 记忆界面要展示条目                                    | ❌ 禁止。用 `memories/read`                                          |

唯一允许直接碰的文件系统对象是**工作空间内的文件**（那是用户的文件，不是内核的内部状态）与**EvoWork 自己的目录**。

---

## 3. 协议适配层

### 3.1 职责

前端不直接调 app-server，而是调适配层暴露的语义化 API。四个理由：

1. **收敛实验方法**（D3 的"在服务层做一层适配收敛"）。当前用到的实验方法：`project/*`、`thread/queue/*`、`thread/search`、`thread/searchOccurrences`、`thread/memoryMode/set`、`memory/reset`、`turn/start.collaborationMode`、`turn/start.permissions`、`turn/start.additionalContext`、`thread/list.projectId`、`thread/list.parentThreadId`、`thread/list.ancestorThreadId`、`thread/realtime/*`、`collaborationMode/list`、`thread/timeline/list`。**上游任一变更只改适配层一处。**
2. **展开 EvoWork 概念**：场景/模式 → `collaborationMode` + `permissions` + `model`（03 §2.4）。
3. **合并数据源**：任务列表 = `thread/list` + 本机投影表；产物 = 本机索引。
4. **降级与兜底**：实验方法不可用时（上游移除或未开启）走兜底路径而不是白屏。

### 3.2 初始化序列

```
1  spawn codex-app-server (stdio)
2  → initialize { clientInfo, capabilities: { experimentalApi: true } }     ← K2 必需
3  ← initialize result（记录内核版本）
4  → initialized                   ← **不是** notifications/initialized（F17，2026-09-05 修订）
5  → 能力探测：对无副作用的实验方法各调一次 → 决定 UI 降级（F18，见 §3.3 的修订）
6  → model/list + modelProvider/capabilities/read   · 模型下拉与能力徽标（03 §4.5）
7  → permissionProfile/list        · 权限下拉（含 allowed 标记）
8  → skills/list · plugin/installed · mcpServerStatus/list
9  → threadSection/list · project/list(exp)
10 → thread/list { limit: 30, sortKey: recencyAt }   · 侧边栏首屏
11 本机服务启动：sqlite 打开 → 投影表增量校正 → scheduler misfire 扫描（§6）
```

**第 4 步的方法名（F17，2026-09-05 修订）**：内核的 `ClientNotification` 用
`#[serde(tag = "method", rename_all = "camelCase")]`，变体 `Initialized` 序列化后就是 `"initialized"`
（`app-server-protocol/src/protocol/common.rs:1994`；内核自己的测试客户端也这么发，
`app-server-test-client/src/lib.rs:1773`）。本文原先写的 `notifications/initialized` 是错的。
写错的后果值得单独说：内核**不会报错**，握手看起来完全成功，只是它永远收不到那条通知 ——
这种"静默半成功"比报错难查得多。

**第 5 步的机制（F18，2026-09-05 修订）**：本文原先写「用 `experimentalFeature/list` 的实际返回
决定 UI」，**这条不成立**。实测 `experimentalFeature/list` 返回的是**内核运行时功能开关**
（`shell_tool` / `unified_exec` / `transcript_v2` 这类，共 141 项，`features/src/lib.rs:893`），
与"某个实验协议方法在不在"没有关系。实验方法的真实门禁是两层：

| 层 | 表现 | 我们该怎么反应 |
|---|---|---|
| `initialize` 未声明 `capabilities.experimentalApi` | 调用被拒：**-32600** + `"… requires experimentalApi capability"` | **这是我们自己的 bug**，不是降级 —— 必须响亮地失败。把它当降级会让"实验方法全部不可用"静默变成常态 |
| 上游移除了该方法 | **-32601** method not found | 这才是降级：走 §3.3 的兜底路径并显式告知用户 |

所以判定方式改为**探测 + 失败即定性**：
启动时对**无副作用且不需要 thread/turn 上下文**的实验方法（当前只有 `project/list`）各调一次；
其余方法（queue / memoryMode / realtime / search）停在 `unknown`，首次真实调用失败时再定性 ——
拿假 threadId 去探测它们只会得到"找不到这个 thread"，判断反而更不准。
`experimentalFeature/list` 仍然调用，但用途变成"记录内核开了哪些功能"（诊断信息），不参与降级判定。

**Thread 的创建时机**：首页发送第一条消息时才 `thread/start`（03 §1），所以第 10 步的列表里不会有空任务。

### 3.3 实验方法的降级表

| 实验方法                              | 缺失时的降级                                                                             | 用户可见影响                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `project/*`                           | 用本机 `project_local` 表自己管工作空间（只记路径与名称，不做 thread 归属）              | 「项目」入口仍可用；任务按 cwd 分组而非 projectId                            |
| `thread/queue/*`                      | 前端本地队列：执行中的输入先存本机，`turn/completed` 后自动发送                          | 队列不可跨客户端可见（单客户端场景无影响）                                   |
| `thread/search` / `searchOccurrences` | 只做标题搜索（`thread/list?searchTerm`）+ 本机投影表缓存的消息摘要                       | 对话内搜索能力下降，需明确提示「内容搜索暂不可用」                           |
| `turn/start.collaborationMode`        | 退回 `turn/start.model` + `effort`，developer instructions 通过 `additionalContext` 注入 | Ask 模式的指令强度下降 → 此时**必须**依赖 `ToolContributor` 过滤写工具（D8） |
| `turn/start.permissions`              | 退回 `sandboxPolicy`（两者互斥，F5）                                                     | 企业自定义 profile 不可用，只能用三个内置档                                  |
| `thread/memoryMode/set`               | 全局记忆开关代替任务级开关                                                               | 精度下降，需在设置里说明                                                     |
| `thread/realtime/*`                   | 隐藏麦克风按钮                                                                           | 语音不可用（03 §4.7）                                                        |
| `collaborationMode/list`              | **不调用**（F3：只返回两个内置项，对 UI 无用）                                           | 无                                                                           |

降级一律**显式**：UI 上说"这个能力当前不可用"，不假装正常（与 D2 的"降级必须显式"同一原则）。

**三条实现约束（2026-09-05 落地 M2a 时补）**：

1. **降级表与实验方法清单是配对的**：新增一个实验方法就必须给它一条兜底，否则"上游哪天删了它
   → UI 白屏且没人知道为什么"。这条约束已做成代码里的断言（`assertDegradationCoverage()`，
   适配层启动时执行、测试里也钉着），不靠人记。
2. **`turn/start.collaborationMode` 的降级必须连带做另一件事**：退回 `model + effort` 后
   Ask 模式的指令强度下降，此时**必须**依赖 `ToolContributor` 过滤写工具（D8）。
   降级表里这一条带 `mustAlsoDo` 字段，不是提醒而是硬要求 —— 只靠沙箱的 Ask 模式会让模型
   反复尝试写再失败，那正是 D8 要避免的体验。
3. **探测失败 ≠ 不可用**：若探测时内核刚起来还没就绪（不是 -32601），能力保持 `unknown`
   而不是判成 `unavailable`。误判会**永久关掉一个其实可用的能力**，且用户没有恢复入口。

### 3.4 事件流 → UI 状态

app-server 的通知（`common.rs:1853-1920`）分发到三个消费者，**顺序固定**：先落库、再更新 UI、最后触发副作用。

| 通知                                    | 投影表                            | UI                     | 副作用                                   |
| --------------------------------------- | --------------------------------- | ---------------------- | ---------------------------------------- |
| `thread/started`                        | 建行                              | 侧边栏插入             | —                                        |
| `thread/status/changed`                 | 更新 status                       | 状态点、Badge          | 待处理时发通知                           |
| `thread/name/updated`                   | 更新 title                        | 侧边栏、标题栏         | 全文索引更新                             |
| `turn/started`                          | 记 turn 开始                      | 进行中                 | 并发计数 +1                              |
| `turn/completed`                        | **记 `last_turn_status`**         | 状态、耗时             | 通知；并发计数 −1；automation_run 落库   |
| `turn/plan/updated`                     | 存 plan 快照                      | Plan 卡（04 §5.2 #4）  | 派生"规划中"                             |
| `turn/diff/updated`                     | —                                 | 变更视图               | —                                        |
| `item/started` / `item/completed`       | 存 item 摘要（用于首屏快显）      | 消息流                 | `FileChange` → 产物识别（08 §2.2 信号②） |
| `item/agentMessage/delta` 等增量        | 不落库                            | 流式追加（节流 60fps） | —                                        |
| `item/*/requestApproval`（**request**） | 记待审批                          | 审批卡 + 吸顶条        | 系统通知                                 |
| `thread/queue/changed`                  | —                                 | 队列区                 | —                                        |
| `thread/tokenUsage/updated`             | 累加用量                          | 用量条                 | 预算闸门检查（10 §5）                    |
| `skills/changed`                        | —                                 | 技能目录               | —                                        |
| `mcpServer/startupStatus/updated`       | —                                 | 连接器状态             | 失败时通知                               |
| `project/changed`                       | —                                 | 工作空间下拉           | —                                        |
| `account/rateLimits/updated`            | —                                 | 用量视图               | 接近上限时提示                           |
| 未识别通知                              | 记原始 JSON 到 `unknown_event` 表 | 无                     | 每日聚合一条日志（R2 的上游变更雷达）    |

**落库优先**是刻意的：UI 崩溃/刷新后能从投影表恢复，反之不行。

---

## 4. 本机数据模型

单个 sqlite：`~/.evowork/evowork.db`（与 `CODEX_HOME` 同级，D6）。WAL 模式，单写者（服务层），UI 只读走服务层 API。

### 4.1 `thread_projection` —— 任务状态投影

存在理由见 04 §2：内核不提供状态过滤、日期过滤，也没有客户端元数据槽（README F7/F8/F9）。

```sql
CREATE TABLE thread_projection (
  thread_id        TEXT PRIMARY KEY,
  title            TEXT,
  cwd              TEXT,
  project_id       TEXT,
  section_id       TEXT,
  -- 内核给不了的部分：
  derived_status   TEXT NOT NULL,   -- running|pending|planning|completed|failed|interrupted|archived
  last_turn_status TEXT,            -- completed|interrupted|failed|in_progress
  last_turn_id     TEXT,
  scenario_id      TEXT,            -- 03 §2
  mode_id          TEXT,            -- craft|plan|ask
  permission_id    TEXT,
  model            TEXT,
  plan_confirmed   INTEGER DEFAULT 0,  -- 派生"规划中"用
  automation_id    TEXT,            -- 来自定时任务
  artifact_count   INTEGER DEFAULT 0,
  token_input      INTEGER DEFAULT 0,
  token_output     INTEGER DEFAULT 0,
  cost_estimate    REAL DEFAULT 0,
  budget_limit     INTEGER,
  share_id         TEXT,
  first_message    TEXT,            -- 首屏快显
  created_at       INTEGER, updated_at INTEGER, recency_at INTEGER,
  archived         INTEGER DEFAULT 0
);
CREATE INDEX ix_tp_status  ON thread_projection(derived_status, recency_at DESC);
CREATE INDEX ix_tp_updated ON thread_projection(updated_at DESC);
CREATE INDEX ix_tp_cwd     ON thread_projection(cwd, recency_at DESC);
CREATE INDEX ix_tp_auto    ON thread_projection(automation_id, created_at DESC);
```

**`derived_status` 的取值（2026-09-05 补第八个）**：
`running | pending | planning | completed | failed | interrupted | archived` 之外，
实现补了一个 **`idle`** —— thread 已创建但还没有任何回合。首页只在首次发送时才 `thread/start`
（03 §1），所以它很短暂，但 `thread/fork` / `thread/resume` 之后都会出现。
不给它名字的话，它只能被塞进 `running` 或 `completed`，**两种都是谎话**；
UI 上它对应 04 §8 的"任务无消息（刚创建）"空态。

**权威性规则**：`title` / `cwd` / `archived` 的真源是内核，投影表只是缓存 —— 筛选时先用投影表选出 id 集合，再拉权威字段渲染（04 §3.4，注意那里对"怎么拉"有一处修订）。`derived_status` 及其后的字段真源是投影表。

**一致性校正**：启动时与每 10 分钟做一次 `thread/list`（`useStateDbOnly: true`，避免全量扫 rollout）对账 —— 补齐新 thread、清理已删除的、修正 title。

### 4.2 `item_digest` —— 首屏快显缓存

```sql
CREATE TABLE item_digest (
  thread_id TEXT, seq INTEGER, item_id TEXT, item_type TEXT,
  summary   TEXT,          -- 一行摘要，不存完整内容
  created_at INTEGER,
  PRIMARY KEY (thread_id, seq)
);
```

只存最近 50 条的摘要，用于 04 §9 的"< 300ms 出内容"。**不是权威副本** —— 打开任务后立刻用 `thread/items/list` 校正。

### 4.3 `artifact` —— 产物索引

见 08 §2.4。

### 4.4 `automation` / `automation_run` —— 调度

按总纲 §6.9 的模型，加上 07 §8 的两个增量字段：

```sql
-- automation: 同总纲 §6.9（含 device_id / misfire_policy / catchup_window / wake_system）
-- automation_run 增补：
--   trigger            TEXT  -- SCHEDULED|MANUAL|MANUAL_TEST|CATCHUP
--   original_fire_time  INTEGER  -- CATCHUP 时指向原定时刻（07 §5.3）
--   failure_class      TEXT  -- MODEL|SCRIPT|APPROVAL_TIMEOUT|ENVIRONMENT|QUOTA
CREATE UNIQUE INDEX ix_run_idem ON automation_run(automation_id, fire_time);  -- 幂等键，D5
```

`failure_class` 决定是否计入 `consecutive_failures`（07 §7 最后一条：`ENVIRONMENT` 不计入）。

### 4.5 其余五张表

| 表              | 用途                                        | 文档    |
| --------------- | ------------------------------------------- | ------- |
| `library_node`  | 「我的资料」与团队空间缓存节点树            | 06 §6   |
| `library_index` | FTS5 全文索引（资料 + 产物 + 上传解析产出） | 06 §3.4 |
| `access_log`    | 最近访问                                    | 06 §3.3 |
| `share`         | 分享记录（链接、有效期、访问计数、撤销）    | 08 §7   |
| `subscription`  | 私有源订阅（源、版本、签名指纹）            | 05/06   |
| `notification`  | 通知中心                                    | 02 §5.1 |
| `audit_log`     | 本机审计留痕（Q12）                         | 10 §6   |
| `unknown_event` | 未识别的上游通知（R2 雷达）                 | §3.4    |

### 4.6 迁移与备份

- schema 版本号存 `meta` 表；迁移脚本单向、幂等、启动时自动执行。
- **投影类表（`thread_projection` / `item_digest` / `library_index`）可以被删除重建** —— 它们的真源在别处（内核 / 文件系统）。迁移失败时的兜底就是丢弃重建，不阻塞启动。
- **权威类表（`automation` / `share` / `audit_log` / `subscription` / `artifact`）不可丢** —— 迁移前自动备份到 `evowork.db.bak.<version>`，迁移失败则回滚并报错，**宁可启动失败也不丢定时任务定义**。

  **两道防线的分工（2026-09-05 修订，被测试逼出来的）**：本文原先只说"备份 + 回滚"，
  而"把备份文件拷回主库"这个动作**在进程内是无效的** —— 连接还开着，SQLite 有自己的页缓存与
  WAL，进程退出时会把内存里的状态 checkpoint 到刚被覆盖的文件上，那次破坏性改动于是又回来了。
  正确的分工是：

  | 防线 | 管什么 | 不管什么 |
  |---|---|---|
  | **事务回滚**（主） | 迁移代码抛错、DDL 失败、约束冲突 —— SQLite 的 DDL 是事务性的，建表与数据搬迁能一起回滚 | 进程被杀 |
  | **文件备份**（副） | 进程在迁移中途被杀（断电 / OOM / 强退）后，下次启动有个东西可回滚 | 进程内的错误 |

  因此迁移失败时**不自动拷回备份**，只回滚事务 + 抛错 + 在错误信息里指明备份位置。
  "看起来做了恢复其实没做"比"明确告诉你备份在哪"危险得多。
- **`artifact` 归权威类**需要说明：产物**本体**的真源是文件系统（D6），但索引里的 `title`
  （可重命名而不改文件名）、`version` 链、`share_id`、`source_signal` 在磁盘上没有对应物，
  丢了就再也推不出来。所以它是"指向文件的权威元数据"。
- 这条区分要在代码里显式表达（两个迁移器），否则"重建索引"的逻辑总有一天会把 automation 表也清了。

---

## 5. 断连与重连

| 场景                        | 处理                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| app-server 崩溃             | §1 的退避重启 + 会话恢复 + 显式提示                                                                                        |
| stdio 管道阻塞              | 心跳（30s 一次轻量请求）超时 3 次判定失联 → 走崩溃路径                                                                     |
| 事件丢失（重启期间的 item） | 重连后对每个打开的 thread 做 `thread/items/list` 拉全量，按 item_id 去重合并                                               |
| 网关不可达                  | 内核会返回错误；UI 顶部 `--danger` 条 + 「检查模型接入」；**不自动切换模型**（03 §8）                                      |
| 云端控制面不可达            | 不影响执行（一切本地）；只影响：私有源刷新、automation 定义同步、配额上报、策略更新。UI 分别提示，不做一个笼统的"离线"横幅 |
| 云端策略包过期              | 按 R11：超期自动降级为只读模式，并明确告知原因与恢复方式                                                                   |

---

## 6. Scheduler 的实现要点

总纲 D5/§6.9 已定语义，此处只补三处实现细节：

### 6.1 启动时的 misfire 扫描

```
区间 = [max(last_fire_time, now - catchup_window), now]
对每个 ACTIVE 且 device_id = 本机 的 automation：
  枚举区间内应触发的时间点（按存储 timezone 解析 cron）
  对每个未落库的时间点：
    · 先写一条 MISSED / MACHINE_OFFLINE            ← 07 §5.3 要求"漏了要留痕"
    · 再按 misfire_policy 决定是否追加 CATCHUP 执行
```

**先写 MISSED 再补跑**的顺序是文案一致性的前提（07 §5.3）：用户必须同时看到"漏了"和"补了"。

### 6.2 幂等

唯一索引 `(automation_id, fire_time)`（§4.4）。单机单进程，不需要分布式锁（D5 原话）。补跑记录的 `fire_time` 用**原定时刻**、`trigger = CATCHUP`、`original_fire_time` 指向自身 —— 这样同一时刻不会被补两次。

### 6.3 时钟

- cron 解析用**存储的 `timezone`**，不用系统时区（07 §3.2）。
- 用单调时钟计算 sleep 间隔，用墙上时钟判定触发时刻；两者不一致时（用户改系统时间、休眠唤醒）以墙上时钟为准并立即做一次 misfire 扫描。
- 睡眠唤醒事件（macOS `NSWorkspaceDidWakeNotification` / Windows `WM_POWERBROADCAST` / Linux systemd sleep hook）直接触发扫描，不等下一个 tick。

---

## 7. 配置

```
~/.evowork/
  config.toml            ← 内核配置（model_providers / permissions / mcp_servers / hooks）
  requirements.toml      ← 企业强制层（allow_managed_hooks_only 等，R11）
  evowork.db             ← §4
  scenarios/             ← 场景包（03 §2.2）
  modes/                 ← craft.md / plan.md / ask.md（README §4.1，取代 P3 补丁）
  slots.toml             ← 运营位开关（03 §6）
  library/               ← 我的资料
  library-cache/         ← 团队空间缓存
  assistant/             ← 助理会话的 cwd（02 §4.2）
  scratch/               ← 临时工作空间
  logs/
```

`CODEX_HOME` **保持内部路径名不动**（K5：只改对外可见字符串），通过环境变量指向 `~/.evowork/kernel/`。

配置写入规则：内核相关的键通过 `skills/config/write` 等协议方法或直接写 `config.toml` 后 `config/mcpServer/reload`；**EvoWork 自己的配置不混进 `config.toml`**，避免 rebase 时与上游的配置 schema 冲突。

---

## 8. 可观测（对齐总纲 §6.12 与 Q14）

| 通道             | 内容                                       | 约束                                                                                |
| ---------------- | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| 本机日志 `logs/` | 结构化日志，含请求 id、耗时、错误码        | **不含 prompt 与响应正文**（与 Q14 对网关的要求同口径，本机也这么做，便于用户自查） |
| `otel` 导出      | 默认**关闭**；企业可配置指向自有 APM       | span attribute 禁带 input/output（Q14）                                             |
| `rollout-trace`  | 完整执行轨迹，留本机                       | 用于回放与事故复盘（Q12 审计留痕）                                                  |
| 崩溃上报         | 默认关闭；开启需显式同意                   | 堆栈不得携带请求体（Q14）                                                           |
| 云端上报         | 只有 token 计数 / 时延 / 错误码 / 用量摘要 | D9："只有身份与计量，无内容"                                                        |

**可审计手段**（总纲 §10.2 第 2 条要在 M0 拿结论的那项，本机侧的落法）：把"不记正文"做成**代码层面的不可能**而不是约定 —— 日志接口只接受结构化字段，`prompt` / `content` / `body` 这类键在序列化层被白名单过滤；配套一个 CI 测试：跑一次真实任务，断言日志与 trace 里不出现输入文本的任何 8 字以上片段。
