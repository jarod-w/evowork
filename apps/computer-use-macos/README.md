# macOS 原生电脑操控 Helper

设计 12 的独立权限主体，最低 macOS 14.4；只链接系统 framework，无第三方原生依赖。宿主验证签名和 Team ID 后启动 App 内的固定可执行文件，使用继承的私有 stdio 长度帧，不监听网络或文件 socket。屏幕内容直接以内存帧返回，不写临时截图文件。

源码已包含 AX 读取/安全字段抑制、窗口截图、元素点击、设置值、辅助动作、有限按键、纯文本粘贴/恢复、Unicode 输入与文本选择；物理输入监听和 60 秒空闲退出。当前 App 身份识别保守限定 TextEdit、Finder、Numbers。坐标点击、多次点击、拖拽、滚动和扩展选择尚未开放；不将固定 schema 的存在描述成所有原生动作均已完成。

`node scripts/build-computer-use.mjs` 在 macOS 构建 Swift 并装配 `build/computer-use/EvoWork Computer Use.app`。Linux 环境无法编译 AppKit/ScreenCaptureKit，本轮原生源码未编译、未真机验证。构建出的发布标记强制 `releaseVerified=false`，桌面不能启用，也不会注册可用工具。

发布前必须完成：Swift 编译与原生测试；同 Team ID 签名、公证与升级 TCC；调用方 code-signature/audit-token 第二因子；剪贴板中断/崩溃恢复；窗口移动/锁屏/多屏/secure field；动作预算和无变化检测；中断 P95 < 500 ms；所有九个动作；MCP 图文/blob/备份真实删除。不能手工翻转发布标记代替这些验收。
