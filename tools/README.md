# tools —— 开发期工具（不随产品分发）

| 包                                                 | 用途                              |
| -------------------------------------------------- | --------------------------------- |
| [`eslint-plugin-evowork/`](eslint-plugin-evowork/) | 把 CLAUDE.md 的铁律做成 lint 规则 |

两条规则，都对应文档里**会被 deadline 压垮的约定**：

| 规则                  | 守的是                                                                          | 出处                         |
| --------------------- | ------------------------------------------------------------------------------- | ---------------------------- |
| `no-kernel-internals` | K2 边界纪律：不读内核 sqlite / rollout / memories 文件，不链接 Rust 与 SDK 内部 | 09 §2 的三条"容易被破的地方" |
| `no-style-literals`   | 组件里零字面量颜色与 px                                                         | 01 §9 验收项 1               |

**误报比漏报更危险**：一旦规则误报，人会整片 `eslint-disable`，那时真正的破线也一起放行了。
所以 `no-kernel-internals` 对 `memories` / `rollout` 这类可能出现在内核路径里的词只在**路径形态**下报错
（`memory/status` / `memory/reset` 是正路，`~/.evowork/kernel/memories` 是歧路）。当前 app-server
不暴露记忆正文列表，因此界面也不绕过协议直接读生成文件。规则自己的测试就钉着这条区分。
