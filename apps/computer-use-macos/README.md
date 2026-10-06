# macOS 原生电脑操控 Helper

设计 12 的独立权限主体，最低 macOS 14.4；只链接系统 framework，无第三方原生依赖。宿主验证签名和 Team ID 后启动 App 内的固定可执行文件，使用继承的私有 stdio 长度帧，不监听网络或文件 socket。屏幕内容直接以内存帧返回，不写临时截图文件。

源码已包含 AX 读取/安全字段抑制、窗口截图、元素点击、设置值、辅助动作、有限按键、纯文本粘贴/恢复、Unicode 输入与文本选择（`replace`/`extend`）；物理输入监听和 60 秒空闲退出。P2 枚举运行中前台类型 App，核对受信签名链、bundle/signing id、发布者及实际进程路径，按运行切片验签并用其 CDHash 绑定授权。已识别 Apple 的 TextEdit、Finder、Numbers、Pages、Keynote、Preview、Notes、Reminders、Calendar、Contacts、Mail，以及 Microsoft 签名的 Word、Excel、PowerPoint、OneNote、Outlook。支持表之外的签名应用返回 unknown，拒绝激活/读取；浏览器、终端、凭据、系统、自身与远程桌面分类后仍禁止原生操控。2026-10-06 补齐窗口坐标点击、1–3 次点击、左右/中键、有限滚动及有距离/时长预算的拖拽；均仍待 AX/TCC 真机验收。坐标要求最近成功截图，并在审批前后及执行前重验截图和窗口；中断清理会释放鼠标。原生目标检查独立于模型参数，父进程必须匹配正式桌面 App 的签名标识及 Helper Team ID。

2026-10-06 按用户要求增加微信（`com.tencent.xinWeChat` / `5A4RE8SF68`）、企业微信（`com.tencent.WeWorkMac` / `88L2Q4487U`）、印象笔记（`com.yinxiang.Mac` / `7D498F54KM`）、WPS Office（`com.kingsoft.wpsoffice.mac` / `YK4WKE5WAM`）和 Thunderbird（`org.mozilla.thunderbird` / `43AQ936H96`）；应用标识与对应 Team ID 必须同时匹配，五者本机安装签名已核对。已知应用共 21 个；同厂商其它应用不自动放行。准入与企业策略仍生效，发送/分享/Enter/带换行输入及未知编辑仍要求本次动作确认。

`node scripts/build-computer-use.mjs` 在 macOS 构建 Swift 并装配 `build/computer-use/EvoWork Computer Use.app`。2026-09-24 在 macOS 27.0 / CLT 27.0 上原生 release 编译与装配通过。`swift run --package-path apps/computer-use-macos EvoWorkComputerUsePolicyTests` 运行不依赖 XCTest/宏的策略检查，覆盖窗口绑定、重复文本拒绝、UTF-16 范围、`extend`、坐标边界和拖拽路径（54 项，含身份类别/发布者/标识冒充拒绝）；装配后用 `node scripts/verify-computer-use-health.mjs` 检查真实 Helper 进程的长度帧与 `health` 握手，以及非受信父进程在读取应用前被拒绝。这两项都不能代替 AX/TCC 真机测试。构建出的发布标记强制 `releaseVerified=false`，桌面不能启用，也不会注册可用工具。

发布前必须完成：AX/截图/动作原生真机测试；同 Team ID 签名、公证与升级 TCC；同 Team ID 正向调用方 code-signature 验收（源码和非受信调用拒绝已实现）；剪贴板中断/崩溃恢复；窗口移动/锁屏/多屏/secure field；动作预算和无变化检测；中断 P95 < 500 ms；所有九个动作；MCP 图文/blob/备份真实删除。不能手工翻转发布标记代替这些验收。

P2 元数据探针 `node scripts/verify-computer-use-apps.mjs` 直接提取生产签名函数，在独立 Swift 程序里验证真实运行应用。只读签名与进程元数据，不激活窗口、不读 AX、不请求 TCC；Finder 必须通过 ordinary 准入，失败退出。当前 macOS 27.0 的 Finder 多架构切片已通过；这不证明同 Team ID 正向宿主调用或 AX/TCC 能力。

可在命令后指定已运行的 bundle id，例如 `node scripts/verify-computer-use-apps.mjs com.tencent.xinWeChat com.yinxiang.Mac`。指定应用必须出现在运行中前台类型应用中并通过 ordinary 准入，否则探针失败；只输出身份分类/数量，不输出聊天或笔记内容。
