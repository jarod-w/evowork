# 完整确定性 Playwright 回归与修复

日期：2026-10-24 至 2026-10-25（北京时间）。平台：macOS arm64。基线：`ui_based_codex` / `c3c0fd3`，版本仍为 `0.0.8`。

## 结果

首轮完整回归 **145 通过、21 失败**；修复与定向验证后，最终完整回归 **166/166 通过，零失败、零跳过、零重试**，44 个文件，耗时 **730.8 秒（约 12 分 11 秒）**。最终全量从北京时间 10 月 24 日 23:51 开始，10 月 25 日 00:03 结束。

测试驱动真实 Electron、正式渲染层、preload、发货内核与本地服务；模型响应由确定性本机网关提供。Office 使用真实 LibreOffice，OCR 使用实际本机构建的识别运行时。没有使用用户提供的 GLM 凭据、发起真实模型付费请求或修改内核。

| 阶段 | 结果 | 凭据 |
| --- | --- | --- |
| 原始完整运行 | 145 通过 / 21 失败，零跳过、零重试，1107.2 秒 | [日志](assets/2026-10-25-deterministic-playwright/initial.log) |
| 首次复跑原失败项 | 18 通过 / 3 失败，余下为两条 Office 和一条浏览器用例 | 本机 `dist/playwright-release/targeted`、`/tmp/evowork-playwright-targeted.log` |
| 浏览器修复后每例重复三次 | 6/6，零跳过、零重试，47.9 秒 | [日志](assets/2026-10-25-deterministic-playwright/browser-fixed.log) |
| Office / 文件结果 UI | 9/9，零跳过、零重试 | [日志](assets/2026-10-25-deterministic-playwright/office-fixed.log) |
| 解析隔离 / Office / 文档导出回归 | 59/59 | [日志](assets/2026-10-25-deterministic-playwright/office-regressions-green.log) |
| 最终完整 UI | 166/166，零跳过、零重试 | [日志](assets/2026-10-25-deterministic-playwright/final.log) / [逐项结果 JSON](assets/2026-10-25-deterministic-playwright/results.json) |

完整 JSON 报告另存本机 `dist/playwright-release/initial-report.json`、`browser-fixed-report.json` 和 `final-report.json`。默认 `test-results/.last-run.json` 最终为 `passed`、失败数组为空。

## 定位与修复

### 浏览器实际读取超时

隔离 HOME 下 Chrome 的网络服务会等待用户登录钥匙串，CDP 导航超时，本机测试页面收到零请求。普通 HOME 的独立浏览器探针能通过，不能替代实际 MCP 与隔离应用旅程。

`plugins/connectors/browser/cdp.mjs` 在 macOS 的专用临时浏览器启动参数中增加 `--use-mock-keychain`，避免依赖真实登录钥匙串。没有开启远程访问或使用用户浏览器 profile。公开资料用例增加实际 MCP 读取结果附件、任务唯一性及工具调用次数断言；授权读取、引用跳转、历史恢复与拒绝后零请求的原断言保持。两例连续重复三次通过，再由完整回归覆盖。

### Office 版式转换失败

真实 LibreOffice 需要单实例 Unix socket。原沙箱拒绝所有网络操作，转换器尝试在全局临时目录建立 IPC；macOS 默认临时目录的路径加上 LibreOffice 的 socket 名还可能超过系统长度上限。

预览与文档 PDF 导出统一使用短的独立作业目录，并通过 `-env:OSL_SOCKET_PATH` 把 IPC 定位到该目录。解析器新增默认关闭的 `allowLocalIpc`，仅 Office 转换启用；沙箱只允许本次目录内的 Unix socket 绑定、连接和接收。IP 网络、外部 Unix socket、目录外文件读写继续拒绝。没有扩大原来的转换期限、内存限制或文件权限。

新增回归真实创建 socket，并验证外部文件读写、其他目录的 socket、经作业目录软链接逃逸、TCP 连接和 TCP 绑定均失败，外部服务零连接、原文件字节不变。文档导出另用 LibreOffice 长度的 socket 名验证路径长度。真实 Word / Excel / PPT / RTF 逐页预览，以及 21 页只渲染前 20 页的边界全部通过；截图已查看。

[IPC 边界专项](assets/2026-10-25-deterministic-playwright/ipc-boundaries.log) · [Word](assets/2026-10-25-deterministic-playwright/office-docx.png) · [PPT](assets/2026-10-25-deterministic-playwright/office-pptx.png) · [20 页截断](assets/2026-10-25-deterministic-playwright/office-limit.png)

### 测试剧本、定位器与依赖

| 首轮失败范围 | 原因与处理 |
| --- | --- |
| 审批、内核崩溃、审批恢复、两条可视化（5 条） | `generate:false` 预热错误消费下一次工具剧本。预热只回复建立/完成事件，不领取采样剧本；关键旅程按提示标记认领请求。新增网关回归先红后绿。 |
| 三条破坏性审批、策略目录读取（4 条） | Stop hook 的追加回合使旧的 `DONE` 或宽泛发送按钮提前命中。改用命令唯一完成标记及精确按钮，仍验证真实审批、拒绝、文件内容与工具结果。 |
| 文件生命周期（3 条） | 追问未绑定当前回合，遗漏写入审批或等待旧回复。统一绑定命令和完成标记、按实际审批推进，再核对文件版本与撤销行为。 |
| 电脑操控授权列表、记忆引用（2 条） | 授权行结构和多段 Markdown 与旧定位器不符。按当前行及整个消息区检查；撤销落盘、引用刷新和无原始标记的断言保留。 |
| 图片生成三种结果（3 条） | 固定模型剧本未履行后续建议登记约定，Stop 造成重复结论/视觉请求。夹具先登记空建议再查看/收尾；真实生成调用、视觉调用、拒绝后零请求及失败状态仍严格核对。 |
| Office（2 条） | 补齐真实转换器并修复上述 IPC；夹具中文字体从实际办公解释器目录读取，缺字体明确失败。 |
| OCR（1 条） | 缺独立运行时。按仓库固定源版本与哈希构建实际 OCR 成品后执行原用例，没有用假识别替代。 |
| 公开资料读取（1 条） | 上述隔离 HOME / 钥匙串问题。 |

[预热回归修复前失败](assets/2026-10-25-deterministic-playwright/gateway-regression-red.log)。没有通过添加 skip、增加重试、延长超时或删除原行为断言取得通过。

`package.json` 的 `test:ui` 现在显式选择 `--project=fake`，与既有文档约定一致，防止默认命令意外同时选中真实厂商测试；`test:ui-real` 保持独立。`pnpm run test:ui --list` 已核对为 **166 项 / 44 文件**。

## 复验命令与环境

先完成 `pnpm run build`，再运行下列命令。所有路径都是本轮本机产物，应按实际平台替换。

```bash
PYTHONDONTWRITEBYTECODE=1 \
EVOWORK_OFFICE_PYTHON="$PWD/build/office/mac-arm64/runtime/bin/python3" \
EVOWORK_OFFICE_CONVERTER=/private/tmp/evowork-playwright-LibreOffice.app/Contents/MacOS/soffice \
EVOWORK_OCR_TEST_RUNTIME="$PWD/dist/playwright-release/ocr-build/ocr-arm64-darwin" \
node node_modules/@playwright/test/cli.js test --project=fake --retries=0 --reporter=list,json
```

最终完整构建已通过。OCR 使用仓库构建脚本及固定资产校验；CMake 4.4.4 只放在临时工具目录。LibreOffice 25.8.2.2 arm64 来自官方历史包，只读挂载后复制到隔离临时目录，严格代码签名校验通过；未安装到 `/Applications`。测试办公 Python 直接使用已有随包运行时及 Noto 中文字体。

## 最终全仓检查

最终 `pnpm run check` 退出 **0**，**3419 项通过、2 项既有跳过**，208 个测试文件通过、1 个既有跳过，测试阶段 170.72 秒。格式、lint、全部类型、内核补丁预算、协议形状与第三方许可门禁均通过。两项跳过来自既有 `runtime-installer/test/install.e2e.test.ts`，不是 Playwright 跳过。

使用 pnpm 10.30.3，提供实际办公解释器与转换器，限制 Vitest 并发，原检查入口和各测试期限保持：

```bash
PYTHONDONTWRITEBYTECODE=1 \
EVOWORK_OFFICE_PYTHON="$PWD/build/office/mac-arm64/runtime/bin/python3" \
EVOWORK_OFFICE_CONVERTER=/private/tmp/evowork-playwright-LibreOffice.app/Contents/MacOS/soffice \
VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 \
pnpm run check
```

[全仓检查汇总](assets/2026-10-25-deterministic-playwright/check-summary.log)。

## 过程与验收边界

全仓复验时提供真实办公解释器，暴露一条既有单测的环境依赖：共享安装用例未清除 `EVOWORK_OFFICE_PYTHON`，实际进入管理员解释器验证分支，原来的安装 Promise 同一性断言失败。该用例现明确清空并在结束时恢复变量，保留单次安装、异常清理及重试的全部原断言。此修正只涉及单测，不改变最终 UI 已验证的业务代码。[失败记录](assets/2026-10-25-deterministic-playwright/check-environment-failure.log)。

只验 macOS arm64、本机隔离数据目录与确定性模型。原生电脑操控的 AX / TCC / 签名验收仍不由假 Helper 用例证明，真实模型质量与跨平台行为也不在本轮结论内。既有显式记录的安全行为缺口（例如 D1-4 重定向组合）未因套件通过而视为已修复。

验收阶段没有升级版本、发布、替换已安装应用或重建发行 DMG/ZIP。已有安装包早于本轮修复，正式发布前需要重新打包并验证实际发行包；Developer ID / 公证等原有发版门槛仍适用。
