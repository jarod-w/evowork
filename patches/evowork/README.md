# patches/evowork —— 对内核的补丁（K1）

**硬上限：≤ 5 个文件、≤ 500 行。** `pnpm run check:kernel-budget`（`scripts/patch-budget.mjs`）
在每次 CI 上算这笔账。

**当前清单：1 个补丁、2 个文件。**

| 补丁 | 总纲 | 内容 |
| ---- | ---- | ---- |
| `0001-exec-overwrite-approval` | §7 P6 | shell 命令截断写一个已存在的文件时要审批（外部验收 D1-2，2026-10-01 用户批准） |

**怎么编进去**：`node scripts/build-kernel.mjs` 把 `../codex` 的 HEAD 导出到 `build/.kernel-src/`、
按文件名顺序打这里的补丁、编 `codex-app-server`，产物与来源说明（`KERNEL_PROVENANCE.json`）放进
`build/kernel/<平台>/`。`../codex` 本身不动。`--check` 只试打补丁，上游 rebase 后先跑它。

**打包与 E2E 只认这样编出来的内核**：它们核对 `KERNEL_PROVENANCE.json`（`scripts/kernel-provenance.mjs`），
没有来源文件、二进制被换过、补丁改了没重编，都直接报错。

总纲 §7 在 P6 之前判定真正需要的补丁只剩 **P4（对外可见品牌字符串）** 一项（仍未落地）：

- ~~P1 连接器 base url~~ → 环境变量绕过，无需改码
- ~~P2 注册 provider~~ → `config.toml` 的 `model_providers` 绕过
- ~~P3 `ask.md` 模式模板~~ → **F1 实测后删除**：`turn/start.collaborationMode.settings.developer_instructions` 纯配置可实现
- **P4 品牌字符串** → 需改（只改对外可见的；内部路径名如 `CODEX_HOME` 保持不动，减少补丁面）。
  **智能体自称「Codex CLI」不是 P4**：走 `thread/start.baseInstructions`（F25），不打补丁。
- ~~P5 遥测端点~~ → 走配置

**加补丁的前置条件**（D7 / K1，脚本会检查）：

1. 同名 `.md` 说明文件，其中必须有「**为什么扩展点做不到**」一节，且要对四个扩展点
   （技能 / MCP / hooks / extension-api）**逐一说明**。"上游没提供"不算理由。
2. 先在 `docs/` 里改架构，再动补丁（CLAUDE.md §9）。

代价提醒：违反 K1 的代价不是"代码丑"，是**每次上游 rebase 都要重付一遍**。
上游速度参考：总纲 v0.1 基线至今 237 个提交。
