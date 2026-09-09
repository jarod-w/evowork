# browser —— EvoWork 官方连接器（Q9 / 05 §4.4）

stdio MCP server。工具：`browser_navigate` · `browser_snapshot` · `browser_screenshot`。

- 只允许 `http` / `https`
- 上传不做；下载不做
- 本机没有 Chrome / Chromium 时，工具调用失败并说明原因，不假装打开了页面
