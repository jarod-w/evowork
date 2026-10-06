# browser —— EvoWork 官方连接器

stdio MCP server，使用独立 Chrome / Chromium profile；不继承用户浏览器登录态。构建入口 `node scripts/build.mjs` 会装配同源动作策略 `vendor/policy.mjs`，并从独立目录验证发布包可启动。

工具：`browser_navigate`、`browser_snapshot`、`browser_screenshot`、`browser_click`、`browser_fill`、`browser_press_key`、`browser_scroll`、`browser_download`。

- 只允许无内嵌凭据的 http/https URL。每个新 origin 单独准入，页面请求、导航和下载重定向均核对；拒绝不转向其它操控通道。
- 元素来自受控 CDP 快照；动作带 30 秒内最新 `state_id`，审批前后核对页面摘要，动作开始消费状态，之后必须重读。点击前核对命中元素，遮挡或目标变化拒绝。
- 敏感及用途不明的写操作单次确认，卡片显示网站、目标、输入和现有表单值；验证码、密码与文件字段拒绝。模型不能提交任意 JS/CDP、selector、风险或审批声明。
- 截图返回原生 MCP PNG。普通浏览器自动下载关闭；显式下载单次确认，保存到系统下载目录，最多 50 MiB、随机文件名前缀、不覆盖，失败删除半成品，停止中断下载。
- 导航与写操作共用 100 次动作预算。拒绝写动作或取消请求结束会话；新窗口、worker、独立 iframe 在执行前暂停并关闭整个专用浏览器，目前不支持这些目标。
- 缺 Chrome / Chromium 返回 `BROWSER_UNAVAILABLE`，错误不回显页面正文或凭据。

`node scripts/verify-browser.mjs` 已在 macOS 的真实 Chrome 上通过本机合成页面验收：导航、快照、输入、状态消费、截图、滚动、按键、批准提交、显式下载、拒绝提交后无 POST、导航/下载跨 origin 拦截及新窗口关闭。不证明其它平台、真实站点登录态或桌面内核的 browser 审批链路；原生 Computer Use 仍受独立发布闸门约束。
