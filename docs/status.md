# 开发状态

> **更新于 2026-09-07（第 15 次）**。这份文件回答一个问题：**现在到哪了、下一步是什么、什么还不能信。**
> 计划与优先级在 [work-priority.md](work-priority.md)，架构与决策在 [总纲](evowork-on-codex-design.md)，
> 怎么编译与部署在 [build-and-deploy.md](build-and-deploy.md)。
> 这里只写**当前事实**，不写计划理由 —— 两边说法冲突时，以本文的"验收凭据"列为准。

## 一句话

**M0–M9 的核心实现全部落地并全绿**（P0 骨架 · M1 网关 · M2a 服务层 · M2 前端 · M3 技能与解析 ·
M4 安全策略 · M5 自动化 · M8 产物与可视化 · M9 打包配置）。
**Q16 三家模型全部对真实 endpoint 实测过**，并因此改出三个真缺陷。

剩下的不是"还没写"，而是**四类需要外部条件才能推进的事**：
真机与证书（U3/U4/U5）· 人工评分（U1）· 装依赖跑通打包（M9）· 若干 UI 页面与真实接线。

| 指标 | 值 |
| --- | --- |
| 门禁 | `pnpm run check` 全绿：prettier · eslint（含 K2 边界规则）· tsc（含测试）· vitest · K1 补丁预算 |
| 依赖 | Electron **44.2.0**（`--version` 实测可运行）· mermaid 11.17（**已代码分割**：主 chunk 244KB，mermaid 683KB 独立）· 办公扩展**有了 App 内安装器**（2026-09-07，`services/runtime-installer`）。实测：干净 HOME 从零联网装 **66 秒**通过（含“搬走目录再跑”的可搬运检查）；本机打的离线包在干净 HOME 上**离线装 41.7 秒**通过（下载函数被换成一被调用就炸）。四个技能用系统 python3 调用时 re-exec 兜底实测生效，docx/xlsx/pptx/图表四种产物已生成并回读验证；图表中文用扩展自带的 Noto Sans SC 渲染正常。**OCR 档仍未装**（`pytesseract` 缺失），扫描件走不通 |
| 测试 | **1032 个通过、2 个跳过**。跳过的两条是 presentations 的"装了扩展才验得到"分支（本机没有 `python-pptx`）。**"没装扩展怎么办"那条不跳** —— 它由夹具强制构造（2026-09-06 修好，此前那个夹具名不副实，见 §3） |
| 源码 | 约 28.4k 行（不含测试）+ 17.2k 行测试 |
| 内核补丁 | **0 个文件 / 0 行**（预算 5 / 500）—— 设计判定只剩 P4 品牌字符串一项待落 |
| 内核基线 | `89a4eec6da`（2026-09-04）；F1–F19 已在此基线复核（**F19 是 M4 实测新增**：hooks 输出契约的三条硬约束） |

---

## 1. 按里程碑

| 里程碑 | 状态 | 已完成 | 未完成 |
| --- | --- | --- | --- |
| **P0-1** 回写总纲 | ✅ | 总纲 v0.4 + 详细设计集 v0.2；删掉补丁 P3；新增 F17 / F18 两条内核事实 | — |
| **P0-2** 决策 | ✅ | Q17–Q29 十三条全部决策并回写 §10.1.1 / §10.1.3 | — |
| **P0-3** 仓库骨架 | ✅ | pnpm workspace · lint · 严格类型（含测试）· CI · 每日漂移雷达 · 补丁预算 · 许可清单 | — |
| **P0-6** M0 可行性 | 🟡 | 结构化生成链路、Q14 不落盘的可审计手段、三家协议语义 | GLM 产物质量人工评分（U1）· misfire 真机体验（U3） |
| **P1-1** M1 网关 | 🟢 | Responses↔Chat 全量翻译 · 三家 provider · 错误码映射 · 用量规范化 · SSE · 能力端点 · Q14 不落盘 · **三家真实 endpoint 实测** | 企业私有部署包 · `maxContextTokens` 实测 · 长压测 |
| **P1-2** M2a 服务层 | 🟢 | 协议层 · 14 张本机表 + 两个迁移器 · 适配层（会话/心跳/重启/恢复/降级/事件流/审批/场景） | automation 相关表的写入方（等 M5）· 产物索引写入方（等 M8） |
| **P1-3** M2 前端 | 🟢 | token 层 · 基础组件 · 19 类 Item · 四类审批卡 · 三栏工作台 · 首页与 Composer · 任务列表与六组筛选 · 变更视图 · Electron 引导与 preload · 本机服务宿主 · **2026-09-06：应用外壳与侧边栏骨架（01 §3.1–3.3）· 线性图标集 · 补齐 §5.2/5.6/5.7 三个组件 · 六个 IPC 动作接线 · 回车→建任务→切页实测通过 · 模型选择器端到端接通（网关能力端点 → 下拉 → `turn/start.model` + 任务级设置；真窗口实测下拉已填充）** · **2026-09-07：点开已完成任务走 `openTask` 拉历史（此前只吃当场事件流，重启后对话区是「还没有消息」）** | 语音输入 · `@` 候选真实数据源 · 虚拟滚动 · 回合失败原因的对话内渲染 · **助理/项目/专家三个页面本身**（入口已接，现在是如实说明的空页） |
| **P2-1** M3 办公技能与解析 | 🟢 | **四个技能全部完成**（documents / spreadsheets / presentations / charts，共用一套骨架）· **本机解析管道**（识别 / 六道闸门 / 内置解析器 / zip / 注入载荷）· **三档运行时分发** | office / ocr 档的实际 python 解析器（接口已定，等 M4 的受限子进程）· 扩展包下载编排（并入 M9） |
| **P2-2** M4 安全与策略 | 🟢 | 三级路径策略（硬拦截对完全访问也生效）· 权限 profile 文案与平台限制 · 命令风险四维判定 · 并发与预算闸门 · guardian 映射 · 审计记录与链式哈希 · **hooks 策略包**（四个事件，决策可测） | 沙箱层的实际接线（seatbelt/landlock 由内核提供，需在 turn/start 上验证）· 策略包签名下发（R11）· 审计 UI · **Windows 隔离强度结论（见 U5）** |
| **P3-1** M5 自动化 | 🟢 | **带命名时区的 cron**（含 DST 两个边界）· misfire 三策略与落库顺序 · 失败分类与自动暂停 · 设备绑定与迁移 · 自然语言触发解析（不调模型）· 调度循环 | 与内核的接线（`startRun` 现在是注入端口）· `wake_system` 的三平台唤醒 · 自动化的 UI（07 的表单与历史页） |
| **P3-3** M8 可视化等 | 🟢 | **Visualizer**（fence 识别 · SVG 白名单清洗 · chart spec 校验 · 沙箱 iframe）· 产物识别三信号与版本 · 分享授权流（Q10 六条规则）· 资料库视图与两种删除语义 · 本机磁盘占用 | 图表库与 mermaid 的实际接线（属 M9 打包）· 资料库三栏 UI · 分享的上传实现与云端托管 · `fs/watch` 接线 |
| **P3-2** M9 打包 | 🟢 | Electron 入口 · electron-builder 配置（三平台 + 差量更新）· macOS entitlements · **体积预算与档位边界检查**（R10）· **无证书时降级为未签名并把标注写进文件名**（U4）· **打包驱动 `scripts/package.mjs`**（把 package-plan 的四条规则接上）· **2026-09-06：macOS arm64 真实打包跑通并启动验证** | 签名公证（卡 P0-5 证书）· 自动更新服务端 · EvoWork CLI 随包（Q13）· 应用图标（现在用的是 Electron 默认图标）· Windows / Linux 未在真机打过 |

图例：✅ 完成 · 🟢 核心完成，剩余项已列 · 🟡 部分 · ⬜ 未开始

---

## 2. 代码在哪、各是什么

| 位置 | 内容 | 测试 |
| --- | --- | --- |
| `packages/protocol` | app-server JSON-RPC v2 的手写子集 + NDJSON 双向分发（**K2 边界的类型面**） | 20 |
| `packages/logging` | Q14「不落盘正文」的实现处：**没有接受自由字符串的日志入口** + 字段注册表 + 泄露检测 | 28 |
| `packages/tokens` | 01 §2 的 design token + 对比度自动化断言 + CSS 变量生成 | 24 |
| `services/store` | 14 张本机 sqlite 表 · 投影/权威两个迁移器 · 状态派生 · FTS5 trigram | 47 |
| `services/kernel-adapter` | **K2 边界的唯一实现处**：会话 · 心跳 · 退避重启 · 会话恢复 · 能力探测与降级 · 事件流三消费者定序 · 审批双策略 · 场景展开 · 内核进程启动器 | 98 |
| `services/gateway` | Responses↔Chat 翻译 · 三家 provider 与错误映射 · 用量规范化 · SSE 服务 · 能力端点 | 81 |
| `apps/desktop` | Electron 引导 · preload · 本机服务宿主 · 全部 UI | 152 |
| `services/artifacts` | 产物识别（三信号 + 版本 + 重定位）· 分享授权（Q10）· 资料库视图与磁盘占用 | 26 |
| `services/scheduler` | 定时调度：cron（时区 + DST）· misfire 补偿 · 失败语义 · 设备迁移 · 自然语言解析 | 54 |
| `services/policy` | 安全与策略：三级路径策略 · profile 文案 · 命令风险 · 并发与预算 · guardian 映射 · 审计与链式哈希 · 平台能力 · **四个 hook 的决策** | 64 |
| `services/ingest` | 解析管道：magic-byte 识别 + 编码嗅探 · 六道闸门（含压缩炸弹与路径穿越）· 内置解析器 · 最小 zip 读取器 · 注入载荷与启发式摘要 · 三档运行时 | 52 |
| `plugins/skills/_shared` | 四个技能共用的骨架：退出码 · 校验与"报错不含用户内容" · 产物上报 · 运行时文案 | （由各技能覆盖） |
| `plugins/skills/{documents,spreadsheets,presentations,charts}` | 四个办公技能：Schema + 模板 + 渲染器 + 产物上报 | 56 |
| `apps/desktop` 的 `visualizer.tsx` | **R5 的落点**：fence 识别 · SVG 白名单清洗 · chart spec 校验 · 沙箱 iframe | 20 |
| `plugins/hooks/evowork-policy` | 策略包（K3 第三个扩展点）：四个事件的 I/O 壳，决策在 `services/policy` | （由 policy 覆盖） |
| `tools/eslint-plugin-evowork` | K2 边界规则 + token-only 样式规则（把 CLAUDE.md 的纪律机器化） | 2 |
| `scripts/` | 漂移雷达（F1–F16 机器复核）· 补丁预算 · 许可清单 · **provider 实测探针** | — |

---

## 3. 哪些结论是"对着真东西验过的"

这一节与 [work-priority §10](work-priority.md) 对应。**没列在这里的，就是还没被证伪过的。**

| 结论 | 怎么验的 |
| --- | --- |
| ✅ **Q16 三家的协议语义**（U2，已关闭） | 2026-09-05 用 `scripts/verify-provider.mjs` 对三家真实 endpoint 逐项实测：DeepSeek 3 个型号 + kimi-k3 + glm-5.3-flash |
| ✅ **Q14 不落盘的可审计手段**（R7） | 接口形状 + 字段注册表 + 8 字滑窗泄露检测；网关跑完整请求后对日志逐段断言无泄露 |
| ✅ **结构化生成的渲染侧**（R4 的一半） | Schema 校验失败会指出"哪一页哪个字段"，且只列声明的那个 layout 的问题 |
| ✅ **F1–F18 内核事实** | 在基线 `89a4eec6da` 上逐条复核，6 处行号已订正 |
| ❌ **GLM 的产物质量**（U1） | **没验。** 上面验的是协议语义，不是它 PPT 写得好不好。需要 08 §5.4 的三个任务人工评分 |
| ❌ **misfire 补偿的真机体验**（U3） | **没验。** 需要真机关机一夜再唤醒；单测证明不了 OS 行为 |
| ✅ **端到端跑通并拿到真回答**（M2 + M1） | **2026-09-06 实测**：真窗口按回车 → 内核 → 网关 → DeepSeek → 中文回答显示在对话里，**身份是 EvoWork、场景指令生效**。过程中改出六个缺陷（两批，见下表）。**这条验的仍然是链路与身份，不是产物质量**（U1 未变） |
| ✅ **macOS 打包与启动**（M9） | **2026-09-06 在 macOS arm64 实测**：`pnpm run package` 出 dmg/zip 各 197MB，dmg 可挂载；装出的 App 启动后 3 个 Helper 子进程 + 1 个内核进程，`desktop.host.started` 落日志。**过程中修掉三个只有真跑才会暴露的缺陷**，见下表 |
| ✅ **手动选模型的链路**（M2 + M1） | **2026-09-06 实测**：网关带三家真 key 起在 8787，`GET /v1/evowork/models` 返回 5 个模型（**不重复、不含没配密钥的厂商**）；三家各打一次真实 `POST /v1/responses` 都拿到回答（deepseek-v4-flash 1.0s · kimi-k3 3.8s · glm-5.3-flash 2.1s）；真窗口起来后 Composer 里的下拉**已填充**并选中场景默认模型。**下拉的展开与切换是测试覆盖的，不是真点出来的** —— 这台机器上拿不到 UI 自动化的辅助功能权限 |
| ❌ **签名 / 公证链路**（U4） | **没验。** 卡 P0-5 的证书 |
| ❌ **Windows 隔离强度**（U5，新增） | **没验。** 需要一台 Windows 机器实测 `windows-sandbox-rs` 的隔离边界。当前 `WINDOWS_ISOLATION = 'unknown'`，行为**按保守侧走**（停用完全访问 + 能力页如实说"还没评估"）—— 默认按"足够"走的话，结论一旦是"不足"，中间这段时间 Windows 用户是在一个我们以为安全、实际未知的环境里跑完全访问 |
| ❌ **`maxContextTokens`** | **没验。** 要塞满上下文才能测；五个型号都仍在能力表的 `unverified` 列表里 |

### M3 落地时定死的几条（改之前先看测试在断言什么）

| 位置 | 约束 | 改错的表现 |
| --- | --- | --- |
| `spreadsheets` 的 schema | **计算列给公式，rows 里对应位置必须是 null** | 用户改了输入列，合计纹丝不动 —— 而它看起来完全正常 |
| `documents` 的层级校验 | 标题层级只能逐级下降 | Word 目录缺一层、导航窗格错位，生成时不报错 |
| `charts` 的字体探测 | 没有中文字体就**停下来**，不画方框图 | 方框图不报错，等用户打开文件才发现 |
| `ingest` 的 `checkArchive` | 先列后解；穿越拒整包 | 42KB 的 zip 写满磁盘；或攻击者靠"部分成功"探目录 |
| `ingest` 的注入载荷 | 路径 + 摘要 + 关键页，**不含全文** | 长文档炸上下文 |
| 运行时文案 | TS 与 Python 两侧**逐字相同**（有测试比对） | 用户以为解析和生成要装两个不同的东西 |

### M4 落地时定死的几条

| 位置 | 约束 | 改错的表现 |
| --- | --- | --- |
| `paths.ts` 的判定顺序 | 硬拦截**先于**工作空间判定，且**不看 `permission_mode`** | 把工作空间设在 `~/.ssh` 就能绕过；或"完全访问"能读走私钥 |
| `paths.ts` 的归一化 | `..` 必须在匹配前解析 | `~/work/../.ssh/id_rsa` 被判成工作空间内 |
| `hooks/contract.ts` | `deny` 必须带非空 reason；没有 `ask`；`updatedInput` 只配 `allow` | 内核丢掉整条输出，**策略静默失效**（F19） |
| `profiles.ts` | 未知 profile 显示 id 本身，**不隐藏** | 企业自定义档位在 EvoWork 里"消失" |
| `audit.ts` 的类型 | 没有能装正文的字段 | 想记正文得改类型，而改类型会被 review 看见 |
| `platform.ts` 的默认值 | `unknown` 走保守侧 | Windows 用户在未知隔离强度下跑完全访问 |

### M5 落地时被测试抓出来的两个 DST 错误

第一版 cron 是"UTC 游标每分钟 +1，读它的本地字段看匹不匹配"。**两个 DST 边界都错了**：

| 边界 | 第一版的行为 | 现在 |
| --- | --- | --- |
| 春季跳过（02:00→03:00） | 本地 02:30 那天根本不出现 → **整天被跳过** | 在跳变后的第一个瞬间触发（03:00） |
| 秋季重复（01:00 出现两次） | 游标两次都匹配 → 那天**跑了两次** | 按本地日历日迭代，每个「日+时+分」只产生一个候选 |

DST 一年只发生两次，错了要等半年才有人报 —— 这正是"写测试断言后果"的价值。

### M8 / M9 落地时定死的几条

| 位置 | 约束 | 改错的表现 |
| --- | --- | --- |
| `visualizer.tsx` 的 `IFRAME_SANDBOX` | 给 `allow-scripts`，**绝不给 `allow-same-origin`** | 两者同时给等于没有沙箱；而它"看起来能用"，最容易在调试时被顺手加上 |
| `sanitizeSvg` | 白名单，且**点名删 `foreignObject`** | 它能在 SVG 里嵌任意 HTML，不像 `<script>` 那样显眼 |
| `validateChartSpec` | 拒绝未知字段与函数字符串 | `formatter: "function(v){...}"` 是把任意代码塞进来的入口 |
| `recognize.ts` 的信号优先级 | 技能上报 > FileChange > hook | png 到底是 chart 还是 image **只有信号源知道**；按时间取最后一个会覆盖掉 |
| `share.ts` 的授权形状 | 一次一个 `artifactId`，勾选框不预勾 | "记住授权"与"批量"各自能让这条出网通道悄悄变成默认开启 |
| `library.ts` 的两个删除函数 | 我的资料=真删文件；本地产物=只删索引 | 写反了用户丢文件 |
| `package-plan.mjs` | 缺任一 secret 就**整体**降级为未签名 | 半签名的产物看起来像正式包 |

### 四个页面各自最该被守住的一条

| 页面 | 约束 | 写错的后果 |
| --- | --- | --- |
| 资料库 | 「我的资料」删除 = **真删磁盘文件**；「本地产物」删除 = **只删索引**，勾选框不预勾 | 写反了用户丢文件 |
| 自动化表单 | 关机不执行 / 绑定这台电脑 / 并发与重试定死 —— 三条都要在**配置时**说，不是事后解释 | 用户的心智模型从第一天就是错的（R9） |
| 执行历史 | 跳过与漏跑**分列统计**，Badge 不是 danger | 关机漏跑 3 次看起来像"失败 3 次"，用户去查任务本身，那里什么问题都没有 |
| 审计页 | 页面与**导出**都只给分类 + 短哈希 | 导出会让内容离开这台电脑 —— "顺便带上原始路径"很自然，但它会让一份不含正文的记录突然含了 |
| 首运行 | 隐私措辞**不能夸大成"完全不出网"**；解析组件必须可跳过且说清后果 | 前者用户从账单就能发现；后者 300MB 会挡在首次体验前面（R10） |

### 接线时改出的缺陷（**都是"两个模块各自都对，合起来才不对"**）

装上依赖、把端口接到真实实现上之后，端到端测试立刻抓出若干条 —— 全部是单测**结构上抓不到**的：

| 缺陷 | 表现 | 已改 |
| --- | --- | --- |
| **幂等键与补偿策略互斥** | 总纲 §6.9 写幂等键是 `automation_id + fire_time`，而 07 §8-1 要求"先写 MISSED 再补跑"—— 两条记录共享同一个 `fire_time`，于是**补跑那条永远插不进去**：历史里只有一条「错过」，任务再也没跑 | 键加上 `trigger`；已回写总纲 §6.9 |
| **产物类型订正被去重挡掉** | 三个识别信号到达顺序不固定。watcher 先按扩展名把 png 判成 `image`，技能上报（信号 ①，带着"这是 chart"）随后到达时内容哈希没变 → 被当成"重复"整条丢掉，那张图**永远显示成图片** | 新增 `corrected` 分支：内容没变但来了更高优先级信号时做**元数据订正**（不产生新版本）；已回写 08 §2.2 |
| **`load_template` 调用签名不匹配** | 抽共用骨架时改了签名，presentations 没跟着改。装 python-pptx 之前，`import pptx` 先失败，**这个 bug 一直被挡在后面** | 装上运行时后立刻暴露并修复 |
| **日志字段名没注册** | 上传日志写了 `sizeBytes`，而字段注册表里叫 `byteSize` —— 策略把它**静默丢掉**（这正是注册表的设计意图） | 改用注册表里已有的名字：一个概念一个名字 |
| **打开任务不拉历史** | 适配层有 `openTask`（`thread/items/list`），渲染层点侧边栏只改 `activeTaskId`。标题和「已完成」来自投影表，对话条目只活在当场事件流里 —— 重启后再点，空态写「还没有消息」 | 切任务走 `openTask`；内核返回的是 `{ turnId, item }` 且默认 25 条一页，解开并按页拉完 |

前两条尤其值得记：它们各自的单元测试全绿，因为**每个模块单独看都是对的**。

### 真跑一次打包改出的五个缺陷（**全部是"装得上、看不出哪里错了"**）

2026-09-06 第一次在 macOS 上真正打出 dmg 并双击它。五条缺陷此前都存在于仓库里，
**没有一条能被现有测试抓到** —— 它们的共同特征是失败时不报错、不退出、不打日志。
现在 `apps/desktop/test/packaging.test.ts` 把其中四条钉住了：

| 缺陷 | 表现 | 已改 |
| --- | --- | --- |
| **ESM 入口的顶层 `await` 与 `whenReady()` 死锁** | 入口模块求值必须先结束 Electron 才发 `ready`，而 `bootstrap()` 第一件事就是 `await whenReady()` —— 互相等。现象是**进程活着、零个 Helper 子进程、一行输出都没有**，和"崩了"完全区分不开 | 入口不再顶层 await，promise 放走并 `.catch` 后 `app.exit(1)`：启动失败必须响亮 |
| **preload 根本没有入口** | `preload/index.ts` 只导出 `installBridge`，**从不自调用**（那是刻意的，为了让"暴露了哪些方法"可断言）。打包出的 preload 因此是一段谁也不执行的代码：`window.evowork` 不存在，渲染层每次调用都是 `undefined is not a function`，而主进程一切正常 | 新增 `preload-entry.cjs`。必须是 **CJS**：窗口开着 `sandbox: true`，而 Electron 的沙箱化 preload 不支持 ESM |
| **没有任何地方创建 `~/.evowork`** | 开发机上它一直存在（人手工建的），所以这条只在**干净机器第一次运行**时出现。内核要求它的家目录已存在、不存在就退出，而我们默认丢弃内核 stderr → "内核起不来且什么都没说" | `createServiceHost` 里加 `ensurePaths`，**在开库与起内核之前**；两条测试钉住 |
| **`node:sqlite` 与 Electron 版本冲突** | `services/store` 用 `node:sqlite`（Node 22.5+），而当时钉的 Electron 33 带 Node 20.18.3 → 主进程 bundle 在 import 阶段抛 `ERR_UNKNOWN_BUILTIN_MODULE`，同样是静默退出 | Electron 升到 44.2.0（Node 24.20）。**Electron 的 Node 比同期 LTS 落后一到两代**，这是选内置模块时要先查的一件事 |
| **vite 的 `base` 是绝对路径** | 打包后走 `loadFile`（file://），而 `base: '/'` 生成的 `<script src="/assets/…">` 在 file:// 下指向**文件系统根目录** → 404。现象是**窗口正常打开、标题栏正常、整页全白**，主进程日志一切正常，渲染进程也不报错 | `vite.config.ts` 设 `base: './'`。这一条是装完 dmg 双击才发现的 —— 前四条在命令行就能复现，它不行 |

外加两条打包配置问题：`electron` 装在 `apps/desktop` 下导致 electron-builder 算不出版本号
（它检测到 pnpm workspace 后从**仓库根**解析），已挪到根；`app.asar` 里 7390 个条目是
用不上的 `node_modules`（三个入口都是自包含 bundle），排除后 dmg 从 115MB 降到 95MB。

**方法论上值得记的两条**：

① 排查中途 `ELECTRON_RUN_AS_NODE=1` 泄漏进了 shell 环境，导致后续几次"启动失败"
其实是以纯 Node 在跑，得出的结论全是假的。判"应用起没起来"不要看主进程在不在 ——
看 `pgrep -f 'EvoWork Helper'` 有没有子进程。

② **命令行验证到不了终点**。前四条在命令行就能复现；第五条（全白）必须装完 dmg 双击。
最有效的探针是给 `BrowserWindow` 挂 `console-message` / `did-fail-load` / `did-finish-load`，
在 `did-finish-load` 里 `executeJavaScript` 取 `#root` 的 innerHTML 长度与 `typeof window.evowork` ——
这两个数字直接区分开"没加载 JS"、"加载了但渲染为空"、"渲染了但桥没通"。

### 第一次真按回车改出的四个缺陷（2026-09-06）

上面那次打包只验到「窗口打开、页面画出来」。**真去输入框里打一句话按回车**，
四条串在一起的缺陷立刻暴露 —— 前两条是接线缺口，后两条是内核事实（已登记为 F20 / F21）：

| 缺陷 | 表现 | 已改 |
| --- | --- | --- |
| **六个渲染动作只注册了审批一个** | `bootstrap` 只 `ipcMain.handle` 了 `askApproval`，而 preload 声明了六个。任何操作都得到 `No handler registered`，而渲染层用 `void send()` 发起调用 —— rejection 无人接管：**既不弹窗也不进日志，就是"点了没反应"** | 遍历 `RENDERER_ACTIONS` 注册，实现放在 `ServiceHost['actions']`（不 import electron，可测）。`bootstrap.test.ts` 断言两份清单**逐项相等** |
| **推给渲染层的事件形状对不上** | 宿主把适配层的 `UiEvent`（任务视角：`task-status` / `item-delta`）原样转发，而 `app.tsx` 认的是组件视角（`task-updated` / `item`）。两边各自都有测试、合起来是断的 | 新增 `renderer-bridge.ts` 做翻译，契约放在 `src/shared/ipc.ts` 由两侧**共用一份类型** |
| **F20：`turn/start` 的 `model` 是必填** | `BUILTIN_SCENARIOS` 里没有 `model`（toml 里有、代码兜底里没有）→ 内核回 `missing field \`model\``。表现是**任务建出来了、一句话都没有** | 三个内置场景补上 `model` / `reasoningEffort`，与 toml 对齐 |
| **F21：没人把配置装进内核家目录** | 命名权限档位在内核家目录的 `config.toml` 里解析；干净机器上那个文件根本不存在 → **每一次** `thread/start` 都被拒 | `ensureKernelConfig` 在建目录之后、开库之前装模板；**已存在不覆盖**（企业会改它） |

### 用户第一次真发消息又改出三个（同日）

上面那次验的是「回车能不能把任务建起来」。用户实际发了一句话之后，**任务标着「失败」、
对话里一个字都没有** —— 三条叠在一起：

| 缺陷 | 表现 | 已改 |
| --- | --- | --- |
| **回合失败的原因被丢掉** | 内核**是**把原因发过来的（`Turn.error`，`v2/thread_data.rs:390-391`，仅在 failed 时填充），而 `turnCompleted` 只读了 `status` 和 `durationMs`。用户能做的只有再试一次，而再试一次也会失败 | 原因经 `turn-completed` → `turn-failed` 一路带到界面，**原样显示不归类**：`connection refused` 与 `401` 对用户是完全不同的两件事 |
| **网关令牌从来没传给内核** | `config.toml` 写的是 `env_key`，内核从自己的进程环境取；而**双击启动的应用不继承 shell 环境**，所以正常安装的应用里它永远是空的。launcher 早就留了 `extraEnv`（还有测试），宿主一直没用 | `readGatewayToken`：环境变量优先，其次 `~/.evowork/gateway-token`。**过渡方案**，见第 4 节 |
| **缺令牌等到发消息才知道** | 03 §8 要求"模型不可用"在**发送之前**就说 | 启动时没令牌就推一条 notice，说清怎么配 |

### 接上真 key 拿到第一条回答，又改出两个（同日）

链路通了之后模型答了，但**答的不是我们的产品**：

> 你好！我是运行在 **Codex CLI** 里的编码代理…

| 缺陷 | 表现 | 已改 |
| --- | --- | --- |
| **F22：`settings` 是 snake_case** | `Settings` 是 v2 里唯一没有 `rename_all` 的结构体，也不 `deny_unknown_fields` —— 我们写的 `developerInstructions` **被静默丢掉**。`model` 恰好两种写法相同，所以现象是"模型对、只有指令没生效"，最难归因 | 改 snake_case，并加断言钉住三个键名（`Object.keys(settings)` 逐字相等，不留 camelCase 影子） |
| **F23：模式指令没人安装** | `config/modes/*.md` 随包分发，`readInstructions` 读的是 `~/.evowork/modes/` —— 干净机器上那个目录不存在。与 F21 同一类，但后果**完全静默**：空的 `developer_instructions` 是合法值 | `ensureModeInstructions` 首次运行时逐个文件安装，已存在的不覆盖 |

**这两条都是 K5 的运行时破口。** 被丢掉的那段指令第一句就是「你是 EvoWork 的执行智能体」——
丢了它，内核自带的身份原样漏出来，而这条路径上**没有任何东西会报错**：
产品还在跑，只是变成了另一个产品。

修完之后同一个问题的回答：

> 你好！我是你的 **EvoWork 执行智能体**，当前工作在 **Craft（你说我做）** 模式…
> 交付可直接外发的办公文件（文档用 docx、表格用 xlsx…）、表格里写公式、数据标明可追溯来源

后半句证明**场景片段也生效了**（`craft-office.md` 的三条产物约束逐条出现），
不只是模式片段。

实测到的终点：桌面 → 内核 → 网关 → DeepSeek → 回到界面，**拿到中文回答**，
身份正确、场景指令生效。这条链路至此第一次被完整验证过。

**方法论**：上面那四条没有一条能被单元测试抓到，也没有一条能在命令行复现 —— 它们都要求
"真的有一个窗口、真的有一个内核进程、真的按下回车"。有效的探针是用 Electron 自己起窗口，
`executeJavaScript` 往输入框写值（React 受控组件要用原生 setter）+ 派发 `keydown`，
再读 `.ew-task-item-title` 的条数与提示条文案 —— 这三个数字直接区分开
"没发出去"、"发出去但被拒"、"建了任务但没回合"。

**顺带修掉的一条 UI 纪律漏洞**：提示条此前只在任务页渲染，而**第一条消息是在首页发的** ——
它失败时用户看到的是输入框恢复原样、别的什么都没有。首页现在也渲染 notices。

### 只叠加 developer 指令盖不住系统底稿（2026-09-07）

F22/F23 修好之后，用户再问「介绍一下自己」，回答变成：

> 我是运行在 **Codex CLI** 里的执行智能体，当前处于 **Craft（你说我做）** 模式…

两层**都生效了**：Craft 来自 `developer_instructions`，Codex CLI 来自内核写死的
base instructions。模型在「你是谁」上听系统底稿。第二问「你是什么模型」还去
`cat ~/.evowork/kernel/skills/.system/openai-docs/SKILL.md` —— 那只系统技能把
「you / this app」绑到 Codex 文档上。

| 缺陷 | 表现 | 已改 |
| --- | --- | --- |
| **F25：身份在 base instructions，不在 developer** | `developer_instructions` 只叠加。官方覆盖口是 `thread/start.baseInstructions`（整段替换）。`model_instructions_file` 相对路径按 cwd 解析，不能写进模板 | 随包 `config/prompts/base-instructions.md`（内核 `default.md` 的 fork，只改身份段），每次建任务经适配层传入；缺文件时发 notice，不静默 |
| **系统技能 `openai-docs`** | 问「你是谁 / 你是什么模型」会去读 Codex 文档 | `[[skills.config]]` 按名字关掉；适配层每次 `thread/start` 再传一次，老安装的 `config.toml` 不被覆盖也能生效 |

这不是 P4。P4 是用户看得见的 CLI 帮助 / UA；「介绍一下自己」走的是内核已经提供的覆盖口。

### 接模型下拉（手动选模型）改出两个（2026-09-06）

需求是"应支持手动选模型"。UI 组件（`ModelSelect`）与服务层的 `overrides.model` 早就有了，
缺的是**中间那一段**：谁给下拉喂数据、选中的那个怎么走到 `turn/start`。接的过程中撞到两个：

| 缺陷 | 表现 | 已改 |
| --- | --- | --- |
| **网关的模型表把没配密钥的厂商加了回来** | `main.ts` 把 `availableModels()`（按密钥过滤过的子集）当成 `createModelRegistry` 的 `extra` 传进去，而后者是 `[...P0_MODELS, ...extra]` —— 于是**每条重复一次**，且**没配密钥的厂商被原样加回来**。实测：只配 DeepSeek 时端点照样列出 Kimi 与 GLM。用户会选中一个没有密钥的模型、发出去、拿到上游 401 | 新增 `createModelRegistryFrom`（一份确定清单，同 id 后来者覆盖）+ `availableModelRegistry()` 把**组合本身**变成可测的一步；回归测试断言"没配密钥的不许出现，也不许重复" |
| **F24：模型清单的真源不是内核** | 03 §7 与 09 §3.2 第 6 步原先写「调 `model/list`」。**不成立**：内核不知道网关配了哪几家密钥，会列出选中即失败的模型（03 §8 要的是**发送之前就说**）；不配 `model_catalog_json` 时它返回的还是 OpenAI 的型号清单（K5 + 一条未登记的出网路径） | 下拉改读网关的 `GET /v1/evowork/models`；两处文档已回写，F24 进 §4 事实表 |

第一条是 CLAUDE.md §9.1「两个模块各自对，合起来可能不对」的又一例：过滤有测试、组合有测试，
**组合的用法没有**。它在此之前看不见，因为没有任何 UI 消费过 `list()`。

**顺带修掉一条与需求无关的**：`WITHOUT_OFFICE_RUNTIME` 这个"强制无扩展环境"的夹具**名不副实** ——
它只把 `EVOWORK_OFFICE_PYTHON` 指向不存在的路径（挡住 re-exec 的兜底），却没挡住
**当前解释器**里的模块。开发机的用户级 site-packages 里常有 python-docx / openpyxl，
于是这三条测试在那些机器上渲染成功、退出码 0（本机就是这样，`pnpm run check` 一直是红的）。
改成额外挂一个 `sitecustomize.py` 只挡办公扩展那四个模块 —— `PYTHONNOUSERSITE=1` 不行，
它连 `jsonschema` 一起挡掉，会走进"校验库缺失"那条**退出码相同、文案不同**的分支。

### 三家实测改出的缺陷（都是"不报错但行为错"）

1. **Kimi 的 404 会被内核无限重试** —— 它的错误体只有 `type` 没有 `code`，而映射只看 `code`；查不到就落到"原样返回"，内核对映射不上的错误一律当可重试。已修（`code` 缺失回退到 `type` + 401/403/404 列入永久状态码）。
2. **Kimi 的 cache 命中永远显示 0** —— 它把命中数放在 usage 顶层的 `cached_tokens`，另两家一个用 `prompt_cache_hit_tokens`、一个用嵌套的 `prompt_tokens_details.cached_tokens`。0 是"不支持 cache"的合法取值，所以漏读不会有人发现。已修。
3. **三家主力型号全是推理模型** —— 能力表按"旗舰才推理、flash 是轻量档"的直觉写了三个 `false`。标错会让推理段整块不显示，用户只觉得这模型不动脑子。已订正。

另有两条选型信息：**`imageInput` 有三种结局**（真能看 / 明确拒绝 / **接受但看不见**——deepseek-v4-flash 就是第三种），以及**推理模型会吃掉 `max_tokens`**（给 64 token 预算时 DeepSeek 与 GLM 都返回空 content）。

### 用户对着真界面报的五个（2026-09-06，第二轮）

前面几轮验的是"链路通不通"。这一轮用户是**对着跑起来的界面**报的，
所以每一条都在"功能其实是通的、但界面在骗人或没法用"这一档：

| 缺陷 | 根因 | 已改 |
| --- | --- | --- |
| **12 个任务全叫「未命名任务」** | 不是标题没刷新，是**永远不会有标题**：内核只在客户端显式调 `thread/name/set` 之后才发 `thread/name/updated`（`thread_processor.rs:638-658` 是唯一发送点），`Thread.name` 在那之前一直是 null。**内核把命名整个留给了 GUI**，而我们没接 | 新建任务时用第一条需求就地起名（`kernel-adapter/src/title.ts`，**不调模型**）并写回内核（真源仍是内核，09 §4.1）；已存在的旧任务由 `displayTitle` 回退到投影表的 `first_message`，不写库 |
| **重命名会把标题抹成 null**（顺带抓到） | 通知的字段是 **`threadName`**（`v2/thread.rs:1982-1988`），我们读的是 `p.name` → undefined → `?? null`。而"字段缺席 = 名字被清空"本身是合法语义，所以这条**没有任何一层会报错**。当时的测试也写着 `name`：**测试与实现犯了同一个错** | 读对字段；假内核补上这条通知（照抄字段名与"先响应后通知"的顺序），并加一条断言把两种语义分开 |
| **任务已完成，推理区还写着「思考中…」** | 摘要行的判据是 `durationSeconds`，而内核的 `Reasoning` 变体**只有 id / summary / content 三个字段**（`v2/item.rs:280-286`），从来不给时长 —— "完成"那一态**永远到不了**。附带：`summary` / `content` 是 `Vec<String>`，渲染层只读 `text`，所以完成后正文还会**从有字变成空白** | 耗时由主进程按 `item/started`→`item/completed` 掐表，完成标记也由主进程贴；渲染层分三态：思考中 / 已思考 N 秒 / **推理过程**（量不到就不说数字）。中断与失败时在 `turn-completed` 上收摊挂着的条目 |
| **模型下拉很乱** | 通用菜单最小宽 180（01 §5.19），而这一行要**并排**装下等宽 `provider/model`（28 字约 190）与三个能力徽标（约 110）→ 名字从中间折成两行、徽标贴着折行文字 | ModelSelect 用自己的 `ew-model-menu`（最小宽 340 / 最大高 320 自滚），名字单行省略号 + 完整 id 进 `title`，徽标 `flex-shrink: 0`。数值已回写 01 §5.15，三条约束由 `styles.test.ts` 扫 CSS 守着 |
| **点「选择工作空间」后不能正常显示** | 选项是空的：`workspaces` 从来没有人喂过数据。零个选项时 `ew-menu` 渲染成一个**带内边距和阴影的白色空盒子**盖在 Footer 上 —— 看起来像界面坏了 | 两处都补：① `Menu` 新增 `emptyHint`，**空也要给出原因**（与 01 §5.19「禁用项必须给出原因」同一条纪律）；② 工作空间列表真的接上 `project/list`（实验方法，不可用时空数组不影响启动），选中的 id 由主进程翻成 `overrides.cwd` |

另按用户要求**下架 `deepseek-chat` 与 `deepseek-reasoner`**（目录里 DeepSeek 只留 v4-flash）。
连带改了三个场景包、两个配置模板与 `allowed_models` 的默认值 —— 漏改任何一处，
`resolveModelChoice` 每次启动都会弹一条"场景默认的模型当前不可用"，
而那句话该留给真正配错的用户。实测记录保留在总纲 §D2，**型号下架不等于实测没发生过**。

**这一轮的共同点**：五条里有三条（未命名 / 思考中 / 空下拉）的失败方式都是
**界面在陈述一件不成立的事**，而不是报错。它们全部越过了 922 条测试，
因为测试断言的是"给了 durationSeconds 就显示 N 秒"这类**条件成立时**的行为 ——
没有人问过"那个条件会成立吗"。

### 接上四个页面 + 网关自启改出的六个（2026-09-06，第三轮）

需求是"把写好的四个页面接上路由"和"让宿主自己拉起网关"。前者的前提**只对了一半**：
资料库与自动化确实只缺路由，审计页的链路断在更前面。接的过程中撞到六条：

| 缺陷 | 表现 | 已改 |
| --- | --- | --- |
| **审计链路整个不存在** | hook 在产出记录并写向 `EVOWORK_AUDIT_LOG`，而**没有任何一处设置那个环境变量**，`audit_log` 表也没有读写方。10 §6 的原则 6「审计对用户可见」当时是"既不写也不读" | 内核的 `extraEnv` 里给出路径（hook 是内核的子进程，环境从那儿继承）；新增 `createAuditRepo` + `audit-ingest.ts`（JSONL → 表，搬完截断，插入失败不截断） |
| **渲染层不能 import 服务层的 barrel** | `@evowork/policy` 的 index 带出 `audit.ts`（`node:crypto`）、`@evowork/ingest` 带出 `probe.ts`（`node:child_process`）→ vite 构建直接失败。**四个页面一起炸**，而在它们被挂进 `app.tsx` 之前从没进过 bundle，所以一直没报错 | 四个包加子路径导出，渲染层改深路径；审计页的 `verifyChain` 挪去主进程（完整性校验本来就该由持有权威数据的那一层做）；`styles.test.ts` 扫源码拦这类导入，**不看可达性** |
| **`.ew-page` 是我新造的类，CSS 里一条规则都没有** | 那一页缩成左上角一小块，而页面组件自己的样式全对 —— 与 app.css 开头记的 `.ew-app` 塌陷同一类 | 补齐 `.ew-page` / 自动化列表 / 引导壳的规则；新增断言：**每个顶层视图根都要在 `.ew-app >` 的 flex 规则里** |
| **首运行门禁是个死路** | 打开引导门禁但没接目录选择器：`blockingReason` 要求至少一个工作空间，而干净机器上内核一个 project 都没有 → 「下一步」永远是灰的，**整个应用打不开**。真窗口探针第一次跑就卡在这 | `showOpenDialog` 从 electron 注入 → `pickWorkspace` 动作 → 选完立刻落 `meta`（用户可能选完就关窗口）；`getStartup` 的 workspaces = 内核 project ∪ 本机记录（这正是 `DEGRADATION[project/list]` 写明的兜底） |
| **`spawnFn` 只有注入口、没有默认值** | 宿主只在测试里传它，**真跑时网关一次都没起来**，而失败被归成一句"缺少启动器" —— 看起来像配置问题 | 默认用真的 `spawn`；三种"不起"各自记一条日志（此前只推 notice，日志里什么都没有） |
| **入口把两个独立问题压成一个开关** | `EVOWORK_DEV` 同时决定"随包资源在哪"与"渲染层从哪来"，于是"用仓库里构建好的产物直接跑一次"**没有任何表示法**：不设它就去 `process.resourcesPath` 找内核，而那时它指向 **Electron 自己的 app 包**（`spawn .../Electron.app/Contents/Resources/kernel/... ENOENT`）；设了又去连一个没起的 vite | 拆成 `app.isPackaged`（资源在哪）与 `EVOWORK_DEV`（连不连 vite）；未打包时按**入口文件**定位仓库根，不看 `process.cwd()` |

**真窗口验过的**：引导六步全部走通并落 `meta`；侧边栏六个入口逐个点开，
主内容区都是 1004×848（铺满，不是塌成一块）；网关作为 App 的子进程起来，
`/v1/evowork/models` 返回 3 个模型；退出时子进程被回收（`gateway.child.exited`）。

**这一轮的方法论**：前四条没有一条能被单元测试抓到 —— 它们要求"真的有一个窗口、
真的点下去"。有效探针是 Electron 起窗口 + `executeJavaScript` 点侧边栏，
再读主内容区的 `getBoundingClientRect()`：**尺寸比文本更能区分"没渲染"与"渲染了但塌了"**。

### 安装后启动报「连不上模型网关」（2026-09-07）

装好的 App 从访达打开，Composer 上一条 danger：「连不上模型网关，现在发不出任务」。
**2026-09-07 对 `/Applications/EvoWork.app` 当场核对**：启动日志
`gateway.child.skipped reason=NO_KEYS`，asar 里没有 `readGatewayEnvFile`；
而 `~/.evowork/gateway.env` 里三家密钥都在。用同一份密钥、同一个
`Resources/gateway/main.js` 手工 spawn，`GET /v1/evowork/models` 返回 3 个模型 ——
网关程序没坏，是宿主没把文件里的密钥灌进子进程。

四件事叠在一起，每一件单独看都像已经处理过：

| 缺陷 | 表现 | 已改 |
| --- | --- | --- |
| **`~/.evowork/gateway.env` 文档让人写、宿主从不读** | 从终端起 Electron 时 shell 里有 `DEEPSEEK_API_KEY`，网关能起；双击安装包时进程环境是空的，本机网关走 NO_KEYS **根本不起**。模型目录那一次 fetch 打到没人听的 8787，catch 写成「连不上」 | 启动时读 `gateway.env` 补进子进程环境；引导第④步和首页录入框写的是同一个文件 |
| **NO_KEYS 被误报成「连不上」** | 宿主其实已经知道原因（`gateway.result.notice` 写着没密钥），但 `listModels` 仍然去 fetch，ECONNREFUSED 把原因盖掉。用户下一步该填密钥，界面却让他去查网关进程 | 网关没起时 `listModels` 原样返回 skip notice，带 `reason: 'no-keys'`；Composer 据此画出录入框，而不是只给「检查模型接入」再 fetch 一次 |
| **本机访问令牌也要人手工写文件** | 双击启动没有 `EVOWORK_GATEWAY_TOKEN`，即使用户配了密钥，网关也会因没令牌拒绝启动 | 拓扑 A 没有令牌时宿主自己签一个写进 `gateway-token`，并传给内核和本机网关。拓扑 B（网关在别处）仍然要用户提供 |
| **`spawn` 异步失败仍报 `{ started: true }`** | ENOENT / 子进程立刻 `exit 1` 时宿主以为网关在，再 fetch 一次变成「连不上」 | `error` / 非零 `exit` 把 result 改成 `SPAWN_FAILED`，listModels 不再去打没人听的端口 |

另：`spawn` 返回不等于 `listen` 完成。冷启动那几百毫秒里去 fetch，也会变成同一句「连不上」。`start()` 现在会等到端口在听（或超时说清楚）。

源码修了必须**重新构建后再装**。只改工作区、继续跑 14:34 那个 asar，界面上还是同一句「连不上」。
2026-09-07 把新 asar 写进 `/Applications/EvoWork.app` 后再起一次：日志是
`gateway.child.started itemCount=3`，不再是 `skipped reason=NO_KEYS`。

---

## 4. 卡住的事

| 事项 | 卡在 | 影响 |
| --- | --- | --- |
| **网关令牌的正式机制** | **未决策** | 现在是过渡方案：`EVOWORK_GATEWAY_TOKEN`、`~/.evowork/gateway-token`（本机拓扑会自动签发）、厂商密钥在 `~/.evowork/gateway.env` 或引导里填。明文文件不满足「密钥不落盘」的本意。两条候选：Electron `safeStorage` 存钥匙串 + 设置页录入，或 identity 服务签发短期令牌（Q14 原设计，identity 尚未开始）。**决策前不要把这些文件当成正式机制** |
| **P0-5 代码签名证书** | 外部采购 | M9 打包只能出未签名产物；U4 无法证伪 |
| **U1 GLM 产物质量** | 需要人工评分（08 §5.4 的三个任务），不是技术阻塞 | 若不达标应换旗舰档，**不靠加模板硬扛**（总纲原话）。这个结论越晚拿到，返工面越大 |
| **U3 misfire 真机体验** | 需要真机关机一夜 | M5 的文案与补偿策略无法确认 |
| **P4-2 法务审查** | 外部 | 与开发并行，不阻塞 |

---

## 5. 下一步（按 work-priority 的优先级）

1. ~~P2-1 M3~~ **已完成**（2026-09-05）。Q22「第 12 周内测」的交付面（M0 + M1 + M2a + M2 + M3）至此在代码层面齐了 —— 缺的是 U1 的人工评分。
2. ~~P2-2 M4~~ **核心已完成**（2026-09-05）。剩 Windows 隔离结论（U5，需真机）与策略包签名下发（R11）。
3. ~~P3-1 M5~~ **核心已完成**（2026-09-05）。剩与内核接线、`wake_system`、以及 07 的自动化 UI。
4. ~~P3-3 M8~~ **核心已完成**（2026-09-05）。剩图表库/mermaid 接线（随 M9 打包）、资料库三栏 UI、分享的上传实现。
5. ~~P3-2 M9 打包~~ **macOS 侧已跑通**（2026-09-06）。剩签名公证（卡 P0-5 证书，U4）、应用图标、以及 Windows / Linux 的真机打包。

---

## 6. 一句话概括"还剩什么"

| 类别 | 具体 | 卡在 |
| --- | --- | --- |
| **需要外部条件** | GLM 产物质量评分（U1）· misfire 真机（U3）· 签名公证（U4）· Windows 隔离（U5） | 人 / 真机 / 证书 |
| ~~需要装依赖~~ | ✅ **不再需要人装**：办公扩展 2026-09-07 起由 App 内的安装器装（`services/runtime-installer`），用户点一个按钮；离线机器用 `EVOWORK_OFFICE_BUNDLE`。`electron` 44 · `mermaid` 11 随包 | — |
| ~~需要接线~~ | ✅ **已接**：scheduler↔内核 · `fs/watch`↔产物索引 · 分享上传 · 四个技能↔办公运行时（缺模块时自动换解释器重跑）· **安装器↔引导第 ⑤ 步与探针**（装完 `probe.invalidate()` 再重探） | 剩：外部解析器↔受限子进程（等 M4 沙箱）—— 这意味着**拖入 docx/pdf 仍拿不到解析内容**，只会以原始文件引用（文案已改成不再劝人装扩展） |
| ~~还没画的 UI~~ | ✅ **已完成**：资料库三栏 · 自动化表单与执行历史 · 用量与审计页 · 首运行六步引导。2026-09-07 新增第 33 个组件 **ProgressBar**（办公扩展安装进度），**已按 Q24 的规矩先补进 01 §5.33 再实现** | — |

前两类不是写代码能解决的；后两类是纯工作量，且各自的**约束与判据都已经写进对应包的 README 与测试**。

## 7. 这份文件怎么维护

每完成一个里程碑或拿到一条"对着真东西验过的"结论时更新，**同时更新 [work-priority §10](work-priority.md)**。
第 3 节的两张表是这份文件的核心 —— 它们分别回答"什么能信"和"什么不能信"，
而项目最大的风险从来不是没做完，是**把没验过的东西当成验过的**。
