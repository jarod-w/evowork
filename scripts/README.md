# scripts —— 仓库脚本

| 脚本                                                         | 用途                                                            | 谁在跑                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`kernel-drift.mjs`](kernel-drift.mjs)                       | 上游漂移雷达：提交量与影响面 · **F1–F16 断言复核** · 补丁试合并 | 每日 job（`.github/workflows/kernel-drift.yml`）+ 每个 PR + 本地   |
| [`kernel-assertions.json`](kernel-assertions.json)           | F1–F16 的**机器可读孪生体**                                     | 上面那个脚本读它                                                   |
| [`kernel-contract.mjs`](kernel-contract.mjs)                 | K2 协议形状自检：我们发的 JSON 对不对得上内核真正接受的形状     | **`pnpm run check`** + CI                                          |
| [`patch-budget.mjs`](patch-budget.mjs)                       | K1 补丁预算自检（≤5 文件 / ≤500 行 + 说明文件）                 | CI                                                                 |
| [`gen-third-party-notices.mjs`](gen-third-party-notices.mjs) | 生成 / 校验 `THIRD_PARTY_NOTICES.md`（K5）                      | CI + 依赖变更时                                                    |
| [`verify-provider.mjs`](verify-provider.mjs)                 | 用**真实 endpoint** 核对一家 provider 的流式语义（U2）          | 拿到某家 key 之后跑一次；**不进 `pnpm run check`**（要网络、要钱） |

## 为什么形状要机器比对，而不是靠断言

`kernel-assertions.json` 守的是「**我们已经知道要看的东西**还在不在」—— needle 式：
某个字符串是否仍存在于某个内核文件里。它拦不住「内核新加了一个必填字段」
或者「某个枚举换了拼法」，因为没人会为一个还不知道存在的字段写断言。

2026-09-26 那次排查里，同一类缺陷有 **13 处**，`kernel-assertions.json` **一条都发现不了**：

| 症状                                | 用户看到的                                              |
| ----------------------------------- | ------------------------------------------------------- |
| `turn/interrupt` 漏 `turnId`        | 「停止」按钮从来没成功过一次，弹窗里只有一个裸 `-32600` |
| `thread/list` 的 `sortKey` 写成驼峰 | 一致性校正每十分钟失败一次，**而且没有任何日志**        |
| 权限审批回错形状                    | 点「允许」和点「拒绝」授予的东西一样多：都是零          |

前两种是 -32600；第三种更坏 —— 内核**根本不报错**，`unwrap_or_else` 兜个默认值继续跑。

所以 `kernel-contract.mjs` 换一条路：**直接读内核的 Rust 结构体**，按
`Option<>` / `#[serde(default)]` / `rename_all` / `rename` 算出每个字段在线上
是否必填、叫什么名字，再和我们声明的形状逐条对。它不依赖任何我们手写的镜像，
所以不会过期 —— 上游改字段名的那一刻，`pnpm run check` 就红。

形状写在脚本里的 `OUTGOING` / `INCOMING` / `REPLIES` 三张表，而不是从 TS 里正则抠 ——
**会误报的检查最后一定被关掉**。表和代码脱节由 `checkCoverage()` 兜：
新增一个调用点却不登记，检查就失败。

## 为什么断言要有机器孪生体

CLAUDE.md §1 要求「凡是设计文档里带 `path:line` 的断言，动手前都要重新核对」。这条纪律
在 237 个提交的漂移量下必然失效 —— 不是因为人不守规矩，而是因为没人每天做这件事。

所以把它变成 CI 的活：`kernel-assertions.json` 是 `docs/design/README.md §4` 的孪生体，
改一边必须改另一边。脚本区分三种结果：

- **OK** —— 断言成立且行号未变
- **LINE-MOVED** —— 断言成立、行号漂了（**常态，不算失败**，只提示更新文档）
- **BROKEN** —— needle 消失、枚举变体数变化、或 `mustNotHave` 的字段出现了。
  这意味着**设计文档里的某条判断可能已被上游推翻**，每日 job 会开 issue。

BROKEN 不总是坏消息：比如 `thread/list` 哪天真加了状态过滤参数，F8 会 BROKEN，
而结论是我们可以**删掉**一部分自建投影逻辑。

## `verify-provider.mjs` 的两条纪律

1. **只打印形状，不打印正文。** 它不是网关，但如果它把响应正文打到终端再被贴进 issue，
   Q14 的「不落盘正文」就等于没有。唯一的例外是错误 `code` —— 那本来就是我们要映射的枚举值。
2. **断言写的是"与能力表一致"，不是"我以为的样子"。** 第一版写成"非推理型号不吐
   `reasoning_content`"，对 `deepseek-v4-flash` 报了红 —— 而那不是缺陷，是那个名字带 flash
   的模型确实会推理。判据应当是能力表与上游是否一致，因为不一致才会让翻译层丢东西。

```bash
EVOWORK_PROBE_KEY=... node scripts/verify-provider.mjs \
  --base https://api.deepseek.com --model deepseek-v4-flash --reasoning true
```
