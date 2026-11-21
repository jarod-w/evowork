# 2026-11-21 · 浏览器连接器信任入口（#28）

修复 [issue #28](https://github.com/jarod-w/evowork/issues/28)：真实网页研究旅程在连接器目录查找名称以“浏览器 ”开头的整卡按钮，30 秒超时，未能继续信任及网页读取。

## 结论与改动

确认是测试夹具过时。隔离 HOME 的实际目录中已有名称为“浏览器”的官方连接器，卡片是展示容器，入口是独立按钮 **“查看权限 · 浏览器”**。失败时的公开窗口快照同时包含卡片标题、待信任状态和此按钮；服务端目录继续补充官方浏览器，产品目录与启用链路无需修改。

- 新增 `browser-connector.mjs`，真假模型用例共用具名按钮进入详情，再核对“浏览器”标题及“信任「浏览器」”对话框，完成明确的信任确认；移除依赖 `.ew-projects-grid` 和旧整卡按钮名称的定位。
- 补充目录单元回归，钉住展示名、具名查看权限入口及信任动作；打开对话框、取消都不会启用，确认只调用一次 `browser`。
- 保留原有模型、Chrome、来源授权、拒绝零请求、随机口令、引用、历史恢复及禁用命令访问的断言和时限。增加信任详情截图及实模型证据文件，证据写入前继续核验测试密钥未出现。

## 验证

- 修改前真实 Electron / 发货内核 / 确定性网关 **2/2 失败**，均在原定位器等待 30 秒后超时：[原始失败日志](assets/2026-11-21-browser-connector-entry/red.txt)、[公开窗口快照](assets/2026-11-21-browser-connector-entry/red-context.txt)。
- 目录单元测试 **17/17**。完整 `pnpm run check` 退出 0：**3636 项通过 / 6 项既有跳过**，格式、lint、全部类型、补丁预算、54 请求协议和许可证检查通过：[完整仓检](assets/2026-11-21-browser-connector-entry/check.txt)。最后补充实模型证据文件后，对四份修改的测试文件另行执行 lint，并通过真实窗口复验。
- 确定性窗口 **2/2（4.9 秒，单 worker、零重试）**，使用真实 browser MCP 与 Chrome，覆盖授权前零读取、批准后网页正文及来源引用、引用点击、刷新恢复，以及拒绝后零请求/编造引用不可点击：[窗口日志](assets/2026-11-21-browser-connector-entry/playwright-fake.txt)。
- 原始 MiMo + 真实 Chrome 用例 **1/1**，补充持久化证据后的最终复验 **1/1（21.3 秒，单 worker、零重试）**。模型从本机页面取回提示中没有的随机口令，授权前页面请求数为 0，授权后共 3 次页面请求；`browser_navigate`、`browser_snapshot`、`browser_read_page` 均 completed，没有 `commandExecution`。刷新后口令和来源 URL 均保持，6 次模型请求全为指定 MiMo 端点、6 个上游响应均为 HTTP 200：[实模型日志](assets/2026-11-21-browser-connector-entry/playwright-mimo.txt)、[实际历史及请求元数据](assets/2026-11-21-browser-connector-entry/mimo-evidence.json)、[内核生命周期](assets/2026-11-21-browser-connector-entry/mimo-lifecycle.json)。
- 已查看[信任后的浏览器详情](assets/2026-11-21-browser-connector-entry/browser-connector-trusted.png)及[刷新后口令与来源引用](assets/2026-11-21-browser-connector-entry/browser-read-and-citation.png)，标题、连接状态及引用均可识别。
- 对全部 16 个修改/新增的测试、文档和证据文件执行现有测试密钥的精确字节扫描，零命中、零读取错误：[扫描结果](assets/2026-11-21-browser-connector-entry/credential-scan.json)。

## 边界

本轮修改只有测试夹具、回归和验收文档，使用现有产品构建与发货内核；没有改动产品界面、catalog、信任流程、审批策略或原生浏览器实现。模型调用前显式校验 `EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash` 与 `https://api.xiaomimimo.com/v1`，密钥仅由既有本机测试环境注入，不写入代码、配置或证据。只访问新隔离 HOME 中的合成本机报告；未验证外站搜索稳定性或 Windows / Linux。未升级版本、替换安装或发布。
