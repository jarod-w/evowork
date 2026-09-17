# @evowork/tokens —— 01 的 design token（M2）

[01 §2](../../docs/design/01-ui-design-system.md) 是**数值真源**，这个包是它的代码形态
（CSS 变量 + TS 常量）。01 的浅色中性层与语义色自 2026-09-16 起对齐
[`plugins/skills/ui-design`](../../plugins/skills/ui-design/SKILL.md) 工作台基线。
`docs/design/ui-spec.html` 是渲染面；三者不一致时以 01 为准。

**四条 token 纪律**（01 §2 / §8）：

1. 组件里不允许出现字面量颜色、字号、圆角 —— `@evowork/no-style-literals` 会拦（01 §9 验收项 1）。
2. **语义色的文字必须用 `-text` / `-strong` 变体**。不要用基色写文字——即使 `--warning` /
   `--danger` / `--info` 在当前浅色板上碰巧 ≥4.5，换底或主题后不一定还达标。`--success`
   在 `-weak` 上只有 4.18:1，`--accent` 只有 2.82:1。
3. `--text-tertiary` 只能用于非必要信息（时间戳、占位符、版本号），实测约 3.1:1，**不满足正文要求**。
4. 边框对比度在默认主题下**不达标且这是刻意取舍**（01 §8.3）：默认保真度优先（发丝线），
   另提供高对比模式覆盖三个 token。**不允许把默认模式的断言设成 3.0 然后放宽通过条件**。

品牌层只有四项（K5 的落点）：`--accent` 系列 + `appName` + `logo` + `mascot`。焦点蓝不属于品牌四项。
换品牌只改这四项，布局零改动 —— Q25 已定代码与文档统一落 **EvoWork**。
