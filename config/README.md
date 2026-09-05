# config —— 配置模板

对应 09 §7 的 `~/.evowork/` 布局。**分工必须守住**：

| 文件                        | 归属         | 规则                                                                    |
| --------------------------- | ------------ | ----------------------------------------------------------------------- |
| `config.toml`               | **内核配置** | `model_providers` / `permissions` / `mcp_servers` / `hooks`             |
| `requirements.toml`         | 企业强制层   | `allow_managed_hooks_only` 等（R11）                                    |
| `modes/{craft,plan,ask}.md` | EvoWork      | developer instructions 片段。**取代了原 P3 补丁**（F1）                 |
| `scenarios/*.toml`          | EvoWork      | 场景包。内核的 `collaborationMode/list` 是硬编码的（F3），装不了这个    |
| `permissions/`              | 说明         | 四个命名 profile（10 §2.2）的中文文案映射；profile 本体在 `config.toml` |
| `showcase/*.toml`           | EvoWork      | 案例池（03 §5）。随包 + 私有源下发，**不联网**                          |
| `slots.toml`                | EvoWork      | 运营位开关（Q18：默认全关，只有 `showcase` 开）                         |

**EvoWork 自己的配置不混进 `config.toml`**（09 §7 原话）—— 否则 rebase 时会与上游的配置 schema 冲突。

`CODEX_HOME` **保持内部路径名不动**（K5：只改对外可见字符串），通过环境变量指向 `~/.evowork/kernel/`。
