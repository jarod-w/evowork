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
EVOWORK_UI_MODEL_KEY=sk-... pnpm run test:acceptance -- -g "D3-"        # 一组
EVOWORK_UI_MODEL_KEY=sk-... pnpm run test:acceptance -- -g "C3 " --repeat-each=5   # 看比例
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
  `deepseek-flash`（默认）· `hy4-preview`（硅基流动 · 腾讯混元）· `mimo-v2.6-flash`（小米 MiMo）。
- 开跑前会先探一次上游（`beforeAll`），不可达就整套不跑；回合失败或模型一个字没回的用例
  **不判分**，报「没有真正跑起来」和原因 —— 否则安全类用例会因为「什么都没做」而空心通过。

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
