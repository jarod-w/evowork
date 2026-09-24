# 12 · 电脑操控（Computer Use）设计

> 状态：**设计决策已确认；CU-Q1–CU-Q6 全部完成，待实施**
> 日期：2026-09-24
> 适用基线：EvoWork `5fdde4147650b3b146ec8a4a78c1815f89fbad5b`；Codex `ee6814bfa4889fe9b2b3dcc9cc8bdd91effa8ab8`
> 关联文档：[总纲](../evowork-on-codex-design.md) · [服务层](09-service-layer.md) · [安全与权限 UX](10-security-permissions-ux.md) · [插件](05-experts-skills-connectors.md)

## 0. 一句话结论

EvoWork 应沿用 Codex 的分层思路，但不能直接复制或分发未获得开源或再分发授权的 `@oai/sky` 与
`Codex Computer Use.app`（包含它们的 Computer Use 插件声明为 `Proprietary`）：在 **Codex 内核不打补丁** 的前提下，自建一个随产品签名分发的
原生辅助 App，通过名为 `cua_repl` 的本机 stdio MCP server 暴露“读状态 → 按元素操作 →
重新读状态”的闭环；所有系统权限、应用准入、危险动作确认、审计和紧急停止均由 EvoWork
宿主掌控。

首版已确认仅支持 **macOS 14.4+**（CU-Q1=A），工具面覆盖读取应用状态、点击、滚动、拖拽、按键、输入、
粘贴、设置值、选择文本和辅助动作；不做锁屏操控、音频录制、后台监控、录制回放、验证码代做，
也不让 agent 操控 EvoWork 自身的审批界面、密码管理器、任何终端/命令行前端或系统设置。

原生 Helper 与 `cua_repl` MCP server **随 macOS 基础安装包分发，但电脑操控能力默认关闭**
（CU-Q2=A）。首次使用只做本机组件校验和系统权限引导，不临时联网下载执行组件；组件缺失、损坏或
版本不匹配时进入修复流程，不带病启动。

AX 正文与必要截图会作为工具结果**随本机任务历史留存**（CU-Q5=A）。首次在任务中启用电脑操控前，
必须明确告知读取内容、当前模型、数据去向和本机留存；结构化审计仍不得复制这些正文。

---

## 1. 背景、目标与非目标

### 1.1 背景

EvoWork 当前可以通过内核执行命令、修改文件、调用 MCP，并有 browser 连接器，但不能操作
普通桌面应用。例如，无法在 Finder、TextEdit、Numbers 或企业客户端里读取当前窗口并完成点击、
输入、选择和滚动。

“电脑操控”与普通 MCP 连接器的差异是：

1. 它读取屏幕与辅助功能树，天然可能接触任务无关的敏感内容。
2. 它的动作发生在用户真实桌面，会产生不可逆或对外部世界有影响的结果。
3. macOS 的辅助功能和屏幕录制权限绑定到签名后的原生可执行文件，不能靠纯 JavaScript 完整解决。
4. UI 元素随界面变化会失效，必须把每次操作与刚获取的界面状态绑定，不能长期复用坐标或元素 id。

### 1.2 目标

- 用自然语言操作用户明确允许的本机桌面应用。
- 优先依据辅助功能树定位元素，必要时使用截图与相对窗口坐标兜底。
- 每次操作之后重新观察，形成可纠错的闭环，而不是盲目执行动作序列。
- 复用 Codex 已有 MCP、Guardian、`mcpServer/elicitation/request`、Item 事件和审批链路。
- 保持 K1：不修改 `../codex`；保持 K2：桌面前端仍只通过 app-server JSON-RPC v2 与内核交互。
- 权限默认关闭、按应用授权、随时可停，并留下不含正文和截图内容的审计记录。
- 原生服务不联网；屏幕内容只可能经现有模型调用通道发给当前任务选定的模型提供方。

### 1.3 非目标

- 不做远程桌面、远程协助或跨设备控制。
- 不做 7×24 小时后台观察、Computer History、录制与回放。
- 不在首版支持锁屏状态自动解锁或继续操作。
- 不绕过 CAPTCHA、HTTPS 安全警告、权限提示、付费墙或系统访问控制。
- 不通过 Computer Use 操控 Terminal、iTerm、Warp 等终端/命令行前端，也不操控 System Settings；
  命令执行继续走受控 shell 工具，系统设置由用户手动完成（CU-Q6=A）。
- 不直接复用 OpenAI 专有二进制、专有 npm 包、品牌资源或私有更新服务。
- 不用电脑操控替代已有的 API、MCP、文件或浏览器专用能力；专用能力可用时仍优先使用它。
- Windows/Linux 已确认不进入首版。协议保持跨平台；两端平台驱动、权限适配、签名打包与真机矩阵
  作为后续独立工作项登记，不把接口占位描述成当前可用能力。

---

## 2. Codex 实现核对结果

本节只记录为本设计实际核对过的事实。Codex 路径相对外层工作区的 `codex/`。

### 2.1 能力不是内核内置鼠标工具，而是插件与宿主服务组合

本机 Codex 的 `computer-use@openai-bundled` 插件只包含 manifest、图标和 `SKILL.md`。技能要求模型
通过持久化的 Node REPL 加载 `@oai/sky`，其公开给模型的窗口级接口为：

```text
list_apps
get_app_state
click
drag
paste
perform_secondary_action
press_key
scroll
select_text
set_value
type_text
```

`get_app_state` 同时返回辅助功能树文本和窗口截图；后续动作优先引用其中的 `element_index`，
元素不可用时才退到截图坐标。每次动作后要求重新获取状态，避免复用陈旧元素。

实际宿主由三层组成：

```text
Codex 模型
  → node_repl / cua_repl（MCP；持久 JS 上下文）
  → @oai/sky（JS 客户端；参数校验、应用授权、遥测）
  → Codex Computer Use.app（Swift 原生服务）
      · AXUIElement / Accessibility
      · ScreenCaptureKit
      · CGEvent / AppKit
      · 本机 socket / XPC
```

安装样本显示原生服务是后台 `LSUIElement` App，持有 Apple Events、联系人、屏幕录制和辅助功能
相关能力，并通过带长度前缀的本机 JSON-RPC socket 通信。其实现还包含应用级准入、屏幕锁定检测、
用户中断、状态栏提示和陈旧元素检测。

### 2.2 Codex 已为 computer use 预留特殊安全语义

以下均在当前内核基线中存在：

- `codex-rs/protocol/src/mcp.rs:38-40`：只有 MCP server 名 `node_repl` 或 `cua_repl`
  被识别为 Node REPL-backed computer use。
- `codex-rs/protocol/src/openai_models/guardian.rs:72-84`：这两个 server 的工具调用进入
  `GuardianScope::ComputerUse`，而不是普通 MCP scope。
- `codex-rs/core/src/mcp_tool_call.rs:1294-1327`：内核只向上述 server 下发模型提供的
  `computer_use` confirmation policy。
- `codex-rs/config/src/computer_use.rs:7-35`：用户配置支持默认应用访问策略，以及 macOS bundle id、
  Windows AUMID/签名可执行文件级 allow/deny。
- `codex-rs/config/src/browser_computer_use_requirements.rs:89-111`：企业要求层可以禁止锁屏操控、
  禁止持久授权、强制默认应用策略和按应用 deny。
- `codex-rs/app-server-protocol/src/protocol/v2/config.rs:428-432,500-506`：上述要求可经
  `configRequirements/read` 暴露给客户端。
- `codex-rs/app-server-protocol/src/protocol/v2/mcp.rs:385-404,751-874`：MCP server 发起的
  elicitation 会作为 `mcpServer/elicitation/request` 交给 app-server 客户端，回复区分
  `accept` / `decline` / `cancel`，并允许结构化内容。
- `codex-rs/config/src/mcp_types.rs:25-48`：MCP 工具审批模式为 `auto` / `prompt` / `writes` /
  `approve`；工具可通过 read-only annotation 参与判定。

### 2.3 可借鉴与不可直接复用的边界

| 内容 | 处理 |
| --- | --- |
| “观察—动作—再观察”的交互协议 | 复用设计思想与行为约束 |
| `cua_repl` 特殊 server 名 | 复用；无需内核补丁即可进入 ComputerUse Guardian scope |
| MCP tool approval、elicitation、Item 事件 | 直接复用内核协议 |
| `computer_use` / requirements 配置形状 | 对齐并由 EvoWork 设置页管理 |
| `@oai/sky`、Computer Use App、图标、文案 | **不分发、不复制实现**；`@oai/sky` 包内未发现独立开源许可证，包含它的插件 manifest 标注 `Proprietary`，且含第三方品牌 |
| Node REPL 二进制及 trusted services runtime | **不复用**；它不在开源 Codex 仓库中 |
| 锁屏自动解锁、消息/联系人专用能力、后台历史 | 首版不实现 |

因此本文所说“基于 Codex 方案”是指复用它的**分层、协议接点、安全语义和交互闭环**，不是复制
其专有代码或二进制。

---

## 3. 设计决策

### CU-D1 · 独立原生辅助 App，不把高权限能力放进 Electron 渲染进程

新增签名后的 `EvoWork Computer Use.app`。macOS 的辅助功能树读取、窗口截图和输入事件注入全部
在该进程中完成。Electron 渲染进程继续保持 `contextIsolation=true`、`nodeIntegration=false`、
`sandbox=true`，不获得任何新系统权限。

理由：TCC 权限归属稳定、崩溃域独立、权限可单独撤销、便于明确显示“正在控制”，也避免一个 XSS
直接获得桌面控制能力。

### CU-D2 · MCP server 命名为 `cua_repl`，但首版不用任意 JavaScript REPL

首版 `cua_repl` 是受限的 stdio MCP server，直接暴露固定 schema 的 11 个工具，不提供 `eval`、
文件系统、shell 或任意模块加载。使用这个 server 名是为了复用内核已有 ComputerUse Guardian scope
和 confirmation policy，不代表向模型开放通用 REPL。

这与 Codex 当前实现有一处有意差异：Codex 借助已存在的可信 Node REPL 复用浏览器和电脑操控；
EvoWork 尚无这个可信运行时，贸然自建任意 JS 执行器会扩大攻击面。若以后确实需要组合式 REPL，
必须作为独立安全项目评审。

### CU-D3 · 辅助功能树优先，截图兜底

`get_app_state` 返回：

1. 目标应用与窗口的稳定标识；
2. 带本次状态版本号的扁平化辅助功能树；
3. 可选窗口截图；
4. 当前焦点、选中文本、窗口 bounds、scale factor；
5. 是否需要截图才能可靠操作。

动作优先使用 `element_index`。只有以下情况允许坐标：应用不提供 AX 节点、画布/游戏类界面、
或节点动作明确失败。坐标以刚获取的**目标窗口截图左上角**为原点，不用全屏绝对坐标。

### CU-D4 · 每个动作绑定状态版本，动作后强制重新观察

每次 `get_app_state` 生成 `state_id`，元素索引只在该 `state_id` 下有效。除 `list_apps` 和
`get_app_state` 外，所有工具调用必须携带 `state_id`。发生下列任一情况即返回 `STALE_STATE`：

- 前台窗口、窗口 bounds 或目标进程变化；
- 状态生成超过 30 秒；
- 已执行过改变界面的动作；
- AX element 已失效或无法唯一重定位。

服务端不会“猜一个最像的元素继续点”。模型必须重新调用 `get_app_state`。

### CU-D5 · 三层授权不能互相绕过

1. **系统权限层**：macOS Accessibility + Screen Recording；用户未授予则只返回设置引导。
2. **应用准入层**：默认 deny；首次访问某 App 询问“仅本次任务 / 始终允许 / 不允许”。企业策略
   可强制 deny，且优先级高于用户选择。
3. **动作审批层**：复用 MCP tool approval + Guardian + EvoWork 审批卡。硬禁止项即使“完全访问”
   也不能绕过。

CU-Q3=A：用户可以选择“始终允许某 App”。该选择只持久化**应用准入**，不等于永久批准这个 App
内的点击、输入、上传、发送或删除动作；动作审批层仍逐次按当前审批档和风险类别执行。持久授权按
规范化 App 身份保存于本机，不云同步，可在设置页随时撤销；硬禁止列表、企业对具体 App 的 deny、
签名身份变化和用户撤销均优先使其失效。CU-Q3 未采纳“企业版一律禁用持久授权”的 C 选项。

### CU-D6 · 电脑操控不用于无人值守自动化

首版自动化任务不得调用 `cua_repl`。原因是电脑状态、焦点和可见窗口不可预测，且当前自动化审批
会在 10 分钟后拒绝。能力探测时应对 `source=automation` 隐藏这组工具；若内核暂不能按来源隐藏，
则由 `pre_tool_use` hook 硬拒绝并记录 `COMPUTER_USE_UNATTENDED_DENIED`。

### CU-D7 · 新增的是现有模型通道的数据类别，不新增网络出口

原生辅助 App 和 MCP server 均禁止联网。AX 文本和截图会作为工具结果进入当前任务，并随下一次
模型请求经现有“内核 → 本机网关 → 当前模型提供方”通道传输。UI 必须明确展示当前模型及凭据来源，
并在任务首次启用电脑操控时提示：

> 为完成此任务，EvoWork 会读取你允许的应用窗口；界面文字和必要截图会发送给当前所选模型。

不得把截图另发给“视觉模型”或云 OCR 兜底。当前模型不支持图片时只使用 AX 文本；如果不足以
可靠操作，就失败并建议用户切换支持图片输入的模型。

### CU-D8 · 浏览器 App 可操控，但 browser connector 始终优先

CU-Q4=A：首版允许 Computer Use 操控 Safari、Chrome 等浏览器 App，但普通网页中的读取、定位、点击、
输入、导航和下载优先使用现有 browser connector（CDP）。只有 CDP 覆盖不到的浏览器 chrome、扩展页、
原生文件选择器、原生权限弹窗，或目标浏览器明确无法建立 CDP 会话时，才允许切换到 Computer Use。

切换不能成为绕过 browser 策略的后门：origin 白名单、上传、下载、表单提交和敏感数据外发若已被
browser connector 拒绝，Computer Use 也必须拒绝，不能因为换了执行通道就放宽。切换前仍需目标
浏览器 App 的应用准入；一次操作链只由一种控制器持有，不能交错复用 CDP 节点与 `state_id`。

当前 browser MCP 已存在，但“能力路由 → 受控回退 → 策略继承”尚未实现，不能把本决策写成现有能力。

### CU-D9 · AX 正文与截图随任务留存，但不进入结构化审计

CU-Q5=A：`get_app_state` 返回的 AX 正文、选中文本和截图作为 MCP 工具结果写入本机任务历史，生命周期
与任务一致。归档任务会继续保留这些内容；真正删除任务或执行覆盖该任务的历史清理时，必须同时删除
对应 rollout、图片/blob 和索引。只从 EvoWork 投影表或侧栏移除一行不算删除。

任务历史留存与结构化审计严格分开：`audit_log` 只记 App id、动作类型、结果码、是否含截图等元数据，
不得复制 AX 正文、截图、输入内容或窗口标题。Helper 的传输临时文件继续执行 5 分钟 TTL；删除临时
副本不会删除已进入任务历史的内容。

本机删除不能撤回已经发送给模型提供方的数据；提供方可能按其服务条款保留请求内容。首次提示必须
说明这一边界。CU-M0 仍需实测具体 rollout/blob 路径、备份/导出行为和真实删除效果，但不再重新选择
留存方案。若当前内核无法完成真实删除，公开 beta 前必须补齐删除路径或如实阻断该功能。

---

## 4. 总体架构

```text
┌──────────────────────────────────────────────────────────────────────┐
│ EvoWork Renderer                                                     │
│ 设置/权限状态 · 电脑操控 Item · 应用审批卡 · 正在控制横条 · 停止按钮 │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ 既有 preload IPC（语义化，不暴露 ipcRenderer）
┌───────────────────────────▼──────────────────────────────────────────┐
│ EvoWork Electron Main                                                │
│ computer-use-host · 策略合并 · 审计 · 生命周期 · 本机认证 socket     │
│ 生成每次启动 token，并注入 app-server 环境；不持有截图正文            │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │ 启动/健康检查/停止             │ 既有 stdio JSON-RPC v2
                ▼                               ▼
┌──────────────────────────────┐      ┌───────────────────────────────┐
│ EvoWork Computer Use.app     │      │ codex-app-server              │
│ Swift / LSUIElement          │      │ MCP + Guardian + approvals    │
│ AX + ScreenCaptureKit        │      └──────────────┬────────────────┘
│ CGEvent + Clipboard restore  │                     │ 启动 stdio MCP
│ 状态栏/遮罩/Esc 中断         │                     ▼
└───────────────▲──────────────┘      ┌───────────────────────────────┐
                │ 私有 Unix socket    │ cua_repl server.mjs            │
                │ 0700 dir + token    │ 固定 11 工具，无 eval/shell/fs │
                └─────────────────────┴───────────────────────────────┘
```

### 4.1 为什么不让 MCP server 直接获得 Accessibility 权限

MCP server 由内核按任务生命周期启动，进程路径和宿主可能变化；TCC 权限提示、签名身份和升级后的
权限延续都不稳定。固定 bundle id 的辅助 App 才是权限主体。MCP server 只是低权限协议适配器，
即使被提示注入诱导，也必须通过宿主 token、应用准入和动作策略才能触发原生操作。

### 4.2 本机认证与进程关系

- Electron 主进程每次启动生成 256-bit 随机 `EVOWORK_CUA_SESSION_TOKEN`，只放在内存和子进程环境。
- app-server 继承该变量；`[mcp_servers.cua_repl].env_vars` 只登记变量名，不把值写进 `config.toml`。
- 辅助 App 监听 `~/.evowork/run/<pid>/computer-use.sock`；目录权限 `0700`、socket `0600`。
- 每个请求同时校验 token、父会话 id、turn id 和单调递增序号；无效三次立即断开。
- socket 不接受 TCP，不监听局域网，不把 token 写日志。
- Electron 主进程退出、用户点停止、turn 结束或 60 秒无心跳时，辅助 App 撤销活动会话并释放输入控制。

macOS 后续应增加调用方 code-signature/audit-token 校验，作为 token 之外的第二因子；这是安全验收项，
不是首版可选优化。

---

## 5. 工具协议

### 5.1 工具清单与 MCP annotations

| 工具 | 主要参数 | 输出 | annotation |
| --- | --- | --- | --- |
| `list_apps` | 无 | 最近使用/正在运行的可定位应用 | read-only |
| `get_app_state` | `app`, `disable_diff?`, `include_screenshot?` | `state_id`, AX 文本、截图、窗口元数据 | read-only |
| `click` | `app`, `state_id`, element 或坐标、按键、次数 | 动作结果 | destructive/write |
| `drag` | `app`, `state_id`, 起止窗口坐标 | 动作结果 | destructive/write |
| `paste` | `app`, `state_id`, `text`, `format` | 动作结果 | destructive/write |
| `perform_secondary_action` | `app`, `state_id`, `element_index`, `action` | 动作结果 | destructive/write |
| `press_key` | `app`, `state_id`, `key` | 动作结果 | destructive/write |
| `scroll` | `app`, `state_id`, element/坐标、方向、页数 | 动作结果 | destructive/write |
| `select_text` | `app`, `state_id`, element、文本、前后缀、选择模式 | 动作结果 | destructive/write |
| `set_value` | `app`, `state_id`, element、值 | 动作结果 | destructive/write |
| `type_text` | `app`, `state_id`, 文本 | 动作结果 | destructive/write |

`scroll` 虽通常低风险，仍标为 write，因为它会改变界面状态并使元素索引失效。`get_app_state` 默认返回
相对上一次状态的 AX diff；`disable_diff=true` 返回完整树。

### 5.2 统一输入约束

```ts
type AppTarget = {
  app: string;          // bundle id 优先，也接受 list_apps 返回的规范 id
  state_id: string;     // 除 list/get 外必填
};

type ElementOrPoint =
  | { element_index: number }
  | { x: number; y: number };
```

- `element_index` 与坐标二选一，不能同时给。
- 坐标必须落在最近截图的目标窗口 bounds 内。
- `click_count` 仅允许 1–3；`pages` 为 1–5；单次 drag 时长和距离有上限。
- `press_key` 只接受枚举化键名与有限组合，不接受全局快捷键；目标 App 必须为前台。
- `type_text` 中的换行可能提交表单，技能指令要求模型在提交型编辑器中优先 `paste` 或 `set_value`。
- `paste` 临时替换系统剪贴板，动作完成或失败都恢复原内容；不把原剪贴板内容返回模型或写日志。

### 5.3 统一输出

```ts
type ComputerUseResult = {
  ok: boolean;
  code?:
    | 'PERMISSION_REQUIRED'
    | 'APP_DENIED'
    | 'APP_NOT_FOUND'
    | 'WINDOW_NOT_FOUND'
    | 'STALE_STATE'
    | 'ELEMENT_NOT_FOUND'
    | 'USER_STOPPED'
    | 'SCREEN_LOCKED'
    | 'MODEL_IMAGE_UNSUPPORTED'
    | 'POLICY_DENIED'
    | 'TIMEOUT'
    | 'INTERNAL';
  message: string;      // 可给模型看的短说明，不含屏幕正文
  requires_refresh?: boolean;
};
```

动作成功统一回复“已完成，请重新获取应用状态”，不返回猜测性的业务结论。

### 5.4 AX 树表示

扁平文本每行一个元素，示例：

```text
[12] button "保存" enabled actions=[Press]
[13] textField "文件名" value="周报" focused settable
[14] scrollArea "正文" selectedText=""
```

规则：

- 只保留可见或与操作相关的节点，默认预算 2,000 行 / 64 KiB。
- 密码字段只输出 `secureTextField`，绝不输出 value。
- 对表格、树和列表保留父子层级、行列位置与选中态。
- 元素 id 是会话内随机映射，不暴露 AX 对象地址、PID 内存地址或可复用系统句柄。
- diff 必须带 `base_state_id`；找不到基线时自动返回完整树并标注原因。

---

## 6. 端到端时序

### 6.1 首次读取应用

```text
模型 → cua_repl.get_app_state(app)
内核 → MCP tool approval/Guardian（read-only 通常不阻塞）
MCP → 宿主：校验 turn、任务来源、系统权限、企业策略
宿主 → UI：该 App 尚未获准，发起 mcpServer/elicitation/request
用户 → 仅本次任务 / 始终允许 / 拒绝
宿主 → Helper：激活 App，读取 AX，按需截图
Helper → MCP → 内核 → 模型：状态文本 + 可选图片
UI：时间线显示“已读取 <App> 窗口 · 内容已保存到此任务”，默认不展开屏幕正文
```

### 6.2 执行动作

```text
模型 → click(app, state_id, element_index)
内核 → 根据 MCP annotation + 当前审批档决定用户审批或 Guardian 复核
策略层 → 检查禁止应用、锁屏、任务来源、状态新鲜度、动作上限
Helper → 执行动作
Helper → 使旧 state_id 失效
模型 → get_app_state(app)
模型 → 根据新状态继续、纠错或结束
```

### 6.3 用户中断

以下任一事件立即中断本回合的电脑操控会话：

- 用户按 Esc；
- 用户点击常驻“停止控制”；
- 用户在被控制应用中产生真实鼠标/键盘输入；
- 窗口切到禁止应用、锁屏或快速用户切换；
- turn 被 `turn/interrupt`；
- Helper/MCP/宿主任一心跳超时。

中断只终止电脑操控，不默认删除任务；工具返回 `USER_STOPPED`，agent 应停止动作并说明可继续等待指示。

---

## 7. 权限、审批与安全策略

### 7.1 系统权限引导

设置 → 安全与权限新增“电脑操控”：

| 状态 | UI | 可用能力 |
| --- | --- | --- |
| 随包组件缺失或损坏 | “修复组件” | 无；不临时联网下载 |
| 待辅助功能权限 | “打开系统设置”+ 检查状态 | 仅列应用，不读 UI |
| 待屏幕录制权限 | 单独说明截图用途 | AX-only |
| 就绪 | 绿色状态 + 已允许 App 数 | 完整能力 |
| 企业禁用 | 锁态 + 策略来源 | 无 |
| 组件版本不匹配 | “修复组件” | 无，不尝试降级协议 |

权限必须由用户在系统设置里完成。Agent 不得替用户点击 TCC、辅助功能或屏幕录制授权。

### 7.2 应用策略优先级

```text
硬禁止列表
  > requirements.toml 企业规则
  > 用户按 bundle id 的 deny/allow
  > default_app_access（建议 deny）
  > 本次任务临时授权
```

首版硬禁止：

- EvoWork 自身窗口，尤其是审批、设置和权限 UI；
- macOS 登录窗口、SecurityAgent、System Settings 整个 App（包括但不限于 TCC/隐私与安全面板）；
- Passwords、Keychain Access、第三方密码管理器与身份验证器；
- Terminal、iTerm、Warp 等任意 shell/命令行前端（命令应走已有受沙箱和审批控制的 shell 工具）；
- 远程桌面/屏幕共享应用；
- 能展示或导出系统级凭据的管理工具。

CU-Q6=A：Terminal、iTerm、Warp 等所有终端/命令行前端，以及 macOS System Settings 整个 App
均为 Computer Use 硬禁止目标，不只禁止“隐私与安全”页面。硬禁止发生在激活、读取 AX 或截图之前：
`list_apps` 不把它们作为可操作目标返回；显式指定时返回 `POLICY_DENIED`。持久 App allow、三档审批、
Guardian 通过或“完全访问”都不能覆盖。命令仍可通过既有 shell 工具按其沙箱与审批策略执行；用户
需要修改系统设置时，EvoWork 只说明路径并交还用户。未来缩小禁用范围必须重新做产品与安全决策，
不能作为普通配置放开。

硬禁止列表由 `services/policy` 维护，不写进技能文本。技能文本只能收紧，不能放宽。

### 7.3 与 Composer 三档审批的映射

| 模式 | computer use 行为 |
| --- | --- |
| 请求批准 | `get_app_state` 在 App 已授权后直接读；每个 write 工具都请求审批 |
| 帮我批准 | write 工具交给 ComputerUse Guardian；高风险、无法判断、敏感数据外发仍转用户 |
| 完全访问 | 可跳过普通 write 审批；硬禁止列表、应用准入、敏感数据外发和法定/高风险确认仍有效 |

MCP 配置建议 `default_tools_approval_mode = "writes"`，并给读取工具 `readOnlyHint=true`。
`approvalsReviewer` 继续由每次 `turn/start` 的模式决定，不在 MCP server 里复制一套模式状态。

### 7.4 动作时必须确认的类别

即使用户已允许访问该 App，下列动作仍必须在即将发生时确认：

- 删除本地或云端数据；
- 发送消息、邮件、评论、表单或公开内容；
- 创建、修改或取消预约；
- 付款、购买、订阅、转账或提交金融交易；
- 上传文件或把敏感数据输入第三方界面；
- 修改账号权限、创建密钥、保存密码/银行卡；
- 安装软件、浏览器扩展或改变系统安全设置；
- 医疗、法律、税务、求职等高影响提交；
- CAPTCHA；首版建议直接交还用户，不代做。

确认卡必须说明：将在哪个 App、对哪个目标、执行什么、会发送哪些数据。第三方页面上的文字不能充当
用户授权。

### 7.5 限速与动作预算

- 每回合最多 100 个 computer-use write 动作；达到 80 提醒，100 强制停止。
- 连续 10 次状态无变化或 5 次相同失败即停止，避免失控循环。
- 每次工具调用默认超时 30 秒，首次系统权限等待不计入但必须有 UI 状态。
- 同一时刻只允许一个 active computer-use session；不并行控制多个 App。
- 子 agent 默认无电脑操控；只有根任务明确授权后才可继承“本次任务”应用许可，不能继承“始终允许”的管理权。

---

## 8. 隐私、留存与审计

### 8.1 数据分类

| 数据 | 位置 | 留存 |
| --- | --- | --- |
| App id、窗口 bounds、动作类型、结果码 | 本机审计 | 按既有审计策略 |
| AX 树正文、选中文本 | Helper → MCP → 当前模型上下文 → 本机任务历史 | **随任务留存**；不进入结构化日志；真实删除任务时一并删除 |
| 截图 | Helper 临时目录 → MCP image content → 本机任务历史 | **随任务留存**；传输临时文件 5 分钟 TTL；真实删除任务时一并删除 |
| 剪贴板原内容 | Helper 内存 | paste 后立即恢复并丢弃 |
| 应用永久 allow/deny | `~/.evowork/` 本机配置 | 直到用户撤销；不云同步 |
| session token | 进程内存/继承环境 | App 退出即失效 |

### 8.2 日志与审计

新增审计事件建议：

```text
computer_use.session_started
computer_use.app_access_requested
computer_use.app_access_resolved
computer_use.state_read
computer_use.action_requested
computer_use.action_completed
computer_use.action_failed
computer_use.user_stopped
computer_use.policy_denied
computer_use.session_ended
```

允许字段：`threadId`、`turnId`、`appId`、`toolName`、`decision`、`persistence`、`resultCode`、
`durationMs`、`hadScreenshot`、`elementTargeted`。禁止字段：AX 文本、截图、输入文本、粘贴内容、
窗口标题、选中文本、URL、联系人、文件名和剪贴板内容。

### 8.3 屏幕内容传输提示

首次在每个任务启用时显示一次阻塞式提示，包含当前模型、凭据来源、数据去向和留存方式：

> EvoWork 将读取你允许的应用窗口。界面文字和必要截图会发送给当前所选模型，并保存在这条任务的
> 本机历史中，直到你真正删除该任务或清理任务历史。删除本机任务不能撤回模型提供方已收到的数据。

按钮为“继续并启用”与“取消”。用户拒绝后本任务不再自动弹出；只有用户再次明确要求操控电脑时才
重试。设置页提供总开关和“清除所有应用授权”；后者只清 App allow/deny，不删除既有任务历史，文案
必须明确区分。任务历史删除入口及其磁盘验收见 04 §3.3。

---

## 9. EvoWork 代码落位

建议目录如下；名称描述职责，实施时不另起平行架构：

```text
evowork/
  apps/
    computer-use-macos/           # Swift 原生 Helper 工程与测试
  services/
    computer-use/                 # 平台无关协议、策略、状态机、错误类型
  plugins/
    skills/computer-use/          # 模型工作流与安全指令
    connectors/computer-use/      # cua_repl stdio MCP server（固定工具面）
  apps/desktop/src/main/
    computer-use-host.ts          # Helper 生命周期、socket、token、健康检查
  apps/desktop/src/renderer/
    views/settings-computer-use.tsx
    components/computer-use-status.tsx
  config/
    computer-use-policy.toml      # EvoWork 自有策略；不要混入内核未知字段
```

具体改动面：

| 位置 | 改动 |
| --- | --- |
| `packages/protocol` | 加入 `mcpServer/elicitation/request` 的手写子集；仍只声明实际依赖面 |
| `services/kernel-adapter` | 审批路由新增 `mcp` 类型、结构化回复与持久范围；关联 thread/turn |
| `services/policy` | App allow/deny、硬禁止、动作预算、无人值守拒绝、审计决策 |
| `services/catalog` | 官方 Computer Use 作为一个组合插件展示；未就绪时显示系统权限原因 |
| `apps/desktop/main` | Helper 安装/版本/启动/退出、临时 token、状态广播 |
| `apps/desktop/preload/shared` | 只增加语义化状态查询、打开设置、停止、授权管理动作 |
| `apps/desktop/renderer` | 设置卡、任务状态条、审批卡和时间线 Item |
| `config.toml` 写入方 | 注册 `mcp_servers.cua_repl`，`env_vars` 只含 token/socket 变量名 |
| `requirements.toml` | 对齐 `allow_browser_and_computer_use`、`computer_use.*` 企业约束 |
| `build/` | Helper 的签名、公证、bundle id、版本绑定和 extraResources |

### 9.1 配置草案

内核配置只放内核认识的键：

```toml
[mcp_servers.cua_repl]
# 下列两个绝对路径由桌面宿主按实际安装位置生成，不能写死 /Applications。
command = "/ABS/PATH/EvoWork.app/Contents/MacOS/EvoWork"
args = ["/ABS/PATH/EvoWork.app/Contents/Resources/plugins/connectors/computer-use/server.mjs"]
env = { ELECTRON_RUN_AS_NODE = "1" }
env_vars = ["EVOWORK_CUA_SOCKET", "EVOWORK_CUA_SESSION_TOKEN"]
startup_timeout_sec = 15
tool_timeout_sec = 30
default_tools_approval_mode = "writes"
enabled = true
```

EvoWork 自有策略另存：

```toml
enabled = false
default_app_access = "deny"
allow_persistent_approval = true
allow_locked_computer_use = false
max_write_actions_per_turn = 100

[macos.bundle_ids]
"com.apple.Passwords" = "deny"
"com.apple.keychainaccess" = "deny"
"com.apple.Terminal" = "deny"
"com.googlecode.iterm2" = "deny"
"dev.warp.Warp-Stable" = "deny"
"com.apple.systempreferences" = "deny"
"com.evowork.desktop" = "deny"
```

企业 requirements 与本机策略合并后只会更严格，不能把 deny 合并成 allow。

---

## 10. 产品与 UI

### 10.1 入口

- 插件页：官方“电脑操控”组合插件，显示“未启用 / 缺权限 / 就绪 / 企业禁用 / 组件异常”。
- 设置 → 安全与权限：总开关、系统权限状态、已允许应用、撤销授权、诊断。
- Composer：不新增常驻复杂控件；用户明确提出桌面操作时由模型加载技能。
- 任务页：电脑操控期间顶部常驻高可见状态条，显示当前 App、动作计数、“停止控制”。
- 时间线：复用 MCP Tool Call Item，但翻译为用户语义，如“读取 Numbers 窗口”“点击‘保存’”；
  默认折叠技术参数且不显示输入正文。读取项显示“内容已保存到此任务”，用户可主动查看留存内容。

### 10.2 首次启用流程

```text
用户要求操作桌面应用
  → 解释会读取什么、发给哪个模型
  → 用户启用本任务电脑操控
  → 校验随包 Helper（缺失、损坏或版本不匹配时进入修复流程）
  → 用户手动授予 Accessibility
  → 用户手动授予 Screen Recording（可跳过，进入 AX-only）
  → 选择目标 App 的授权范围
  → 开始操作
```

### 10.3 可见控制与防误解

- Helper 活动时显示菜单栏图标；动作期间显示不抢焦点的边缘指示。
- 状态条不得只用颜色表达，必须有文字“EvoWork 正在使用 <App>”。
- Esc 和“停止控制”始终可用，不能被 agent 隐藏或点击。
- 用户真实输入优先，检测到鼠标/键盘介入立即暂停。
- 不显示“已连接”来代替“已授权”；系统权限、Helper 连接、App 授权是三个独立状态。

---

## 11. 打包、签名与升级

### 11.1 macOS

- Helper bundle id 建议 `com.evowork.desktop.computer-use`，上线后不得随意变化。
- Helper、主 App、MCP server 启动器必须同一 Team ID 签名，并作为一组公证。
- CU-Q2=A：Helper 与 `cua_repl` MCP server 进入 macOS 基础包；`enabled=false`，安装完成不自动申请
  Accessibility 或 Screen Recording，也不自动启动控制会话。
- Accessibility 与 Screen Recording 的权限延续依赖稳定的签名要求；未签名开发包只用于开发验证，
  不能代表正式升级行为。
- Helper 最低系统版本建议 14.4，与参考实现一致；如产品仍支持更低 macOS，Computer Use 单独标不可用。
- 更新必须原子替换主 App 和 Helper。协议握手包含 `protocolVersion` 与 `buildVersion`，不兼容时拒绝工作。

### 11.2 体积与许可

- 不把 OpenAI 的 Helper、`@oai/sky` 或品牌资产加入 `extraResources`。
- 自建 Swift Helper 只链接系统 framework，尽量不引入大型运行时。
- 新依赖进入 `THIRD_PARTY_NOTICES`，并由现有许可检查守卫。
- 体积预算脚本新增 Helper 档位；预期增量应控制在 20 MB 内，超过需单独说明。

---

## 12. 测试与验收

### 12.1 自动测试

| 层 | 必测内容 |
| --- | --- |
| 协议 | 11 个工具 schema、未知字段、边界值、错误码、版本握手 |
| 状态机 | 首次必须 get、动作后失效、30 秒过期、跨 App state 不可复用 |
| 策略 | 默认 deny、企业 deny 优先、硬禁止不可绕过、自动化拒绝 |
| 硬禁止 App | Terminal/iTerm/Warp 与 System Settings 在激活、AX、截图前拒绝；持久授权和完全访问不可覆盖 |
| 审批 | accept/decline/cancel、仅本任务/始终、窗口关闭时保守拒绝 |
| 隐私 | 日志与结构化审计中搜不到 AX 文本、截图 base64、输入/粘贴正文、窗口标题；任务历史能按 item 找到留存内容 |
| 删除 | 归档后内容仍在；真实删除任务/历史清理后 rollout、截图/blob 与索引均不存在，投影表删行不能冒充删除 |
| 宿主 | token 不落盘、错误 token 断开、主进程退出清理、版本不匹配拒绝 |
| Helper | AX 序列化、secure field 脱敏、坐标裁剪、剪贴板恢复、物理输入中断 |
| UI | 权限六态、停止按钮、审批卡、全键盘操作、屏幕阅读器文案 |
| 打包 | Helper 存在、签名链一致、无 OpenAI 品牌/路径、三方许可完整 |

### 12.2 真机矩阵

至少覆盖：

- macOS 14 / 15 / 26，各一台干净用户账号；
- 单屏、双屏、Retina 缩放；
- TextEdit、Finder、Safari、Numbers，以及一个 AX 信息不完整的 Canvas/WebView App；
- 首次授权、拒绝后重试、系统设置撤权、App 升级、Helper 崩溃恢复；
- 屏幕锁定、快速用户切换、窗口最小化、多窗口同名；
- 用户中途移动鼠标/输入键盘、按 Esc、点击停止；
- 支持图片与不支持图片的模型各一次；
- 请求批准、帮我批准、完全访问三档各一次。

### 12.3 MVP 验收任务

1. “打开 TextEdit，新建文档，输入三行文字并保存到用户选择的目录。”
2. “在 Finder 中找到用户指定文件并重命名。”—— 重命名前按既有文件管理规则审批。
3. “读取 Numbers 当前表格可见区域，将某个单元格改为指定值。”
4. “在 Safari 打开用户指定站点并填写非敏感测试表单，但提交前等待确认。”
5. “操控过程中用户移动鼠标，EvoWork 在一次动作内停止且不再继续。”
6. “打开终端执行命令”与“打开系统设置修改配置”均在读取界面前返回 `POLICY_DENIED`，并分别引导使用
   受控 shell 工具或由用户手动操作。

验收成功不仅看最终结果，还要求：每步都能关联最新 `state_id`、无硬禁止绕过、审计无正文泄露、
停止延迟 P95 < 500 ms、动作成功率在上述固定任务上 ≥ 90%。

---

## 13. 分阶段实施与工作量

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| CU-M0 技术尖刺 | AX/ScreenCaptureKit/CGEvent 原型；实测 MCP image/AX 的存储、备份/导出与真实删除路径；签名/TCC 验证 | 1–1.5 人周 |
| CU-M1 只读链路 | Helper、socket、认证、`list_apps/get_app_state`、设置权限页 | 1.5–2 人周 |
| CU-M2 动作链路 | 9 个动作、状态失效、剪贴板恢复、用户中断、限速 | 2–2.5 人周 |
| CU-M3 内核接线 | `cua_repl` MCP、技能、elicitation、Guardian、Item/审计 | 1.5–2 人周 |
| CU-M4 产品收口 | 应用授权管理、状态条、打包签名、公证、真机矩阵 | 1.5–2 人周 |

macOS MVP 合计约 **7.5–10 人周**，其中原生权限、签名与安全验收不可用普通前端工作量替代。
Windows 预计另需 4–6 人周，Linux 预计另需 3–5 人周。两者均为 **CU-Q1 明确排除在首版之外的未实现能力**，
必须先完成各自的平台技术尖刺，再单独确认范围与排期；不能因为平台无关协议已预留就宣称支持。

推荐发布门槛：CU-M0 的截图/AX 留存与真实删除验证、正式签名下 TCC 行为和用户中断可靠性三项未通过前，不进入
公开 beta。

---

## 14. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 提示注入诱导 UI 操作 | 数据外发或错误提交 | 第三方内容不算授权；Guardian + 硬策略 + 动作时确认 |
| AX 元素陈旧/错位 | 点错按钮 | `state_id`、动作后失效、窗口相对坐标、失败不猜测 |
| 截图包含任务外隐私 | 隐私泄露 | 窗口级裁剪、目标 App 授权、明确传输提示、禁止后台/全屏抓取 |
| Helper 权限过大 | 本机安全风险 | 独立签名进程、无网络、认证 socket、硬禁止列表、最小工具面 |
| 国内模型不支持图片 | 视觉 App 无法操作 | AX-only 显式降级；不足时要求切模型，不静默走其他云服务 |
| 截图/AX 随 rollout 长期留存 | 用户误解、敏感内容残留 | CU-Q5=A 明确告知；内容与任务同生命周期；真实删除做磁盘验收；结构化审计不复制正文 |
| TCC 权限在升级后丢失 | 功能突然不可用 | 稳定 bundle id/Team ID/designated requirement；正式签名升级测试 |
| `cua_repl` 特殊语义上游漂移 | 审批范围退化 | 漂移雷达增加 `is_node_repl_backed_server` 与 Guardian 映射断言 |
| 用户无法及时制止 | 连续误操作 | Esc、可见停止按钮、物理输入中断、单会话、动作预算 |
| 专有参考实现许可风险 | 无法发布 | 只做行为级兼容；不复制/链接/分发专有组件；法务复核 |

---

## 15. 已确认问题与决策

CU-Q1–CU-Q6 已于 2026-09-24 全部确认。下表保留原选项、最终决策及理由，作为实施与验收依据；
后续改变任一边界都需要重新评审并同步回写关联文档。

| 编号 | 问题 | 选项 | 建议 / 已确认决策 |
| --- | --- | --- | --- |
| **CU-Q1** | 首发平台范围？ | A macOS 14.4+；B macOS+Windows；C 三平台 | **已确认 A（2026-09-24）。** 首版仅支持 macOS 14.4+。Windows/Linux 明确记为后续未实现能力，分别完成 UIA/签名与 Wayland/X11/权限技术尖刺后再立项。 |
| **CU-Q2** | 电脑操控是默认内置还是可选安装？ | A 随基础包但默认关闭；B 首次使用下载；C 管理员单独部署 | **已确认 A（2026-09-24）。** Helper 与 MCP server 随 macOS 基础包分发，但功能开关默认关闭；安装时不申请 TCC 权限，首次明确使用时才引导授权。企业仍可通过 requirements 禁用。 |
| **CU-Q3** | 是否允许“始终允许某 App”？ | A 允许；B 只允许本任务；C 企业版禁用 | **已确认 A（2026-09-24）。** 支持本机持久 App allow，直到用户撤销；它只跳过该 App 的准入询问，不跳过动作审批、硬禁止或企业对具体 App 的 deny。未采纳 C 的“企业版一律禁用”。 |
| **CU-Q4** | 是否首版支持浏览器 App？ | A 支持但 browser connector 优先；B 完全禁止浏览器 | **已确认 A（2026-09-24）。** 普通网页优先 browser connector；只有浏览器 chrome、扩展页、原生文件选择器/权限弹窗或 CDP 不可用时才回退 Computer Use。回退继承 URL、上传、下载、提交和数据外发策略，不得绕过拒绝。 |
| **CU-Q5** | 截图和 AX 正文在任务历史中的留存策略？ | A 与任务一同留存并明确告知；B 回合后清除；C AX 留存、截图清除 | **已确认 A（2026-09-24）。** AX 正文和截图随本机任务历史留存，首次启用前明确告知；归档不删除，真实删除任务/清理历史时必须清除 rollout、blob 与索引。结构化审计仍不保存正文。 |
| **CU-Q6** | 是否允许操控终端和系统设置？ | A 全部硬禁止；B 逐次高危确认；C 完全访问可用 | **已确认 A（2026-09-24）。** 所有终端/命令行前端及 System Settings 整个 App 在激活、AX、截图前硬拒绝；持久授权、审批和完全访问均不可覆盖。命令走既有 shell，系统设置交还用户。 |

### 15.1 需要法务/商务确认但不属于产品选择

在发布前确认“参考 Codex 行为与接口、自主实现底层”的 clean-room 边界。本文默认：不使用
`@oai/sky` 源码或二进制作为构建依赖，不复制其文案/图标/品牌资源，不连接其更新服务；只依据
可观察行为和开源 Codex 的协议接点实现 EvoWork 自有组件。

### 15.2 确认记录

| 日期 | 决策 | 影响与文档回写 |
| --- | --- | --- |
| 2026-09-24 | **CU-Q1=A：电脑操控首版仅支持 macOS 14.4+** | 本文 §0、§1.3、§11–§13 已按 macOS 首发收口；Windows/Linux 作为未实现的后续平台能力登记到 `docs/status.md`、`docs/work-priority.md` 与 `docs/build-and-deploy.md`。 |
| 2026-09-24 | **CU-Q2=A：随基础包分发但默认关闭** | 本文 §0、§7.1、§10.2、§11 已按“随包、不开启、不预授权、不临时下载”收口；打包验收和当前未实现状态同步登记到构建、状态与优先级文档。 |
| 2026-09-24 | **CU-Q3=A：允许“始终允许某 App”** | 本文 CU-D5、§7.2、§7.5、§8.1 已收口持久授权边界：只持久化应用准入、本机保存、可撤销、不由子 agent 继承，且不覆盖动作审批与硬禁止。未采纳 C。 |
| 2026-09-24 | **CU-Q4=A：支持浏览器 App，browser connector 优先** | 新增 CU-D8，并同步 05 §4.4：普通网页走 CDP，Computer Use 只补不可覆盖界面；策略拒绝跨通道继承，不能借回退绕过。当前路由与回退尚未实现。 |
| 2026-09-24 | **CU-Q5=A：AX 正文和截图随任务留存并明确告知** | 新增 CU-D9，回写 §6.1、§8、§10、§12–§14，并同步 04 §3.3/§5.2 与 10 §6。CU-M0 改为验证存储和真实删除，不再重新选择留存方案。 |
| 2026-09-24 | **CU-Q6=A：终端和系统设置全部硬禁止** | 回写 §1.3、§7.2、§9.1、§12：策略在读取界面前拒绝，任何授权档不可覆盖；终端任务改走 shell，系统设置交还用户。同步 10 §2.3。 |

---

## 16. 完成定义

以下全部满足才可将“电脑操控”标为已完成：

- CU-Q1–CU-Q6 已全部按 A 书面确认。
- `pnpm run check`、原生 Helper 测试、许可检查、补丁预算和打包预算全绿。
- Codex 内核补丁仍为 0；CU-Q5=A 不以“分离清除截图”为目标。若真实删除或内容索引仍需补丁，必须先按 K1 单独写理由并评审。
- 正式签名的 macOS 安装包完成 TCC 首次授权、升级保留和撤权恢复测试。
- 六个 MVP 验收任务通过，并有用户中断、硬禁止、审批三档与审计无正文泄露证据。
- 设置页如实展示能力状态；未安装、未授权、模型不支持、企业禁用都不伪装成“已就绪”。
- 首次留存提示、任务历史查看与真实删除通过磁盘级验收；不能用投影表删行冒充删除。
- `docs/status.md`、`docs/architecture.md`、构建部署文档和第三方许可清单在实现完成时同步回写。
