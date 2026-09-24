# 电脑操控连接器

固定 server 名 `cua_repl`，复用内核 ComputerUse 审批语义。入口由 Electron 作为 Node 启动；工具实现来自 `services/computer-use` 的单文件构建。仅连接宿主提供的 Unix socket，不接收 TCP 地址，不提供 eval、shell 或文件工具。

功能默认关闭，宿主只有在原生发布验证通过后才允许启用。token 来自继承环境，不写入配置、日志或工具参数。工具调用必须包含内核 `_meta.threadId/sessionId`；宿主另外验证当前回合和来源，不能用模型参数授权。
