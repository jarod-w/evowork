# 电脑操控与自动批准：首版实现与验收

日期：2026-11-01（Asia/Taipei）。基线：`8f57a6d`，验收时为该基线上的工作区改动；版本保持 0.0.8。

## 范围

用户确认两项均为首版 P0，客户应用以微信、TextEdit、WPS/Office 和浏览器办公应用为主。
Apple Developer ID 正在申请，先完成开发与可执行测试；本轮不发布、不替换用户安装应用。

- 自动批准复用发货内核的同步 Guardian。实际使用任务选定的 MiMo v2.6 Flash 或 DeepSeek Flash 独立审查，不将模式改成完全访问，不给内置审查型号随意绑定另一家服务。
- 原生审查通知转换为独立本机证据，显示进行中、通过、阻止、超时、取消和风险理由。按 reviewId 合并；终态不能被迟到事件回退，刷新与 SQLite 重开恢复，任务删除后不重建。
- 用户拒绝/取消、停止控制、锁屏或审查失败后，下一步建议 Stop hook 不再强制追加模型工作；抑制绑定原回合，不影响新回合。
- 粘贴只走显式纯文本工具；协议和原生映射均拒绝 `Meta+V`。文本框元素单击走 AX Focus，按钮仍走声明的 AXPress；安全字段与无法识别的控件拒绝，不在失败后猜坐标。
- 已知本地办公/聊天应用的可编辑文本框单次左键元素聚焦免额外业务确认；风险标签优先，坐标、非文本控件、右键/多击、未知 App 继续确认。发送、删除、上传、付款等独立确认没有取消。

## 测试拓扑与边界

环境为本机 macOS arm64，Node 24.22.1、pnpm 10.30.3、Playwright 1.63.0、Electron 44.2.0。
发货内核来源证明仍使用已有两项补丁；没有修改上游内核。

两家模型分别使用用户指定的型号和地址。密钥只经关闭回显的标准输入进入测试进程环境，不写入源码、模型文件或报告。
请求观测仅保存端点、真实上游型号、时间、状态与固定布尔字段，不保存请求头、消息或凭据。

桌面应用用例为**真实 Electron、发货内核、产品宿主网关、真实厂商模型、真实 MCP 和注入的假原生 Helper**。
微信测试联系人、消息和 WPS/Word/TextEdit 窗口内容都是合成数据；不向真实微信联系人发送消息。
浏览器用例使用**实际 Chrome**、独立 profile 和本机合成办公表单，按实际 POST 次数和内容判定。

**这些桌面用例不证明真实应用的 AX/TCC、截图、物理输入中断或正式签名已通过。**
发布标记保持 `releaseVerified=false`。原生浏览器工具栏、扩展页和文件选择器回退尚未开放；普通网页继续使用受控 browser。

## 结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 原版 `pnpm run check` | 3483 通过 / 2 项既有跳过，退出 0；215 测试文件通过、1 既有跳过；格式、lint、类型、K1/K2 与许可检查通过 | [完整日志](assets/2026-11-01-computer-use-auto-review/check.log.txt) |
| 完整构建 | 退出 0；发货内核未改，桌面/网关/MCP/策略包与 Helper 产物已冻结哈希 | [构建日志](assets/2026-11-01-computer-use-auto-review/build.log.txt)、[36 项源码与产物哈希](assets/2026-11-01-computer-use-auto-review/source-sha256.json) |
| Swift 原生纯策略 | 65 项通过；包含文本框聚焦、按钮动作、受保护字段、快捷键与剪贴板旁路边界 | [日志](assets/2026-11-01-computer-use-auto-review/native-policy.log.txt) |
| 真实 Helper 最小进程探针 | health 长度帧通过；非受信父进程在读取应用前被拒；没有读取 AX/截图 | [日志](assets/2026-11-01-computer-use-auto-review/helper-health.log.txt) |
| App 签名元数据探针 | Finder 验证通过；10 个有效身份（其中普通 App 3、浏览器 3、终端 1、未知类别 3），3 个拒绝 | [只读结果](assets/2026-11-01-computer-use-auto-review/app-identities.json) |
| 客户应用已安装包元数据 | 微信与 WPS 的 bundle/signing ID 和 Team ID 与现有准入表匹配；TextEdit 为 Apple 标识。仅显示静态签名元数据，未激活应用、未读内容，不代替签名链/AX 验收 | [元数据](assets/2026-11-01-computer-use-auto-review/installed-app-signature-metadata.json) |
| MiMo v2.6 Flash 真实模型 + Playwright | 最终 14/14，无重试/跳过，528.737 秒；此前同运行时代码也为 14/14 | [JSON 报告](assets/2026-11-01-computer-use-auto-review/mimo-playwright.json)、[逐例原始证据](assets/2026-11-01-computer-use-auto-review/mimo-cases.json) |
| DeepSeek Flash 真实模型 + Playwright | 最终 14/14，无重试/跳过，153.572 秒 | [JSON 报告](assets/2026-11-01-computer-use-auto-review/deepseek-playwright.json)、[逐例原始证据](assets/2026-11-01-computer-use-auto-review/deepseek-cases.json) |
| 确定性 Playwright | 最终 17/17，无重试/跳过，34.944 秒 | [JSON 报告](assets/2026-11-01-computer-use-auto-review/deterministic-playwright.json)、[日志](assets/2026-11-01-computer-use-auto-review/deterministic-playwright.log.txt) |

每个模型的 14 项覆盖：实际命令提权自动审查与证据恢复 1 项、实际 Chrome 表单接受/拒绝 2 项，以及 TextEdit/微信/WPS/Word 的读写顺序、敏感动作接受/拒绝、终端禁用与审批档组合 11 项。接受动作核对真实测试文件字节、假 Helper 的调用/发送次数或实际 POST 内容；拒绝核对零副作用、无其它通道绕过和无强制 Stop hook。确定性组另覆盖审查允许、拒绝及无效审查输出的失败关闭。 本轮针对固定合成任务验收，没有开展 `--repeat-each` 的稳定率统计；现场失败保留，不据最终通过推断任意办公流程的成功率。

型号与请求核对见[脱敏汇总](assets/2026-11-01-computer-use-auto-review/model-requests.json)：MiMo 164 次请求均指向 `mimo-v2.6-flash` 和小米端点，已观测 162 次响应均 HTTP 200；DeepSeek 166 次请求均指向 `deepseek-flash` 和 DeepSeek 端点，已观测 165 次响应均 HTTP 200。取证结束前分别有 2 / 1 条请求未记录到响应，原因未确认，不能据此声称所有请求都成功。两个完整轮次各有 14 次内核启动，意外退出均为 0。

已查看界面截图：[DeepSeek 自动审批刷新恢复](assets/2026-11-01-computer-use-auto-review/deepseek-auto-review.png)、[DeepSeek 浏览器提交完成](assets/2026-11-01-computer-use-auto-review/deepseek-browser-approved.png)、[MiMo 微信单次发送](assets/2026-11-01-computer-use-auto-review/mimo-wechat-confirmed.png)、[MiMo 拒绝浏览器提交](assets/2026-11-01-computer-use-auto-review/mimo-browser-denied.png)。桌面内容均为合成夹具。

源码与导出证据使用两组实际凭据做精确字节扫描，0 命中；[扫描结果](assets/2026-11-01-computer-use-auto-review/secret-scan.json)记录文件数和方法，不保存凭据。发布标记仍为 [releaseVerified=false](assets/2026-11-01-computer-use-auto-review/release.json)。

复现（先完成构建，真实模型密钥由安全环境注入，不写入命令或文件）：

```sh
VITEST_MAX_FORKS=2 VITEST_MIN_FORKS=1 VITEST_MAX_THREADS=2 VITEST_MIN_THREADS=1 pnpm run check
node scripts/build.mjs
swift run --package-path apps/computer-use-macos EvoWorkComputerUsePolicyTests
node scripts/verify-computer-use-health.mjs
node scripts/verify-computer-use-apps.mjs
node node_modules/@playwright/test/cli.js test auto-review.spec.mjs computer-use.spec.mjs web-research.spec.mjs --project=fake --retries=0
# 分别设置 EVOWORK_UI_MODEL_PRESET=mimo-v2.6-flash / deepseek-flash
# EVOWORK_UI_MODEL_KEY 仅通过进程环境提供；EVOWORK_UI_FOLLOW_UP_WIRE=1 开启脱敏型号观测
node node_modules/@playwright/test/cli.js test auto-review.real.spec.mjs browser-office.real.spec.mjs computer-use.real.spec.mjs --project=real --retries=0
```

本机完整检查使用已有办公 Python 运行时，通过 `EVOWORK_OFFICE_PYTHON` 指定，限制 Vitest 并发为 2；不增加测试超时或新增跳过。真实窗口组串行执行，不与构建重叠。首次沙箱内 host/socket 测试遭系统权限限制，未据此判断产品失败；同代码在可使用本机 socket 的环境通过。

## 发现与修复

1. 自动审查原本已能执行，但界面没有消费原生审查通知；新增通知适配、状态展示和任务级本机证据。
2. 刷新测试原先误以为会自动回到当前任务；改为从侧栏重开同一任务，再核对真实持久证据。失败时取证不再掩盖原始错误。
3. “已停止”“已交付”被初版措辞断言误判；修正语义范围，文件字节、Helper 调用、单次发送、POST 次数及拒绝后零执行断言保持。
4. MiMo 一次在拒绝 Enter 后已经正确说明停止，但 Stop hook 又强制登记下一步，产生无关的“2 + 2 = 4”尾回复。修复拒绝/停止后的钩子联动，保留[原始失败证据](assets/2026-11-01-computer-use-auto-review/regression-mimo-stop-before-fix.json)，不把无关回复纳入通过条件。
5. DeepSeek 合法地先点击输入框再按 Enter；初版测试将聚焦确认也计为发送确认。改为按具体敏感动作判定，同时补上原生 AX Focus 路径与严格的普通聚焦策略，发送仍只允许确认后执行一次。
6. DeepSeek 最终轮次初次为 13/14：浏览器已正确单次 POST 并读回结果，但测试先 count 再 innerText，卡片在两次查询间消失后触发等待超时。改用一次 allInnerTexts 快照，未增加等待时间或放松提交次数/内容断言；只改该测试文件，全部运行时代码及构建哈希保持一致。保留[13/14 报告](assets/2026-11-01-computer-use-auto-review/prior-deepseek-playwright.json)与[实际 POST 记录](assets/2026-11-01-computer-use-auto-review/regression-deepseek-browser-test-race.json)。

## 正式原生验收待办

证书到位后，使用同 Team ID 的正式签名桌面包和 Helper，按设计 12 §17 继续完成真实应用 AX/截图、TCC 授权/撤销/升级、九类原生动作、多屏/窗口变化/锁屏、物理输入中断 P95、剪贴板异常恢复，以及真实 MCP 内容/blob/索引删除矩阵。不能用本轮假 Helper 测试或手工改发布标记替代。


证书到位后的首轮应用矩阵（使用专用测试数据；每次写入前后重新观察）：

| 应用 | 任务与效果断言 | 目前证据 |
| --- | --- | --- |
| 微信 | 专用验收联系人/会话；核对接收人及已有草稿；拒绝后发送数为 0，单次确认后发送数为 1，再读消息结果；切换会话后旧状态失效 | 假 Helper 已测接受/拒绝；真实微信未验 |
| TextEdit | 新建临时未保存文档，聚焦并写入唯一标记，重读一致；拒绝写入不变；原文档不覆盖 | 真实模型 + 假 Helper 已测；真实 AX 未验 |
| WPS / Word / Excel / PowerPoint | 临时文档/工作簿/演示文稿的 AX 识别、聚焦、编辑和重读；另测保存/覆盖/分享逐次确认与拒绝不执行 | WPS/Word 的拒绝提交链已测；各真实 App/文件格式未验 |
| 浏览器办公应用 | 独立 profile 中打开页面、填表、核对 origin 和提交内容；接受仅 1 次 POST，拒绝 0 次；跨 origin 再授权 | 本机合成表单实际 Chrome 已测；客户业务站点和登录态未验 |

所有应用均需补焦点/窗口变化、过期 state_id、Esc/停止控制、用户物理输入、锁屏、Helper 断连及剪贴板恢复；正式签名正向链路与上述矩阵通过前保留发布闸门。
