# 合并 #20（办公技能：改稿 · 分析 · 批量文件）与评审后的修复

2026-10-22，macOS arm64。#20（`cursor/office-skills-connectors-6ac7`）合进 `ui_based_codex`（合并提交 82390c3），随后按评审意见在同一分支上修。#20 带来：documents / presentations / spreadsheets 的「抽回内容 JSON」、documents 导出 PDF、七个新技能（minutes · weekly-report · email-draft · data-analysis · diagrams · scan-to-ledger · batch-files）、办公场景指令点名浏览器连接器。

## 评审发现与修复

| 范围 | 发现 | 修复（提交） |
| --- | --- | --- |
| PDF 导出 | 直接在用户权限下跑 LibreOffice：能联网、能写任意位置、宏与外部链接没锁、无超时 | 与预览转换器同一套隔离：seatbelt 禁网、只写临时目录、最小环境变量、45 秒超时杀整个进程组、25 MB 上限、校验 `%PDF-` 头、关宏、外部链接永不更新；转换失败退出码 5、不留 PDF；**其他平台拒绝、不裸跑**。已在内核沙箱里时 seatbelt 套不上（`sandbox_apply` EPERM），只在这一种报错下改为在那一层里直接跑（5e92bf6） |
| 改稿写回 | 写回会静默覆盖原文件；抽取认不出的内容静默丢掉 | 写回要 `--overwrite`；抽取列出丢了什么（`dropped`），默认停下，用户同意后才 `--allow-lossy`（5e92bf6）。documents / presentations 补认结构化文档标签、目录、编号列表、合并单元格、组合形状、软换行等（fa0cbe7），spreadsheets 做到往返一致或报出丢失（66698dd） |
| 场景指令 | 每个办公回合都追加一段浏览器连接器说明 | 删掉；Craft 指令已经覆盖（f6ed5f2） |
| batch-files | 工作区可指向任务目录之外；移动可能覆盖；Mac 上只差大小写 / Unicode 写法的名字没当同名；中途失败不撤回 | 工作区取真实路径且必须在任务目录内；不覆盖的 link + unlink 移动；NFC + casefold 判同名；倒序撤回，撤回也失败时退出码 6 并逐条列出（a123b2c、5b77eea） |
| 检查器 | scan-to-ledger 按字面比金额；纪要不看否定词与缺席；data-analysis 不查来源是否存在 | 金额按值核对（符号、万 / 亿 / 千、日期数字排除、读法有歧义时报「无法判定」）；否定词与缺席人；待定期限；来源存在且属于声明的来源（7aa437d）；渲染上限改读 documents 的 schema（c66f914） |
| 类型检查 | 8 个包的测试从没被类型检查（缺 `tsconfig.spec.json`），runtime-installer 的测试里有类型错误 | 补齐并修掉；`scripts/typecheck.mjs` 改为「有 TS 测试却没有 spec 配置就失败」—— 守的是这一类，不是这 8 个（787ce22） |
| 测试跳过 | 「无隔离平台拒绝转换」两条测试在 macOS 上跳过，开发机上永远跑不到 | 新夹具 `_shared/test-fixtures/other-platform/` 把 `sys.platform` 改成 `linux`，两条在任何机器上都跑；documents 那条另断言转换器根本没被调用（86534ef） |

技能说明与 [08 §5.2.1](../design/08-artifacts-and-ingest.md) 同步（a4a8024、67805e7）：中间文件进任务的临时目录、抽取与写回规则、PDF 的隔离与残余风险。

## 验收

- 原版 `pnpm run check` 退出 0，**3286 项通过、2 项既有跳过**（runtime-installer 的真机安装，要 `EVOWORK_INSTALL_E2E=1`）。合并前是 3073 项；#20 引入的两条平台跳过已改为强制构造环境。
- 反例：临时把 `render.py` 的平台判断改成永不拒绝，那两条测试**都变红**；还原后通过。
- PDF 隔离在测试里用假转换器核对：参数与一次性配置（关宏、外部链接锁定）、禁网（假转换器去连本机 HTTP 服务，命中只有对照请求那一次）、嵌套沙箱回退（在 `sandbox-exec` 里跑渲染器）、转换失败与非 PDF 输出不落盘。
- `pnpm run build` 退出 0；确定性真窗口回归（hook · 技能安装 · 视图 · 输入框）**15/15**。
- 全量测试里 `apps/desktop` 的测试偶有超时：本轮 5 次全量红过 3 次，每次是不同的用例、分在 5 个文件里（`app.test.tsx` · `settings.test.tsx` · `image-settings.test.tsx` · `service-host.test.ts` · `kernel-policy-install.test.ts`），第一次红的那条单独重跑通过。本轮提交没有改 `apps/desktop`，与 10-22 早先记的那条是同一类负载下的时序问题，未处理。

## 未验与边界

- **没有对真实模型跑过**：新技能的路由（纪要先走 minutes、台账走 scan-to-ledger 等）、抽取后的改稿流程、`--allow-lossy` 的征求同意，都只有单测。
- **没有真 LibreOffice 的转换验收**：测试用的是假转换器；真机转换质量、45 秒是否够大文档用，都没测。
- 内核默认档（请求批准）下 seatbelt 套不上，转换在内核那一层沙箱里跑：禁网、限写成立，**读不受限**；靠外部链接永不更新降低风险。
- 抽取仍有上限：表格超过 10 列、PPT 单元格超过 40 字、一页超过 6 条要点时停下；Markdown 的 setext 标题与缩进代码块不认；抽取因丢失被拒时，已抽出的图片留在临时目录。
- batch-files 的「不跟随符号链接」在检查与移动之间有极小的竞态窗口。
- scan-to-ledger 仍判不了：同一行两个金额且都没有日期、`出租车-128.00` 这类连写负号、后置否定。
- 改动要重新打包才进入安装包。
