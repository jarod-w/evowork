# P6 · 覆盖已有文件要审批（`0001-exec-overwrite-approval.patch`）

2026-10-01，外部验收 D1-2 复现后用户批准。总纲 §7 P6、10 §2.4。

## 改了什么

两个内核文件，只增不改：

- `codex-rs/shell-command/src/bash.rs`：新增 `parse_shell_lc_truncating_redirect_targets`，
  从 `bash -lc` / `zsh -lc` 脚本里取出**截断式输出重定向**（`>`、`>|`、`&>`）的字面目标。
  `>>` 追加、`2>&1` 这类描述符复制、`<` 读入、`$VAR` 这类动态目标都不算。附单元测试。
- `codex-rs/core/src/unified_exec/process_manager.rs`：`exec_command` 算完审批要求之后，
  若结论是「直接跑」（`Skip`，且不是用户白名单规则放行的 `bypass_sandbox`），
  而重定向目标**在工作目录下已经是一个文件**，改成「要审批」，理由是
  `overwrites an existing file: <目标>`。`never` 与关掉了 `sandbox_approval` 的 granular 不动。

理由前缀由 EvoWork 的审批卡换成中文（`services/policy/src/execpolicy.ts` 的
`OVERWRITE_REASON_PREFIX`）。两边各写一份字符串，`services/policy/test` 里有一条测试
断言补丁里的前缀与策略层的逐字相同 —— 不然改了一边，卡片就会露出英文。

## 为什么扩展点做不到

逐个扩展点说（K1 / D7：「上游没提供」不算理由）：

- **技能（SKILL.md + 脚本）**：技能是模型**可以选择**调用的能力，管不到模型直接发出的
  shell 命令。D1-2 里模型写的就是 `printf '已归档\n' > inputs/D1_notes.md`，没有经过任何技能。
- **MCP server**：同上，MCP 工具是模型可选的另一类工具；内核自带的 `exec_command`
  不经过 MCP，审批要求也不由 MCP 决定。
- **hooks**：`PreToolUse` 能看到命令，但只能放行或拒绝 —— **不能发起询问**
  （`permissionDecision: "ask"` 被内核判为无效输出，`hooks/src/engine/output_parser.rs`），
  `updatedInput` 对 shell 工具只能替换 `command` 字符串，加不了 `sandbox_permissions`
  （`core/src/tools/handlers/mod.rs` 的 `updated_hook_command`），所以没法借它把命令变成「要审批」。
  直接拒绝则等于覆盖写永远做不了，比现状更糟。`PermissionRequest` 只在内核**已经决定要问**之后才触发。
- **extension-api contributor（Rust）**：contributor 能挂工具与事件流，但 `exec_command` 的
  审批要求是在 `UnifiedExecProcessManager` 里当场算的，没有给 contributor 的挂点。
- **配置（execpolicy `.rules`）**：规则只对能拆成「纯命令序列」的脚本按段匹配
  （`shell-command/src/bash.rs` 的 `parse_shell_lc_plain_commands` 遇到重定向直接放弃），
  带 `>` 的命令整段匹配不上；而且规则按命令前缀判，**判断不了目标文件存不存在** ——
  「覆盖已有文件」与「新建文件」只差这一点，而新建文件（`cat > outputs/x.md <<EOF`）
  是模型最常见的动作，不能因此每次都问。只有内核的审批点同时拿得到命令与工作目录。

## 已知不覆盖

- **`apply_patch`（这是真模型最常走的那条）**：`exec_command` 里的 `apply_patch <<'PATCH' … PATCH` 被内核截下来按补丁应用，
  不经过这里的挂点，工作空间内的 `Update File` / `Delete File` 都不问。2026-10-01 用 deepseek-flash 跑验收 D1-2 四轮：
  1 轮先在对话里问用户；2 轮直接 `Update File` 改写；1 轮在 `printf … >` 被这个补丁拦下、按策略拒绝之后，
  改用 `Delete File` + `Add File` 把文件删了重建 —— **用户的拒绝没有挡住结果**。所以 P6 修的是测试方原报告里那条命令，
  D1-2 作为「覆盖文件须审批」在真模型下仍然不过；要真正覆盖得另做决定（见 10 §2.4）；
- `>>` 追加（不是覆盖，按 Q45 工作空间内写入不问）；
- `tee`、`cp` / `mv` 覆盖、`python -c "open(..., 'w')"` 这类脚本语言里的写；
- 脚本里先 `cd` 再用相对路径（目标按任务工作目录解析）；`~` 不展开；
- 旧的 `shell` 工具与远端执行环境（只改了 unified exec；`cwd` 不是本地路径时不判）。

## 上游 rebase 时

`node scripts/build-kernel.mjs --check` 会在导出的副本上试打补丁，打不上就失败并指出是哪一个。
`process_manager.rs` 的挂点是 `create_exec_approval_requirement_for_shell(...).await;` 之后、
构造 `UnifiedExecToolRequest` 之前；那段移动了就按新位置重做，别跳过这个补丁编内核。
