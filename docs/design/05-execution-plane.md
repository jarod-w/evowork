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

> 技术路线那句话在这里兑现：**「长时进程守护」和「跨设备接管」不再是功能，而是部署选项。** POC 期 daemon 跑在客户内网常开机上（4.8），这两项当天就成立。

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

POC 期 daemon 定在 macOS（4.8），沙箱用 `sandbox-exec`（seatbelt），实现复用 codex 的 seatbelt 子集（[08 §3](08-codex-integration.md)）。

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
| 模型 API 域名 | 唯一的公网出口 | 取决于 **Q-01b**（[09](09-model-plane.md)） |
| 用友服务器（内网 IP/域名） | 取数 | 内网，不出客户网络 |
| 企业微信群机器人 webhook | 内部推送与审批（4.9） | **公网**，但只发通知文本 |
| 其余 | **全部拒绝** | 包括 pypi / npm（见第三节） |

演示时刻 1 就是把这张表打印出来，加上出口日志：**只有模型 API 一条，财务明细一条没出内网。** **Q-17 / Q-21**

> **Q-21 的后半句常被忽略**：客户内网的常开机器往往默认没有公网出口。模型 API 与企业微信 webhook 都需要公网——这件事要在 M1 就跟客户 IT 确认，不要拖到 M3 彩排。

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

代价是数据库直连协议（若 Q-24 走直连而非 HTTP API）不走 HTTP proxy，SOCKS5 可以覆盖一部分，但不是全部。**这一条要在 M1 就试通，不能假设**。**Q-19 / Q-24**

---

## 六、三种执行面实现的路线

| 实现 | 何时 | 与 POC 的关系 |
|---|---|---|
| 本地沙箱 | POC | 唯一实现 |
| 组织内 Runner | 已经是了 | POC 期常开机上跑的**就是同一份 daemon 代码**（4.8），不是另一套东西 |
| 云沙箱 | Phase 2+ | Fleet 扩容，可选 |

---

## 七、待确认

| # | 问题 | 谁定 |
|:-:|---|:---:|
| Q-17 | 出口白名单初版清单，除三项外还有没有 | 客户 |
| Q-18 | 托管运行时能否接受「预装依赖、不开 pypi/npm 出口」 | 客户 |
| Q-19 | MCP server 子进程的沙箱与出口路径（尤其数据库直连时） | 团队，**M1 内试通** |
| Q-21 | 常开机器最终平台；**该机器能否访问公网**（模型 API + 企业微信） | 客户 |
| Q-20a | `codex-sandboxing` 的取舍，见 [08 §3](08-codex-integration.md) | 团队 |
