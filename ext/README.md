# ext —— Rust 扩展 crate（extension-api contributor，L2）

**这是 K3 优先级里最后一档**：能用技能包表达就别写 MCP，能用 MCP 就别写 hooks，
能用 hooks 就别写 Rust。只有**需要内核内部状态或事件流**时才落到这里。

接口：`../codex/codex-rs/ext/extension-api/src/lib.rs`。已有扩展的写法参考
`../codex/codex-rs/ext/{goal,memories,guardian-v2,image-generation,web-search}/` ——
这是内核自身功能走的正规接口，稳定性远高于 `core` 内部 API（D1）。

**当前设计里唯一确定要写 Rust 的一件事**：D8 的「Ask 模式在 `ToolContributor` 层过滤写工具」。
沙箱已经能挡住写操作，但只靠沙箱会让模型反复尝试再失败（体验问题），所以要在工具层就不给它。
注意这是 `ext/` 扩展，**不是补丁** —— 它不占 K1 的预算。
