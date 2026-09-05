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

> **`pkg-config` 与 `libssl-dev` 是实测踩到的**：缺了它们 `cargo build` 会在 `openssl-sys`
> 上失败，而错误信息出现在几百行输出的中间，`cargo` 最后只说 "build failed"。
> macOS 上通常由 Homebrew 的 openssl 满足；Debian/Ubuntu 要显式装。

只用产品、不改内核的话，**Rust 与那两个系统包都不需要** —— 直接用发布的内核二进制即可（§2.3）。

---

## 2. 构建内核（`../codex`）

### 2.1 只构建我们需要的那一个

```bash
cd ../codex/codex-rs
cargo build -p codex-app-server              # 开发用
cargo build -p codex-app-server --release    # 分发用
```

产物：`target/{debug,release}/codex-app-server`。

**只构建这一个 crate**，不要 `cargo build --workspace`：内核工作区有 200+ 个 crate，
而 EvoWork 只对话 app-server 这一个进程（K2）。全量构建会多花几十分钟，且构建出的
TUI / CLI 我们一个都不用。

首次构建会拉几百个依赖并编译，**耗时以小时计**：本机（多核容器）跑到 30 分钟时
`target/` 已经 5.8 GB 还没产出二进制。留足时间与磁盘（**准备 10 GB 以上**），
别在 CI 里给它设 30 分钟超时。增量构建通常在一分钟内。

在没有改内核的场景下，这一整节都可以跳过 —— 见 §2.3。

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

Q1=A（纯本地桌面应用，见 D9）决定了部署面很小：**云端只有网关**，其余全在用户机器上。

### 5.1 网关（唯一的服务端组件）

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
| `PORT` / `HOST` | 否 | 默认 `8787` / `127.0.0.1` |
| `LOG_LEVEL` | 否 | 默认 `info` |

**密钥只从环境变量读，不写进配置文件**（K4 / Q14）。

systemd 单元示例：

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

### 5.2 桌面 App

打包配置在 [build/electron-builder.yml](../build/electron-builder.yml)。三平台目标：
macOS（dmg / zip，Q26 首发）· Windows（nsis）· Linux（AppImage / deb）。

打包前把内核二进制放到 `build/kernel/<os>-<arch>/`，它会作为 `extraResources` 随包。
**解析运行时不随包**（08 §4：按需下载，否则安装包 +300MB 会挡在首次体验前面）——
`scripts/package-plan.mjs` 里有一条检查专门拦"办公库混进基础包"。

> **打包本身没有实际跑通过。** `electron-builder` 还没接进来，签名与公证需要 P0-5 的证书
> （work-priority §10 的 U4）。`scripts/package-plan.mjs` 已经实现了体积预算、档位边界检查、
> 以及**缺任一 secret 时整体降级为未签名并把标注写进文件名** —— 半签名的产物看起来像正式包，
> 比未签名的更危险。这些逻辑有测试，但"跑一次真实打包"这件事**还没做**。

### 5.3 首次运行

用户侧的授权引导在应用内（02 §9 六步）：欢迎与隐私说明 → 选工作空间 → 权限默认值 →
接入模型 → 解析组件（**可跳过**）→ 完成。运维不需要预置任何东西，除了网关地址与 token。

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
| 策略 hook 看起来没生效 | 忘了 vendor 步骤，hook 找不到实现会**放行并往 stderr 报错** | 跑 `pnpm run build`；真正的兜底在沙箱层，不在 hook 上 |

---

## 7. 本文没验证的部分

**写进手册但没真跑过的，只有这些**，其余每条命令都在本机执行过：

| 项 | 为什么没验 | 关联 |
| --- | --- | --- |
| `electron-builder` 打包三平台 | 依赖没接进来；且需要各平台的构建机 | M9 |
| 代码签名与公证 | 缺证书 | U4 |
| Windows 上的隔离强度 | 缺 Windows 机器；当前按保守侧走（停用完全访问） | U5 |
| systemd 单元 | 本机没有以服务方式跑过，只跑过前台进程 | — |

已验证的包括：内核 `cargo build -p codex-app-server`、`pnpm run check`（840 测试）、
`pnpm run build` 四步、网关单文件启动 + 能力端点 + **对 DeepSeek 的端到端流式请求**、
四个办公技能真实产出 pptx/docx/xlsx/png、hook 加载 vendor 后正确拦截 `~/.ssh`。
