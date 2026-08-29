# M1 桌面外壳 · 交付状态与「未验」清单

> 对应 M1「桌面外壳」阶段 Task 0–4 的交付物：`apps/ui`（Vite + React + TS 前端、`platform`
> 接口、`daemonClient`）与 `apps/ui/src-tauri`（Tauri 2 外壳源码）。九段 CI（`scripts/ci.sh`）
> 全绿，`review clean`，细节见 `.superpowers/sdd/progress.md`。
>
> **这份文档的核心不是「做了什么」，是「哪些还没验」。** 下面每一条「未验」都是本人在 Linux
> 开发机上**结构性做不到**的验证，不是偷懒省略的——原因逐条写清。这份文档将来是别人判断
> 「哪些能信」的依据，含糊一次的代价要到真机那天才结算，所以本文档严格区分「写好了 /
> code review 过了」与「验证过了」，绝不用前者的措辞去描述后者的状态。

## 一、已经做到什么程度

- 前端骨架（Vite + React + TS）、`platform` 接口（浏览器/Tauri 两个实现，5 个方法）、
  `daemonClient`（23 个测试）——这几层**能在这台 Linux 机器上完整地写、跑单测、跑
  `pnpm build`**，产物已实测能在浏览器里打开（手机点企业微信审批链接走的正是这条路径）。
- `apps/ui/src-tauri` 的 Rust 源码（`Cargo.toml`、`main.rs`、`tauri.conf.json5`、
  `capabilities/default.json` 等，约 200 行）已写全，经过三轮 code review 修复后 review clean。
- CI 九段（`./scripts/ci.sh`）全绿，含 CI-9（外壳不渗进业务代码）与扩容后的 CI-4，且两条都
  造过反例确认真的会 FAIL（细节见 `.superpowers/sdd/progress.md` Task 4）。

以上这些是「写完了、经过人工与工具能做到的检验」，**不等于「在真机上验证过」**——下面逐条说明
差距在哪。

## 二、未验清单（核心，逐条不含糊）

### 1. 签名与公证：未执行

需要 macOS 机器 + Apple Developer Program 组织账号。后者是 M0 项，**尚未到位**——
`docs/design/00-index.md` 第五节明确写了「Apple Developer Program 账号」是全项目 lead time
最长的一项（D-U-N-S 编号、2 周起），不列进「待客户确认」表是因为它不需要任何人回答问题，
只需要启动申请。截至本文档写作时，这个账号还没有申请下来。

`apps/ui/src-tauri/tauri.conf.json5` 里 `signingIdentity` / `providerShortName` 当前都是
`null`，对应的注释已经把「拿到账号后填什么、去哪查」写成了 fill-in-the-blanks（证书类型、
`providerShortName` 怎么查、两种 notarization 凭据组合怎么选），但**这些空白本身从未被真实凭据
填过一次，也就没有实际跑过签名或提交公证这两个动作**。

### 2. `.app`：未产出、未在 macOS 上运行过

`bundle.targets` 配的是 `["app", "dmg"]`，但这台开发机是 Linux，`tauri build` 从未在任何机器
上执行过一次，**没有任何 `.app` 或 `.dmg` 文件被产出过**，更谈不上双击打开、看到窗口、跑通
一次真实的 Tauri IPC 往返。`icons/` 目录下是本机用纯 Python 手写的纯色 PNG 占位图，`icon.icns`
（macOS 打包必需）**尚未生成**——这一步连生成占位素材都做不到（本机无 ImageMagick/PIL），
需要 `pnpm dlx @tauri-apps/cli icon` 在装了真实品牌素材的机器上重新生成整套。

### 3. `src-tauri` 的 Rust 源码：未经编译验证

`docs/superpowers/notes/2026-08-29-tauri-linux-probe.md`（Task 0 实测）的结论：在这台 Linux
机器上 `cargo check` 编译到 `glib-sys v0.18.1` 的 build script 时失败——

```
error: failed to run custom build command for `glib-sys v0.18.1`
The pkg-config command could not be found.
```

这不是版本或配置问题，是 Tauri 2 Linux 后端 GTK/WebKitGTK 依赖链的**结构性**要求：
`tauri` → `tauri-runtime-wry` → `wry`/`tao` → `gtk-sys`/`webkit2gtk-sys` 等 `*-sys` crate
的 build script 都要靠 `pkg-config` 找系统库，这台机器上连 `pkg-config` 这个可执行文件本身
都没有。换 Tauri 版本、改 `Cargo.toml` 都绕不开，唯一的绕法是装一整套系统库。

**为什么不在 Linux 上装 GTK 硬凑一次通过：** 那样做只会验证 WebKitGTK 这条链路的可编译性，
而交付目标是 macOS，用的是 WKWebView，是完全不同的一组 `*-sys` crate（`objc`/`cocoa`/
`wry` 的 macOS feature 分支等）。Linux 上装库编译通过，不能推出 macOS 上也会通过——两条
依赖链除了共享 `tauri` 这个上层 crate 名字之外，实际链接的原生库、build script 的分支路径
完全不同。真装了系统库让它「绿一次」，得到的是一个**假的已验证信号**：团队会误以为
`src-tauri` 已经过编译检验，而真正要交付的 macOS 路径其实一次都没跑过。明确「未验」比
一次「装库强行绿」更安全。

因此当前状态准确地说是：**源码写全、经人工 review（三轮，含 capabilities 权限的逐条源码
核对），但从未在任何机器上跑通过一次 `cargo check`/`cargo build`/`tauri build`。** 语法
错误、Tauri API 用法错误、`Cargo.toml` 依赖版本冲突这类问题，**编译器一次都没检查过**。

### 4. Tauri capability 的 9 条权限标识符：手工核对，非编译器验证

`apps/ui/src-tauri/capabilities/default.json` 里的 9 条权限（`dialog:allow-open`、
`fs:allow-read-file`、`opener:allow-open-url`、`notification:allow-is-permission-granted`、
`notification:allow-request-permission`、`notification:allow-notify`、
`autostart:allow-enable`、`autostart:allow-disable`、`process:allow-exit`）是 Task 3 review
时**手工对着 `tauri-plugin-*` crate 源码里的 `permissions/*.toml` 逐条核对出来的**（`README.md`
「Not verified on a real machine」一节原话），不是凭记忆或文档猜的，也不是编译器验证过的。

这一条重要到值得单独强调：**这份 `capabilities/default.json` 曾经整个目录都不存在**——
Tauri 2 的 IPC 是白名单模型，`capabilities/` 缺失时 Tauri 静默解析出一个空权限集，不报编译错误、
不报配置错误，只在真机上第一次调用时以 `command not allowed` 拒绝，且这个坑**编译期完全不可见，
原本也不在这份「未验」清单的草稿里**——是 Task 3 review 时从 Tauri 源码里查证才补上的。这个
先例说明：capability 相关的错误只会在能跑 `cargo build`/真机 IPC 往返的机器上暴露，权限标识符
本身如果拼写错误（比如把 `allow-open` 误写成 `allow_open` 或权限名对不上 plugin 实际注册的
命令名），在这台 Linux 机器上**没有任何手段能发现**——不会编译失败、不会测试失败，因为
根本跑不到解析这份 JSON 的那一步。

### 5. capability 一致性检查（`tauri.capabilities.test.ts`）证明的范围有限

`apps/ui/src/platform/tauri.capabilities.test.ts` 用 TS 编译器 API 遍历 AST，确保
`platform/tauri.ts` 里调用的每个 plugin 命令都能在 `capabilities/default.json` 里找到对应
权限，反之亦然（孤儿权限也会报错）。这条测试**只保证两份文件互相不漂移**——它证明的是
「代码用到的」与「JSON 里授予的」这两份东西相互一致，**完全不能证明这 9 个权限字符串对
Tauri 2 的运行时是合法的**。如果 Tauri 2.11.5 实际的权限命名规则与本人核对时看到的
`permissions/*.toml` 不一致（版本漂移、笔误、看错文件），这条测试会继续全绿，因为它两边
比较的都是同一份人工抄录的字符串，不涉及 Tauri 运行时本身。

## 三、拿到 Mac + Apple 账号那天，按顺序要做的事

> 排序原则：**先验证「已知但从未测过的最大未知数」，再做「已经反复检查过、大概率没问题」的事**。
> 签名公证本身流程成熟、Tauri 官方文档步骤清楚，反而不是当天最该担心的部分。

| 顺序 | 做什么 | 为什么排在这一步 |
|:-:|---|---|
| 1 | `pnpm tauri dev`（先接上 `@tauri-apps/cli`，`package.json` 目前没有这个 CLI 依赖，`tauri.conf.json5` 注释里已写明这是已知缺口）跑起来一个未签名窗口，**手动逐一验证 5 个 `Platform` 方法**：`pickFile`（弹出原生对话框、选一个文件、确认字节能读出来）、`openExternal`（打开一个 URL）、`notify`（弹出系统通知，含首次授权弹窗）、`setAutoLaunch(true/false)`（登录项里真的出现/消失）、`quit`（进程真的退出） | **这是编译期完全测不出、且第一次做「未验清单」草稿时差点漏掉的一条**：capability 的 9 条权限字符串是否对当前 Tauri 版本的运行时合法，只有真机上五个方法真的被调用一次才能证伪。9 条里任何一条拼错、任何一条与 plugin 实际注册的命令名不符，都只会在这一步暴露为 `command not allowed`，而不是编译错误。这一步比「能不能编译」更优先，因为它是这份未验清单里信息量最大、也最容易被误判为「已经 review 过所以没问题」的一项 |
| 2 | `cargo check` / `cargo build`（在 `apps/ui/src-tauri` 目录，不接入根 workspace）—— 先在 macOS 上确认这 200 行 Rust 源码本身没有语法错误、API 用法错误、`Cargo.toml` 版本冲突 | 与第 1 步顺序可以对调（互不阻塞），但既然第 1 步已经要求先跑起来一个窗口，`cargo build` 是第 1 步的前置动作，天然先发生 |
| 3 | `pnpm dlx @tauri-apps/cli icon path/to/真实logo.png` 用真实品牌素材重新生成整套图标（含 macOS 必需的 `icon.icns`），替换掉当前的占位纯色 PNG | 占位图标不影响功能验证，但签名/公证/打包这几步需要真实的 `.icns` 才有意义，且这是低风险、可以先做掉的一项 |
| 4 | 填 `tauri.conf.json5` 里 `signingIdentity`（证书名或 SHA-1 指纹）、按需填 `providerShortName`；notarization 凭据（`APPLE_ID`+`APPLE_PASSWORD`+`APPLE_TEAM_ID`，或 App Store Connect API Key 三件套）设为环境变量，**不写进这个文件** | 配置文件里的注释已经把「填什么、去哪查」写成了 fill-in-the-blanks，这一步是执行注释里已经写清楚的操作 |
| 5 | `identifier` 从占位的 `com.evowork.desktop` 改成组织真实域名反向拼出的标识——**这一步必须在第一次签名之前做**，`tauri.conf.json5` 注释里已经写明改晚了不是简单的 find-and-replace（会影响 Tauri updater/autostart 插件在 keychain 里的 key） | 排在签名前是因为标识符是签名身份的一部分，签完再改等于重新签 |
| 6 | `tauri build`，产出真实签名并公证的 `.app`/`.dmg`，双击打开确认 Gatekeeper 无警告 | 前 5 步都通过之后的收尾动作 |

**备选：CI 上挂一台 macOS runner。** 这是「本机（Linux）验证」与「拿到实机」之间一个现实的
中间步骤——GitHub Actions/自建 CI 若接入 macOS runner，可以让 `cargo check`/`cargo build`/
未签名的 `tauri build` 在这一天之前就先跑起来一次，把上表第 1、2 步能提前暴露的问题提前暴露，
只是签名/公证（需要真实 Apple 账号凭据）与「在真实财务 Mac mini 上装机验证」这两件事依然要
等到实机那天。是否现在就挂，取决于排期——把这个选项记在这里供权衡，不代表建议现在做。

## 四、小结

| 层 | 状态 |
|---|---|
| 前端（`apps/ui/src`，含 `platform`/`daemon`） | 写完、测试覆盖、`pnpm build` 通过，**验证充分** |
| `apps/ui/src-tauri` 源码 | 写完、三轮 review clean，**编译期未验证**（结构性，见上） |
| Tauri capability 权限清单 | 写完、手工核对 plugin 源码、有一致性测试兜底，**运行时合法性未验证** |
| 签名与公证 | 配置占位已写好注释，**从未执行** |
| `.app` / `.dmg` | **从未产出** |

以上五行里，只有第一行是「验证过」，其余四行都是「写好了 / review 过了」，不能读成「验证过」。

## 五、给后续阶段（写 daemon 二进制时）的两条约束

`evo-daemon`（`crates/evo-daemon`）目前是纯 lib crate、**还没有二进制**，所以下面两条现在
无代码可改，只能先记下来供阶段 3 写 `main.rs` 时兑现。两条都**已经**写进了设计文档，本文档
只做汇总与交叉引用，不重复定义：

1. **daemon 不该知道自己是被 launchd 还是被 SCM 拉起来的**——不读 launchd 特有的环境变量、
   不把 plist 路径写进业务代码。已记于 `docs/design/05-execution-plane.md` 第 65 行：
   「这条现在是零成本，后补则要翻一遍启动路径」，并同时给出了 Windows 对应物
   （Windows Service + 服务账户）作为将来要满足的第二种拉起方式。
2. **token 落 `/Library/Application Support/evowork/client.toml`，权限 `644`**——daemon
   装成 LaunchDaemon 跑在专用服务账户下，桌面客户端跑在财务的登录账户下，token 只写服务
   账户家目录的话财务读不到，装完就是打不开。已记于 `docs/design/06-protocol.md` 第 76 行
   （Q-22 的落地形态）与 `docs/design/00-index.md` 第五节「团队决策」表 Q-22 一行。

两条都放在 `docs/design/05-execution-plane.md` / `06-protocol.md` 而不是本文档或计划文件里，
理由是：这两条是**协议/部署层面的契约**（谁能读 token、daemon 以什么身份跑），跟本文档记录的
「桌面外壳这一次交付验没验」是两类信息——契约放进设计文档，交付状态放进这份 status note，
避免同一条约束将来要在两个地方分别改。
