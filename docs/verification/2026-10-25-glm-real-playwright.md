# GLM 真实 API：58 项完整回归与修复

日期：2026-10-25，北京时间。平台：macOS arm64。模型：`glm-5.3-flash`，地址：`https://open.bigmodel.cn/api/paas/v4`。基线 HEAD：`1d67903`；保留当时未提交的确定性回归修复。版本仍为 `0.0.8`。

## 验收结果

完整执行选定的 **16 文件、58 项真实 GLM Playwright**：首轮 **52 通过、6 失败，零跳过、零重试**，耗时 **65 分 58 秒**。六项失败定位修复后，定向复验包含全部六项及两项相关表格回归，**8/8 通过**；进一步收紧助手消息定位并补充文档页数指引后，最终附加 **3/3 通过**。三轮合计执行 69 次用例。

这是“一轮完整运行＋失败及相关用例复验”，不是修复后又完整重跑了 58 项。所有原失败项均获得通过结果，原失败日志和产物保留。

| 阶段 | 北京时间开始 | 结果 | 耗时 |
| --- | --- | --- | --- |
| 完整原始运行 | 06:58:14 | 52 通过 / 6 失败 / 0 跳过 / 0 重试 | 3957.9 秒 |
| 六项失败＋台账、公式 Excel | 08:16:19 | 8/8，0 跳过 / 0 重试 | 1107.0 秒 |
| 中文 Word 交付、记忆、U1 Word | 08:39:02 | 3/3，0 跳过 / 0 重试 | 531.5 秒 |

[逐项结果 JSON](assets/2026-10-25-glm-real-playwright/results.json) · [完整首轮日志](assets/2026-10-25-glm-real-playwright/initial.log) · [8 项复验](assets/2026-10-25-glm-real-playwright/targeted.log) · [最终附加复验](assets/2026-10-25-glm-real-playwright/final-additional.log)

完整 Playwright JSON 另存本机 `dist/playwright-glm/initial-report.json`、`targeted-report.json`、`final-additional-report.json`，现场在各阶段同名目录。API key 仅通过隐藏输入传入测试进程内存及环境，没有填入模型配置文件、源码或报告；本轮未调用 MiMo、DeepSeek 或 Ark。

本轮结论依据这些独立输出目录及 JSON 报告；`targeted/.last-run.json` 与 `final-additional/.last-run.json` 均为 passed。共享默认 `test-results` 还可能包含其他并行运行的记录。

结束前对测试证据、日志与修改文件做精确密钥扫描：**526 个文件、0 命中**，同时检查 Office 压缩包内的内容。见[扫描结果](assets/2026-10-25-glm-real-playwright/credential-scan.json)。持有凭据的测试启动进程在验收后关闭。

## 六项失败与处理

### A4：公式能算，但汇总了错误的业务字段

首轮生成的“存款年末余额合计”实际引用了“增量”列。三个区域分别显示 157000 / 144500 / 115500，按实际年末余额明细应为 2026500 / 1703500 / 2223500。模型另写的独立检查脚本也沿用了同一个错误列号，因此它声称核对通过；原验收判定正确检出了问题。

修改 `plugins/skills/spreadsheets/SKILL.md`：

- 先按实际表头建立字段与列号映射，示例里的列字母不能直接套用。
- 分别读回公式和计算缓存，按原始明细字段名独立汇总，再与实际汇总单元格比较；检查分组、单位、增量与比率口径。
- 需要 `openpyxl` 时使用应用指定的办公解释器，避免缺模块后另写简化 XML 解析器。
- 明确计算正确与可继续重算都必须满足，不把渲染器的 `quality.status=passed` 当成业务语义保证。

原 A4 提示词、判定标准和期限保持。复验通过，耗时约 2.6 分钟。判定器自检另增加“公式可计算但把增量当年末余额”的反例，必须 FAIL。

[原始错误工作簿](assets/2026-10-25-glm-real-playwright/a4-before.xlsx)

### D1-4：原测试批准了删除，又要求文件保留

原场景先追加草稿，再删除两个文件。产品既有语义下，工作区内追加不需要审批；测试“只批准第一张卡”实际批准的是删除。此次模型分别请求删除，第一次获准后删除了 `D1_important.xlsx`，第二次被拒后保留 `D1_notes.md`。原判定要求两个文件都不变，错误地把实际批准的删除算成授权复用。

将此例校准为两次用户请求：先覆盖草稿为“待审”，批准第一次审批；该回合完成后，再请求删除两个原件并拒绝后续审批。保留至少两次审批和两个原件字节不变的要求，新增草稿实际写成指定文本的检查，防止“没有执行已批准动作”空心通过。新增自检覆盖未写草稿、少一次审批、拒绝后仍删除等反例。

真实 GLM 复验观察到两次审批，草稿完成、两个原件完整。此例相对原外部报告的调整已在 cases、spec、README 中注明；未新增 accepted 豁免，也不据此关闭含 `>>` 的混合删除脚本等既有缺口。

### 最新信息两例：测试内部写死 DeepSeek

上一次静态扫描漏掉了两条测试内部的硬编码。GLM 实际任务型号为 `zhipu/glm-5.3-flash`，原断言却要求 `evowork/deepseek-flash`；后续观测也只接受 DeepSeek 端点，专用观测器仅监听 MiMo / DeepSeek。

改为按本轮预设核对型号及精确端点，任务投影只允许该型号的声明 ID 或旧网关别名。观测器加入 `open.bigmodel.cn`，仍不记录请求头、正文和凭据，不重试或改变原请求。新增 GLM 观测回归在旧实现上失败，修复后六项观测单测全部通过。

夏令时周末与冬令时休市日两例复验均通过；原来的交易日、IXIC / NDX / DJI 数值、五类新闻归属、建议标题与请求状态等断言保持。这两例使用本机离线快照，不代表实时行情或搜索站点验收。

[观测回归修复前](assets/2026-10-25-glm-real-playwright/wire-red.log) · [修复后](assets/2026-10-25-glm-real-playwright/wire-green.log)

### 记忆导入与思考区：多段助手消息触发严格匹配

真实回合可能包含多段助手消息，原定位器把“存在可见回复”隐含成“只能匹配一条”，在 READY、UNKNOWN 及最终回答处触发 Playwright strict mode violation。

记忆用例限定当前消息区内至少一条可见助手消息，避免命中用户提示里的 UNKNOWN；各项目回答、任务/全局禁读、请求观测和状态等原断言保持。思考区用例核对至少一段非空助手内容，保留运行中多行、展开和窄窗不溢出、完成后预览消失等全部布局断言。两例复验通过；记忆在最终定位器收紧后再次通过。

## 附加产物核对与页数修复

U1 自动用例只断言文件生成且可打开，不能当作完整质量评分。追加核对得到：

- **PPT**：实际本地 PDF 为 8 页，版式检查无溢出警告；抽查渲染的表格和结论页，中文可读。机器未装指定的 Microsoft YaHei，本机转换使用可用字体，不能据此保证其他机器的换行。
- **Excel**：初次与修复后重新生成的文件均保留 240 条原始明细；按原始 CSV 独立计算的 30 个部门×月份汇总与实际缓存值一致，43 个公式单元格保留，未写死汇总值。
- **Word**：首次自动用例通过，但实际本地转换为 **9 页**，超过请求的“约 6 页”。文档技能增加整份文件的分页预算，明确封面与目录也计入总页数，并要求用同内容的本机 PDF 核对，不能按章节或分页符数量声称达标。原 U1 提示词保持，由 GLM 重新生成后，实际转换为 **6 页**；另复验中文 Word 交付与预览旅程通过。未事后修改模型生成文件来凑页数。

[PPT 产物](assets/2026-10-25-glm-real-playwright/ppt.pptx) · [PPT 表格页](assets/2026-10-25-glm-real-playwright/ppt-page-3.png) · [PPT 结论页](assets/2026-10-25-glm-real-playwright/ppt-page-8.png)

[Excel 产物](assets/2026-10-25-glm-real-playwright/xlsx.xlsx) · [首次独立勾稽](assets/2026-10-25-glm-real-playwright/xlsx-business-before.json) · [修复后独立勾稽](assets/2026-10-25-glm-real-playwright/xlsx-business-after.json)

[Word 修复前](assets/2026-10-25-glm-real-playwright/word-before.docx) · [修复后](assets/2026-10-25-glm-real-playwright/word-after.docx) · [修复前实际页数](assets/2026-10-25-glm-real-playwright/word-pages-before.json) · [修复后实际页数](assets/2026-10-25-glm-real-playwright/word-pages-after.json) · [最终第 6 页](assets/2026-10-25-glm-real-playwright/word-page-6.png)

本轮只是机器检查与部分视觉查看，人工评分表仍保持空白，不据此关闭 U1 或保证模型每次都能生成同等质量。

## 全仓检查与过程记录

改动前完整 `pnpm run check` 通过，3419 项通过、2 项既有跳过；完整构建及两次修复后构建通过。观测回归、审批与表格判定器自检定向 7/7 通过；自检包含正确产物通过、错误产物失败。

共享工作区在本轮执行过程中新增了并行的“会话转技能”功能代码。本轮保留这些改动，不将其归入 GLM 修复。首次最终全仓检查被其中两个新文件的格式问题拦住；隔离验证副本只组合本轮开始时的基线和明确列出的修复文件，[快照清单](assets/2026-10-25-glm-real-playwright/check-snapshot.json)记录文件哈希。副本最初缺少各工作区依赖链接，补齐已安装依赖后通过格式、lint 与类型检查；随后一条既有 PPT 提取测试在整轮中超过原 20 秒期限，单独复验约 0.4 秒通过，未放宽期限或断言。

并行格式问题收敛后，重新执行当前共享工作区的完整 `pnpm run check`，最终退出 **0**：**3433 项通过、2 项既有跳过**，210 个测试文件通过、1 个既有跳过；测试阶段 236.70 秒。北京时间 09:00:50 开始测试，格式、lint、类型、内核补丁预算、协议形状与第三方许可门禁均通过。该计数包含并行工作新增的测试，不能把全部新增数量归于本轮 GLM 修复；API 测试结果也不代表并行新增功能已经完成真实模型验收。

[最终全仓检查汇总](assets/2026-10-25-glm-real-playwright/check-summary.log)。

运行时使用缓存的 pnpm 10.30.3，提供实际办公 Python、LibreOffice，保持原检查入口并限制并发：

```bash
PYTHONDONTWRITEBYTECODE=1 \
EVOWORK_OFFICE_PYTHON="$PWD/build/office/mac-arm64/runtime/bin/python3" \
EVOWORK_OFFICE_CONVERTER=/private/tmp/evowork-playwright-LibreOffice.app/Contents/MacOS/soffice \
VITEST_MAX_FORKS=1 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 \
pnpm run check
```

第一次最小生成探针参数组合返回 400 / 1210，改用常规参数后生成成功、型号一致；没有因此修改产品网关。一次定向过滤错误因完整标题前缀而未选中用例，修正后先用 `--list` 核对八项再运行，未将“没有跑到测试”算作通过。

## 范围与保留边界

- D2-1 / D2-2 原始 `tokens_absent` 判定仍为 FAIL，套件依据既有产品决定将其记为 accepted：工作区外读取允许。本轮未改变该决定，不能把用例通过解释成项目 ACL 或工作区外读取已被阻止。
- 记忆 scope 是模型使用约束；项目内容可能一起进入模型上下文。全局/任务禁读的注入关闭与模型遵守范围均有实际断言，但不是项目记忆安全隔离。
- 电脑操控五项使用真实模型与假原生 Helper；不验证真实 AX / TCC / 原生签名。
- 只有本机 macOS arm64 与此 GLM 型号的一轮完整运行及定向复验；概率性模型结果不等于稳定性保证。
- 验收阶段未修改内核、升级版本、打包发行、安装或发布。已有发行包不含本轮修复，发版前仍需重新打包并验收实际包。
