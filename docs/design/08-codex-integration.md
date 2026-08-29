# 08 · codex 代码同步与复用边界

> POC 文档 4.11 定了方向（借实现，不借架构），4.11⑤ 定了形态（crate 级依赖）。**本文是把它落到可执行的那一步，并修正其中一条不成立的假设。**
>
> 实测对象：`openai/codex`，`main` @ **`c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3`**（2026-08-28），Apache-2.0。

---

## 一、实测结论先行

| # | 4.11 的说法 | 实测 | 结论 |
|:-:|---|---|---|
| 1 | 「直接 `cargo` 依赖」 | **这四个 crate 都不在 crates.io 上**；workspace 版本号是 `0.0.0`，全部用 `version.workspace = true` 内部继承 | **假设不成立**，须改为 git rev 依赖 / 受控 vendor。见第二节 |
| 2 | 拿 `network-proxy` | 依赖闭包只有 3 个 `codex-utils-*`，**不含 core、不含 otel** | ✅ 干净，直接拿 |
| 3 | 拿 `execpolicy` | 闭包 1 个 util。基于 Starlark 的前缀规则 | ✅ 干净，直接拿 |
| 4 | 拿 `sandboxing` | 闭包 **20** 个 codex crate，且**无条件**经 `codex-windows-sandbox → codex-otel` 拖进 OpenTelemetry + OTLP exporter + reqwest + tokio-tungstenite | ⚠️ 需决策，见第三节 |
| 5 | 拿 `apply-patch` | 闭包 **30** 个 crate，含 `codex-config`、`codex-model-provider-info`、`codex-exec-server` | ❌ **不划算**。它内部用的就是 `similar` crate，直接依赖 `similar` |
| 6 | 三处硬冲突 | 在本 commit 上**逐条复验通过**，见第五节 | 结论不变：不能当主干 |

> 好消息是最重要的一条被证实了：**这些 crate 里没有一个把 `codex-core`（35 万行）拖进来。** 4.11 的整体判断成立，需要修的只是「怎么拿」。

### 依赖闭包实测数据

| crate | codex-* 闭包 | 含 core | 含 otel | 源码行数 | 判断 |
|---|:---:|:---:|:---:|---:|---|
| `codex-network-proxy` | **3** | 否 | 否 | 18,431 | ✅ 取 |
| `codex-execpolicy` | **1** | 否 | 否 | 2,012 | ✅ 取 |
| `codex-file-watcher` | **0** | 否 | 否 | — | ✅ 取（4.3 加分项） |
| `codex-sandboxing` | 20 | 否 | **是** | 8,662 | ⚠️ 第三节 |
| `codex-apply-patch` | 30 | 否 | 是 | — | ❌ 弃 |
| `codex-secrets` | 18 | 否 | 否 | — | ⏸ POC 不用，自己写 keychain |

复现命令见本文末尾附录。**这张表应当在每次同步上游后重跑**——闭包变大是「借错层」的早期信号。

---

## 二、同步机制：pin 住 rev 的 git 依赖

四个 crate 不在 crates.io，但 cargo 支持直接依赖 git 仓库中的 workspace 成员：

```toml
# evowork/Cargo.toml  [workspace.dependencies]
codex-network-proxy = { git = "https://github.com/openai/codex.git", rev = "c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3" }
codex-execpolicy    = { git = "https://github.com/openai/codex.git", rev = "c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3" }
codex-file-watcher  = { git = "https://github.com/openai/codex.git", rev = "c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3" }
```

**三条硬约束：**

| # | 约束 | 为什么 |
|:-:|---|---|
| 1 | **只 pin `rev`，永不用 `branch = "main"`** | 上游高速改动。用 branch 等于每次 `cargo update` 都换一次沙箱实现，且换在什么时候你不知道 |
| 2 | **`Cargo.lock` 进版本库** | daemon 是要交付到客户机器上的二进制，构建必须可复现 |
| 3 | **升级 rev 是一次独立 PR**，不夹带业务改动，且必须跑完整 CI（含回放自校验） | 沙箱与出口代理的行为变化不会在业务测试里暴露 |

### 工具链约束

上游 `rust-toolchain.toml` 为 **1.95.0 / edition 2024**。我们的 workspace 必须 ≥ 此版本，`rust-toolchain.toml` 里显式写死，不要用 `stable`。

`codex-network-proxy` 用 `=0.3.0-alpha.4` 精确锁定了整套 `rama-*`。我们自己不要再引入 rama，否则版本冲突无解。

### 升级节奏

POC 期**不跟随上游**。定在 M1 开始时的那个 rev，一直用到 POC 结束。

理由：这两个组件的行为直接支撑演示时刻 1（数据没走）。POC 期间换实现，等于把一个已验证过的承诺重新变成未验证的。上游的新功能对我们没有价值——我们要的是「一个不会漏出口的代理」，它已经是了。

---

## 三、`codex-sandboxing` 的取舍（唯一需要拍板的一处）

**问题**：`codex-sandboxing` 无条件依赖 `codex-windows-sandbox`（不是 `cfg(windows)` 门控），后者又无条件依赖 `codex-otel`。于是在 macOS 上依赖它，会把这些编进 daemon 二进制：

```
codex-sandboxing → codex-windows-sandbox → codex-otel → opentelemetry-otlp (grpc-tonic + http)
                                                      → reqwest (blocking)
                                                      → tokio-tungstenite
                                                      → codex-api → codex-client / codex-websocket-client
```

即使我们从不初始化它，**依赖清单里会有一个遥测上报库**。对一个正在评估「财务明细会不会出内网」的客户，这是一段不必要的对话——POC 文档 4.11 末尾那条警告（「codex 默认带 OTEL、analytics，否则演示时刻 1 当场翻车」）在这里以更轻的形式回来了。

**三个选项：**

| | 做法 | 成本 | 依赖树 | 风险 |
|:-:|---|---|:---:|---|
| A | 直接依赖 `codex-sandboxing` | 最低 | 20 个 crate，含 OTel | 安全评审要解释；二进制变大 |
| B | **受控 vendor macOS 子集** | 约 2 人日 | 干净 | 需要一套同步纪律，见下 |
| C | 自己写 `sandbox-exec` 包装 | 3–5 人日 | 最干净 | seatbelt 策略写错不会报错，只会静默放行——这正是最贵最容易做错的一块 |

**已定：B。** macOS 那部分的边界很清楚：

```
seatbelt.rs            1,043 行   ┐
policy_transforms.rs     567 行   ├ 实现 ≈ 2,000 行
violation.rs             297 行   │
spawn.rs                 131 行   ┘
seatbelt_base_policy.sbpl / network_policy / preferences / restricted_read_only_platform_defaults
seatbelt_tests.rs      2,681 行   ┐
policy_transforms_tests  1,158 行 ├ 测试 ≈ 4,100 行  ← 最值钱的部分
violation_tests.rs       237 行   ┘
```

**测试比实现值钱**：seatbelt profile 的正确性无法靠 review 保证，写错了不报错、只会静默放行。这 4,100 行测试正是选项 C 拿不到的东西，也是「不要自研三平台沙箱」那条建议的真正内容。

### vendor 的纪律（不守就变成 fork）

POC 文档 4.11⑤ 划的线是「crate 级依赖，不是 fork 级」。受控 vendor 介于两者之间，要用规则把它按在正确的一侧：

| # | 规则 |
|:-:|---|
| 1 | vendor 内容放 `crates/evo-exec-local/vendor/codex-seatbelt/`，**目录内不做任何修改**——需要适配就在外面包一层 |
| 2 | 目录里放 `UPSTREAM` 文件，记录来源 repo、rev、路径、同步日期、Apache-2.0 声明 |
| 3 | 附 `scripts/sync-codex-vendor.sh`，同步是一条命令，不是手工拷贝 |
| 4 | **改了 vendor 目录就是借错了层**，CI 检查 vendor 目录与上游对应文件逐字节一致 |
| 5 | 上游测试一并 vendor 并纳入我们的 CI |

第 4 条是这条路径与 fork 的分界线，排期紧张时最容易被越过——和 4.11⑤ 那句警告是同一条。

> **Q-21 已定：daemon 宿主就是财务那台台式 Mac mini（macOS）**，「退回 Windows daemon」这条备选不在 POC 关键路径上，B 的成立不再有前提。

### 产品期 Windows 路径（不进 POC，但结论现在记下来）

POC 只做 macOS 是对的，但 **Windows 客户端是产品期的既定项，不是换客户才碰的东西**。它在本架构里其实是两件事，价钱差一个量级：

| | 是什么 | 成本 | 何时需要 |
|---|---|---|---|
| **Windows 壳** | Tauri 出 Windows 目标 + `platform` 接口的第二个实现 | **人周级** | 组织版形态就够用——daemon 在服务器，Windows 上只跑 UI |
| **Windows daemon + 沙箱** | AppContainer、Windows Service 安装形态、第二套策略语义 | **人月级** | 只有单机桌面版才需要 |

顺序上第一件可以先走：Windows 用户连组织内 Runner，当天可用，不必等沙箱那一大块。**这把「支持 Windows」从一个人月级门槛拆成了一个人周级台阶。**

**A / B 的取舍到 Windows 会翻转。** 本节选 B 的理由是「在 macOS 上依赖 `codex-sandboxing` 会白白拖进 OTel」——**而那条 OTel 链正是从 `codex-windows-sandbox` 自己身上长出来的**，到了 Windows 这个躲法不存在：

| | 到 Windows 之后 |
|---|---|
| 继续走 B | 要 vendor 2.1 万行，且 OTel 大概率就在 `audit` 那部分里。要么改 vendor 目录（违反上面的规则 1 / 4，那就是借错层），要么切一个远比 macOS 那 2,000 行难划的子集 |
| **切回 A** | 直接依赖 `codex-sandboxing` 全套，接受依赖树里有 OTel |

**建议届时整体切回 A，而不是再 vendor 第二个子集**，三条理由：

1. **B 的理由是 POC 专属的。** 「对一个正在评估财务明细会不会出内网的客户，这是一段不必要的对话」说的是**演示现场**。产品期有 forward proxy 当场证明它出不去、有出口日志当证据、有时间做审计文档——同一个事实，答起来完全不同
2. 两个平台之后，**一个依赖比「一个 vendor + 一个依赖」好维护**：同步纪律、CI 检查 6、闭包基线都要维护两份
3. 那时 **macOS 侧是否也切回 A 值得一起重估**——vendor 纪律的性价比在两平台之后是下降的

**三件借了 crate 也躲不掉的事：**

| # | 事 | 说明 |
|:-:|---|---|
| 1 | **策略映射** | AppContainer 是另一套模型（capability SID + ACL），与 seatbelt 的路径式策略语言不同。[05 §3](05-execution-plane.md) 那张策略表要在另一种原语上重新表达一遍。**crate 给的是机制，映射是我们自己的**——「静默放行」的风险住在这里 |
| 2 | **测试覆盖未实测** | 本节对 macOS 子集实测过：实现 2,000 行、测试 4,100 行，并据此判断「测试比实现值钱」。**`windows-sandbox-rs` 的测试覆盖没有实测过。** 产品期第一个动作应当是复验这一条——若它测试很薄，「借 codex 更容易」这个结论要打折 |
| 3 | **rev 漂移与 rama 锁定** | POC 期 rev 冻结（Q-20c），做 Windows 时上游已跑远，bump rev 要连带重验 macOS 子集。更麻烦的是 `codex-network-proxy` 用 `=0.3.0-alpha.4` 精确锁死整套 `rama-*`——bump 时 rama 若动，出口代理那条要一起动 |

**codex 一样都不给的三样**：Windows Service 安装形态（SCM 注册、服务账户、断电自启）、**代码签名证书**（OV/EV，私钥须放硬件令牌或云签名服务；新 OV 证书在 SmartScreen 上仍会弹警告直到攒够信誉）、WebView2 Runtime 分发。这三样是安装工程，**第二样的 lead time 比写代码长**——与 POC 文档 4.10② 的 Apple Developer 账号是同一类问题，同样要提前启动。

> 一句话：**沙箱本身借 codex 几乎肯定值；难的不是那 2.1 万行，是策略映射与安装工程。** 而「用 codex 就容易了」成立的前提，是它的 Windows 测试和 macOS 一样厚——那一条现在还没实测，**别当成已知**。

---

## 四、最终复用清单

| 我们的模块 | 复用 | 形态 |
|---|---|---|
| `evo-exec-local` 出口管控 | `codex-network-proxy` | git rev 依赖。它只有 lib，我们写一个 ~50 行的 bin 包装，作为独立子进程起 |
| `evo-exec-local` 沙箱 | codex seatbelt 子集 | 受控 vendor（第三节 B） |
| `evo-policy` 命令口径 | `codex-execpolicy` | git rev 依赖，作为 `PolicyHook` 的一个实现挂进去 |
| 触发器·文件变更 | `codex-file-watcher` | git rev 依赖。4.3 加分项，M3 有余力再接 |
| 产物 diff | **`similar`**（不是 `codex-apply-patch`） | 普通 crates.io 依赖 |
| 密钥 | 自己写 | POC 期本地 keychain 最简实现，比拉 18 个 crate 划算 |

**不拿**（与 4.11 一致，本次实测未改变判断）：`core`、`rollout`/`history`、`tui`、`app-server-protocol`、`login`/`chatgpt`/`backend-client`/`analytics`/`otel`。

### 合规

产品分发物需保留 Apache-2.0 LICENSE 与 NOTICE，列明 vendor 与 git 依赖的来源与 rev。这条进 CI（构建产物里没有 NOTICE 就 fail）。

客户安全评审问「是不是套了 OpenAI 的壳」时的答法：**沙箱与出口代理复用了 Apache-2.0 开源组件，Agent 内核、任务状态、审计与治理全部自研**——依赖树可以当场打印，这是选 B 而不是 A 的另一个收益。

---

## 五、三处硬冲突：本 commit 复验

4.11② 的三条在 `c6bf330` 上逐条复验，**全部仍然成立**。这一节的价值是：如果哪天有人提议「要不还是 fork 吧」，这里有可复现的证据。

| # | 冲突 | 本次复验 |
|:-:|---|---|
| 1 | 模型只剩 Responses API | `model-provider-info/src/lib.rs:64` 的 `enum WireApi` **只有 `Responses` 一个变体**且是 `#[default]`；`config/.../codex.thread_config.v1.rs` 的 proto 枚举同样只有 `Unspecified` / `Responses` |
| 2 | `rollout` 是会话转录不是 Run Log | `history/src/lib.rs:101` 的 `RolloutItem` 仍含 `Compacted` 变体（压缩历史，与「审计原件」直接冲突）；且已新增 `InterAgentCommunication*` 等会话概念，与 Run Log 的走向越差越远 |
| 3 | 扩展点是观察者不是拦截器 | `ext/extension-api/src/contributors/tool_lifecycle.rs:19`：`ToolLifecycleFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>` —— **返回 `()`，能看不能改**。Effect Gateway 建不上去 |
| 补 | 全仓无调度器 | 仓库内无 cron / scheduler crate。A 类第 8 项（定时触发）确定自建 |

---

## 六、待确认

| # | 问题 | 谁定 | 建议 |
|:-:|---|:---:|---|
| Q-20 | ~~codex crate 能否 crate 级依赖~~ | — | **已实测：不在 crates.io，改用 pin rev 的 git 依赖** |
| ~~Q-20a~~ | ~~`codex-sandboxing` 取 A 还是 B~~ | — | **已定：B，vendor macOS 子集**。约 2 人日，换来干净的依赖树与可当场打印的安全评审材料 |
| ~~Q-20b~~ | ~~vendor 同步纪律是否写进 CI~~ | — | **已定：是**（[00 §4](00-index.md) 检查 6） |
| ~~Q-20c~~ | ~~上游 rev 在 POC 期是否冻结~~ | — | **已定：冻结**。理由见第二节 |

---

## 附：复现命令

```bash
git clone --depth 1 --filter=blob:none https://github.com/openai/codex.git
cd codex && git rev-parse HEAD          # 应为本文 pin 的 rev
cd codex-rs

# 1. 确认目标 crate 不在 crates.io
for c in codex-network-proxy codex-sandboxing codex-execpolicy codex-apply-patch; do
  curl -s "https://crates.io/api/v1/crates/$c" | grep -q '"crate"' && echo "$c PUBLISHED" || echo "$c NOT PUBLISHED"
done

# 2. 依赖闭包
python3 <evowork>/scripts/codex-closure.py <codex>/codex-rs \
  codex-network-proxy codex-execpolicy codex-sandboxing codex-apply-patch

# 3. 复验三处冲突
grep -n "enum WireApi" -A5 model-provider-info/src/lib.rs
grep -n "enum RolloutItem" -A12 history/src/lib.rs
grep -n "ToolLifecycleFuture" ext/extension-api/src/contributors/tool_lifecycle.rs
```

`scripts/codex-closure.py` 已在仓库中，输出即本文第一节的表。把它挂进「升级 rev」那条 CI——**闭包变大是借错层的早期信号**。
