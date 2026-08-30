# M1 增补：macOS 桌面外壳 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 出一个 Tauri 2 空壳——双击打开、窗口里是当前 UI（哪怕还很空）——并把「壳不渗进业务代码」这条从口号变成 CI 检查。

**Architecture:** UI 是纯 Web 栈（Vite + React + TS），壳只是第二种加载方式。UI 与 daemon 之间走 WebSocket + HTTP/JSON-RPC，**不走外壳的原生桥**。原生能力经一个 `platform` 接口，有浏览器与 Tauri 两个实现；`@tauri-apps/api` 只许出现在 `apps/ui/src/platform/` 一个目录。

**Tech Stack:** Vite + React + TypeScript（前端）、Tauri 2（外壳，Rust，约 200 行）、pnpm。

## Global Constraints

- **浏览器入口必须留着，不是二选一**——手机点企业微信审批链接走的就是它。daemon 继续 serve 那份 Web 产物，壳只是第二种加载方式
- **`@tauri-apps/api` 与 `ipcRenderer` 只许出现在 `apps/ui/src/platform/`**（CI 检查 9）。UI 里到处 `invoke`，就是红线 1 的前置形态
- **壳里零业务逻辑**——选 Tauri 而非 Electron 的决定性理由就是主进程没有 Node、想塞都塞不进去
- **UI 只经 `daemonClient` 一个模块访问 daemon**，不直接读 SQLite、不用 `invoke` 拿业务数据
- `crates/` 与 `apps/` 里**不得出现客户专有名词**（`yonyou` / `用友`）
- **`apps/ui/src-tauri` 不进根 Rust workspace**——根 workspace 是 daemon/kernel 那一套，把 GUI 壳塞进去会让 `cargo clippy --workspace` 在每台机器上都要求 GTK/webkit，而壳的正确性与那套无关
- **类型检查必须用 `tsc -b --noEmit`（或 `pnpm build`，其 `build` 脚本是 `tsc -b && vite build`），不要用不带 `-p`/`-b` 的 `tsc --noEmit`**——本工程根 `tsconfig.json` 是 solution 风格（`"files": []` + `references`），裸 `tsc` 编译 **0 个文件**、恒为 0 退出码（实测 `--listFiles` 命中 0）。验收清单上一条恒真的命令比没有它更糟：它让人以为多了一层保障。这是本项目第六个「永远通过的检查」，且是写在派活指令里的
- 每个任务 commit 前跑格式化，以 `./scripts/ci.sh` 全段绿收尾
- 每个任务以一次 commit 收尾

## 本次不做（写清楚，免得被当成遗漏）

| 项 | 为什么 |
|---|---|
| 实际产出签名公证的 `.app` | 需要 macOS + Apple Developer Program 账号（文档列为 M0 项，尚未到位）。开发机是 Linux |
| UI 的业务界面（trace 时间线、审批队列、成本面板） | 属 M2。本次是「空壳 + 接口」，文档原话是「窗口里是当前 UI，哪怕还很空」 |
| `daemonClient` 的真实调用 | daemon 的 HTTP/WS 协议属阶段 3，尚未实现。本次只出接口与类型骨架 |
| daemon 的 launchd 启动路径 | `evo-daemon` 目前是 lib crate、还没有二进制。「不读 launchd 特有 env、不写 plist 路径」这条约束记进计划，阶段 3 写 daemon 二进制时兑现 |

---

## 文件结构

```
apps/ui/
  package.json                  Vite + React + TS
  vite.config.ts
  tsconfig.json
  index.html
  src/
    main.tsx                    入口
    App.tsx                     最小页面：显示协议版本协商结果与连接状态
    platform/
      index.ts                  Platform 接口定义 + 运行时选择实现
      browser.ts                浏览器实现（能力可缺）
      tauri.ts                  Tauri 实现（唯一允许 @tauri-apps/api 的文件）
    daemon/
      client.ts                 daemonClient：UI 访问 daemon 的唯一模块
      types.ts                  暂时手写的协议类型（阶段 3 换成 ts-rs 生成）
  src-tauri/
    Cargo.toml                  独立 workspace，不进根 workspace
    tauri.conf.json             含签名公证配置位（本次不执行）
    src/main.rs                 壳，零业务逻辑
scripts/ci.sh                   +CI-9，CI-4 扩到 apps/，+前端构建与类型检查
```

---

### Task 0: Tauri 与前端工具链在 Linux 上的可行性实测

先验环境，再写代码——与阶段 1 的 Task 0 同一套路。**两种结果都是有效产出**，不要为了让它过而降版本或改配置。

**Files:**
- Create: `docs/superpowers/notes/2026-08-29-tauri-linux-probe.md`

- [ ] **Step 1: 验前端工具链**

```bash
cd /tmp && rm -rf ui-probe && pnpm create vite@latest ui-probe --template react-ts
cd ui-probe && pnpm install && pnpm build
```
记录：能否装、能否 build、产物在哪。

- [ ] **Step 2: 验 `@tauri-apps/api` 能否安装**

```bash
cd /tmp/ui-probe && pnpm add @tauri-apps/api
```
这是纯 TS 包，预期能装。装完 `pnpm build` 仍要过。

- [ ] **Step 3: 验 Tauri 的 Rust 侧在 Linux 上能否 cargo check**

```bash
mkdir -p /tmp/tauri-probe/src && cd /tmp/tauri-probe
cat > Cargo.toml <<'EOF'
[package]
name = "tauri-probe"
version = "0.0.0"
edition = "2021"

[dependencies]
tauri = "2"
EOF
echo 'fn main() {}' > src/main.rs
cargo check 2>&1 | tail -30
```
Linux 上 Tauri 需要 webkit2gtk/GTK 的系统库。**通不过是完全可以接受的结论**——那正是「接口先行」要面对的现实。不要 `apt install` 一堆系统库去硬凑，记录确切错误即可。

- [ ] **Step 4: 写结论文档**

回答四件事：① 前端工具链是否可用 ② `@tauri-apps/api` 是否可装 ③ `src-tauri` 在 Linux 上能否 `cargo check`，不能的话确切错误是什么 ④ 据此，`src-tauri` 这一层在本次应当做到什么程度（源码齐全但不编译？还是连源码都推迟？给出建议与理由）。

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/notes/2026-08-29-tauri-linux-probe.md
git commit -m "chore: Tauri 与前端工具链在 Linux 上的可行性实测"
```

---

### Task 1: `apps/ui` 前端骨架与 `platform` 接口

**Files:**
- Create: `apps/ui/package.json`, `vite.config.ts`, `tsconfig.json`, `index.html`, `.gitignore`
- Create: `apps/ui/src/main.tsx`, `src/App.tsx`
- Create: `apps/ui/src/platform/index.ts`, `platform/browser.ts`

**Interfaces:**
- Produces:
  - `interface Platform { pickFile(): Promise<File | null>; openExternal(url: string): Promise<void>; notify(title: string, body: string): Promise<void>; setAutoLaunch(enabled: boolean): Promise<void>; quit(): Promise<void>; }`
  - `interface PlatformInfo { kind: "browser" | "desktop"; supports(cap: keyof Platform): boolean }`
  - `getPlatform(): Platform & { info: PlatformInfo }`

- [ ] **Step 1: 建 Vite 工程**

用 Task 0 验过的方式在 `apps/ui` 下建 Vite + React + TS 工程。`package.json` 的 `name` 用 `@evowork/ui`。**不要**装 AntD 或任何组件库——本次是空壳，装了就是给 M2 提前做决定。

- [ ] **Step 2: 写 `platform` 接口（先写测试）**

`apps/ui/src/platform/index.ts` 定义 `Platform` 接口与 `getPlatform()`。**接口方法不超过 5 个**（选文件、打开外链、系统通知、自启、退出）——这是设计文档 06 §6 的硬约束，多一个都要有理由。

`getPlatform()` 在运行时判断当前是壳还是浏览器（判断方式由实现者定，但**不许**在 `index.ts` 里 import `@tauri-apps/api`——那会让 CI-9 失败，也会让浏览器构建把 Tauri 代码打进去）。

- [ ] **Step 3: 写浏览器实现**

`browser.ts`：`pickFile` 退回 `<input type=file>`；`notify` 退回 Web Notification；`openExternal` 用 `window.open`；`setAutoLaunch` 与 `quit` **明确不支持**——`info.supports()` 返回 false，调用时抛一个说清楚原因的错误，**不要静默 no-op**（静默会让「这个能力在浏览器下没有」变成一个要靠试才知道的事）。

- [ ] **Step 4: 最小页面**

`App.tsx` 显示：当前 platform 是 browser 还是 desktop、各能力是否支持、以及一个「daemon 未连接」的占位状态。**不要**写任何业务界面。

- [ ] **Step 5: 构建与类型检查**

Run: `cd apps/ui && pnpm install && pnpm build && pnpm exec tsc -b --noEmit`
Expected: 都通过

- [ ] **Step 6: Commit**

---

### Task 2: `daemonClient` 模块

UI 访问 daemon 的**唯一**模块。协议本身属阶段 3，本次只出接口与类型骨架。

**Files:**
- Create: `apps/ui/src/daemon/client.ts`, `apps/ui/src/daemon/types.ts`
- Modify: `apps/ui/src/App.tsx`

**Interfaces:**
- Produces：`createDaemonClient(config: { baseUrl: string; token: string }): DaemonClient`，含 `hello()`、`subscribe(runId, fromSeq, onEvent)`、`rpc(method, params)` 三个入口，以及协议版本协商（主版本不匹配降级为只读）

- [ ] **Step 1: 写类型骨架**

`types.ts` 手写本次需要的最小协议类型（`HelloFrame`、`ProtocolVersion`、`RpcRequest` / `RpcResponse`、事件流帧）。**文件头注释写明：这是临时手写的，阶段 3 会换成 `ts-rs` 从 Rust 侧生成的 `packages/protocol`，届时删掉本文件。** 不写这句，半年后没人知道它该消失。

- [ ] **Step 2: 写 `client.ts`（先写测试）**

至少覆盖版本协商：主版本不匹配 → 客户端进入只读模式（`readOnly` 为 true，`rpc()` 对写类方法直接拒绝）；次版本不匹配 → 正常。这条是设计文档 06 §5 的既定决策（Q-23）。

**不要**真的去连一个 daemon——daemon 的 HTTP/WS 属阶段 3，还不存在。用注入的 fetch/WebSocket 桩来测。

- [ ] **Step 3: 接进 App**

`App.tsx` 用 `daemonClient` 显示连接状态（本次必然是「未连接」，因为 daemon 还没有 HTTP 入口）。**这是有意的**：把调用点摆正，阶段 3 接上真 daemon 时不改 UI 代码。

- [ ] **Step 4: 测试与构建**

Run: `cd apps/ui && pnpm test && pnpm build && pnpm exec tsc -b --noEmit`

- [ ] **Step 5: Commit**

---

### Task 3: Tauri 外壳与 `platform` 的 Tauri 实现

**做到什么程度由 Task 0 的结论决定**：若 `src-tauri` 在 Linux 上无法 `cargo check`，源码仍然写全（它要在拿到 Mac 的当天就能构建），但不接进任何本机构建流程，并在交付说明里明确列为「未验」。

**Files:**
- Create: `apps/ui/src-tauri/Cargo.toml`, `tauri.conf.json`, `src/main.rs`, `build.rs`
- Create: `apps/ui/src/platform/tauri.ts`
- Modify: `apps/ui/src/platform/index.ts`（接上 Tauri 实现）

- [ ] **Step 1: 写 `platform/tauri.ts`**

**这是全仓唯一允许出现 `@tauri-apps/api` 的文件。** 五个方法各自调对应的 Tauri API。

- [ ] **Step 2: 写外壳**

`src-tauri/src/main.rs`：起一个窗口、加载 Vite 产物、就这些。**零业务逻辑**——不注册任何自定义 command，不碰 Run Log，不碰 SQLite。壳越薄，「换外壳 = 重写那一个适配器」这句话越成立。

`Cargo.toml` 里写 `[workspace]`（空表）把它与根 workspace 隔开。

- [ ] **Step 3: 签名公证的配置位**

`tauri.conf.json` 里把 macOS 签名与公证的配置项**写出来并留空/占位**，配一段注释说明需要哪些东西（Developer ID 证书、Apple ID、team ID、app-specific password 或 API key）。这样拿到账号那天是填空，不是从头查。

- [ ] **Step 4: 验证能验的部分**

Run: `cd apps/ui && pnpm build && pnpm exec tsc -b --noEmit`
Expected: 通过（TS 侧包含 `tauri.ts` 也应当类型检查通过——`@tauri-apps/api` 是纯 TS 包）

若 Task 0 的结论是 Linux 上能 `cargo check`，则再跑 `cd apps/ui/src-tauri && cargo check` 并把输出贴进报告。

- [ ] **Step 5: Commit**

---

### Task 4: CI 检查 9、CI-4 扩到 `apps/`、前端接进 ci.sh

**Files:**
- Modify: `scripts/ci.sh`

- [ ] **Step 1: CI 检查 9——外壳不渗进业务代码**

```bash
echo "== CI-9 外壳不渗进业务代码 =="
# 外壳 API 的命中必须全部落在 apps/ui/src/platform/ 内。
# UI 里到处 invoke，就是「内核在 UI 进程里」这条红线的前置形态。
#
# 匹配整个 `@tauri-apps/` 家族，不是只匹配 `@tauri-apps/api`——
# Tauri 2 把能力拆进了 `@tauri-apps/plugin-*`（dialog / fs / notification /
# opener / process / autostart …），**没有一个包含 `api` 子串**。只匹配
# `/api` 的话，业务组件里 `import { open } from '@tauri-apps/plugin-dialog'`
# 会畅通无阻——那正是这条检查要挡的东西。
# （设计文档 00 §4 检查 9 的原文也只写了 `@tauri-apps/api`，同一个缺口，
#  Task 5 回填文档时一并订正。）
offenders=$(grep -rlE '@tauri-apps/|ipcRenderer' apps/ui/src/ 2>/dev/null \
            | grep -v '^apps/ui/src/platform/' || true)
if [ -n "$offenders" ]; then
  echo "FAIL: platform/ 之外出现了外壳 API：$offenders"; exit 1
fi
echo "ok"
```

- [ ] **Step 2: CI-4 扩到 `apps/`**

现有 CI-4 只 grep `crates/`，而规格是 `crates/ apps/`。`apps/` 现在存在了，补上——否则它一建立就静默失守。

- [ ] **Step 3: 前端构建与类型检查进 ci.sh**

加一段跑 `pnpm install --frozen-lockfile`、`pnpm build`、`pnpm exec tsc -b --noEmit`、以及前端测试。**注意**：ci.sh 现在是 Rust 项目的入口，加前端段后要保证在没装 node 的机器上有清楚的报错，而不是莫名其妙的失败。

- [ ] **Step 4: 造反例验证 CI-9 真的会 fail**

**两种写法都要试**，因为它们走的是不同的包名：
1. 在 `apps/ui/src/App.tsx`（`platform/` 之外）临时加 `import { invoke } from '@tauri-apps/api/core'` → CI-9 必须 FAIL
2. 换成 `import { open } from '@tauri-apps/plugin-dialog'` → CI-9 **也必须 FAIL**（这条是原模式漏掉的那类）

两次都还原确认恢复绿。**一条永远通过的检查比没有检查更糟**——这个项目已经出过四次。

> **不要用 `grep -c "tauri-apps" apps/ui/dist/assets/*.js` 来验证「浏览器产物没带 Tauri 代码」。** 压缩后的产物本来就不保留 npm scope 字符串，不论代码有没有被打进去都返回 0——那是个永远通过的检查。真正的验证方式是看 chunk 切分与 `index.html` 的引用关系（Task 3 的报告里有做法）。

同样给 CI-4 造一次反例（在 `apps/ui/src/` 下临时写一个客户名词），确认它现在真的覆盖了 `apps/`。

- [ ] **Step 5: 跑全量 CI**

Run: `./scripts/ci.sh`
Expected: 全段绿（Rust 七段 + 前端段 + CI-9）

- [ ] **Step 6: Commit**

---

### Task 5: 交付说明与文档回填

**Files:**
- Create: `docs/superpowers/notes/2026-08-29-desktop-shell-status.md`
- Modify: `docs/design/00-index.md`（仓库结构补 `apps/ui` 的实际形态）

- [ ] **Step 1: 写交付说明**

必须明确列出**未验**的部分：
- 签名与公证**未执行**（需 macOS + Apple Developer Program 账号，后者是 M0 项、尚未到位）
- `.app` **未产出、未在 macOS 上运行过**
- 若 Task 0 结论是 Linux 无法 `cargo check`，则 `src-tauri` 的 Rust 源码**未经编译验证**

写清楚拿到 Mac + 账号那天要做的事，按顺序列。**含糊过去的「未验」等于假的完成。**

- [ ] **Step 2: 回填 `00-index.md` 的仓库结构**

把 `apps/ui/` 下的实际结构写进去（与文档里已有的 `src/platform/` 与 `src-tauri/` 两行对齐，补上 `src/daemon/`）。

- [ ] **Step 3: 记下阶段 3 的两条约束**

在计划或设计文档里记明，供写 daemon 二进制时兑现：
1. **daemon 不该知道自己是被 launchd 还是 SCM 拉起来的**——不读 launchd 特有环境变量、不把 plist 路径写进业务代码。现在零成本，后补要翻一遍启动路径
2. token 落 `/Library/Application Support/evowork/client.toml`，权限 644——daemon 在专用服务账户下，桌面客户端在财务登录账户下，token 只写服务账户家目录的话财务读不到，装完就是打不开

- [ ] **Step 4: Commit**

---

## 完成检查

- [ ] `./scripts/ci.sh` 全段绿（含新增的 CI-9 与前端段）
- [ ] CI-9 与扩容后的 CI-4 各自造过反例、确认会 FAIL
- [ ] `grep -rE '@tauri-apps/api|ipcRenderer' apps/ui/src/` 的命中全部在 `platform/` 内
- [ ] 浏览器入口可用（`pnpm build` 出的产物能在浏览器里打开）
- [ ] `apps/ui/src-tauri` 不在根 workspace 的 `cargo metadata` 里
- [ ] 交付说明里「未验」清单完整、不含糊
