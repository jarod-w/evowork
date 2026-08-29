# 09 · 模型面：可插拔、能力声明与定价

> **Q-01 已定：模型供应商可配置。** 本文定它落到什么接口上。
>
> 技术路线取舍④那句话是本文的前提：
>
> > **多模型可插拔（P0）的真实成本在评测，不在 adapter。** 写 adapter 是几天的工作。真正的成本是：没有回归评测集，换模型就是碰运气，且退化会延迟数周才暴露在用户投诉里。

---

## 一、「可配置」settle 了什么，没 settle 什么

| | 状态 |
|---|---|
| ✅ 不绑定单一供应商，adapter 层统一 | 本文第二节 |
| ✅ M1 不需要知道用哪家 | Run Log / Gateway / 内核与模型无关 |
| ❌ **POC 现场用哪一家** | 演示时刻 1 要指名道姓，见 **Q-01b** |
| ❌ **财务摘要出内网 / 出境的口径** | 准入问题，不是技术问题 |
| ❌ 多家 = 多张定价表 + 汇率 | 第三节 |
| ❌ 多家之间怎么比较 | 第四节。**这是取舍④说的那个真实成本** |

> 一句话：可配置解决的是「将来能不能换」，没解决「现在用谁、客户认不认」。后者是 M2 开始前必须有答案的。

---

## 二、接口

```rust
#[async_trait]
pub trait ModelProvider: Send + Sync {
    fn id(&self) -> ProviderId;
    fn capabilities(&self, model: &ModelId) -> ModelCapabilities;
    async fn complete(&self, req: ModelRequest) -> Result<ModelResponse>;
}
```

**能力必须显式声明，不能靠试。** 技术路线第八节：「各处直接调 SDK ← 不建议；能力差异不显式声明，降级策略无从实现。」

```rust
pub struct ModelCapabilities {
    pub context_window: u32,
    pub max_output: u32,
    pub tool_calling: ToolCalling,      // None | Native | JsonMode
    pub parallel_tool_calls: bool,
    pub structured_output: bool,        // 见下
    pub vision: bool,
    pub cache: CacheSupport,            // 影响 cost.charged 的 unit 维度
}
```

`structured_output` 不是学术字段，它直接连着一个 P0 机制：[04 §3](04-context-memory.md) 的 cite 校验要求模型输出 `{ value, cite_ids: [...] }`。供应商不支持可靠的结构化输出时，`CiteChecker` 的拦截率会升高 → 需要重试策略。**能力声明的用途就是让这种降级是设计出来的，不是线上撞出来的。**

adapter 之外的一切不感知供应商：`model.requested` / `model.responded` 事件的字段（[01 §4.3](01-run-log.md)）对所有供应商一致，`provider` 只是其中一个字段。

---

## 三、定价表

`cost.charged` 需要 `unit_price_micros`，而 4.11② 已实测：**codex 的 `TokenUsage` 只有 token 数，金额来自 OpenAI 后端**——换任何供应商都拿不到。所以定价表必须是我们自己的。

```toml
# config/pricing.toml
version = "2026-08-a"        # 进 cost.charged.price_table_ver，改价不改历史账

[[price]]
provider = "…"; model = "…"
input_per_mtok_micros      = 0
output_per_mtok_micros     = 0
cache_read_per_mtok_micros = 0
currency = "CNY"             # 或 "USD"
```

**汇率的处理**：`cost.charged` 记**原币**（schema 已有 `currency` 字段），折算放在查询层，汇率单独版本化。这样改汇率不动历史事件——与「事件只增不改」是同一条原则。

> 客户看 token 还是看人民币、汇率多久更新一次，是 **Q-05**。但它不影响上面的结构。

---

## 四、与 eval 的挂钩（判据 5 的实现）

> 判据 5：换一个模型供应商，评测集给出**可比较的分数**。

实现上不需要新造东西：

```
eval/cases/2026-05/case.yaml   记录 provider / model / pricing version
        ↓
run.fork（06 §3）从冻结快照重跑，只换 provider
        ↓
确定性层逐条 diff + 成本层对比
```

这正是 4.7 那条设计约束的收益：**最小 eval 不是新子系统，是给 Run Log 加一个导出与重放入口。** 换供应商的评测，用的是同一个入口。

**一条要提前想清楚的**：4.7 的确定性层要求 **100%，差一分钱算失败**。所以「可配置」的实际含义不是「随便换」，而是：

> 只有**跑过确定性层全集且 100% 通过**的供应商，才进入可选列表。

这条建议写进 `config/pricing.toml` 旁边的 `providers.toml`——每个供应商带一个 `verified_at` 与通过的用例集版本。否则「可插拔」会变成「可以配置到一个不能用的状态」，而这种事故的暴露时间是数周。

---

## 五、本客户的供应商（Q-01b / Q-01c 已定）

| | 供应商 | 用途 | 进客户出口白名单？ |
|---|---|---|:---:|
| 交付 | **DeepSeek** `deepseek-v4-flash-0731` | POC 现场唯一使用 | **是**（唯一一条） |
| 开发 | **OpenAI GPT** | 开发期对照、验抽象、eval 可比性 | **否** |

**这条区分是硬约束，不是习惯**：客户只与 DeepSeek 签了不做训练的协议（Q-01e 据此放开了明细出内网，见 [04 §3](04-context-memory.md)）。GPT 是开发期供应商，**交付到客户机器上的部署里，出口白名单只有 DeepSeek 一条**——[05 §4](05-execution-plane.md) 的 allowlist 就是这条约束的执行机制，不需要额外代码。

> 演示时刻 1 打开出口日志时，若出现第二个模型域名，当场就是事故。把它交给 allowlist 而不是交给纪律。

### 必须从官方文档填、不能假设的字段

`deepseek-v4-flash-0731` 与 GPT 的这几项**逐项查官方文档填入，并用探针用例实测验证**：

| 字段 | 为什么不能猜 |
|---|---|
| `context_window` / `max_output` | 决定账龄任务要不要分批与压缩 |
| `tool_calling` | 决定 Agent 循环能不能成立 |
| `structured_output` | 直接决定 [04 §4](04-context-memory.md) cite 校验的拦截率 |
| `parallel_tool_calls` / `cache` | 后者影响 `cost.charged` 的 unit 维度 |
| 单价（输入 / 输出 / 缓存命中） | 定价表，见第三节。DeepSeek 计价为 CNY，GPT 为 USD——**两种币种同时存在，正好验证第三节「记原币、折算放查询层」是否做对了** |

**探针用例**：M1 第一周写一组极小的用例，实测这五项而不是照抄文档——文档与实际不符是常态，尤其是 `structured_output` 与并行工具调用。结果写进 `providers.toml` 的 `verified_at`。

### 一个要当心的地方：这两家可能验不出抽象

选一海外一国内的理由是「能力与计费差异越大，抽象越经得起用」（第六节）。但 **DeepSeek 的 API 基本是 OpenAI Chat Completions 兼容的**——如果 GPT 那一侧也走 Chat Completions，两个 adapter 会长得几乎一样，抽象等于没被压过。

**建议：GPT 侧走 Responses API，DeepSeek 侧走 Chat Completions。** 让两个 adapter 在 wire 形态上真的不同，抽象才被验到。成本是多花半天，收益是真的知道抽象漏没漏。

> 顺带一提，[08 §5](08-codex-integration.md) 实测过 codex 的 `WireApi` 现在只剩 `Responses` 一个变体——那是他们收窄接口的结果，恰好说明这两种 wire 形态在真实世界里是会分道扬镳的，不是同一件事的两种写法。

---

## 六、M1 接两家的理由（备查）

**理由不是备份，是抽象正确性。** 只接一家，adapter 层一定会长成那一家的形状——tool call 的封装、`stop_reason` 的语义、cache 的计费单位、结构化输出的开关方式，每一处都会不自觉地按那一家写。等真要换的时候才发现抽象漏了，那时调用点已经铺开。

接第二家的成本在 M1 是最低的（约 1–2 人日），此后单调上升。一家海外、一家国内——**能力与计费差异越大，抽象越经得起用**。（Q-01c 已定：DeepSeek + GPT，见第五节的当心事项。）

两家中只有 DeepSeek 进交付形态，GPT 是开发期供应商——见第五节。

---

## 七、待确认

| # | 问题 | 谁定 | 何时 |
|:-:|---|:---:|---|
| ~~Q-01~~ | ~~模型供应商是否绑定~~ | — | **已定：可配置**，本文即其落地 |
| ~~Q-01b~~ | ~~POC 现场用哪一家~~ | — | **已定：DeepSeek `deepseek-v4-flash-0731`**，客户已与上游签不做训练协议。见第五节 |
| ~~Q-01e~~ | ~~财务明细进模型上下文的边界~~ | — | **已定：可出内网，只要上游不用于训练**。装配器策略配为 `DetailEgress::Allow`（[04 §3](04-context-memory.md)），产品默认仍是 `Minimize` |
| Q-01f | 协议里的**日志留存期与访问控制**条款 | 客户 | 「不做训练」通常不覆盖服务端日志留存。合规审计时会被问，值得核一眼——不阻塞开发 |
| Q-05 | 成本对客户呈现口径与汇率来源 | 客户 | M3 |
| ~~Q-01c~~ | ~~M1 接哪两家~~ | — | **已定：DeepSeek + GPT** |
| Q-01d | GPT 侧走 Responses 还是 Chat Completions | 团队 | **Responses**，否则两个 adapter 太像，抽象验不到 |
