# OCR 与资料库正文检索本机验收记录

日期：2026-10-06。对应 [设计 16 §14](../design/16-ocr-and-library-search.md#14-首版实现与验收边界2026-10-06)。本记录证明本地首版接通及下述具体流程通过，不代表 O0–O4 所有发布门槛通过。

## 环境与最终检查

- MacBookAir10,1，Apple M1，macOS arm64；Node 24.19.0、pnpm 10.30.3。
- `pnpm run check` 退出 0：169 个测试文件通过、1 个跳过；2704 项测试通过、2 项跳过。格式、lint、类型、内核补丁预算、协议形状和第三方许可清单均通过。
- `pnpm run build` 退出 0，桌面主进程、preload、renderer 与服务构建完成。
- 真实 Electron + 发货内核 + 本机确定性模型网关：4 项窗口用例全部通过，用时 34.4 秒。模型网关用于检查实际请求内容，未验证真实模型回答质量；OCR 引擎、文件、SQLite 和窗口操作为真实本机流程。

## 窗口验证的实际后果

1. 批量附件：23 个文件中 20 个就绪、3 个拒绝；视觉模型实际请求含 5 个图片输入，CSV 不被当作图片。
2. 拖入办公文件：实际提取并发送 4 个内嵌图片，验证原有附件路径的回归。
3. 资料库：外部原文件复制到管理目录；仅正文含测试词的文件可检索，片段按字面高亮，可预览位置并引用到未发送草稿。刷新后保留检索范围；移除资料后原文件仍在且内容不变。
4. OCR：从窗口安装宿主配置的可信离线组件，识别扫描 PDF 与 PNG。普通任务附件不自动进入资料库；30 页作业在已提交首个结果后停止，刷新后仍为停止状态，显式选择使用部分结果并只将选中图片加入资料库。发送给非视觉模型的实际请求包含识别文件路径、金额和未完成页提示，图片输入数为零。

相关用例：`attachments.spec.mjs`、`library-search.spec.mjs`、`ocr-attachments.spec.mjs`。每个用例使用独立 Electron 用户目录；同一用例的刷新保留该目录，用于验证持久选择。

## 固定样本与离线运行

引擎为 Tesseract 5.5.1、静态 Leptonica 1.85.0；简体中文、英文、方向数据采用 `ocr-sources.json` 中固定的 tessdata_fast 来源与 SHA-256。本机组件清单字节总量为 22,537,155。离线安装使用独立固定的 manifest 摘要，验证各文件与真实识别探针后再换入。

[30 页原始报告](2026-10-06-ocr-baseline.json)记录源文件/字体哈希与逐页结果。清晰合成中英文扫描 30 页平均 CER 为 0，金额、编号逐项正确。完整验证脚本累计 53,144 ms，包含文字层/空白页分类、已完成页复用及旋转验证；此值不是单独 30 页 OCR 的耗时。该脚本显式指定 Python 桥接解析器，其中的图片旋转结果不能代替原生解码器验证。报告中的 `gatePassed` 只指该合成样本的质量断言。

[格式与检索原始报告](2026-10-06-library-baseline.json)另行验证：

- 将办公 Python 设置为不存在的路径，PNG/JPEG/静态 WebP 仍由原生 ImageIO 解码和 Tesseract 识别，金额/编号正确。
- 原生手动顺时针 90° 与自动方向识别均通过，坐标映射回原页后在归一化范围内。
- 动画 WebP 与声明 20,000 × 20,000 像素的 PNG 被拒绝。
- XLSX 第 201 行正文实际命中，定位为“工作表 Sheet · 行 201–220”。
- 真实子进程沙箱测试拒绝范围外文件读写与联网；取消/超时终止所属进程组。RSS 每 250 ms 采样，超限终止；这不是瞬时内核内存硬上限。

这些清晰合成样本不证明真实低清扫描、手写、双栏或复杂表格达到同样质量。

## 检索性能

真实 SQLite 语料含 10,000 文档、100,000 分块，每文档 10 块，每块约 230 字符，数据库小于 1 GB。每个查询执行五次，均返回 20 个文档。

| 查询 | 五次观测（ms） | 最大值（ms） | 设计目标 |
| --- | --- | --- | --- |
| `ZXCVUNIQUE` | 564、547、542、526、498 | 564 | 长词 P95 ≤500 ms，尚未达成 |
| `合同` | 237、212、234、225、206 | 237 | 短词目标 ≤2 s，此组观测通过 |
| `ZXCVUNIQUE 付款` | 667、642、639、648、660 | 667 | 长词/混合目标 ≤500 ms，尚未达成 |

原始报告将五次样本的最近秩统计标记为 `p95Ms`；本记录按五次最大值呈现，不据此宣称获得充分的 P95 分布。仍需扩大冷/热查询与真实语料样本，并优化长词/混合查询。

## 复现入口

从仓库根目录运行，使用正常可工作的 pnpm 10.30.3。macOS 沙箱、原生编译与窗口测试需要相应本机权限；办公 Python 应含 pypdfium2、Pillow、openpyxl 和样本字体。运行时与输出路径由验收人员显式设置，脚本不会静默跳过缺失组件。

```bash
pnpm run check
pnpm run build

# 发行工具入口；--offline 要求固定源码及语言资产已在 work 目录。
node scripts/build-ocr-bundle.mjs --work <build-work> --cmake <cmake-path> --offline

EVOWORK_OCR_TEST_RUNTIME=<verified-bundle> \
EVOWORK_OFFICE_PYTHON=<managed-python> \
EVOWORK_OCR_TEST_OUTPUT=<temporary-output> \
node scripts/verify-ocr.mjs

EVOWORK_OCR_TEST_RUNTIME=<verified-bundle> \
EVOWORK_OFFICE_PYTHON=<managed-python> \
EVOWORK_LIBRARY_TEST_OUTPUT=<temporary-output> \
node scripts/verify-library.mjs

EVOWORK_OCR_TEST_RUNTIME=<verified-bundle> \
EVOWORK_OFFICE_PYTHON=<managed-python> \
pnpm exec playwright test library-search.spec.mjs ocr-attachments.spec.mjs attachments.spec.mjs --project=fake
```

原生辅助程序在本机针对实际沙箱和方向问题修复后重编译并通过上述流程；本次验证组件不是正式签名发行包，未证明最低 macOS 部署版本的可搬运性。发行脚本中的 macOS 14.4 目标仍须独立发行验收。

## 未完成的发布验收

后续进展：2026-10-07 的检索优化在同一规模固定语料上达到长词/混合 P95 ≤500 ms；新旧各组 30 次 A/B 结果一致，见 [优化验收记录](2026-10-07-library-search-performance.md)。本文件保留首次结果与当时的未完成项，不覆盖历史数据。

- macOS x64 真机；签名、公证、可信线上发行地址、正式安装/升级与可搬运组件。
- 真实扫描、低清、复杂版式及完整损坏/加密等质量矩阵；更完整的峰值内存和取消延迟数据。
- 长词/混合检索的 500 ms 性能目标及更充分的冷/热样本。
- 完整 App 冷启动与各故障点强制退出恢复的发行矩阵；窗口刷新验证不等于所有崩溃路径验证。

当前缓存清理仅清正文缓存，保留 OCR 页缓存与索引，界面说明此范围。普通构建若没有宿主配置的可信发行组件，会明确提示不能安装 OCR。O0–O3 的整体门槛与 O4 仍按设计逐项放行。
