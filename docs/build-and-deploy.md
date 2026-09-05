# 编译与部署手册

> **更新于 2026-09-05**。本文里的每条命令都在本机实际跑过；**跑不通的地方会写明"没验过"**，
> 不写"应该可以"。上游内核与本仓库分开写，因为它们的工具链、构建时长、失败方式完全不同。

两个项目的关系见 [CLAUDE.md](../CLAUDE.md) 第 1 节：`../codex` 是**只读的执行内核**，
本仓库是产品。产品需要内核的一个二进制（`codex-app-server`），两者只通过 JSON-RPC 说话（K2）。

---

## 1. 先决条件

| 组件 | 版本 | 用在哪 | 怎么装 |
| --- | --- | --- | --- |
| Node.js | **≥ 22.12**（实测 22.22） | 整个 evowork | nvm / 系统包 |
| pnpm | **10.30.3**（`packageManager` 已锁） | 整个 evowork | `corepack enable` |
| Rust | **1.95.0**（`codex-rs/rust-toolchain.toml` 已锁） | 只构建内核时需要 | rustup（会按 toolchain 文件自动切） |
| Python | ≥ 3.10（实测 3.12） | 办公扩展的宿主 | 系统自带 |
| `pkg-config` + `libssl-dev` | — | **只构建内核时需要** | `apt install pkg-config libssl-dev` |
| `bubblewrap` | — | 内核在 Linux 上的沙箱（**运行时**需要，不是构建时） | `apt install bubblewrap` |

> 这三个都是实测踩到的：
>
> - 缺 `pkg-config` / `libssl-dev` 时 `cargo build` 在 `openssl-sys` 上失败，而错误出现在
>   几百行输出的中间，`cargo` 最后只说 "build failed"。macOS 上通常由 Homebrew 的 openssl
>   满足；Debian/Ubuntu 要显式装。
> - 缺 `bubblewrap` 时**构建不受影响**，但内核启动会往 stderr 报
>   `Codex could not find bubblewrap on PATH`，然后回落到自带的那个。
>   这条在容器里尤其容易漏 —— 它不阻断启动，所以很容易被当成噪音。

只用产品、不改内核的话，**Rust 与那两个系统包都不需要** —— 直接用发布的内核二进制即可（§2.3）。

---

## 2. 构建内核（`../codex`）

### 2.1 只构建我们需要的那一个

```bash
cd ../codex/codex-rs
cargo build -p codex-app-server              # 开发用
cargo build -p codex-app-server --release    # 分发用
```

产物：`target/{debug,release}/codex-app-server`。**debug 构建出来的二进制约 1.1 GB**
（带完整调试信息，属正常），`target/` 总计约 7.7 GB。

**只构建这一个 crate**，不要 `cargo build --workspace`：内核工作区有 200+ 个 crate，
而 EvoWork 只对话 app-server 这一个进程（K2）。全量构建会多花几十分钟，且构建出的
TUI / CLI 我们一个都不用。

首次构建会拉几百个依赖并编译，**耗时以小时计**：本机（多核容器）实测约 40 分钟，
其间 `target/` 一路涨到 7.7 GB。留足时间与磁盘（**准备 10 GB 以上**），
别在 CI 里给它设 30 分钟超时。增量构建通常在一分钟内。

在没有改内核的场景下，这一整节都可以跳过 —— 见 §2.3。

### 2.1.1 验证它能用

```bash
./target/debug/codex-app-server --help      # 能打出用法就说明构建没问题
```

再验一次真正重要的那条 —— **K2 边界**：给它一行 `initialize` 请求，看它回什么。
注意 **stdin 要保持打开**：管道一关它就退出，你会看到"没有响应"而误以为握手失败。

```bash
node -e '
const {spawn}=require("node:child_process");
const p=spawn("./target/debug/codex-app-server",[],{
  env:{...process.env, CODEX_HOME:"/tmp/probe-home"}, stdio:["pipe","pipe","ignore"]});
p.stdout.on("data",d=>{console.log(String(d)); p.kill(); process.exit(0);});
p.stdin.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",
  params:{clientInfo:{name:"evowork-probe",title:"EvoWork",version:"0.0.0"},
          capabilities:{experimentalApi:true}}})+"\n");
setTimeout(()=>{console.log("超时"); p.kill(); process.exit(1);}, 20000);'
```

实测返回：

```json
{"id":1,"result":{"userAgent":"evowork-probe/0.0.0 (...)","codexHome":"/tmp/probe-home",
                  "platformFamily":"unix","platformOs":"linux"}}
```

`codexHome` 回显的是我们给的 `CODEX_HOME` —— 这正是桌面壳把内核家目录指到
`~/.evowork/kernel/` 的机制（K5：只改对外可见字符串，内部环境变量名不动）。

### 2.2 摸协议行为（改适配层之前建议先跑）

```bash
cd ../codex
just app-server-test-client   # 交互式 JSON-RPC 客户端
just codex                    # TUI，看内核原生行为
```

改 `services/kernel-adapter` 之前用它确认协议的实际形状 —— F17/F18/F19 都是这样发现的
（见 [详细设计集 §4](design/README.md)）。

### 2.3 不自己构建内核

打包时内核二进制随包分发（`build/kernel/<平台>-<架构>/`，见
[electron-builder.yml](../build/electron-builder.yml) 的 `extraResources`）。
开发时如果不改内核，可以直接把一份构建好的二进制放到那里，跳过整个 §2。

---

## 3. 构建 evowork

```bash
pnpm install        # pnpm 10 默认拦 install script，electron 已在 onlyBuiltDependencies 里
pnpm run check      # 格式 · lint · 类型（含测试）· 840 个测试 · K1 补丁预算
pnpm run build      # 见下
```

`pnpm run build` 有四步，顺序是刻意的（见 [scripts/build.mjs](../scripts/build.mjs) 的头注释）：

| 步 | 做什么 | 漏了会怎样 |
| --- | --- | --- |
| ① `tsc --build` | 编译所有包，产出 JS 与声明文件 | — |
| ② 复制入口 + vendor 策略包 | `electron-entry.mjs` → dist；`services/policy/dist` → hook 插件目录 | 打包出的应用**没有入口**；或**策略静默失效**（hook 找不到实现会放行） |
| ③ esbuild 打包三个入口 | 网关、主进程、preload 各成单文件 | 见下 |
| ④ vite 打包渲染层 | — | — |

### 3.1 为什么第 ③ 步必须存在

workspace 包的 `exports` 指向 **TS 源码**（`./src/index.ts`），这让 vitest 与 tsc 直接吃源码，
开发期是对的。但 `node services/gateway/dist/main.js` 会顺着同一个 exports 去加载 `.ts` 然后炸掉 ——
**这是实测踩到的**，报错是 `ERR_MODULE_NOT_FOUND: .../src/fields.js`，跟真正的原因看不出关系。

打成单文件顺带解决了部署侧两件事：网关不用把 pnpm 的 `node_modules` 结构搬到服务器上；
Electron 主进程不再依赖 workspace 链接（electron-builder 打包 pnpm workspace 一直是个麻烦）。

### 3.2 产物

```
dist/gateway/main.js                            网关，单文件，可直接 node 运行
apps/desktop/dist/renderer/                     渲染层（vite，含代码分割）
apps/desktop/dist/main/electron-entry.mjs       Electron 入口
apps/desktop/dist/main/bootstrap.bundle.js      主进程，单文件
apps/desktop/dist/preload/index.bundle.js       preload，单文件
plugins/hooks/evowork-policy/vendor/policy.mjs  策略包
```

`dist/` 与 `vendor/` 都已 gitignore —— 它们是产物。

### 3.3 办公扩展（按需，08 §4）

处理与生成 Word / Excel / PPT / PDF 需要一个**独立的 Python 环境**，装在
`~/.evowork/runtime/office/`：

```bash
uv venv --python 3.12 ~/.evowork/runtime/office
uv pip install --python ~/.evowork/runtime/office/bin/python \
  python-docx openpyxl python-pptx matplotlib pdfplumber jsonschema
```

装在自己的目录而不是系统 python：卸载 = 删一个目录，系统 python 升级不会带走它，
而"装没装"这个判断就是"那个解释器能不能 import 那些模块"，没有歧义。
企业离线部署用 `EVOWORK_OFFICE_PYTHON` 指向别处。

**不装也能用**：文本 / Markdown / CSV / TSV / JSON / 压缩包走内置解析器（基础包）。
四个技能在缺模块时会**自动换到这个解释器重跑**；两边都没有时以退出码 3 + 可操作提示结束，
不会产出坏文件。

---

## 4. 开发时怎么跑

### 4.1 网关（本机）

```bash
DEEPSEEK_API_KEY=sk-... \
EVOWORK_GATEWAY_TOKENS=local-dev-token \
PORT=8791 \
node dist/gateway/main.js
```

验证：

```bash
curl -H "authorization: Bearer local-dev-token" http://127.0.0.1:8791/v1/evowork/models
```

**至少要有一家厂商的密钥，且至少要有一个访问 token**，否则网关**拒绝启动**并说明原因 ——
起一个"看起来正常但每次请求都失败"的网关，会让排查从"没配密钥"变成"模型为什么总报错"。

### 4.2 桌面 App

```bash
# 终端 1：渲染层热更新
pnpm --filter @evowork/desktop run dev

# 终端 2：Electron 主进程
EVOWORK_DEV=1 \
EVOWORK_GATEWAY_TOKEN=local-dev-token \
./node_modules/.bin/electron apps/desktop/dist/main/electron-entry.mjs
```

`EVOWORK_DEV=1` 让入口去连 vite dev server，并用 `../codex/codex-rs/target/debug/codex-app-server`
作为内核（见 [electron-entry.mjs](../apps/desktop/src/main/electron-entry.mjs)）。

> **以 root 运行时** Electron 需要 `--no-sandbox`，否则直接 `FATAL ... Running as root is not supported`。
> 这是容器/CI 里的常见情况；正常桌面环境不需要它，**也不该加**。

---

## 5. 部署

Q1=A（纯本地桌面应用，见 D9）决定了部署面很小：**服务端必须部署的只有网关一个组件**，
而它甚至不一定在服务器上 —— [config.toml.template](../config/config.toml.template) 里
`base_url` 的默认值就是 `http://127.0.0.1:8787/v1`。

### 5.1 需要几台服务器

先回答"除了用户的工作机还要什么"这个问题，再看每个组件怎么装。

| 拓扑 | 服务端 | 适用 | 代价 |
| --- | --- | --- | --- |
| **A · 零服务器** | 无。网关作为本机进程随桌面 App 起，监听 `127.0.0.1` | 个人 · 试点 · 完全离网的私有环境 | **厂商 API key 落在用户机器上**，没有集中计量与配额 —— Q14 选"云端托管为主"正是为了托管密钥 |
| **B · 一台服务器 + 一个静态桶** | 网关（§5.2）· 静态文件源（§5.3） | 团队 · 生产的最小面。**推荐的起点** | 要管 TLS 与 token 发放；配额仍是静态 token 粒度 |
| **C · 完整企业形态** | B + identity · 分享托管 · 私有源索引 · 策略包下发 | 多租户 · 企业合规 | 这四样**现在一个都没建**（§5.6） |

**为什么网关省不掉**：内核只认 Responses API —— `wire_api = "chat"` 已被上游移除
（`model-provider-info/src/lib.rs:57`，2026-09-05 在签出 `728cb12fe5` 上核对），
而 DeepSeek / Kimi / GLM 都只说 Chat。**不存在"让内核直连厂商"这条路** ——
可选的是网关的位置，不是它的存在。

用户机器上跑的是执行面的**全部**：agent 循环、沙箱、文档解析、定时调度、产物索引、
策略与审计，没有一样在服务端（进程图见 [architecture.md §1](architecture.md)）。
全仓库非测试代码里的出网调用点只有两处，这就是数据面的全部：

| 出网点 | 谁在发 | 什么时候 |
| --- | --- | --- |
| [providers/registry.ts:115](../services/gateway/src/providers/registry.ts) | **网关**（不是用户机器） | 每次模型调用；prompt 过境但不落盘（Q14） |
| [artifacts/src/upload.ts:85](../services/artifacts/src/upload.ts) | 桌面 App | 仅在逐次授权的分享上传时。**当前产品代码里没有调用方**，见 §5.6 |

### 5.2 网关（唯一必须的服务端组件）

产物是一个文件，运行时只需要 Node ≥ 22：

```bash
scp dist/gateway/main.js server:/opt/evowork/
```

| 环境变量 | 必填 | 说明 |
| --- | --- | --- |
| `EVOWORK_GATEWAY_TOKENS` | **是** | 逗号分隔的访问 token。空则拒绝启动 |
| `DEEPSEEK_API_KEY` / `MOONSHOT_API_KEY` / `ZHIPU_API_KEY` | **至少一个** | 一家都没有则拒绝启动 |
| `PRIVATE_MODEL_API_KEY` + `PRIVATE_MODEL_BASE_URL` | 否 | 私有 endpoint（Q29 保留的配置项） |
| `*_BASE_URL` | 否 | 覆盖各家默认地址（私有部署 / 代理） |
| `PORT` / `HOST` | 否 | 默认 `8787` / **`127.0.0.1`** |
| `LOG_LEVEL` | 否 | 默认 `info` |

**密钥只从环境变量读，不写进配置文件**（K4 / Q14）。两个拒绝启动的条件见 §4.1 ——
起一个"看起来正常但每次请求都失败"的网关，会让排查从"没配密钥"变成"模型为什么总报错"。

三条只在"放到服务器上"时才会遇到的（前两条是代码事实，不是建议）：

| 事实 | 出处 | 部署时怎么办 |
| --- | --- | --- |
| **默认只监听 `127.0.0.1`** | [main.ts](../services/gateway/src/main.ts) 的 `HOST` 默认值 | 显式设 `HOST=0.0.0.0`。忘了的表现是"服务起来了但从外面连不上" |
| **是明文 HTTP，没有 TLS** | [server.ts](../services/gateway/src/server.ts) 用 `node:http`，全仓库没有 `createSecureServer` | 证书由反向代理终止。**这一段没实测过**（§7） |
| **无状态**：不写盘、无数据库、无会话亲和 | 同上；`server.ts` 里没有任何持久化 | LB 后面水平扩展不需要共享存储。**长压测没做**（status.md 的 M1 剩余项） |

systemd 单元示例（**本机没以服务方式跑过**，见 §7）：

```ini
[Service]
ExecStart=/usr/bin/node /opt/evowork/main.js
EnvironmentFile=/etc/evowork/gateway.env
Restart=always
DynamicUser=yes
# 网关不需要写盘：Q14 的"不落盘"在这一层也可以由 OS 兜一道
ReadOnlyPaths=/
PrivateTmp=yes
```

#### Q14 的可审计手段

网关**不落盘 prompt 与响应体**。这不是靠自觉：`@evowork/logging` 没有接受自由字符串的
日志入口，未注册的字段会被静默丢掉，测试里还有 8 字滑窗的泄露检测。
运维侧要验证这件事，看两处：`packages/logging` 的字段注册表、
`services/gateway/test/pipeline.test.ts` 的 Q14 组。

### 5.3 两个静态文件源（不是应用服务器）

| 源 | 谁要它 | 状态 |
| --- | --- | --- |
| 自动更新 | [electron-builder.yml](../build/electron-builder.yml) 的 `publish: generic` → `https://updates.evowork.example/${channel}` | 配置已就位，**服务端没建**。一个对象存储桶即可；不做自动更新就手工分发安装包 |
| 按需下载的办公扩展（`office` / `ocr` 档） | 08 §4 的三档运行时 | **没有分发端**。§3.3 现在是手工建 venv；下载编排并入 M9，尚未实现 |

这是 B 拓扑里唯一可能要再加一个桶的地方 —— 两个源可以是同一个桶的两个前缀。

### 5.4 桌面 App

打包配置在 [build/electron-builder.yml](../build/electron-builder.yml)，驱动是
[scripts/package.mjs](../scripts/package.mjs)。三平台目标：macOS（dmg / zip，Q26 首发）·
Windows（nsis）· Linux（AppImage / deb）。

```bash
# 一次性：把内核二进制放到 build/kernel/<os>-<arch>/
(cd ../codex/codex-rs && cargo build -p codex-app-server --release)
mkdir -p build/kernel/mac-arm64
cp ../codex/codex-rs/target/release/codex-app-server build/kernel/mac-arm64/

pnpm run build      # 打包只搬产物，不会替你构建
pnpm run package    # = node scripts/package.mjs；--dry-run 只跑前置检查
```

产物落在 `dist/release/`。

**目录名用 `mac-arm64` 而不是 `darwin-arm64`**：`${os}` 展开的是 electron-builder 的
`buildConfigurationKey`（`app-builder-lib/out/core.js`：`Platform.MAC = ("mac","mac","darwin")`），
即 **mac / win / linux**。写错了不会报错 —— `extraResources` 会静默拷一个空目录，
应用装上了、一启动找不到内核。`scripts/package.mjs` 因此在打包前先校验这个路径存在且有执行位。

**为什么要 `package.mjs` 而不是直接 `electron-builder --mac dmg`**：
`scripts/package-plan.mjs` 里的四条规则写完之后一个调用方都没有 —— 有测试、但打包时不生效。
这个脚本就是调用方，它接的是：

| 规则 | 做什么 | 直接跑 electron-builder 会怎样 |
| --- | --- | --- |
| `planSigning`（U4） | 缺任一 secret → 整体不签名，`-unsigned` 进**文件名**，并显式 `mac.identity=null` | 静默产出一个名字看起来像正式包的未签名 dmg；或摸到钥匙串里任意一张证书签出一个没打算签的包 |
| `checkTierPlacement`（08 §4） | 对**解压后的 .app** 扫文件名，拦办公库混进基础包 | 安装包悄悄胖 200MB，等用户下载时才发现 |
| `checkSizeBudget`（R10） | 对**安装包**（dmg/exe/AppImage/deb）比 220MB 预算 | 同上 |
| 前置检查 | 四个入口产物 + 内核二进制 + 执行位 | 对着空 dist 也会**成功**，产出一个白屏或秒退的应用 |

体积口径是**安装包**不是解压后的 .app：R10 与 08 §4 约束的是"用户下载多少"
（原话「首次下载 300MB+ 挡在体验前面」）。.app 一定更大 —— Electron 的 framework
单独就 250MB 上下，拿它去比 220MB 会永远红，而那个红不指向任何可以做的事。

`files` 里有一条 `!node_modules`：三个入口都是自包含产物（§3.1），运行时唯一的外部
require 是 `electron` 本身，而 electron-builder 默认会把整棵生产依赖树塞进 `app.asar` ——
实测 80MB 里 7390 个条目是 node_modules、我们自己的只有 75 个，去掉后 dmg 从 115MB 降到 95MB。
**将来引入原生模块（`.node`）时必须把它加回来**，那种依赖打不进 bundle。

### 5.5 首次运行

用户侧的授权引导在应用内（02 §9 六步）：欢迎与隐私说明 → 选工作空间 → 权限默认值 →
接入模型 → 解析组件（**可跳过**）→ 完成。运维不需要预置任何东西，除了网关地址与 token。

### 5.6 现在还不需要部署的四件事

D9 给云端留了四类职责，除模型网关外的其余部分**都还没有实现**。不写清这一点的后果是
按 C 拓扑去准备机器，然后发现没有东西可以装上去。

| 组件 | D9 里的职责 | 实际状态 | 不部署它的影响 |
| --- | --- | --- | --- |
| identity | 账号 · 租户 · 配额 · 授权 | `services/identity/` 只有一份 README | 网关退回静态 token（`staticTokenAuth`）。试点够用，但**没有按用户的配额与审计** |
| 分享托管 | 产物分享（Q10），`/v1/shares` | 客户端 [upload.ts](../services/artifacts/src/upload.ts) 已实现，但 `createUploader` 在产品代码里**没有调用方**；服务端没写 | 分享功能整体不可用。这也意味着**当前形态下本机内容不会离开设备**（除模型调用） |
| 企业私有源索引 | 技能 / 插件分发（Q5：无公开市场） | 未建；`plugins/connectors/` 只有 `.gitkeep`（Q9 本期不做） | 扩展只能随包分发 |
| 签名策略包下发 | 审计汇总 · 策略下发（R11） | 未建。策略与审计链在本机（`services/policy`）已实现 | 企业无法在服务端强制拦截 —— 这正是 D9 明确列出的代价 |

### 5.7 不是"服务器"，但绕不开的基础设施

问"要几台机器"时真正的成本在这里，不在运行时：

| 需要什么 | 为什么 | 状态 |
| --- | --- | --- |
| **三台构建机**（macOS / Windows / Linux） | 内核二进制要按平台构建后放进 `build/kernel/<os>-<arch>/`（§5.4）；electron-builder 也需要在目标平台上出包 | 只有 macOS 一台 |
| **签名证书** | Apple Developer ID + 公证 · Windows 代码签名 | 卡 P0-5，见 §7 与 U4。缺任一 secret 时 `package.mjs` 整体降级为未签名并标注进文件名 |
| 内核构建的时间与磁盘 | 首次约 40 分钟、`target/` 涨到 7.7 GB（§2.1） | 别在 CI 里给它设 30 分钟超时 |

---

## 6. 排障

| 现象 | 原因 | 怎么办 |
| --- | --- | --- |
| `cargo build` 在 `openssl-sys` 失败 | 缺 `pkg-config` / `libssl-dev` | 见 §1 |
| `node dist/.../main.js` 报 `ERR_MODULE_NOT_FOUND: .../src/*.js` | 跑的是 tsc 产物而不是 esbuild 打包产物 | 跑 `pnpm run build`，用 `dist/gateway/main.js` |
| 网关启动即退出，日志 `gateway.boot.no_models` | 一家厂商密钥都没配 | 见 §5.1 |
| 网关启动即退出，日志 `gateway.boot.no_tokens` | 没配 `EVOWORK_GATEWAY_TOKENS` | 同上 |
| Electron `FATAL ... Running as root` | 容器里以 root 跑 | 加 `--no-sandbox`（仅限容器/CI） |
| `require('electron')` 报 "failed to install correctly" | pnpm 拦了 postinstall，运行时才发现 | `pnpm rebuild electron`；确认 `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 里有它 |
| 技能报"需要安装本地办公扩展" | 办公扩展没装或路径不对 | 见 §3.3；或用 `EVOWORK_OFFICE_PYTHON` 指定 |
| 内核 stderr 报 `could not find bubblewrap` | Linux 沙箱组件没装 | `apt install bubblewrap`。不装它会回落到自带的那个，**不阻断启动**，所以容易被当成噪音漏掉 |
| 手工发 `initialize` 没有响应 | **stdin 被关掉了** —— 管道一关内核就退出 | 保持 stdin 打开，见 §2.1.1 的写法 |
| electron-builder 报 `Cannot compute electron version from installed node modules` | 它检测到 pnpm workspace 后把 projectDir 定在**仓库根**，去那里找 `node_modules/electron`；而 electron 装在 `apps/desktop` 下 | `electron` 声明在**根** `package.json` 的 devDependencies（2026-09-05 从 apps/desktop 挪过来的原因就是这个） |
| 打包出的 App 双击没反应；命令行直接跑**退出码 0、一行输出都没有** | 主进程 bundle 在 `import` 阶段就抛了，异常没来得及落到 stderr。当前已知的一处：`services/store` 用 `node:sqlite`，而 Electron 33 带的是 **Node 20.18.3**，没有这个内置模块 | `ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron -e "import('./apps/desktop/dist/main/bootstrap.bundle.js').catch(e=>console.log(e.code,e.message))"` 会把真正的错误打出来 |
| 装好的应用启动即报找不到内核 | `build/kernel/` 下的目录名写成了 `darwin-arm64`。`extraResources` 匹配不到时**不报错**，只拷一个空目录 | 用 `mac-arm64`（§5.2）；`pnpm run package` 会先拦这一条 |
| 策略 hook 看起来没生效 | 忘了 vendor 步骤，hook 找不到实现会**放行并往 stderr 报错** | 跑 `pnpm run build`；真正的兜底在沙箱层，不在 hook 上 |

---

## 7. 本文没验证的部分

**写进手册但没真跑过的，只有这些**，其余每条命令都在本机执行过：

| 项 | 为什么没验 | 关联 |
| --- | --- | --- |
| `electron-builder` 出 Windows / Linux 包 | 缺这两个平台的构建机（macOS 的实测体积见 §5.4） | M9 · §5.7 |
| 代码签名与公证 | 缺证书 | U4 |
| Windows 上的隔离强度 | 缺 Windows 机器；当前按保守侧走（停用完全访问） | U5 |
| systemd 单元 | 本机没有以服务方式跑过，只跑过前台进程 | §5.2 |
| 网关放到服务器上：`HOST=0.0.0.0` + 反向代理终止 TLS | 只跑过明文 `127.0.0.1` 的前台进程 | §5.2 |
| 网关的水平扩展与长压测 | 只跑过单实例；`maxContextTokens` 也仍未实测 | M1 剩余项 |
| 自动更新服务端 | `publish` 配置已就位，服务端没建 | §5.3 · M9 |
| 办公扩展的下载编排 | 没实现；§3.3 现在是手工建 venv | §5.3 · M9 |

已验证的：

- **内核** `cargo build -p codex-app-server` 编完（约 40 分钟，二进制 1.1 GB），
  `--help` 可运行，**`initialize` 握手返回正确、`codexHome` 回显我们给的 `CODEX_HOME`**
- `pnpm run check`（840 测试）· `pnpm run build` 四步
- 网关单文件启动 + 能力端点 401/200 + **对 DeepSeek 的端到端流式请求**
- 四个办公技能真实产出 pptx / docx / xlsx / png（xlsx 里确认是 `=B2*C2` 而不是算好的数）
- 策略 hook 加载 vendor 后正确拦截 `~/.ssh` · Electron 二进制 `--version` 可运行
