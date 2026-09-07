# 「项目」功能设计（列表页 + 详情页 + 后端）

> 2026-09-07。上游：[02 §4.3](../../design/02-information-architecture.md) · [09 §3.3](../../design/09-service-layer.md) ·
> [01 §5](../../design/01-ui-design-system.md) · 清单 §4.5 / §6。
> 本文是实现前的验收基线；与 `docs/design/` 冲突时，以本文为准并**同步改掉那边**（CLAUDE.md §9）。

## 0. 为什么现在做

`/projects` 现在是一个「如实说明的空页」（`apps/desktop/src/renderer/app.tsx:816`）。
更要紧的是**工作空间这个概念现在有三处真源**：

1. 内核 `project/list`（只读，且干净机器上恒为空）
2. `meta` 表里的 `evowork.workspaces` JSON 数组（首运行第②步选的目录）
3. `thread_projection.cwd`（任务实际跑在哪）

首页下拉把前两处拼起来显示（`renderer-bridge.ts:628` 的 `getStartup`），
第三处谁都没用。做「项目」页的一半工作量其实是**把它们收敛成一处**。

## 1. 已定的决策

| # | 决策 | 理由 |
|---|---|---|
| D-P1 | **本机 `project_local` 表为权威**，内核 `project/*` 尽力镜像 | Q1=A 是纯本地应用；`project/*` 是实验方法（上游可能删）；EvoWork 要存的字段（多根、失效标记、任务数口径）本来就超出内核 `Project` 的形状 |
| D-P2 | **单根，但表结构留多根** | 内核 `turn/start` 只收一个 cwd（适配层 `toWorkspace` 已经是"只取第一个 root"）。放开多根时不用迁移 |
| D-P3 | **任务归属按 cwd 落在 root 下**判定 | 与 09 §3.3 降级表的「任务按 cwd 分组而非 projectId」一致；`ix_tp_cwd` 索引已在；`thread_projection.project_id` 当前实际为空，只按它做出来每个空间都是 0 个任务 |
| D-P4 | AGENTS.md **在 App 内可编辑** | 它是用户给 agent 的长期指令，改它是高频动作 |
| D-P5 | 文件树**懒加载、不接 `fs/watch`** | 大仓库不能递归扫全盘；实时性不值一块防抖与句柄回收的活，但**界面不假装是实时的** |
| D-P6 | 「最近产物」与「最近变更」**合并为一块** | 两者在数据上是 `artifact` 表的同一批行；分两块会让同一个文件在上下各出现一次。**这条改了 02 §4.3** |
| D-P7 | 新登记 **5.34 Dialog**，并把 `library.tsx` 的私有确认框换上去 | 不换的话仓库里有两个各写一遍的确认框，而它们对"删文件还是删索引"的措辞纪律是同一条。**这条改了 01 §5** |

## 2. 后端

### 2.1 新包 `services/projects`（纯逻辑，不做 I/O）

照 `services/artifacts` 的形状：判定与视图组装在包里、可单测；sqlite 与 fs 的实际读写在主进程。

| 文件 | 职责 |
|---|---|
| `types.ts` | `ProjectRecord`（id · name · roots · kernelId · 时间戳）· `ProjectCardView` · `RootState` |
| `membership.ts` | `isUnderRoot(root, cwd)`：两侧先过 `@evowork/policy` 的 `normalizePath`，再**只在路径分隔符边界**上比前缀 |
| `cards.ts` | 由 project 行 + thread 行 + artifact 行组装卡片（口径见下） |
| `tree.ts` | 文件树纯逻辑：排序（目录在前、按名）· 噪声目录默认折叠 · **越界判定**（展开路径归一化后必须仍在 root 内） |

卡片三个数字的口径**写死在这里**，因为"差不多"的计数会让用户不信任整页：

- **任务数** = `cwd` 落在 root 下且 `archived = 0` 的 `thread_projection` 行数。`cwd` 为 null 的任务不属于任何空间
- **产物数** = `path` 落在 root 下的 `artifact` 行，**先按 `path` 折成"最高 `version` 那一行"，再看那一行是不是 `PRESENT`**，最后计数。
  顺序不能反：先滤 `PRESENT` 再去重的话，一个「建了又删」的文件（v1 `PRESENT`、v2 `MISSING`）
  会因为 v1 还在表里而被算成 1 个产物 —— 用户点开是空的，而这正是这条规则本来要防的事
- **最近活动** = 该空间任务里最大的 `recency_at`；一个任务都没有时不显示这一段，而不是显示"从未"

`membership.ts` 与 `tree.ts` 的越界判定共用 `@evowork/policy` 的归一化 ——
不自己写一个 `path.resolve` 版本，否则两处对 `..` 的处理迟早分叉。

**这两个判定只是安全边界的一半**（2026-09-07 Task 2 review 实测得出）：它们是纯字符串函数，
看不见 `<root>/link` 其实指向 `/etc`。所以每个真的要碰盘的地方（§2.6 的 `listDir` 与
`readAgentsMd` / `writeAgentsMd`）都必须**先 realpath、再用同一个判定复查**，
且 realpath 失败一律拒绝而不是放行。纯逻辑包不做这件事是对的（它不做 I/O），
但"字符串过了就等于安全"这个推论是错的。

### 2.2 store：两张权威表 + 一次数据迁移

```sql
CREATE TABLE project_local (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kernel_id  TEXT,                    -- 镜像成功才有；为 NULL 不影响任何功能
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE project_root (
  project_id TEXT NOT NULL,
  path       TEXT NOT NULL,           -- 归一化后的绝对路径
  position   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, path)
);
CREATE INDEX ix_prt_path ON project_root(path);
```

- **权威类**（`AUTHORITATIVE_TABLES`），不是投影类：用户建的空间丢了就是丢了，不能"丢弃重建"。
- `AUTHORITATIVE_MIGRATIONS` 追加**第 2 版**：把 `meta` 里 `evowork.workspaces` 的路径搬进新表
  （name = basename），搬完**删掉那个键**。迁移之后 `readLocalWorkspaces` 与
  `LOCAL_WORKSPACES_KEY` 一并删除，首页下拉改从 `project_local` 读 —— 三处真源在这里收敛成一处。

### 2.3 内核镜像：尽力而为，失败不降级

| 动作 | 本机（权威） | 内核（尽力） |
|---|---|---|
| 新建 / 导入 | 写两张表 | `project/create`，**必带 `idempotencyKey`**（`../codex/codex-rs/app-server-protocol/src/protocol/v2/project.rs:92` 的必填字段；我们的协议子集现在没声明它，要补） |
| 改名 | 更新本机 | `project/update`（`EXPERIMENTAL_METHOD` 现在没有它，补方法**必须同时补降级表条目**，否则 `assertDegradationCoverage()` 启动时就会拦下） |
| 移除 | 删两张表的行，**不碰磁盘文件** | 有 `kernel_id` 才调 `project/delete` |
| 列表 | 从本机读 | 不再依赖 `project/list` 取数；它保留为 `PROBE_ON_STARTUP` 的唯一探针（动了会破坏降级判定） |

镜像失败**不给用户看错误**（本机是权威，空间照常可用），只进结构化日志：方法名 + 错误码，
无路径正文（Q14）。

### 2.4 路径失效

列表时对每个 root 做一次 `existsSync`。失效则该卡整卡 `--warning` + 「路径已失效，重新指定」。
**不静默改路径、不自动移除**（与总纲 §6.9 设备迁移同一条原则）。失效空间仍可打开详情
（看历史任务与产物索引），但「在此空间新建任务」禁用**并给原因**。

### 2.5 新建时的路径闸门

新建 / 导入选中的目录先过 `@evowork/policy` 的 `classifyPath`：命中硬拦截清单
（`~/.ssh`、密钥目录等）**直接拒绝并说明原因**。10 §5 那条"把工作空间设在 `~/.ssh` 就能绕过"
正是这个入口 —— 不在这里拦，后面所有路径策略都白做。

### 2.6 IPC 动作（`apps/desktop/src/shared/ipc.ts` + `renderer-bridge.ts`）

`listProjects` · `createProject` · `importProject` · `renameProject` · `removeProject` ·
`openProjectFolder`（`shell.openPath`）· `readProjectDetail` · `listDir`（文件树懒加载）·
`readAgentsMd` / `writeAgentsMd`。

`writeAgentsMd` 由主进程直接写盘（不经内核）；写前同样过 `classifyPath`，
且路径**固定拼成 `<root>/AGENTS.md`**，不接受渲染层传任意路径。

## 3. 前端

### 3.1 组件清单先补（Q24：清单外组件先登记后实现）

| 项 | 情况 | 处理 |
|---|---|---|
| **5.20 ItemCard** | 01 §5 登记了但从未实现 | 这次实现 |
| 项目卡 | 清单外 | **不新造组件**：登记为 5.20 的「角标行」变体（高 128）—— 图标 + 名称 + 根路径（中段省略，1 行）+ 角标行「N 个任务 · N 个产物 · 最近活动」；右上角 `+` 换成 `⋯` 菜单 |
| **5.34 Dialog** | 清单外，但 §1 的 z-index 早有 `300 模态`，且 `library.tsx` 已私自搭了 `ew-delete-confirm` | 新登记：标题 + 正文 slot + 动作行，`role="dialog"`/`alertdialog`、`Esc` 关闭（§4 已有逐层关闭约定）。三个弹窗（新建 / 改名 / 移除确认）都是它的用法 |

### 3.2 列表页 `/projects`（目录式，内容列 800）

标题栏带：`项目` + 搜索（5.16）+ 「导入现有文件夹」「新建空间」。
下方 258×128 卡片三列网格。

- `⋯` 菜单（5.19）：在此空间新建任务 · 打开所在文件夹 · 改名 · 从列表移除
- 失效卡：`--warning` 边框，角标行换成「路径已失效，重新指定」，
  菜单里「在此空间新建任务」禁用**并给原因**（不是灰掉不说话）
- 空态用 `EmptyState`，说清"还没有空间"并直接给两个动作
- **「从列表移除」的确认文案必须说清只解绑不删文件**（02 §4.3 点名的一条）

### 3.3 详情页 `/projects/:id`（三栏）

**中栏 272**：`PanelHeader`（空间名）+ 两个 `TreeSectionHeader` 分区

- **任务 (N)**：`TaskListItem`，点击进 `/tasks/:id`
- **文件**：`TreeItem` 懒加载，展开一层读一层。`.git` / `node_modules` / `dist` / `.venv`
  默认折叠但**显示**（隐藏会让人以为文件丢了），带「显示全部」开关；分区头给刷新 `IconButton`

**主区**

| 区块 | 数据来源 |
|---|---|
| 头部 | `project_local`：名称 + 根路径 + 四个动作（新建任务 / 打开文件夹 / 改名 / 移除） |
| 失效横幅 | `existsSync`，只在失效时出现（`Banner` warning） |
| **最近的文件动作** | `artifact` 表中 `path` 在 root 下的行。列：文件 · 动作（`operation_kind`）· 来自哪个任务 · 时间。**D-P6 的合并落点** |
| 绑定的自动化 | `automation.workspaces`（JSON 路径数组）与 root 求交，用 §2.1 的 `isUnderRoot`。列：名称 · 计划 · 下次触发 · 状态 |
| 空间记忆 | `<root>/AGENTS.md` 纯文本框 + 保存 + 「已保存」反馈；文件不存在时显示占位说明并允许创建 |

### 3.4 「在此空间新建任务」

跳 `/home` 并预选该工作空间。首页下拉在 §2.2 迁移后已改读 `project_local`，
所以这里只是带一个 `preselectProjectId`，不新增机制。

### 3.5 事件与刷新

- 内核 `project/changed` 已翻成 `{ type: 'projects-changed' }`（`services/kernel-adapter/src/events.ts:328`），
  列表页订阅它刷新。**它只反映内核那一侧** —— 本机增删由动作本身返回新列表，不等通知。
- 文件树不接 `fs/watch`（D-P5），刷新靠按钮与进页面，**界面不假装实时**。

## 4. 验收

`pnpm run check` 全绿（prettier · eslint 含 K2/token-only 两条规则 · tsc 含测试 · vitest · K1 补丁预算）。
不含真窗口手动验证。

### 断言写后果（CLAUDE.md §9.1）

| 断言 | 写错的表现 |
|---|---|
| `isUnderRoot('/work', '/workspace/a')` = false | 两个平级目录的任务互相串台 |
| `..` 在归一化**之后**才判定 | `<root>/../.ssh` 被当成空间内，文件树能读走私钥 |
| 新建空间选中硬拦截目录被拒 | 10 §5 的整条路径策略被一个入口绕过 |
| 移除空间后磁盘文件仍在、`artifact` 索引仍在 | 用户丢文件 |
| meta 迁移幂等，且迁移后 `evowork.workspaces` 键消失 | 三处真源没真收敛，下次启动又冒出来 |
| 镜像失败（`project/create` 返回 -32601）时空间照常建成 | 内核一升级，用户建不了空间且不知道为什么 |
| `assertDegradationCoverage()` 对新增的 `project/update` 成立 | 上游删了它 → UI 白屏且没人知道为什么 |
| `writeAgentsMd` 只接受 `<root>/AGENTS.md` | 渲染层传任意路径就能让主进程写盘任意文件 |
| root 内的软链指向外部时拒读；realpath 失败也拒读 | 工作空间里放一个软链就把文件树变成全盘浏览器 |
| `isUnderRoot` 在 `home` 为 `/` 或空串时仍拒绝空 root | 容器里 `HOME` 没设时，空 root 匹配整个文件系统 |

## 5. 要同步改的既有文档

| 文档 | 改什么 |
|---|---|
| `docs/design/01-ui-design-system.md` §5 | 实现 5.20；登记项目卡变体；新增 **5.34 Dialog**；组件计数 33 → 34 |
| `docs/design/02-information-architecture.md` §4.3 | 「最近产物 + 最近变更」合并为「最近的文件动作」（D-P6） |
| `docs/design/09-service-layer.md` §3.3 | `project/*` 一行改为「本机权威 + 内核尽力镜像」；补 `project/update` 的降级条目 |
| `docs/status.md` | M2 前端未完成项里划掉「项目页」 |

## 6. 不做

- 多根路径的 UI（D-P2：只留表结构）
- `fs/watch` 接线（D-P5）
- 内核 `project/import` / `project/move`（排序与批量导入本期无入口）
- 空间级记忆的"每日工作记录与主题蒸馏"（清单 §11，属另一条线）
