# 设置页 · MiMo 实模型 Playwright 验收

2026-10-20 已补测并修复默认预算执行、耗尽暂停、明确追加与结束路径，见[预算暂停实模型验收](2026-10-20-budget-mimo.md)。本篇保留 2026-10-19 当时的范围与边界。

2026-10-19，macOS arm64。按用户指定的 `mimo-v2.6-flash` 与 `https://api.xiaomimimo.com/v1`，使用真实 Electron、preload、宿主网关和发货内核。最终 **2/2 通过，1.3 分钟，Playwright 零重试、零跳过**；完整 `pnpm run check` 退出 0，**2980 项通过、2 项既有跳过**。

本轮只新增实模型窗口用例、说明和验收证据，没有修改前轮设置页实现或产品模型适配。前轮确定性布局、图片与记忆回归继续见[原型落地验收](2026-10-19-settings.md)。

## 实际结果

| 旅程 | 验证结果 | 证据 |
| --- | --- | --- |
| 模型、分类、记忆 | 默认对话标签；修改弹窗显示指定接口；点击已保存模型的连接检查，得到“通了：这个模型现在可以用。”；记忆开关更改后刷新仍保留，再恢复原值；960/480 宽七分类逐项切换、标题正确、页面无横向溢出 | [模型证据](assets/2026-10-19-settings-mimo/models-evidence.json) |
| 预算草稿与保存 | 输入 200000 后失焦，宿主偏好未改变；点击新建任务弹出未保存确认，取消后保留草稿；明确保存后刷新仍为 200000；随后可以创建并完成真实任务 | [预算证据](assets/2026-10-19-settings-mimo/budget-evidence.json) |
| 真实执行 | 两项各生成八个随机整数，只放在本机 `settings-input.json`，不在提示词里提供答案。模型自行运行 Python、写出 JSON、登记并展示文件；测试核对命令历史、准确结果、completed 回合、最终回复和 idle 状态 | [机器总览](assets/2026-10-19-settings-mimo/summary.json) |
| 网关与内核 | 收集证据时的 14 次已观测请求均为指定模型，端点均为 `https://api.xiaomimimo.com/v1/chat/completions`，14 个 HTTP 状态全部 200，无记录的传输错误；两次内核启动、运行中意外退出 0，夹具未发现网关泄漏 | [窗口日志](assets/2026-10-19-settings-mimo/playwright.log)、[模型生命周期](assets/2026-10-19-settings-mimo/models-lifecycle.json)、[预算生命周期](assets/2026-10-19-settings-mimo/budget-lifecycle.json) |
| 全仓检查 | 格式、lint、类型、2980 项测试、内核补丁预算、协议形状与许可检查全部通过；2 项跳过为既有用例 | [完整日志](assets/2026-10-19-settings-mimo/full-check.log) |

第一项输出 `{"sum":2346,"max":826}`，第二项输出 `{"sum":3905,"max":937}`，均与各自随机输入的独立计算一致。第二项中，MiMo 首次生成的 Python 把结果计算误缩进到循环中，触发 `ValueError`；模型自行修正缩进后命令退出 0、结果正确。历史与截图保留这个失败步骤，最终通过不表示所有中间工具调用都一次成功，也不把模型自行修正算成 Playwright 重试。

## 过程修正

初轮 **1 通过、1 失败**：第二项已完成文件与页面断言，但取上游证据时有 10 个 request、9 个 response，最后一次请求仍在途，立即比较数量导致失败。原始[失败日志](assets/2026-10-19-settings-mimo/initial-observation-race.log)保留。

修改的只是观测时机：收集证据前，按进程与请求 ID 等待每个已发请求有结果，最长 60 秒；随后仍要求请求/响应数量相等、正确模型/端点、所有状态 200、无传输错误。未返回请求依然失败，没有放宽页面、文件、回合或网络结果断言。复跑最终 2/2。元数据观测不记录请求正文，未据此将该后台请求精确归因到某一种后台任务。

## 截图

以下最终截图均已查看：

- [1280 宽：模型连接成功](assets/2026-10-19-settings-mimo/real-settings-model-connected.png)
- [960 宽：顶部分类选择器](assets/2026-10-19-settings-mimo/real-settings-model-960.png)
- [480 宽：模型布局](assets/2026-10-19-settings-mimo/real-settings-model-480.png)
- [预算草稿离开确认](assets/2026-10-19-settings-mimo/real-settings-budget-guard.png)
- [预算保存并刷新后](assets/2026-10-19-settings-mimo/real-settings-budget-saved.png)
- [第一项真实文件结果](assets/2026-10-19-settings-mimo/models-task.png)
- [第二项真实文件结果与中途失败记录](assets/2026-10-19-settings-mimo/budget-task.png)

## 复现与边界

先经隐藏输入安全注入 `EVOWORK_UI_MODEL_KEY`，再运行：

```bash
EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash node node_modules/@playwright/test/cli.js test settings.real.spec.mjs --project=real --retries=0
pnpm run check
```

模型元数据由隔离 HOME 的 `models.toml` 注册，密钥仅经隐藏 stdin、进程环境进入宿主和网关；没有将这把密钥填入 renderer、写入源码或持久化凭据库。截图中“未保存密钥”表示隔离夹具的凭据库没有保存密钥，与环境变量方式的真实连通性检查是两回事。未选择明文保存。源码、日志和验收产物的精确凭据扫描 **0 命中**，见[扫描结果](assets/2026-10-19-settings-mimo/credential-scan.json)。

观测复用测试专用 `EVOWORK_UI_FOLLOW_UP_WIRE`，仅包装 fetch 记录端点、型号、时间和 HTTP 状态，不修改请求/响应或伪造工具结果。合成输入只在隔离工作区，不上传用户项目文件；任务完成和正确文件结果同时验证，不能只凭 HTTP 200 判成功。

本轮预算仅验证偏好保存与后续任务正常运行，不覆盖预算耗尽停机、并发准入或宣布默认预算的执行接线已完成。未通过 UI 新增/保存真实密钥，未验证系统钥匙串、实际图片生成、企业账号、整个 App 退出重开、Windows/Linux 或签名安装包。本轮没有发布安装包或重启用户日常使用的应用。
