# EVOWORK · 设计文档索引

> 本组文档是 [next-gen-agent-platform-poc-scope.md](../next-gen-agent-platform-poc-scope.md) 的**可实现版本**：POC 文档回答「第一步先做什么」，本组回答「这一步的每个契约长什么样」。
>
> 文档地图：
>
> | 文档 | 回答 |
> |---|---|
> | [feature-list](../next-gen-agent-platform-feature-list.md) | 要做什么 |
> | [tech-roadmap](../next-gen-agent-platform-tech-roadmap.md) | 怎么做到 |
> | [poc-scope](../next-gen-agent-platform-poc-scope.md) | 第一步先做什么 |
> | **本组 `docs/design/`** | **第一步的每个契约长什么样** |

---

## 零、本组文档的适用范围

只覆盖 **M1 地基 + M2/M3 所需的契约**。凡是 POC 文档划到 C 类（明确不做）的，本组只在 schema 上留位，不做设计。

判据不变，全组服从 POC 文档零章那一条：

> **允许实现简陋，不允许调用点错位。**

因此本组文档的重点在**接口与数据契约**，不在实现细节。凡是写了「POC 期做法」的地方，都同时写了「将来换什么、换的时候动不动调用点」。

---

## 一、文档清单

| # | 文档 | 对应地基 | 挡不挡 M1 |
|:-:|---|:---:|:---:|
| 01 | [Run Log 事件 schema](01-run-log.md) | A | **挡** |
| 02 | [Effect Gateway 与 dry-run](02-effect-gateway.md) | B | **挡** |
| 03 | [内核状态机与回放](03-kernel.md) | A | 挡 |
| 04 | [上下文装配、污点与记忆](04-context-memory.md) | C | M2 |
| 05 | [执行面、沙箱与出口](05-execution-plane.md) | D | M1 |
| 06 | [daemon / UI 协议](06-protocol.md) | — | M1 |
| 07 | [POC 域落地：用友 · 口径库 · eval](07-poc-domain.md) | — | M2 |
| 08 | [codex 代码同步与复用边界](08-codex-integration.md) | D | **挡**（已实测） |

01 与 02 是 M1 第一行代码的前置——它们定义的类型就是 `evo-protocol` 的内容，其余 crate 全部依赖它。

08 是 POC 文档 4.11 的**实测落地版**：已对 `openai/codex` @ `c6bf330`（2026-08-28）逐条复验，并**修正了 4.11⑤ 中一条不成立的假设**（那四个 crate 不在 crates.io 上）。开工前必读。

---

## 二、仓库结构

```
evowork/
├── Cargo.toml                    # workspace
├── clippy.toml                   # 内核确定性静态检查（见第四节）
├── crates/
│   ├── evo-protocol/             # 事件 + RPC 类型定义，ts-rs 导出 TS
│   ├── evo-kernel/               # 纯函数状态机。无 IO / 无时钟 / 无随机数
│   ├── evo-runlog/               # SQLite 事件存储、快照、回放器
│   ├── evo-context/              # 上下文装配、污点传播、cite 校验
│   ├── evo-memory/               # 记忆存储 + 口径库加载
│   ├── evo-policy/               # 策略钩子 trait + POC 硬编码实现
│   ├── evo-gateway/              # Effect Gateway 管线
│   ├── evo-exec/                 # 执行面接口（Executor / Lease）
│   ├── evo-exec-local/           # 本地沙箱实现，依赖 codex crates
│   ├── evo-model/                # 模型 adapter + 能力声明 + 定价表
│   ├── evo-mcp/                  # MCP client
│   ├── evo-daemon/               # 唯一组装点，唯一写 Run Log 的进程
│   └── evo-cli/                  # 运维命令 + eval runner
├── apps/
│   └── ui/                       # Vite + React + AntD，纯 Web
├── packages/
│   └── protocol/                 # ts-rs 生成产物，不手写
├── mcp-servers/
│   └── yonyou/                   # 独立进程。crates/ 里不得出现「用友」
├── eval/
│   ├── cases/                    # 冻结快照 + 期望输出
│   └── run.sh                    # 一条命令跑全集
└── scripts/
    ├── sync-codex-vendor.sh      # 见 08：受控 vendor 的同步入口
    └── codex-closure.py          # 见 08：上游依赖闭包检查，挂进 CI
```

`crates/evo-exec-local/vendor/` 下是受控 vendor 的上游代码（[08](08-codex-integration.md)），**该目录内不做任何修改**，CI 检查与上游逐字节一致。

`mcp-servers/yonyou` 与主干同仓但不同依赖树，靠 CI 检查隔离（第四节第 5 条）。客户换成金蝶时删掉这一个目录即可——这就是 4.1「主干里零行用友」的可执行形态。

### 依赖方向

```
evo-protocol   ← 谁都依赖它；它不依赖任何 evo-*
evo-kernel     ← 只依赖 protocol
evo-runlog     ← protocol
evo-context    ← protocol
evo-policy     ← protocol
evo-gateway    ← protocol + policy
evo-exec       ← protocol
evo-exec-local ← exec + codex crates
evo-model      ← protocol
evo-mcp        ← protocol + exec
evo-daemon     ← 全部
```

一条规则：**组装只发生在 `evo-daemon`。** 新增一条兄弟 crate 之间的依赖，需要在 PR 描述里说明为什么不能由 daemon 组装。这条不是洁癖——它是「内核不在 UI 进程里」这条边界在 crate 层的对应物。

---

## 三、开发约定（五条不可议价）

| # | 约定 | 为什么 |
|:-:|---|---|
| 1 | **内核 crate 不得依赖时钟、随机数、env、文件、网络** | 判据 3。做法见第四节 |
| 2 | **只有 `evo-daemon` 写 Run Log** | 多写者一致性问题不存在，是 daemon 边界的直接收益 |
| 3 | **事件 schema 只增不改**：加字段必须 optional，改语义必须升 `schema_ver` 并保留旧版解码 | 红线 3 |
| 4 | **任何工具调用只有 Gateway 一个出口**，包括内置工具 | 红线 2 |
| 5 | **`crates/` 与 `apps/` 里不得出现客户专有名词** | 4.1 / 自检第 4 条 |

### 事件 schema 变更流程

改 `evo-protocol` 里的事件定义，PR 必须同时包含：

1. `schema_ver` 的处理（新增 optional 字段可不升版；语义变化必须升）
2. 旧版本解码路径的保留与测试用例
3. `eval/cases/` 里至少一条历史 Log 的回放通过

> 这三条缺一条就合不进去。**这是红线 3 唯一可执行的防线**——「不许后补字段」是口号，「PR 必须带历史回放测试」才是机制。

---

## 四、CI 检查清单

这几条现在写进 CI 是半天，半年后补是一个季度（且判据 3 那条那时已经不可能补救）。

| # | 检查 | 实现 |
|:-:|---|---|
| 1 | 内核不读时钟 / 随机数 / env | `clippy.toml` 的 `disallowed-methods` + `disallowed-types`；并检查 `evo-kernel` 的 `cargo tree` 不含 `chrono` / `time` / `rand` / `uuid` / `getrandom` |
| 2 | **回放自校验** | 对 `eval/cases/` 中每条历史 Log 全量重放，每个 `checkpoint` 事件处比对 `state_hash`。不一致即 fail |
| 3 | 治理旁路 | 检查 `evo-exec*` / `evo-mcp` 未被 `evo-daemon` 之外的地方直接调用（即不得绕过 gateway） |
| 4 | 客户名词隔离 | `grep -riE 'yonyou\|u8\|用友' crates/ apps/` 必须为空 |
| 5 | 协议同步 | `ts-rs` 生成结果与 `packages/protocol` 已提交内容一致，否则 fail |
| 6 | vendor 未被修改 | `crates/evo-exec-local/vendor/` 与上游 pin 住的 rev 逐字节一致（[08 §3](08-codex-integration.md)） |
| 7 | 上游依赖闭包 | `scripts/codex-closure.py` 的输出与基线一致；闭包变大即 fail（借错层的早期信号） |

> 第 2 条是整套设计里性价比最高的一项：它把「内核里悄悄读了时钟」从**半年后被发现**变成**当天被发现**。技术路线第七节点名担心的正是这一条。

---

## 五、待确认问题汇总

各文档末尾都有自己的一份，这里汇总便于一次性过。**标注「客户」的建议随 M0 一起发出去，不要等到 M2。**

### 需客户确认

| # | 问题 | 影响 | 文档 |
|:-:|---|---|:---:|
| Q-01 | **模型供应商是谁**，财务摘要能否出内网 / 出境，是否需要私有部署模型 | 演示时刻 1 的话术、成本定价表、eval 基线。三份既有文档全文未定 | 01 / 05 |
| Q-02 | Run Log 里会留存进入模型的财务摘要，**保留多久、能否导出、谁能看** | 决定 blob 与事件表的切分是否够用 | 01 |
| Q-05 | 成本按什么口径给客户看：token 数 / 人民币 / 两者 | 定价表与汇率来源 | 01 |
| Q-08 | **高危操作分级口径**：哪些动作必须人点、审批人是谁 | Gateway 策略钩子的初版内容 | 02 |
| Q-09 | dry-run 下只读动作照常执行，**会产生真实模型费用**，客户能否接受 | 演示话术 | 02 |
| Q-10 | 安全评审能否接受「shell 类工具的治理兜底是沙箱 + 出口代理，而非静态分析」 | 见 02 第五节 | 02 |
| Q-14 | **溯源粒度**：一个账龄分档金额背后是几百张单据，财务要看到什么粒度 | 4.4① 是本客户唯一的信任建立机制，粒度定错等于白做 | 04 |
| Q-15 | 口径库初版条目谁来最终确认（财务负责人还是经办人） | 4.6 装不满则护城河无演示 | 04 / 07 |
| Q-17 | **出口白名单初版清单**：模型 API、用友服务器、企业微信之外还有没有 | 演示时刻 1 | 05 |
| Q-18 | 托管运行时的依赖：POC 期能否接受**预装依赖、不开 pypi/npm 出口** | 开了出口，演示时刻 1 就不干净 | 05 |
| Q-21 | 常开机器最终平台（争取 macOS）**及该机器能否访问公网模型 API** | 后半句常被忽略：内网机器往往默认无公网 | 05 |
| Q-24 | 用友取数走 API 还是数据库直连 | MCP Server 的实现，不影响语义接口 | 07 |
| Q-25 | 历史 3–6 个月人工成品表 + 只读账号（M0，已知） | 口径库与评测真值同时依赖 | 07 |
| Q-26 | 财务能否接受「不催清单」这类口径以**文件**形式维护并由他们自己改 | 决定口径库是产品机制还是又一个 Excel | 07 |
| Q-28 | 账龄表版式、跟催任务包推给个人还是业务组 | M2 期再定即可 | 07 |

### 需团队内部拍板

| # | 问题 | 建议 | 文档 |
|:-:|---|---|:---:|
| Q-03 | blob store 形态 | 文件 + content-addressed，不进 SQLite | 01 |
| Q-04 | `env.sampled` 采样粒度 | 每 turn 一次 | 01 / 03 |
| Q-06 | 快照频率与 Log 分库 | 每 50 事件一快照；单库多 run | 01 / 03 |
| Q-07 | 事件 schema 变更流程 | 见第三节 | 00 |
| Q-11 | 工具 manifest 谁写；MCP server 的 manifest 从哪来 | 见 02 第四节 | 02 |
| Q-12 | 模型响应解析放内核还是 runtime | 放 runtime，内核只吃结构化事件 | 03 |
| Q-13 | 回放自校验纳入 CI 的时点 | M1 内，不能拖 | 03 |
| Q-16 | 记忆在 POC 期是否真的启用 | 建表但不启用，只加载口径库 | 04 |
| Q-19 | MCP server 子进程的出口与沙箱路径 | 见 05 第四节，**这是设计里最容易漏的一个洞** | 05 |
| Q-20 | ~~codex crate 能否 crate 级依赖~~ | **已实测：不在 crates.io，改用 pin 住 rev 的 git 依赖** | 08 |
| Q-20a | `codex-sandboxing` 取全量依赖（带 OTel）还是 vendor macOS 子集 | **vendor 子集**，约 2 人日 | 08 |
| Q-20b | vendor 同步纪律是否进 CI | 是。不进 CI 一定会被越过 | 08 |
| Q-20c | 上游 rev 在 POC 期是否冻结 | 冻结 | 08 |
| Q-22 | UI ↔ daemon token 的分发方式 | 见 06 | 06 |
| Q-23 | 协议版本不兼容时的处理 | 见 06 | 06 |
| Q-27 | eval 冻结快照的存放与更新 | 见 07 | 07 |

---

## 六、明确不在本组设计范围内

Agent Fleet 与并行隔离、对抗式验证、policy-as-code 策略引擎实现、分层记忆的组织层、轨迹自蒸馏、SSO/RBAC、DLP 规则、hash chain 与外部锚定、云沙箱、跨设备接管、Computer Use。

以上每一项在本组文档里**只以「留位」的形式出现**（字段、trait、目录），不做设计。留位的位置在各文档里都标了 `[Phase 2+]`。
