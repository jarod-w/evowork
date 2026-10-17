# P7 · 首轮记忆基线保留未整理来源

2026-10-17，修复 WorkBuddy 真实模型验证的 done 后遗漏。补丁只在发货内核导出副本应用，不改上游签出。`ensure_git_baseline_repository` 唯一生产调用方为记忆工作区准备。

首次或损坏后 ensure 原来调用 reset 并提交现存 note，随后 diff 不再包含它们。改为建立空树基线；再次 ensure 保留已有基线，成功整理的 reset 仍提交当前文件树。文件和来源正文不动，扩展笔记会作为 added 进入原生带上限的 diff，后续增改删除仍按已有机制处理。不保证模型永不遗漏，也不通过改状态库或重启掩盖失败。

## 为什么扩展点做不到

- 技能：可指导模型读取文件，但无法改变在模型启动前完成的内部 Git 基线初始化；不能把内部存储写脚本作为产品路径。
- MCP：没有公开基线、强制整理或重新入队方法；直接改内部 Git/SQLite 会违反 K2。
- hooks：PostToolUse 可证实 note 写入，但不能加入记忆工作区锁、改变其基线事务或修改 done 作业的冷却状态。
- extension-api：已有正式记忆 contributor 自行调用内部 memories-write；没有注入 Git 初始树/覆盖 diff 的 contributor 回调。新 contributor 重做整理会形成第二套正文来源，不能修正现有原子步骤。

## 范围与验证

生产逻辑只改 git-utils 基线文件；同文件单测覆盖预先存在的 note、重复 ensure、成功 reset 和后续增删。记忆 workspace 测试覆盖损坏基线恢复。P6 与 P7 合并预算由 `scripts/patch-budget.mjs` 核验。构建使用 `scripts/build-kernel.mjs`，真实 Electron E2E 核对二进制来源；严禁用重启或时间老化加速整理。

历史上已经 done 且内容错误的来源不会自动绕过六小时冷却重跑；此修复修正首次/损坏基线的输入，不提供按项目遗忘或严格隔离。该限制应在验收中保留。
