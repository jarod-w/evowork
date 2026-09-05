# plugins —— 随产品分发的扩展包（L2）

| 目录                         | 内容                                                                      | 里程碑 |
| ---------------------------- | ------------------------------------------------------------------------- | ------ |
| [`skills/`](skills/)         | 四个办公产物技能：documents / spreadsheets / presentations / charts       | M3     |
| [`agents/`](agents/)         | 专家角色 `*.toml`（`agent-roles` 格式 + EvoWork 的 `[interface]` 展示段） | M7     |
| [`connectors/`](connectors/) | MCP server 集合。**本期只做 `browser/`**（Q9）                            | M6     |
| [`hooks/`](hooks/)           | 策略包：审计 · 配额 · 合规                                                | M4     |

**技能格式零改动**（总纲 §6.3）：`SKILL.md` + frontmatter，沿用内核的加载机制与三个根目录。

**产物技能的核心设计是结构化生成**（08 §5.3，R4 的主要缓解手段）：模型输出的不是 pptx、
也不是 python 代码，而是一份受 JSON Schema 约束的**内容 JSON**；排版、字号、留白、配色由
`render.py` 按模板库完成。理由：轻量档模型（GLM-5.3-flash）在"写 python-pptx 代码"上失败率高，
在"填受约束的 JSON"上可靠得多。这条同时降低了对模型的要求与产物的方差。
