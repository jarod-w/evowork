# 2026-10-17 · WorkBuddy 文本记忆导入验收

## 发货内核接口核实

基线为 macOS arm64 发货二进制，commit `d583e73c4d1204f1e9f654ef87065e9f0dd07ac7`，SHA-256 `d4e0b99dd4622f5f32b45f5f92a5b20c7bbdff7c31c3e817f9956a09842f375d`。未改上游源码或内核二进制，补丁仍只有 P6。

| 候选 | 实测与源码结论 | 处理 |
| --- | --- | --- |
| memory/write、memory/import、memories/add_ad_hoc_note、tool/call RPC | 发货进程以 unknown variant 拒绝；协议方法表无这些方法 | 不虚构通用写入 RPC |
| externalAgentConfig/import | 记忆仅支持 Claude Code；providerId 只作归因，未知 migrationSource 回退默认来源 | 不伪装 Claude 来源，不生成伪造 session/cwd 文件 |
| memories.add_ad_hoc_note | 正式记忆扩展注册的模型工具，需 memories + use_memories + dedicated_tools；创建追加式 note，不覆盖现有文件 | 显式授权的临时导入会话调用 |
| mcpServer/tool/call | memories 不是 MCP server，实际返回 unknown MCP server | 不用 MCP 调用冒充原生工具调用 |
| experimentalRawEvents | 能显示工具参数与结果，但字段明确标注 internal use only；常规 thread/read 只有用户和模型回复 | 不纳入产品依赖 |
| PostToolUse + hook/completed | 成功原生工具输出触发正式 hook；公开通知保留来源、顺序及 context entry | 已受信任的产品策略 hook 计算文件名/正文哈希回执；宿主精确核对 |

当场核对源码：`app-server-protocol/src/protocol/v2/thread.rs:161`（内部 raw 标记）、`thread_data.rs:106`（可自定义 threadSource）、`hook.rs:103`（公开完成回执）；`ext/memories/src/extension.rs:146`（工具准入）、`tools/ad_hoc_note.rs:52`（模型写入工具）、`local/ad_hoc_note.rs:17`（create_new、write_all）；`core/src/tools/registry.rs:695`（仅成功执行 PostToolUse）；`state/src/runtime/memories.rs:24`（六小时冷却）。路径均相对 `build/.kernel-src/codex-rs/`。

独立探针 `node scripts/verify-workbuddy-memory.mjs` 使用隔离 HOME、合成资料、本机确定性网关，实际验证写入及公开 hook 回执，不启用 raw events。完整工具处理器来自构建后的产品 policy 包。回执不含记忆正文；生产代码不检查原生文件，白盒检查只在探针及 test-support 进行。

## 产品实现与边界

设置 → 导入和 `/import` 选择「WorkBuddy 文本」。支持粘贴及本地选择 UTF-8 Markdown/TXT，最多 64 KiB；预览、编辑、模型与个人/项目归属选择后才提交。取消不创建任务、不发送模型请求、不写记忆。模型与项目在主进程重新核验，个人导入使用宿主登记的临时环境；只读临时会话不运行记忆提取，完成后取消订阅并清理临时环境。

确认页说明所选模型及凭据来源、正文经模型服务发送及用量、读取/生成全局设置保持、整理延迟、不自动同步。原生文件名包括内容与 scope 摘要；宿主 meta 仅保存哈希、scope、文件名、时间和状态。来源或 scope 不同分别登记，同一规范化文本/scope 不重复提交。

只有受信任的同步 PostToolUse 回执匹配来源文件、hook 顺序、原生文件名和正文哈希，且回合正常完成，才显示「资料已保存」。模型声称成功、正文改变、不可信 hook、断线和超时均不能产生成功状态。写前持久化 pending；下次打开将未完成批次视为 unknown，不自动重放。超时尚未确认停止时阻止其他记忆写操作，用户重开应用后核对，产品不主动重启内核。Claude 同步/导入与文本导入、清空互斥；整体清空成功后才清除文本导入的去重登记。

ad-hoc 写入不会主动 enqueue 整理。后续普通任务启动内核管线，可能受原生六小时冷却、配额等限制；资料保存不代表整理完成或当前任务热更新。修改后的快照追加，旧知识不会自动遗忘。项目 scope 是使用指导，当前仍无严格跨项目不可见 ACL。本轮不读取真实 WorkBuddy 私有目录、登录账号或接云端同步，也不声称能完整导出 WorkBuddy 所有记忆。

## 验证

独立原生探针通过；新增策略与适配层边界用例 **12 项通过**，涵盖可信回执、仅模型声称成功、正文变化、错误来源/顺序、缺失 hook、格式/大小、去重/scope、断线与超时不重放。完整 `pnpm run check` 退出 0：**182 个文件通过、2910 项通过，2 项既有运行时安装条件跳过**；格式、lint、测试类型、补丁预算、协议及许可证检查通过。完整桌面构建退出 0。

WorkBuddy 五项真实 Electron + 发货内核 Playwright 已通过：文件/文本预览与取消、个人和项目落盘、范围/内容去重、读取设置保持、设置和命令入口、历史重开、窄窗、原生 note 后续实际整理、新任务收到记忆、禁读无注入、模型只声称成功仍为未知、导入中受控内核终止与未知批次不重放、无效 UTF-8/超大文件/不可用模型和 HTML 不执行。后续整理使用实际 note，不预写摘要或修改作业时间戳。

最终完整记忆回归矩阵 **24/24（4.8 分钟，零重试、零跳过）**，含 5 项 WorkBuddy 及 19 项既有记忆用例。随后仅调整表单布局和长历史换行、补充快照追加说明，重新构建渲染层并专项复验 **5/5（14.7 秒）**；样式规则 31 项、相关 lint 与格式检查通过。模型为本机确定性网关，证明路由、原生工具执行、回执、整理与上下文传递，不证明真实厂商模型整理质量或严格项目隔离。

## 内核生命周期与证据

完整矩阵记录 24 份用例生命周期、30 次启动、4 次明确故障注入退出，**意外退出 0**。其中三次沿用既有历史恢复/确认前丢失/V2 配置恢复验证，一次为 WorkBuddy 导入中断。样式复验另有 5 份记录、6 次启动、1 次同类明确故障注入、意外退出 0。生命周期均在正常 App 收尾前保存；整应用关闭重开用例显式记录各次关闭前状态。任何未标记的内核退出即使随后恢复，也会导致用例失败；本轮不以重启加速整理。

所有终止均调用当前测试夹具持有的 ChildProcess；未按名称杀进程，未终止用户的 EvoWork 或其他正在运行的内核。独立探针也只有一次启动，观测截止正常收尾前没有退出。

- [原生能力探针](assets/2026-10-17-workbuddy-memory-import/native-capabilities.json)
- [完整矩阵生命周期](assets/2026-10-17-workbuddy-memory-import/kernel-lifecycle.json)
- [样式专项生命周期](assets/2026-10-17-workbuddy-memory-import/polish-kernel-lifecycle.json)
- [WorkBuddy 保存结果](assets/2026-10-17-workbuddy-memory-import/workbuddy-result.png)
- [480 宽度表单](assets/2026-10-17-workbuddy-memory-import/workbuddy-480.png)，已人工查看，控件分行且文本框不再裁切；长内容在弹窗正文内滚动，确认/取消固定可达。

## 发现并修正的问题

第一轮五项中两项失败：临时会话事件进入产品页面，触发原生不支持的队列查询，错误 toast 阻挡后续点击。初次按 thread/start 响应标记会话后仍有一项失败，证明 thread/started 可以先于响应抵达。改为发送公开 threadSource 标记，在启动通知到达时即可识别并隔离内部会话；第三轮 **5/5（15.3 秒）**，没有放宽内容断言或使用强制点击。新增无危险 toast 与任务列表仍为空断言。

受限环境的完整检查曾因回环网络和原生权限测试失败；在允许相应能力的环境重跑。默认 pnpm 启动器尝试获取指定版本失败，pnpm 9 的许可证检查又因本地 store 索引位置失败；最终使用已安装 pnpm 10.33.0、关闭自动版本获取、显式指向已有全量 store，通过检查，没有安装/升级依赖或改写许可证清单。

复现命令（macOS arm64，需要桌面、回环监听与 Swift 缓存权限）：

```bash
node scripts/verify-workbuddy-memory.mjs /private/tmp/evowork-workbuddy-native.json
PATH=/usr/local/bin:$PATH node scripts/build.mjs
PATH=/Users/wangli/Library/pnpm/.tools/pnpm/10.33.0/bin:/usr/local/bin:$PATH npm_config_manage_package_manager_versions=false npm_config_store_dir=/Users/wangli/Library/pnpm/store pnpm run check
node node_modules/@playwright/test/cli.js test workbuddy-memory.spec.mjs memories.spec.mjs memory-import.spec.mjs memory-import-restart.spec.mjs --project=fake --retries=0 --output=/private/tmp/evowork-workbuddy-ui-final
```

以上为确定性验收；以下记录后续真实模型补验。未发布安装包，未改用户正在运行的应用或真实记忆。


## MiMo 真实模型补验

模型固定为用户指定的 `mimo-v2.6-flash`，通过产品宿主网关访问 `https://api.xiaomimimo.com/v1`，内核请求 ID 为 `xiaomi/mimo-v2.6-flash`。密钥只从隐藏 stdin 进入环境，不写入源码、配置、请求观测或证据。隔离 HOME 内使用带随机标记的合成 WorkBuddy 快照，不读取真实 WorkBuddy 私有数据。

Playwright 经 `/import` 的实际 UI 导入个人 Markdown 文件及两组项目文本，验证可信保存状态、原生 note 原文逐字一致、scope 元数据和导入不生成用户任务。普通新任务触发真实模型后台整理，等待实际作业完成；不植入摘要、不使用确定性模型、不修改作业时间、不重启内核加速。新任务再检查项目 cwd、实际回答和请求中的记忆上下文，覆盖 Alpha/Beta、未导入 Gamma、单任务禁读、全局禁读及 Alpha 显式询问 Beta 约定。每个阶段均断言同一个内核进程、无任何运行中退出。

发现与修正：

- 第一轮（2.6 分钟）真实模型写入了笔记，但将原文 JSON 字符串中的内层转义改为实际换行，未通过精确正文哈希校验。UI 如实显示结果未确认，没有误报成功；该轮只有一次内核启动、零退出。改用带内容摘要边界的原文快照，仅工具参数保留一层 JSON 编码，仍逐字校验全部正文，不接受模型口头声明或自动重试未知批次。新增多行中文、引号及字面量转义回归。
- 第二轮（7.7 分钟）三次导入、实际整理、两个所属项目、未导入项目和两种禁读均产生预期证据；在全局禁读任务截图导航时，任务标题被产品截短，测试按完整输入标记定位按钮超时，尚未执行显式跨项目用例及末尾完整断言，因此不记为通过。改用宿主实际返回的任务标题定位，另增加任务实际 cwd 等于项目目录的校验；该轮一次启动、零退出。
- 第三轮三次导入成功，但后台代理返回 `failed_agent`（作业 error，重试额度 3 → 2）。在只读诊断确认后停止仍在等待的 Playwright，记为 interrupted，不能当作通过；未对内核发信号、未修改作业或重放写入。公开状态没有更细原因，不能归咎厂商网络。主证据停留在 TRIGGER 后的 running 快照；终态错误见单独只读观测记录。新增 HTTP 状态码观测（不保存正文/请求头）及作业 error 快速失败，继续以新隔离环境核验。
- 第四轮（1.6 分钟）个人和 Alpha 保存成功；Beta 的模型工具参数只在快照结束标记后增加一个 LF，真实文件中原文、scope 和标记仍完全相同，却被整段哈希判为 unknown。HTTP 观测均为 200，一次启动、零退出。修复仅对匹配结束标记之后的 LF 规范化；原文内的空行、scope、标记、尾部空格及普通非快照文本改变仍拒绝。新增正反边界用例，不自动重放该批次。
- 修复后确定性 WorkBuddy Playwright **5/5（22.3 秒）**；完整构建退出 0。正式完整 `pnpm run check` **2911 项通过、2 项既有跳过、182 个文件通过**，格式、lint、类型、补丁预算、协议形状和许可证均通过。受限沙箱检查因本机网络/原生探针限制失败后停止；首次允许本机能力的检查有一项既有资料库更新异步用例失败，单独复核 8/8，停止受限检查后完整复核通过，未改无关资料库代码。

- [第一轮失败证据](assets/2026-10-17-workbuddy-memory-import/real-first-failure-evidence.json)及[生命周期](assets/2026-10-17-workbuddy-memory-import/real-first-failure-lifecycle.json)
- [第二轮定位失败证据](assets/2026-10-17-workbuddy-memory-import/real-selector-failure-evidence.json)及[生命周期](assets/2026-10-17-workbuddy-memory-import/real-selector-failure-lifecycle.json)

- [第三轮整理失败只读观测](assets/2026-10-17-workbuddy-memory-import/real-consolidation-failure-observation.json)、[最后阶段快照](assets/2026-10-17-workbuddy-memory-import/real-consolidation-failure-evidence.json)及[生命周期](assets/2026-10-17-workbuddy-memory-import/real-consolidation-failure-lifecycle.json)

- [第四轮尾部换行差异证据](assets/2026-10-17-workbuddy-memory-import/real-trailing-lf-failure-evidence.json)及[生命周期](assets/2026-10-17-workbuddy-memory-import/real-trailing-lf-failure-lifecycle.json)


### 最终第五轮：未通过，不以保存成功代替可用性

三份导入均为 `saved`，原生 note 的原文和 scope 校验通过。触发整理的新任务正常完成，但后台作业虽然为 `done`、无错误码、重试额度仍 3，正文只有 162 字符，声称没有 ad-hoc notes；实际三个 note 及原生扩展 instructions 均存在。摘要没有纳入任何随机标记。这里记录的是实际漏纳入，尚未定位到是原生输入准备还是模型处理环节，不能把 HTTP 200 或作业 done 当作质量通过。

为完整检查这个失败现场，通过 Playwright CDP 连接**同一 Electron、同一内核**，没有重新导入、植入/改写记忆、修改作业时间或重启内核。原用例仍在等待正文标记，暂时暂停其 Playwright worker，防止等待超时提前关闭窗口；Electron、网关和内核继续运行。六个补测任务完成后恢复 worker，原用例按缺少正文标记超时失败正常收尾（13.5 分钟）。暂停没有使内核冷却时间或整理作业发生变化。当前测试源已将等待改为作业终态，正文质量断言保留为 soft failure，并继续全部行为场景；该最后接线通过格式/lint，未再发起第六轮模型重跑来追求绿色结果。

| 同一失败现场的新任务 | 实际结果 | 判定 |
| --- | --- | --- |
| Alpha，读取开启 | 个人标记及三个本项目字段全部 UNKNOWN，未取得自己的已保存事实 | **失败** |
| Beta，读取开启 | 个人标记及三个本项目字段全部 UNKNOWN | **失败** |
| 未导入 Gamma | 读到个人标记；三个项目字段 UNKNOWN，无 Alpha/Beta 具体约定 | 该场景通过 |
| Alpha 单任务禁读 | 四项 UNKNOWN，3 次请求均无记忆上下文/标记，返回工具证据未读原生 memories 路径 | 该场景通过 |
| Beta 全局禁读 | 四项 UNKNOWN，4 次请求均无记忆上下文/标记，返回工具证据未读原生 memories 路径 | 该场景通过 |
| Alpha 显式询问 Beta | 三项 UNKNOWN，未复述 Beta 具体内容 | 未误用；空摘要条件下不证明“其他项目记忆已可见时仍拒绝”的强保证 |

六个补测任务均正常完成，实际 cwd 均与所属项目路径一致；**33 项断言中 29 项成立、4 项失败**（Alpha/Beta 的个人与项目事实使用）。该轮共 7 个普通新任务（含整理触发），观测到 **39 次请求，全部路由到指定模型**；补测本身 22 次请求。第二轮曾在成功整理后证明 Alpha/Beta 正确使用，Gamma 不借用，两种禁读无注入，但它因定位失败未完成整套用例；不能用其局部正例覆盖第五轮的真实失败。

项目 scope 仍只是使用指导。第二轮共享摘要含两个项目具体内容，Alpha/Beta/Gamma 的 developer 上下文均可见，Gamma 还能读取共享正文。第五轮虽未误用，也不代表严格项目隔离。禁读验证的是原生记忆上下文关闭及本轮未读取原生记忆文件，不是任意文件路径 ACL。

五轮生命周期合计 **5 次启动、运行中退出 0、意外重启 0**，每轮都是单一内核进程。第五轮 CDP 补测前后 PID 始终 `20483`，正常测试应用关闭记录 code=0；前三轮失败/中断均如实保留，没有以重启加速整理。最终文本修复后的完整构建、`pnpm run check` 退出 0（**2912 项通过、2 项既有跳过**）；确定性 WorkBuddy Playwright **5/5（21.4 秒）**。这些代码回归通过，**不改变真实模型端到端未通过的结论**。

待解决：后台 `failed_agent` 与 done 后漏纳入 note 的可靠性/可观测性；不能靠六小时冷却内重复触发、清库或自动重启掩盖。只有资料保存成功，不足以承诺下一任务稳定使用。此次未新增内核补丁或发布安装包。

日志文本副本仅去除行尾空格；原始回答、工具输出和逐字笔记证据仍完整保留在 JSON 中。

- [第五轮完整现场](assets/2026-10-17-workbuddy-memory-import/real-final-evidence.json)、[最终 Playwright 失败输出](assets/2026-10-17-workbuddy-memory-import/real-final-playwright.log.txt)
- [同一内核六任务行为及断言](assets/2026-10-17-workbuddy-memory-import/real-live-behavior-evidence.json)、[补测脚本原文](assets/2026-10-17-workbuddy-memory-import/real-live-verifier.mjs.txt)、[补测输出](assets/2026-10-17-workbuddy-memory-import/real-live-playwright.log.txt)
- [五轮完整生命周期](assets/2026-10-17-workbuddy-memory-import/real-all-round-lifecycle.json)、[最终轮生命周期](assets/2026-10-17-workbuddy-memory-import/real-final-lifecycle.json)
- 已人工检查截图：[Alpha 使用失败](assets/2026-10-17-workbuddy-memory-import/real-live-a_on.png)、[全局禁读](assets/2026-10-17-workbuddy-memory-import/real-live-g_off.png)、[跨项目请求](assets/2026-10-17-workbuddy-memory-import/real-live-cross.png)；[较早成功整理后的 Alpha](assets/2026-10-17-workbuddy-memory-import/real-earlier-alpha_on.png)用于保留正例，不代替最终结果。

复现真实模型测试时，先通过隐藏输入将用户凭据放入 `EVOWORK_UI_MODEL_KEY` 环境，不把值写进命令行或文件，然后执行：

```bash
EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash node node_modules/@playwright/test/cli.js test workbuddy-memory.real.spec.mjs --project=real --retries=0 --output=/private/tmp/evowork-workbuddy-real
```

最终精确凭据扫描覆盖 **25,161 个文件、423,435,047 字节，0 命中**：含五轮日志/证据、补测产物、失败保留 HOME 及当前变更文件。扫描使用隐藏输入进行字节级比对，不输出正文或密钥。见[扫描结果](assets/2026-10-17-workbuddy-memory-import/real-secret-scan.json)。

## 后续修复验收

后续已定位 503/测试流重试配置与首轮基线漏纳入两个根因，P7、网关和测试夹具修复后，新的发货内核 MiMo 完整旅程通过。本记录的失败现场与当时结论保留；修复、真实 diff、七个新任务及零意外重启证据见[整理修复记录](2026-10-17-workbuddy-consolidation-fix.md)。
