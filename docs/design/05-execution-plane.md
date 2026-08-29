# 05 · 执行面、沙箱与出口

> 地基 D。Executor 无状态，凭 lease 从 Gateway 领取 effect 执行。
>
> 具体复用哪些 codex 代码、怎么同步，见 [08](08-codex-integration.md)（已实测）。本文只谈接口与治理语义。

---

## 一、接口

```rust
#[async_trait]
pub trait Executor: Send + Sync {
    fn id(&self) -> ExecutorId;
    fn capabilities(&self) -> ExecutorCapabilities;   // 支持哪些 tool class、有没有网络、平台
    async fn execute(&self, lease: Lease, effect: DispatchedEffect) -> EffectOutcome;
    async fn heartbeat(&self, lease: &Lease) -> Result<()>;
}

pub struct Lease {
    pub lease_id: LeaseId,
    pub run_id: RunId,
    pub effect_id: EffectId,
    pub expires_at_ms: u64,     // 来自 env.sampled，不是执行器自己读时钟
    pub workspace: WorkspaceHandle,
    pub egress_policy: EgressPolicy,
    pub capability: CapabilityToken,
}
```

POC 期只有一种实现（`LocalSandboxExecutor`），且与 daemon 同进程。**但 lease 机制仍然存在**——这是 0.2 白名单「执行面：只做本地沙箱一种实现，组织内 Runner / 云沙箱是同一接口的另两种实现」的可执行形态。lease 现在是一个结构体传参，将来是一次 RPC 领取，调用点不变。

> 技术路线那句话在这里兑现：**「长时进程守护」和「跨设备接管」不再是功能，而是部署选项。** POC 期 daemon 与 UI 同机，都在财务那台 Mac mini 上（4.8），daemon 装成 LaunchDaemon 跑在专用服务账户下——**桌面客户端退出、财务注销，任务照跑**。这两项当天就成立，且不需要第二台机器。

`EffectOutcome` 必须带 `actual_targets` 与 `actual_egress`，与 effect 声明的 `declared_*` 比对（[01 §4.4](01-run-log.md)）。POC 期只记录不拦截，但字段与比对代码现在就写——这是「供应链管控：声明只读却在写文件即拦截」的数据基础。

---

## 二、工作区隔离

每个 run 一个工作区：`~/.evowork/workspaces/<run_id>/`。

| POC 期 | Phase 2 |
|---|---|
| 直接建目录；若目标是 git 仓库，用 `git worktree` | 加 COW 快照（APFS `clonefile`），支持 Fleet 并行与冲突消解 |

工作区句柄（`WorkspaceHandle`）从第一天就是一个抽象，不是一个 `PathBuf`——Fleet 期它会变成「某个快照的挂载点」。

---

## 三、沙箱

**Q-21 已定：daemon 宿主是财务那台台式 Mac mini，macOS。** 沙箱用 `sandbox-exec`（seatbelt），实现复用 codex 的 seatbelt 子集（[08 §3](08-codex-integration.md)）。

这条落定同时消掉两件事：POC 文档 4.8 那条「退回 Windows daemon」的排期风险不再需要预留，[08 §3](08-codex-integration.md) 选 vendor macOS 子集的路径也随之确定成立——不必再为 `codex-windows-sandbox` 留后路。

**落位形态：LaunchDaemon + 专用服务账户（如 `_evowork`）。** 这不只是部署细节，它同时是沙箱之外的第二层隔离：

| | 说明 |
|---|---|
| 系统级启动，与登录无关 | 财务锁屏、注销、退出桌面客户端都不影响 daemon；**只有关机不行** |
| 工作区、Run Log、blob、用友只读凭据都在服务账户家目录下 | 财务的日常登录账户读不到——与本节最后那条敏感目录硬拦截同向：**有些约束不该由策略来保证** |
| 卸载 = 删一个用户 + 一个 plist | POC 结束机器还回去是干净的 |

> **一条前提必须在装机前验，否则"常开"是假的**：机器若开着 FileVault，**断电重启后停在解锁界面，LaunchDaemon 在有人登录前根本不会启动**。要么请 IT 对这台机关掉（daemon 数据本来就在独立服务账户下，不靠全盘加密），要么接受"意外断电需有人去输一次密码"并且别把自动恢复写进承诺。计划内重启可用 `fdesetup authrestart` 绕过，意外断电绕不过。另需 `pmset -a sleep 0 disksleep 0 autorestart 1` 并挪开系统自动更新的重启窗口。

| 维度 | POC 期策略 |
|---|---|
| 文件读 | 工作区 + 只读系统路径 + 托管运行时目录；其余拒绝 |
| 文件写 | **仅工作区** |
| 网络 | 沙箱内不直连，全部经 forward proxy（第四节） |
| 进程 | 允许起子进程；子进程继承同一 profile 与 `HTTP(S)_PROXY` |
| 敏感目录 | `~/.ssh`、`~/.aws`、keychain、浏览器 profile **硬拦截**（不是策略可放宽项） |

最后一行是有意与策略分开的：策略引擎可以放宽目录权限，但这几个路径不在策略的可及范围内。理由与 [02 §2](02-effect-gateway.md) 里「污点检查在策略求值之前」相同——**有些约束不能是可配置的**。

托管运行时（Python / Node）跑在同一沙箱内，依赖装在工作区下的受管目录。

> **依赖安装与出口的冲突，是这一节唯一的真问题**：`pip install` 需要 pypi 出口，而演示时刻 1 要断掉除模型 API 外的全部出口。
> 建议 POC 期**预装依赖、不开 pypi/npm 出口**：账龄这个场景需要的就是 pandas / openpyxl 一类，一次装好即可。开了出口，演示时刻 1 就不干净。**Q-18**

---

## 四、出口管控

**forward proxy 是唯一出口。** 复用 `codex-network-proxy`（[08](08-codex-integration.md) 实测：依赖闭包只有 3 个 utils crate，干净）。

```
沙箱子进程 ──HTTP(S)_PROXY──▶ evo-proxy (本地子进程)
                                  │  allowlist 匹配
                                  ├─ 命中 → 转发 + 记账事件
                                  └─ 未命中 → 拒绝 + 记账事件
```

技术路线那条判断在这里落地：**SDK 层拦截总有绕过路径**（Agent 会跑 `curl`、装依赖、起子进程），而「出口全量记账」一旦有绕过路径就失去审计意义。

### allowlist 初版

| 目的地 | 用途 | 备注 |
|---|---|---|
| **DeepSeek API** | 唯一的模型出口 | Q-01b 已定。**GPT 是开发期供应商，不进交付形态的 allowlist**（[09 §5](09-model-plane.md)） |
| 用友服务器（内网 IP/域名） | 取数，**HTTP API**（Q-24） | 内网，不出客户网络；与其他两条走同一个 proxy |
| 企业微信群机器人 webhook | 内部推送与审批（4.9） | **公网**，但只发通知文本 |
| 其余 | **全部拒绝** | 包括 pypi / npm（见第三节）、以及**任何第二个模型域名** |

> 最后半行是有意写进 allowlist 而不是靠纪律的：演示时刻 1 打开出口日志时若出现第二个模型域名，当场就是事故。**开发期与交付形态用同一份代码、不同一份 allowlist**——这也是「允许实现简陋，不允许调用点错位」的一个实例。

演示时刻 1 就是把这张表打印出来，加上出口日志：**只有模型 API 一条，财务明细一条没出内网。** **Q-17 / Q-21**

> **Q-21 已定：该机器可访问公网模型 API。** 于是 DeepSeek 与企业微信 webhook 两条路都通。
>
> 这让演示时刻 1 的性质变得更好，而不是更弱：**出口是被我们的 proxy 拒掉的，不是被网络环境拒掉的。** 机器本身能上公网，却只有 allowlist 里那几条走得通——可以当场往 allowlist 里加一条再删掉，让客户看见管控是活的。靠「机器本来就没网」演出来的「数据没走」，客户回去自己装一台能上网的机器就复现不了了。

### 记账粒度

每次出口产生一条记录：目的地、字节数、命中的规则、发起的 effect_id。这些既进 proxy 自己的结构化日志，也回填到 `tool.result.actual_egress`——**同一事实只有一个权威副本（Run Log），proxy 日志是它的补充证据而不是第二套账。**

---

## 五、MCP client 与一个容易漏掉的洞

MCP server 是**独立进程**（4.1：用友接入 = 一个 MCP Server 进程，产品主干零特化）。于是有一个问题需要明确回答：

> **MCP server 进程本身，受不受沙箱和出口管控？**

如果不受，那么「所有出口都经 proxy」这句话就有了一个缺口——而用友 MCP server 恰好是**唯一需要访问用友数据库/API、并且会拿到全部财务明细**的进程。这是整套设计里最值得盯的一个洞。

**方案：MCP server 与其他被执行的东西同等对待。**

| | 处理 |
|---|---|
| 进程启动 | 由 daemon 拉起，不由用户手工起 |
| 沙箱 | 同一 seatbelt profile，工作区限定为它自己的目录 |
| 出口 | 注入 `HTTP(S)_PROXY`，allowlist 里为它单独开用友服务器地址 |
| 调用 | 每次 MCP tool call 是一个 effect，走 Gateway 六步 |
| manifest | 由 daemon 侧的 `mcp-manifest.toml` 补齐（[02 §4](02-effect-gateway.md)） |

**Q-19 已定：按上表处理，MCP server 与其他被执行的东西同等对待。**

**Q-24 已定为走 HTTP API，这个洞随之关上了。** 原本的担心是数据库直连不走 HTTP proxy、SOCKS5 只能覆盖一部分——走 API 之后，用友取数与模型调用、企业微信推送是同一条路径：注入 `HTTP(S)_PROXY`，allowlist 匹配，全量记账。**「所有出口只有 proxy 一个」这句话因此没有缺口**，M1 不再需要为此留验证任务。

> 若将来某个客户只能走库直连，退路仍然在（把该 MCP server 放进沙箱自己的网络命名空间，或接受只记账不代理并在出口清单里显式标注）——但那是换客户时的事，不进 POC 排期。

---

## 六、三种执行面实现的路线

| 实现 | 何时 | 与 POC 的关系 |
|---|---|---|
| 本地沙箱 | POC | 唯一实现 |
| 组织内 Runner | 已经是了 | POC 期财务那台 Mac mini 上跑的**就是同一份 daemon 代码**（4.8）。客户将来要把它挪到机房专机，改的是一个地址 |
| 云沙箱 | Phase 2+ | Fleet 扩容，可选 |

---

## 七、待确认

| # | 问题 | 谁定 |
|:-:|---|:---:|
| Q-17 | 出口白名单初版清单，除三项外还有没有 | 客户 |
| Q-18 | 托管运行时能否接受「预装依赖、不开 pypi/npm 出口」 | 客户 |
| ~~Q-19~~ | ~~MCP server 子进程的沙箱与出口路径~~ | — **已定：同等对待**。Q-24 走 API，出口完全被 proxy 覆盖，无遗留验证项 |
| ~~Q-21~~ | ~~常开机器平台与公网可达性~~ | — **已定：daemon 宿主 = 财务的台式 Mac mini（macOS），可访问公网模型 API。客户零硬件** |
| ~~Q-20a~~ | ~~`codex-sandboxing` 的取舍~~ | — **已定：vendor macOS 子集**，见 [08 §3](08-codex-integration.md) |
