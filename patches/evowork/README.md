# patches/evowork —— 对内核的补丁（K1）

**硬上限：≤ 5 个文件、≤ 500 行。** `pnpm run check:kernel-budget`（`scripts/patch-budget.mjs`）
在每次 CI 上算这笔账。

**当前清单为空。** 总纲 §7 判定真正需要的补丁只剩 **P4（对外可见品牌字符串）** 一项：

- ~~P1 连接器 base url~~ → 环境变量绕过，无需改码
- ~~P2 注册 provider~~ → `config.toml` 的 `model_providers` 绕过
- ~~P3 `ask.md` 模式模板~~ → **F1 实测后删除**：`turn/start.collaborationMode.settings.developer_instructions` 纯配置可实现
- **P4 品牌字符串** → 需改（只改对外可见的；内部路径名如 `CODEX_HOME` 保持不动，减少补丁面）
- ~~P5 遥测端点~~ → 走配置

**加补丁的前置条件**（D7 / K1，脚本会检查）：

1. 同名 `.md` 说明文件，其中必须有「**为什么扩展点做不到**」一节，且要对四个扩展点
   （技能 / MCP / hooks / extension-api）**逐一说明**。"上游没提供"不算理由。
2. 先在 `docs/` 里改架构，再动补丁（CLAUDE.md §9）。

代价提醒：违反 K1 的代价不是"代码丑"，是**每次上游 rebase 都要重付一遍**。
上游速度参考：总纲 v0.1 基线至今 237 个提交。
