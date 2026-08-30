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
| 09 | [模型面：可插拔、能力声明与定价](09-model-plane.md) | 模型面 | M2 |

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
│   ├── evo-runlog/               # SQLite 事件存储、快照存储
│   ├── evo-context/              # 上下文装配、污点传播、cite 校验
│   ├── evo-memory/               # 记忆存储 + 口径库加载
│   ├── evo-policy/               # 策略钩子 trait + POC 硬编码实现
│   ├── evo-gateway/              # Effect Gateway 管线
│   ├── evo-exec/                 # 执行面接口（Executor / Lease）
│   ├── evo-exec-local/           # 本地沙箱实现，依赖 codex crates
│   ├── evo-model/                # 模型 adapter + 能力声明 + 定价表
│   ├── evo-mcp/                  # MCP client
│   ├── evo-daemon/               # 唯一组装点，唯一写 Run Log 的进程；回放器在此
│   └── evo-cli/                  # 运维命令 + eval runner
├── apps/
│   └── ui/                       # Vite + React + AntD，纯 Web
│       ├── src/platform/         # 唯一允许出现 @tauri-apps/api 的目录（CI 检查 9）
│       └── src-tauri/            # Tauri 2 外壳，约 200 行，零业务逻辑
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

> **回放器为什么在 `evo-daemon` 而不是 `evo-runlog`。** 回放需要 `evo-kernel::fold`
>（`reduce` + `decide`），如果把回放器放进 `evo-runlog`，就会形成一条兄弟 crate 依赖
> `evo-runlog → evo-kernel`，与上面这张依赖方向表冲突（`evo-runlog` 该依赖里没有
> `evo-kernel`）。因此**存储在 `evo-runlog`，回放在 `evo-daemon`**（见
> `crates/evo-daemon/src/replay.rs`），`evo-cli` 经 daemon 取用。这样「组装只发生在
> `evo-daemon`」就没有第二个例外——回放虽然只读，但它同样是「把 kernel 的纯函数与
> runlog 的存储组装到一起」，性质上和写 Run Log 是同一件事。

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

> **首次演练：M1 阶段 1 给 `plan.step` 加了 optional 字段 `call`**（见
> [01 §4.3](01-run-log.md#43-上下文与模型)）。三条要求逐条兑现——① `schema_ver` 不升
>（新增 optional 字段）；② 旧版解码路径由 `evo-protocol` 的
> `unknown_optional_fields_do_not_break_decoding` 覆盖；③ `eval/cases/synthetic-01`
> 的回放在 CI 里通过。**这条流程是可执行的，不是口号。**

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
| 8 | **快照可丢弃** | 删掉全部 snapshot 后回放结果与保留快照时一致（Q-06）。没有它，早晚有人往快照里塞一个 Log 里没有的状态 |
| 9 | **外壳不渗进业务代码** | `grep -rE '@tauri-apps/api\|ipcRenderer' apps/ui/src/` 的命中必须全部落在 `apps/ui/src/platform/` 内。POC 期就要出桌面外壳（4.10②）之后，这条从「将来注意」变成当期防线——**UI 里到处 `invoke`，就是红线 1 的前置形态** |
| 10 | 构建产物/依赖目录未被跟踪 | `git ls-files` 查跟踪状态（非磁盘遍历），命中 `(^|/)(node_modules\|target\|dist\|\.pnpm)(/\|$)\|\.rlib$\|\.rs\.bk$` 时打印具体路径并给出修复：`git rm -r --cached <path>`；防止大量构建产物误入版本库 |

> 第 2 条是整套设计里性价比最高的一项：它把「内核里悄悄读了时钟」从**半年后被发现**变成**当天被发现**。技术路线第七节点名担心的正是这一条。

---

## 五、待确认问题汇总

各文档末尾都有自己的一份，这里汇总便于一次性过。

**当前状态：团队侧零待定；剩下的全是客户问题，且没有一条阻塞 M1。** 建议随 M0 一次性全部发出去——不是因为开发要等它们，而是因为其中几条的答案如果落在意外值上（见 [第六节](#六不在本组设计范围内)前的说明），那是方案级变化而非配置变化，越晚发现越贵。

> **另有一件事不是「待确认」而是「待启动」，却比下表任何一条都紧急：Apple Developer Program 账号。** 客户已明确桌面客户端形态是验收条件（POC 文档 4.10②），签名公证是硬前提，组织账号需 D-U-N-S 编号、**2 周起**——它是全项目 lead time 最长的一项，**第 1 天不启动、第 6 周一定卡住**。不列进表里，因为它不需要任何人回答。

### 需客户确认

| # | 问题 | 影响 | 文档 |
|:-:|---|---|:---:|
| ~~Q-01~~ | ~~模型供应商是否绑定~~ | **已定：可配置**（多供应商可插拔），落地见 09 | 09 |
| ~~Q-01b~~ | ~~POC 现场用哪一家~~ | **已定：DeepSeek `deepseek-v4-flash-0731`**（客户已与上游签不做训练协议） | 09 |
| ~~Q-01e~~ | ~~财务明细进模型上下文的边界~~ | **已定：可出内网，只要不用于训练**。策略配 `DetailEgress::Allow`，产品默认仍为 `Minimize` | 04 |
| Q-01f | 协议里的**日志留存期与访问控制**条款 | 「不做训练」通常不覆盖服务端日志留存；合规审计会问。不阻塞开发 | 09 |
| ~~Q-29~~ | ~~演示时刻 1 的话术怎么改~~ | **已改**：演示时刻 1 更名为「出口可控、去向可查」，POC 文档第一节 / 4.8 / 第五节 / 附言共 6 处同步收紧 | 04 |
| Q-02 | Run Log 里会留存进入模型的财务摘要，**保留多久、能否导出、谁能看** | 决定 blob 与事件表的切分是否够用 | 01 |
| Q-05 | 成本按什么口径给客户看：token 数 / 人民币 / 两者 | 定价表与汇率来源 | 01 |
| Q-08 | **高危操作分级口径**：哪些动作必须人点、审批人是谁 | Gateway 策略钩子的初版内容 | 02 |
| Q-09 | dry-run 下只读动作照常执行，**会产生真实模型费用**，客户能否接受 | 演示话术 | 02 |
| Q-10 | 安全评审能否接受「shell 类工具的治理兜底是沙箱 + 出口代理，而非静态分析」 | 见 02 第五节 | 02 |
| Q-14 | **溯源粒度**：一个账龄分档金额背后是几百张单据，财务要看到什么粒度 | 4.4① 是本客户唯一的信任建立机制，粒度定错等于白做 | 04 |
| Q-15 | 口径库初版条目谁来最终确认（财务负责人还是经办人） | 4.6 装不满则护城河无演示 | 04 / 07 |
| Q-17 | **出口白名单初版清单**：模型 API、用友服务器、企业微信之外还有没有 | 演示时刻 1 | 05 |
| Q-18 | 托管运行时的依赖：POC 期能否接受**预装依赖、不开 pypi/npm 出口** | 开了出口，演示时刻 1 就不干净 | 05 |
| ~~Q-21~~ | ~~常开机器平台与公网可达性~~ | **已定：不再需要单独的常开机**——daemon 宿主就是财务那台台式 Mac mini（macOS），**客户零硬件**；可访问公网模型 API。Windows daemon 的排期风险与 08 vendor 路径的前提同时消掉。落位形态与装机前提见 05 §3 | 05 / 08 |
| ~~Q-24~~ | ~~用友取数走 API 还是数据库直连~~ | **已定：走 API**。MCP server 的出口完全被 proxy 覆盖，Q-19 的遗留验证项消失 | 07 / 05 |
| Q-25 | 历史 3–6 个月人工成品表 + 只读账号（M0，已知） | 口径库与评测真值同时依赖 | 07 |
| Q-26 | 财务能否接受「不催清单」这类口径以**文件**形式维护并由他们自己改 | 决定口径库是产品机制还是又一个 Excel | 07 |
| Q-28 | 账龄表版式、跟催任务包推给个人还是业务组 | M2 期再定即可 | 07 |
| Q-31 | **装机三前提**：① IT 是否允许在财务那台 Mac mini 上安装常驻服务（LaunchDaemon + 专用服务账户）② 能否关闭 FileVault，或接受断电后需人工解锁 ③ 能否给一条 DHCP 保留（固定内网 IP，手机审批链接要它） | 三条任一不成立，「常开」就是假的，演示时刻 3 受影响。**不阻塞 M1，阻塞 M2 的真机跑通**。①若为否，退路是我方自带一台 Mac mini | 05 |

### 团队决策（全部已定，备查）

| # | 决策 | 结论 | 文档 |
|:-:|---|---|:---:|
| Q-01c | M1 先接哪两家模型供应商 | **DeepSeek + GPT**，仅 DeepSeek 进交付形态的 allowlist | 09 |
| Q-01d | GPT 侧走哪个 API | **Responses**（DeepSeek 走 Chat Completions），让两个 adapter 在 wire 形态上真的不同 | 09 |
| Q-03 | blob store 形态 | **文件 + content-addressed**，`blobs` 表只做索引与保留期 | 01 |
| Q-04 | `env.sampled` 采样粒度 | **每 turn 一次**。内核对时间的分辨率就是一个 turn | 01 / 03 |
| Q-06 | 快照频率与 Log 分库 | **每 50 事件一快照 + 两个语义点；单库多 run**。「删掉快照结果不变」是硬测试 | 01 / 03 |
| Q-07 | 事件 schema 变更流程 | 见第三节：PR 必须带版本处理、旧版解码测试、历史 Log 回放 | 00 |
| Q-11 | 工具 manifest 谁写 | **daemon 侧维护，无 manifest 即最严**。弹审批频率在 M2 观察 | 02 |
| Q-12 | 模型输出解析放哪 | **runtime**，内核只吃结构化 `plan.step` | 03 |
| Q-13 | 回放自校验进 CI 的时点 | **M1 内**，先用合成 Log 也要跑 | 03 |
| Q-16 | 记忆在 POC 期是否启用 | **建表不启用**，精力放口径库 | 04 |
| Q-19 | MCP server 的沙箱与出口 | **与其他被执行的东西同等对待**。DB 直连是 M1 验证任务 | 05 |
| Q-20 | codex crate 依赖形态 | **pin 住 rev 的 git 依赖**（实测不在 crates.io） | 08 |
| Q-20a | `codex-sandboxing` 取舍 | **vendor macOS 子集**，避开 OTel 依赖链。**产品期做 Windows 时预计整体切回 A（直接依赖全套）**——B 的理由是 POC 专属的，见 08 §3 末 | 08 |
| Q-20b | vendor 同步纪律 | **进 CI**（检查 6） | 08 |
| Q-20c | 上游 rev | **POC 期冻结** | 08 |
| Q-22 | UI ↔ daemon token | `/Library/Application Support/evowork/client.toml` 分发（daemon 与桌面客户端同机但在不同账户下，权限 644）；**审批链接 token 24 小时 + 单次使用** | 06 |
| Q-23 | 协议版本不匹配 | **主版本不匹配降级为只读**，次版本正常 | 06 |
| Q-27 | eval 冻结快照存放 | **blob store**，git 里只放 `case.yaml` / `truth/` / `rules.lock` | 07 |
| Q-30 | 桌面外壳何时做 | **提前到 M1**。客户已明确「形态是验收条件」；壳不依赖业务进度，提前的唯一目的是给签名公证抢时间。约束：`@tauri-apps/api` 限定在 `platform/`（检查 9），浏览器入口必须保留 | 00 |

**团队侧零待定。** 但其中两条带着 M1/M2 的验证义务，不是拍完就结束：

| 决策 | 还要验什么 | 何时 |
|---|---|---|
| Q-11 | 「无 manifest 即最严」会不会让演示频繁弹审批 | **M2**。若频繁，解法是补 manifest，不是放宽默认值 |

（Q-19 原本挂着一项 M1 验证，Q-24 定为走 API 后已消失——用友、模型、企业微信三条出口走的是同一个 proxy，没有缺口。）

另有两条决策直接变成 CI 条目（检查 2、8），见第四节——**它们是这几条决策里唯一不会被时间侵蚀的部分。**
