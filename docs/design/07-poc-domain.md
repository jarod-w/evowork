# 07 · POC 域落地：用友 · 口径库 · eval

> POC 文档第四节定了这个客户要什么，本文定 schema 与目录格式。
>
> **本文描述的一切都在 `mcp-servers/` 与 `eval/` 下，`crates/` 与 `apps/` 里不得出现任何客户专有名词**（4.1 / 自检第 4 条，CI 检查见 [00 §4](00-index.md)）。

---

## 一、语义接口（先定它，不押版本）

4.2 的判断：版本未确认时，正确做法不是猜一个版本，而是让猜错不产生代价。上层 Agent、口径库、报表模板、评测集全部依赖下面这四个 tool 的**出参 schema**，版本差异关在 MCP Server 内部。

```jsonc
// list_receivables(period: "YYYY-MM") -> Receivable[]
{
  "customer_code": "C0012", "customer_name": "…",
  "doc_no": "XSFP-2026-0473",           // 单据号，溯源锚点
  "doc_date": "2026-05-08",             // 单据日期
  "due_date": "2026-08-06",             // 到期日
  "currency": "CNY", "amount_orig": "128000.00",
  "amount_local": "128000.00",          // 本币
  "received": "40000.00", "balance": "88000.00",
  "salesperson": "…", "source_ref": "…" // 回指用友的定位信息，供 cite 用
}

// list_customers() -> Customer[]
{ "code", "name", "category", "agreed_terms_days", "salesperson" }

// list_settlements(period) -> Settlement[]
{ "customer_code", "doc_no", "settle_date", "amount", "against_doc_no" }

// get_period_summary(period) -> PeriodSummary
{ "period", "total_receivable", "doc_count", "customer_count" }   // ← 评测的对账锚点
```

**三条不可让步：**

1. **金额一律用十进制字符串，不用浮点。** 财务客户，`4.7` 的确定性层要求「差一分钱算失败」。JSON number 是 double，`0.1+0.2` 问题会在某个月的某张表上出现一次，然后信任就没了
2. **每条记录都带 `doc_no` 与 `source_ref`**，这是 A 类第 13 项溯源的落点，不是可选字段
3. **`get_period_summary` 是对账锚点**：它与 `list_receivables` 求和必须逐项相等，这是 eval 确定性层的第一条断言

### 取数必须冻结

用友里的历史单据会被红冲、调整、期末结转。**取一次即落盘冻结**，评测只跑在冻结快照上（4.2 / 4.7 约束②）。

冻结快照 = 一次 `run` 的产物：四个 tool 的原始返回 + 取数时刻 + 用友版本标识，content-addressed 存进 blob store。**它天然就是 Run Log 的一部分，不是另一套存储。**

---

## 二、MCP Server 的 manifest

产品侧要能对用友的每个方法做治理，靠 [02 §4](02-effect-gateway.md) 的 manifest：

```toml
# mcp-servers/yonyou/manifest.toml —— 由 daemon 加载，不在产品代码里
[[method]]
name = "list_receivables"
class = "read"
egress = [{ host = "yonyou.internal", port = 8080 }]

[[method]]
name = "create_voucher"          # 4.4② 的 dry-run 演示对象，POC 期不真写
class = "write"
reversible = false
risk = "L3"
targets = [{ from_param = "/entries", kind = "erp_voucher", op = "create" }]
preview = "create_voucher_preview"    # ← 演示时刻 2 的全部技术含量就在这一行
```

`create_voucher_preview` 返回将写入的凭证清单、科目、金额、影响期间。**产品主干对此零特化**——从 Gateway 看，这只是「一个第三方工具声明了 preview」。

POC 期只申请只读账号，`create_voucher` 在 server 里实现为「preview 可用，write 直接报错」。这样演示时刻 2 完全真实，且零风险。

---

## 三、口径库格式

A 类第 11 项。**唯一不会被模型吞掉的知识资产**，也是 POC 成败常常唯一取决于的一项。

```
workspaces/finance/rules/
├── meta.yaml              # version, effective_from, owner, changelog
├── aging.yaml             # 账龄口径
├── customers.yaml         # 客户分类与账期
├── no-dunning.yaml        # 不催清单  ← 出现在催收清单里就是事故
├── toys.yaml              # 模具费/开模费、退货折让、认证费用归集
├── export.yaml            # 汇率折算、退税周期
├── dunning.yaml           # 话术分级、抄送规则、禁止直接发的客户
└── delivery.yaml          # 报表模板、发送对象与时点
```

```yaml
# aging.yaml
version: 3
buckets: [{ name: "0-30", from: 0, to: 30 }, { name: "31-60", from: 31, to: 60 },
          { name: "61-90", from: 61, to: 90 }, { name: "90+", from: 91, to: null }]
start_from: doc_date          # doc_date | ship_date | contract_terms
overdue_basis: due_date
notes: "外贸客户按合同账期起算，见 customers.yaml 的 override"
```

四条约束：

| # | 约束 | 为什么 |
|:-:|---|---|
| 1 | **一条口径都不进代码或提示词** | 红线 6。检验：删掉这个目录换成客户 B 的，产品一行不改 |
| 2 | 进上下文时标 `OrgTrusted`，带 `cite_id` | 报表里「按 90 天分档」这个动作本身也要能点回口径文件 |
| 3 | 有 `version`，改动进 git | 「账龄改成按合同账期」之后，怎么知道没改坏别的——靠 eval 跑一遍 |
| 4 | **财务自己能看懂能改** | 否则它就退化成又一份需要工程师维护的配置。**Q-26** |

> 获取方式仍是 4.6 那条一举两得的做法：**直接要客户过去 3–6 个月已经做完的那几张表**。人工表里隐含着全部口径，同时它就是下一节的评测真值。

---

## 四、最小 eval

4.7：本客户 eval 从「可选」变成「必须」——财务场景没有「95% 准确」这回事，一个数字错整张表作废。

**它不是评测框架，是一个用例目录 + 一个断言脚本 + 一条命令。**

```
eval/
├── cases/
│   ├── 2026-03/
│   │   ├── snapshot/          # 冻结的用友取数（四个 tool 的原始返回）
│   │   ├── truth/             # 财务当时人工做的账龄表与催收清单
│   │   ├── rules.lock         # 当时生效的口径库版本
│   │   └── case.yaml          # 输入声明 + 断言配置
│   ├── 2026-04/
│   └── 2026-05/
├── assertions/
│   ├── deterministic.py       # 确定性层
│   └── judgement.py           # 判断层
└── run.sh                     # 一条命令跑全集
```

```bash
./eval/run.sh                  # 或 UI 里的按钮（rpc: eval.run，见 06）
# → 逐条 diff + 通过率，结果写回 Run Log
```

### 三层断言

| 层 | 断言 | 目标 |
|---|---|---|
| **确定性层** | ① 应收总额 / 单据条数 / 客户数 与 `get_period_summary` **逐项相等**<br>② 账龄分档逐格比对人工表<br>③ **不催清单里的客户不得出现在催收清单** | **100%，差一分钱算失败** |
| **判断层** | 催收优先级 top10 与财务当时实际动作的重合度 | 给区间，不给绝对值 |
| **成本层** | 单次任务 token / 费用 | 有基线即可 |

### 三条设计约束（4.7 原文，逐条落到实现）

1. **用例输入从 Run Log 导出，不手写。** `run.fork` + 事件导出就是导出机制（[06 §3](06-protocol.md)）——最小 eval **不是新造子系统，是给 Run Log 加一个导出与重放入口**，天然零丢弃
2. **必须跑在冻结快照上。** 见第一节
3. **有真值就不用 LLM-as-judge。** 财务场景难得地拥有 ground truth，别浪费

工作量 2–3 人日。它看起来贵是因为通常被想象成「评测平台」。

> **Q-27 已定**：冻结快照放 **blob store**，git 里只放 `case.yaml`、`truth/` 与 `rules.lock`，快照以 `content_hash` 引用。
>
> 两条理由：几个月的用友明细进 git 会让仓库迅速变大且每次更新都是二进制 diff；更要紧的是快照本来就是某次 run 的产物（第一节），它已经在 blob store 里了——**再拷一份进 git 就是第二份权威事实**，和快照表的问题同构。

---

## 五、四件交付物

4.5 的验收物，每周一 8:00 自动产出：

| # | 交付物 | 技术要点 |
|:-:|---|---|
| 1 | 账龄表（Excel） | 每个数字带 cite（[04 §3](04-context-memory.md)）；daemon 输出 JSON，前端渲染，前端不解析 xlsx |
| 2 | 催收清单 | 不催清单校验是**确定性层断言**，不是提示词嘱托 |
| 3 | 按业务员分组的跟催任务包 | 经企业微信推送；**系统不对外发**，业务员自己联系客户 |
| 4 | 本次成本 | `cost.charged` 聚合，随出表一并推送 |

产物必须是标准格式、可导出、可脱离平台使用（功能清单非目标最后一条）。

---

## 六、待确认

| # | 问题 | 谁定 | 备注 |
|:-:|---|:---:|---|
| ~~Q-24~~ | ~~用友取数走 API 还是数据库直连~~ | — | **已定：走 API**。[05 §5](05-execution-plane.md) 的出口缺口随之关上；MCP Server 内部仍要吃掉版本差异 |
| Q-25 | 历史 3–6 个月人工成品表 + 只读账号 | 客户 | **M0 唯一的客户侧关键路径**，第一天就要开口 |
| Q-26 | 财务能否接受口径以文件形式维护并自己改 | 客户 | 不能的话口径库退化成工程师维护的配置 |
| ~~Q-27~~ | ~~冻结快照存 git 还是 blob store~~ | — | **已定：blob store + git 里放索引**，见第四节 |
| Q-28 | 账龄表版式、跟催包推个人还是业务组 | 客户 | M2 期自然浮现，届时再定 |
