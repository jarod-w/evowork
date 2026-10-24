# 下一步参数诊断与最新信息口径修复

2026-10-24，本机 macOS arm64。用户反馈同一会话中建议工具缺少标题报错，以及美股分析混用前一交易日、周度新闻、盘后事件和相近指数。

## 修复

- 工具说明和字段描述明确每条必填 title / prompt。宿主保留真实来源核对，返回所有固定字段路径与约束，不回显未知键或用户正文；非法提案整组拒绝、不部分保存，继续交付当前请求、不自动重试或触发 Stop 补报。
- Craft 补齐最新信息的证据使用规则：目标时区、交易日历与收盘状态；发布时间、事件时间和覆盖期间分别核对；区分单日/周度、盘前/盘中/收盘/盘后以及指数/ETF/期货，明确 IXIC 与 NDX 不同。滚动 `when:1d` 和标题不等于事件日期，盘后报道不能一刀切排除。交付前检查一致性，冲突未解决须待核验，归因区分报道观点与模型推测。
- 新模式哈希登记，沿用已发布版本迁移机制；用户自定义文件不强制覆盖。
- 完整类型检查发现既有 `acceptance-panel.tsx` 从错误相对路径导入 `TaskStatusView`，修正一行导入，未改面板行为。

## 验收

| 检查 | 结果与证据 |
|---|---|
| 旧版上的新增参数回归 | 11 项失败，[修复前](assets/2026-10-24-temporal-next-actions/unit-before.txt) |
| 参数文件定向回归 | 28/28，[修复后](assets/2026-10-24-temporal-next-actions/unit-after.txt) |
| 上游观测与脱敏回归 | 5/5，[观测测试](assets/2026-10-24-temporal-next-actions/wire-unit.txt) |
| 真实 Electron + 发货内核 + 本机确定性上游 | 9/9：缺少两个 title 时具体报错、一次调用、最终回复正常、无候选、不重试，以及输入框与建议生命周期；[窗口回归](assets/2026-10-24-temporal-next-actions/deterministic-ui.txt) |
| 用户指定真实模型 | `deepseek-flash`，实际端点 `https://api.deepseek.com/v1/chat/completions`，2/2，零重试；[日志](assets/2026-10-24-temporal-next-actions/real.txt)、[汇总](assets/2026-10-24-temporal-next-actions/summary.json) |
| 完整构建 | 通过，[构建日志](assets/2026-10-24-temporal-next-actions/build.txt) |
| 原版 `pnpm run check` | 退出 0，3400 项通过 / 2 项既有跳过，格式、lint、类型、K1、协议形状与许可清单通过；[完整日志](assets/2026-10-24-temporal-next-actions/check.txt) |

真实模型使用本机固定行情、交易日历与五篇新闻正文测试证据使用行为，价格基数每次随机，涨跌幅从文件计算。实际模型调用仍经产品宿主网关出网，材料读写在本地；没有替换模型输出、强制 tool_choice 或执行下一阶段。

| 场景 | 最近完整交易日 | 新闻分类 | 指数 | 建议 |
|---|---|---|---|---|
| 夏令时周末：北京时间 10-24 09:06 | 10-23 | N1 前日回顾、N2 周度为背景；N3 盘后复盘可用于当日归因；N4 盘后新事件；N5 指数名/数字冲突待核验 | IXIC −0.21%、NDX −0.004%、DJI −1.23%，名称/代码逐项对应 | 1 次，标题完整、saved=true、界面可见 |
| 冬令时休市日：北京时间 11-27 09:06，给定日历中 11-26 休市 | 11-25 | 同上，没有把休市日或本机日期当作交易日 | 同上，由不同随机价格基数计算 | 1 次，标题完整、saved=true、界面可见 |

最终两项共 **31 次厂商请求、31 个 HTTP 200**，任务请求在 system 层携带新规则，工具携带标题必填说明；两次内核启动、意外退出 0。证据包括公开历史、无请求头和正文的上游布尔元数据、输出与截图：[夏令时结果](assets/2026-10-24-temporal-next-actions/summer/review.json)、[夏令时截图](assets/2026-10-24-temporal-next-actions/summer/verified.png)、[冬令时结果](assets/2026-10-24-temporal-next-actions/winter/review.json)、[冬令时截图](assets/2026-10-24-temporal-next-actions/winter/verified.png)。两图已目视核对。

密钥通过隐藏 stdin 进入父进程，再以子进程环境传给网关；未写入命令参数或配置。证据写入前检查不含密钥，最终测试目录精确扫描 **0 命中**。临时复用认证的测试目录和凭据密文副本已清理。

## 过程失败与边界

前置流程因项目创建后界面未刷新停在选择器，尚未发送模型请求，见[夹具失败](assets/2026-10-24-temporal-next-actions/project-picker-failure.txt)。随后正常打包入口的独立认证尝试在执行中关闭主窗口，没有获得可定位原因的生命周期证据，未判通过，见[退出现场](assets/2026-10-24-temporal-next-actions/normal-auth-exit.txt)。用户之后提供指定模型凭据，最终改用仓库既有真实 Electron 夹具与产品网关完成验证；不据此宣称独立打包入口的退出问题已解决。

直接模型首轮生成了正确复盘，但断言误读了任务字段 `model`，随后又把网关任务命名空间误当厂商命名空间。现断言公开字段 `modelId` 的实际投影值 `evowork/deepseek-flash`，并对实际厂商请求精确验证 `deepseek-flash` 与端点；未放宽日期、指数、分类或建议断言。见[字段失败](assets/2026-10-24-temporal-next-actions/direct-metadata-failure.txt)、[命名空间失败](assets/2026-10-24-temporal-next-actions/gateway-namespace-failure.txt)。首轮门禁发现既有类型路径错误；一次临时夹具把运行目录放进源码树触发 lint，现复用标准系统临时目录。未删检查或扩充超时掩盖失败。

最新信息修复属于 Agent 指令与行为验证，不是宿主自动事实核验。只测试用户指定模型的两份离线快照，未验证实时搜索、交易所日历服务、任意问法或所有模型；没有对原问题做统计性失败率对照。没有修改内核、替换 `/Applications/EvoWork.app`、发布安装包或升级版本。

## 复现

仓库根执行；按既有隐藏 stdin/进程环境机制提供 `EVOWORK_UI_MODEL_KEY`，不把凭据写进命令或文件：

```bash
EVOWORK_UI_MODEL_PRESET=deepseek-flash node node_modules/@playwright/test/cli.js test latest-information.real.spec.mjs --project=real --retries=0
node node_modules/@playwright/test/cli.js test next-actions.spec.mjs composer.spec.mjs --project=fake --retries=0
pnpm run check
pnpm run build
```
