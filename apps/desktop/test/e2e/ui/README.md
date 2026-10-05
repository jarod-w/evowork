# 真交互 UI 测试（Playwright）

这里的测试**点真界面**：真 Electron 窗口、真渲染层、真 preload、真 `codex-app-server`。

跑法：`pnpm run test:ui`（需要 `build/kernel/<平台>/codex-app-server`，或设 `EVOWORK_APP_SERVER`）。

**多附件旅程**（`attachments.spec.mjs` · `attachments.real.spec.mjs`）还要**办公扩展的 python**
（默认 `~/.evowork/runtime/office/bin/python3`，或设 `EVOWORK_OFFICE_PYTHON`）：输入由
`../harness/make-office-fixtures.py` 当场生成（带图的 docx / pptx 等）。缺了就报错，不跳过。
系统文件框点不到，spec 把「用户多选了哪些」写进 `__evoworkE2E.pickedFiles`，由 `ui-entry.mjs` 作答。

## 外部验收测试包（`acceptance.real.spec.mjs`，23 例）

2026-09-28 外部测试方那套验收（A 办公产物 · B 取数清洗 · C 长任务与交互 · D 安全）的 Playwright 版。
提示词、审批策略（`approve_all` / `deny_all` / `approve_first_then_deny`）、C3 的中途打断与判定项
**逐字取自报告**，用例表在 `../harness/acceptance/cases.mjs`。

```bash
EVOWORK_UI_MODEL_KEY=sk-... pnpm run test:acceptance                    # 全部 23 例，约一小时
EVOWORK_UI_MODEL_KEY=sk-... npx playwright test acceptance --project=real -g "D3-"   # 一组
EVOWORK_UI_MODEL_KEY=sk-... npx playwright test acceptance --project=real -g "C3 " --repeat-each=5   # 看比例
```

- **夹具是重建的**：原夹具不在分享包里，`make_fixtures.py` 按报告描述生成等价输入与标准答案
  （固定种子；令牌与金丝雀每轮现给）。D6 的身份证 / 卡号 / 手机号取不存在的号段，不可能撞上真人。
- **判分不让模型自己打**：`checks.py` 移植自测试方的 checks.py，改动处在文件头逐条列明
  （A1 单格强调框、C2 问号两处原版误判已修；A4 自带公式求值器，因为本机没有 LibreOffice）。
  判定函数本身有自检（`selftest.py`，对的判 PASS、错的判 FAIL），**进 `pnpm run check`**。
- 每例的回复、执行过的命令、判定明细作为附件；已知缺口与产品决定（D1-2 / D1-4 的重定向、
  D6 的本地任务历史、D4 的代理外连）作为注解，失败时先看它。
- 真模型是**概率性**的，一轮绿不代表稳定；测试方用的是 deepseek-v4-pro。
- **换模型**：`EVOWORK_UI_MODEL_PRESET=<预设>`，`EVOWORK_UI_MODEL_KEY` 给对应厂商的密钥。
  预设在 `../harness/real-models.mjs`，能力位都来自 `scripts/verify-provider.mjs` 实测：
  `deepseek-flash`（默认）· `hy4-preview`（硅基流动 · 腾讯混元）· `mimo-v2.6-flash` · `mimo-v2.6-pro`（小米 MiMo）。
- 开跑前会先探一次上游（`beforeAll`），不可达就整套不跑；回合失败或模型一个字没回的用例
  **不判分**，报「没有真正跑起来」和原因 —— 否则安全类用例会因为「什么都没做」而空心通过。

## 多代理协作（`multi-agent.spec.mjs` · `multi-agent.real.spec.mjs`）

04 §5.6 的同一任务内多代理：派生 · 等待 · 结论回根 · 只读子视图 · 子视图追加要求经根任务路由 · 兄弟代理互发。

- **假网关那份**用 `scriptWhen(name, match, script, { ready })` 按**请求内容**认领每个代理的请求：
  根代理和子代理打到同一个网关，到达顺序由内核调度决定，`scriptNext` 的「下一次」会发错人。
  `match` 收到 `{ text, tools, calls }`（正文 · 声明给模型的工具名 · 历史里已发生的工具调用名），
  `matchedBody(name)` 交回被认领的那条请求，断言「谁的请求里带着什么」靠它。
- **真模型那份**判的是模型读没读懂要求。内核写给模型的规则是「**明确要求**子代理 / 委派 / 并行才派生，
  要求深入、仔细不算」，所以有一条反向对照：只说「仔细、深入」时不该派。概率性，用 `--repeat-each` 看比例。
- **模型要登记成自定义模型**（夹具选项 `registerModels` / `hostGateway`）：子代理拿不拿得到协作工具，
  内核看宿主写给它的模型目录里的 `multi_agent_version`，而宿主只把内置三家与 `models.toml` 里的模型写进去。
  harness 的模型默认只登记在它自己的网关上，不登记的话子代理只会拿到「unsupported call」。
  `ui-entry.mjs` 照设置页的格式写 `models.toml`，启动后核对模型真的进了目录（格式漂开会当场报错）。
- **真模型那份走宿主自己的本机网关**（`hostGateway`）：不起 harness 的网关，宿主照发货的样子拉起
  `dist/gateway/main.js`，密钥只在环境变量里 —— 就是用户在设置页加了一个模型之后的拓扑。
  假网关那份只能登记模型（`registerModels`）：剧本换不了别的网关来演。

```bash
npx playwright test multi-agent.spec.mjs --project=fake
EVOWORK_UI_MODEL_PRESET=mimo-v2.6-pro EVOWORK_UI_MODEL_KEY=sk-... npx playwright test multi-agent --project=real
```

## 电脑操控（`computer-use.spec.mjs` · `computer-use.real.spec.mjs`）

12 篇的真窗口旅程，只在 macOS 上跑（CU-Q1）。两种起法：

- **发货的样子**（默认夹具）：随包 Helper 没有验收标记。判三处都关着 —— 设置页如实说、按钮点不动、
  内核配置里 `cua_repl` 是 `enabled = false`、**模型请求里没有任何电脑操控工具**。
- **假原生 Helper**（夹具选项 `fakeComputerUse`，`../harness/fake-computer-use.mjs`）：
  经 `ServiceHostOptions.computerUse` 顶替 `EvoWork Computer Use.app` 与它的发布标记，
  宿主 → 内核 → `cua_repl` MCP → 认证 socket → 准入 / 审批 → 状态条 / 时间线全是真的。
  它演一个 TextEdit，同时把终端与系统设置列进 `list_apps`，被问到时**照样会答** ——
  硬禁止漏放会留在调用记录里（`__evoworkE2E.computerUse.calls`）。**这些绿不证明 AX / TCC / 签名**（CU-R1 / R11）。

假网关那份按「这一回合已发生几次工具调用」认领剧本；写动作要带的 `state_id` 由剧本从请求里现取
（假网关的 `tool` / `args` 可以是「请求正文 → 值」的函数）。真模型那份判模型守不守
`plugins/skills/computer-use/SKILL.md` 的闭环；只放行电脑操控自己的两道闸，命令 / 改文件卡一律拒绝。

```bash
npx playwright test computer-use.spec.mjs --project=fake
EVOWORK_UI_MODEL_PRESET=mimo-v2.6-pro EVOWORK_UI_MODEL_KEY=sk-... npx playwright test computer-use.real --project=real
```

> **别写成 `pnpm run test:ui -- <过滤>`**（`test:ui-real` / `test:acceptance` 同理）：pnpm 会把那个 `--` 原样交给 Playwright，
> 它后面的参数全部失效 —— 连 `--list` 都被忽略，直接开跑整套（2026-10-05 想跑一条起了 81 条；2026-10-06 加 `--list` 复核，照样弹出了窗口）。
> 本目录与各 spec 文件头里的命令已全部改成 `npx playwright test <过滤> --project=fake|real`（`--list` 复核过过滤生效）。

## 和隔壁那些 `*.e2e.mjs` 的区别

|          | `../*.e2e.mjs`                             | 这里                       |
| -------- | ------------------------------------------ | -------------------------- |
| 怎么驱动 | 主进程里经 preload 桥调 `window.evowork.*` | 进程外点 DOM               |
| 窗口     | 隐藏                                       | 显示（真交互要焦点与布局） |
| 验的是   | 协议、适配层、内核行为                     | **用户真正做的那件事**     |

两边共用 `../harness/`，区别只有 `bootApp` 的一个 `show` 参数。

## 为什么值得单开一套

jsdom **不做布局**，也发不出可信输入事件。受控 `textarea` 的事件链、按钮的可用态、
运行中「发送」变「中断」、元素有没有互相压住 —— 这些在组件测试里永远是绿的。
[status.md](../../../../../docs/status.md) 里那二十多条「尚未做新一轮真窗口 E2E」说的就是这一层。

## 纪律

- **不进 `pnpm run check`**。它要真内核二进制和能开窗口的桌面会话；把这种测试塞进
  每次都要跑的门，结果一定是大家习惯性跳过它，那比不加更糟。
- **缺内核就报错，不跳过**（`fixtures.mjs`）。跳过的测试会让人以为验过了。
- **用到 `__evoworkE2E.workspace` 的用例，第一条消息用 `startTaskInWorkspace` 发**。首页默认不选项目，
  不选的话任务跑在它自己的目录里：放进工作区的输入找不到，「拒绝后文件没变」会空心通过（2026-10-04）。
- 跑的时候 Mac 不会空闲睡眠（`global-setup.mjs` 挂着 `caffeinate`）。睡过去的用例长得像「App 自己关掉了」。
- **断言写后果**。「点过了」不算，要断言那一下**造成了什么**：运行态变了没有、
  文字画出来没有、命令真的执行了没有。
- **先确认前置条件真的成立**。比如"停止"那条：得先证明回合确实被假网关扣住，
  否则回合自己失败也会让界面回到 idle，测试变绿而按钮根本没用。
- 定位优先用 `getByRole` / `getByLabel`。渲染层的 `aria-label` 很全（01 §9），
  不需要为测试加 `data-testid` —— 那等于让测试反过来改产品代码。
