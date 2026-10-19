# 默认预算耗尽暂停 · MiMo 实模型验收

2026-10-20，macOS arm64。继续使用用户指定的 `mimo-v2.6-flash` 和 `https://api.xiaomimimo.com/v1`，经过真实 Electron、preload、宿主网关与发货内核。最终实模型 Playwright **2/2，1.8 分钟，零重试、零跳过**；既有目标与设置窗口回归 **7/7，43.2 秒**；完整 `pnpm run check` **2990 项通过、2 项既有跳过，退出 0**。

## 发现与修复

1. **默认预算仅保存，没有应用到新任务。** 修复前，在设置页保存 1 token 后启动真实 MiMo 普通任务，公开 `getTaskGoal` 返回空，预算断言失败。宿主现在把已保存默认预算传到新任务，适配层在首轮前用原生 `ThreadGoal.tokenBudget` 初始化暂停目标，正常桌面回合启动后才激活。初始化失败不会不限预算启动模型。未成功发送草稿的重试保留原预算，已有任务的追问不被全局默认值覆盖；不限任务不隐式创建持续目标。
2. **固定小额追加不足以恢复实际工作。** 第一轮接线修复后，耗尽暂停和结束路径已通过；追加按钮仍按旧算法自动增加少量 token。本次从已用 5416、预算 1 变为总预算 6416，下一轮用量到 7017 又暂停，结果文件未交付。现改为先打开既有目标与预算编辑区，用户填写新**总预算**，高于已用量才允许“保存预算并继续”；留空明确选择不限。打开编辑和取消都不激活目标、不发模型请求，不再按固定数值自动分配额度。
3. **耗尽条仍显示原生绿色。** 截图复现后，显式设置 Electron 进度条样式，使用既有 warning token；正常与耗尽状态的最终截图均已查看。

修复没有改动内核源码、内核补丁或模型网关适配，没有自建预算计量器。预算任务沿用内核目标机制：目标为用户需求，完成后由模型确认目标完成；全局默认预算作用于新任务，已经运行的任务保留各自预算。

修复前证据：[默认预算窗口失败](assets/2026-10-20-budget-mimo/before-default-ui.log)、[默认预算回归失败](assets/2026-10-20-budget-mimo/before-default-regression.log)、[追加预算窗口失败](assets/2026-10-20-budget-mimo/before-append-ui.log)、[追加预算回归失败](assets/2026-10-20-budget-mimo/before-append-regression.log)。权威状态见[默认预算缺失](assets/2026-10-20-budget-mimo/before-default-evidence.json)、[旧追加算法再次耗尽](assets/2026-10-20-budget-mimo/before-append-evidence.json)。过程失败没有算入最终通过，也未放宽暂停、文件、回合或网络断言。

## 最终行为

| 检查 | 追加预算旅程 | 结束任务旅程 |
| --- | --- | --- |
| 设置保存与实际预算 | 设置页保存 1 token，普通任务的内核预算确认为 1 | 同左 |
| 真实耗尽暂停 | `budgetLimited`，已用 13476，1 个回合，未生成结果文件，页面 idle | `budgetLimited`，已用 5225，1 个回合，未生成结果文件，页面 idle |
| 刷新保留 | 刷新并打开原任务，观察 5 秒：仍耗尽，回合 1、请求 2 均不增加，结果文件不存在 | 同左 |
| 明确动作之前 | 打开追加编辑、填数后取消，再打开仍为原预算；继续观察 3 秒，状态仍耗尽、请求数不增加 | 直接选择“结束任务” |
| 明确动作之后 | 保存总预算 100000，随后第 2 回合完成；真实读取随机整数 379、721，Python 计算并生成 `{"sum":1100}`，模型确认目标 complete，页面 idle | 权威状态 complete；再观察 5 秒仍只有原回合、原请求数，无结果文件 |
| 上游证据 | 8 次请求，全部为指定模型及接口，HTTP 全部 200 | 2 次请求，同左 |

两项合计记录 **10 次**上游请求，端点均为 `https://api.xiaomimimo.com/v1/chat/completions`。每个 request 按进程与序号都配到 HTTP 200 response；两次内核启动，运行中意外退出 0，夹具未发现网关泄漏。完整权威目标、公开任务历史、文件内容和请求元数据见[追加证据](assets/2026-10-20-budget-mimo/extend-budget-evidence.json)、[结束证据](assets/2026-10-20-budget-mimo/finish-budget-evidence.json)、[机器总览](assets/2026-10-20-budget-mimo/summary.json)。

追加后的 MiMo 首次把输入数组当成 `a`/`b` 对象读取，Python 报 `TypeError`；模型自行检查实际文件并修正，最终结果正确。这一次中间工具失败保留在任务历史中，最终通过不表示每条工具命令一次成功，也不是 Playwright 重试。

## 检查与截图

- [最终完整桌面构建](assets/2026-10-20-budget-mimo/final-build.log)退出 0。
- [实模型最终 2/2](assets/2026-10-20-budget-mimo/final-real-ui.log)，[既有窗口 7/7](assets/2026-10-20-budget-mimo/existing-ui.log)。后者覆盖目标生命周期、替换确认、无目标控制、目标预算编辑/恢复，以及设置分类、窄窗、草稿保护和保存恢复。
- [完整检查](assets/2026-10-20-budget-mimo/full-check.log)退出 0：2990 项通过、2 项既有跳过，格式、lint、类型、内核补丁预算/协议形状及许可检查通过。回归包含新任务预算传递、已有任务不重置、草稿重试保留预算、预算初始化失败拒绝执行及非法预算在创建任务前拒绝。
- 已查看关键截图：[耗尽暂停与警示色](assets/2026-10-20-budget-mimo/extend-budget-limited.png)、[新预算保存前](assets/2026-10-20-budget-mimo/extend-budget-add-confirm.png)、[明确追加后完成](assets/2026-10-20-budget-mimo/extend-budget-final.png)、[刷新仍耗尽](assets/2026-10-20-budget-mimo/finish-budget-restored.png)、[结束后不再执行](assets/2026-10-20-budget-mimo/finish-budget-final.png)。

## 复现与边界

先通过隐藏输入安全注入 `EVOWORK_UI_MODEL_KEY`，不把密钥写入命令、脚本、配置或页面：

```bash
EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash node node_modules/@playwright/test/cli.js test settings-budget.real.spec.mjs --project=real --retries=0
node node_modules/@playwright/test/cli.js test goal.spec.mjs settings.spec.mjs --project=fake --retries=0
pnpm run check
```

测试在隔离 HOME 关闭本地记忆，避免后台记忆请求干扰“暂停后零新请求”的断言；不影响用户日常配置。检查点脚本只控制本机输入就绪时间，计算数据是临时随机整数；模型自主执行、报错修正、计算、文件交付和完成判断均为真实行为。没有伪造回复、usage、预算状态或工具输出。观测仅记录模型、端点、时间、状态及序号，不保存鉴权或上游正文。密钥只经隐藏 stdin 和进程环境传给宿主与网关；源码、日志和测试产物精确扫描 **0 命中**，见[凭据扫描](assets/2026-10-20-budget-mimo/credential-scan.json)。

**预算由内核在工具/回合边界计量与收尾，不保证精确停在第 N 个 token。** 本例预算为 1，耗尽时实际累计高于 1，表格保留真实数值；通过的是耗尽后不再自动执行实质任务，以及明确追加/结束的控制行为。未声称在途 API 请求可逐 token 截断或已经发生的费用可以回滚。

本轮验证页面刷新恢复，未验证预算状态跨整个 App 退出重开的恢复、并发准入、其它模型或其它平台。仅验 macOS arm64，未发布或安装新版本，也未改动用户日常应用的配置。
