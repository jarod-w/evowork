# 真窗口 E2E 的 harness

**这一层只负责「把 App 启动起来」，一句断言都不写。**

## 为什么要拆

拆之前，`skill-reference.e2e.mjs` 与 `agent-loop.e2e.mjs` 各自抄了一份启动代码：约 40 行的
bootstrap 注入缝（四个 Electron 接缝 + 四条路径 + 宿主环境）、临时 home、`waitFor`、
阶段标记。抄漏一处的表现不是报错，是**「窗口起来了但少一条链路」**——而断言写在别的文件里，
不会指向启动代码。

更要紧的是第二个理由：**启动与驱动的变化原因不同**。驱动（点什么、断言什么）随产品走，
启动（进程怎么起、缝往哪注）随内核与 Electron 走。混在一个文件里，换驱动方式就要重写启动。

## 三个模块

| 文件               | 管什么                                                                |
| ------------------ | --------------------------------------------------------------------- |
| `runner.mjs`       | 阶段 / 结果标记的输出契约 · `waitFor` · 给进程外驱动的控制面          |
| `boot.mjs`         | 一次性 home · 内核 config.toml 落盘 · `bootApp()` 真窗口启动          |
| `fake-gateway.mjs` | 脚本化的假模型网关（`skill-reference` 用；`agent-loop` 用的是真网关） |

## 纪律

- **标记前缀由调用方传**。外层脚本（`scripts/desktop-skills-e2e.mjs` ·
  `scripts/verify-agent-loop.mjs`）靠 stdout 上的结果标记判成败，前缀是两侧之间的契约。
  这里不替它拼一个「看起来对」的名字 —— 拼错了的表现是「跑完了但没有验收结果」。
- **内核配置不做模板拼装**。TOML 里一个键属于哪张表，取决于它写在哪个表头之后；拼装器
  一旦把某行放进错误的段落，配置会**静默生效在另一张表上**，既不报错也不生效。
  `writeKernelConfig()` 只负责写，正文由调用方给全。
- **`spawnFn` 有隐藏后果**。给宿主传它，端口上残留网关的回收会被换成「不扫描」
  （`service-host.ts:1124`）。所以 `bootApp()` 默认不包这一层，要 `killKernel()` 的那条
  测试显式传 `captureKernelProcess: true`。
- **假网关不是真网关的替代品**。假的测**真内核**（心跳帧 F30、可重试错误码 F32/F33 只有
  真 app-server 能证伪），真的测**真翻译层**（`to-chat.ts` / `from-chat.ts`）。两条都要留。

## 第 2 步会动哪里

换 Playwright 从进程外驱动 DOM 时，改的是驱动侧，这三个模块基本原样保留。两处例外：

1. `boot.mjs` 里窗口现在是 `show: false`。真交互（焦点 / hover / 布局）要把它显示出来。
2. `runner.mjs` 的 `publishControls()` 是为那一步留的：`electronApp.evaluate()` 在主进程里
   求值，够得着 `globalThis`，够不着这些模块的闭包。「杀内核」「让网关这一次挂住」这类
   只有主进程做得到的动作，必须从那里露出去，否则第 2 步只能把它们重写一遍。

## 上层

- 驱动与断言：`apps/desktop/test/e2e/*.e2e.mjs`
- 外层运行器：`scripts/desktop-skills-e2e.mjs` · `scripts/verify-agent-loop.mjs`
- 现状与欠账：`docs/status.md`（搜「真窗口 E2E」）
