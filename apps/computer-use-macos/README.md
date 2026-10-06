# macOS 原生电脑操控 Helper

设计 12 的独立权限主体，最低 macOS 14.4；只链接系统 framework，无第三方原生依赖。宿主验证签名和 Team ID 后启动 App 内的固定可执行文件，使用继承的私有 stdio 长度帧，不监听网络或文件 socket。屏幕内容直接以内存帧返回，不写临时截图文件。

源码已包含 AX 读取/安全字段抑制、窗口截图、元素点击、设置值、辅助动作、有限按键、纯文本粘贴/恢复、Unicode 输入与文本选择（`replace`/`extend`）；物理输入监听和 60 秒空闲退出。当前 App 身份识别保守限定 TextEdit、Finder、Numbers。2026-10-06 补齐窗口坐标点击、1–3 次点击、左右/中键、有限滚动及有距离/时长预算的拖拽；均仍待 AX/TCC 真机验收。坐标要求最近成功截图，并在审批前后及执行前重验截图和窗口；中断清理会释放鼠标。原生目标检查独立于模型参数，父进程必须匹配正式桌面 App 的签名标识及 Helper Team ID。

`node scripts/build-computer-use.mjs` 在 macOS 构建 Swift 并装配 `build/computer-use/EvoWork Computer Use.app`。2026-09-24 在 macOS 27.0 / CLT 27.0 上原生 release 编译与装配通过。`swift run --package-path apps/computer-use-macos EvoWorkComputerUsePolicyTests` 运行不依赖 XCTest/宏的策略检查，覆盖窗口绑定、重复文本拒绝、UTF-16 范围、`extend`、坐标边界和拖拽路径（21 项）；装配后用 `node scripts/verify-computer-use-health.mjs` 检查真实 Helper 进程的长度帧与 `health` 握手，以及非受信父进程在读取应用前被拒绝。这两项都不能代替 AX/TCC 真机测试。构建出的发布标记强制 `releaseVerified=false`，桌面不能启用，也不会注册可用工具。

发布前必须完成：AX/截图/动作原生真机测试；同 Team ID 签名、公证与升级 TCC；同 Team ID 正向调用方 code-signature 验收（源码和非受信调用拒绝已实现）；剪贴板中断/崩溃恢复；窗口移动/锁屏/多屏/secure field；动作预算和无变化检测；中断 P95 < 500 ms；所有九个动作；MCP 图文/blob/备份真实删除。不能手工翻转发布标记代替这些验收。
