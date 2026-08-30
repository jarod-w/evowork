# Tauri 与前端工具链在 Linux 上的可行性实测

> 对应 M1「桌面外壳」阶段 · Task 0。目的：在写任何 Tauri 代码之前，摸清这台 Linux 开发机的
> 工具链到底能把「Vite + React + TS 前端」与「`src-tauri` Rust 侧」这两层做到哪一步——交付形态
> 是 macOS 的签名公证 `.app`，提前做这件事只为了给 Apple 签名公证抢 lead time。

## 环境

- Node `v22.22.0` / npm `10.9.4` / pnpm `10.30.3`
- `rustc 1.95.0 (59807616e 2026-04-14)` / `cargo 1.95.0 (f2d3ce0bd 2026-03-21)`，位于 `$HOME/.cargo/bin`
- 平台：Linux（`6.8.0-101-generic`，x86_64）
- 探针目录：`/tmp/ui-probe`、`/tmp/tauri-probe`（临时，不进版本库）

## Step 1：前端工具链（Vite + React + TS）

```
cd /tmp && rm -rf ui-probe && pnpm create vite@latest ui-probe --template react-ts
cd ui-probe && pnpm install && pnpm build
```

**结果：全部通过。**

- `pnpm create vite@latest` 正常脚手架出项目（`vite v8.2.2` 模板）。
- `pnpm install` 6.6s 装完，`react 19.2.8` / `react-dom 19.2.8` / `typescript 6.0.3` /
  `@vitejs/plugin-react 6.1.1` 等，无报错，只有 pnpm/typescript 自身的版本更新提示（无影响）。
- `pnpm build`（`tsc -b && vite build`）208ms 内完成，产物落在 `dist/`：

```
dist/index.html                   0.45 kB │ gzip:  0.30 kB
dist/assets/react-CHdo91hT.svg    4.12 kB │ gzip:  2.06 kB
dist/assets/vite-BF8QNONU.svg     8.70 kB │ gzip:  1.60 kB
dist/assets/hero-CLDdwZDr.png    13.05 kB
dist/assets/index-D64VDMd1.css    4.10 kB │ gzip:  1.47 kB
dist/assets/index-CP6jzYRJ.js   193.28 kB │ gzip: 60.63 kB
✓ built in 208ms
```

## Step 2：`@tauri-apps/api` 能否安装

```
cd /tmp/ui-probe && pnpm add @tauri-apps/api
```

**结果：通过。** `@tauri-apps/api 2.11.1` 1.5s 装完（纯 TS 包，无原生依赖，无需 pkg-config/系统库）。
装完后重跑 `pnpm build`，输出与 Step 1 完全一致（bundle 体积、耗时均无异常变化）——`@tauri-apps/api`
本身不产生编译期副作用，前端这一层不受它拖累。

## Step 3：`src-tauri`（Tauri Rust 侧）在 Linux 上能否 `cargo check`

```
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
cargo check
```

**结果：不通过。** `tauri = "2"` 锁定解析到 `tauri 2.11.5`。依赖树下载、编译到 `glib-sys v0.18.1`
的 build script 时报错退出，`cargo check` 以非零状态终止：

```
   Compiling glib-sys v0.18.1
warning: glib-sys@0.18.1: Could not run `PKG_CONFIG_ALLOW_SYSTEM_CFLAGS=1 pkg-config --libs --cflags glib-2.0 'glib-2.0 >= 2.70'`
error: failed to run custom build command for `glib-sys v0.18.1`

Caused by:
  process didn't exit successfully: `/tmp/tauri-probe/target/debug/build/glib-sys-50ac6494cae497ad/build-script-build` (exit status: 1)
  --- stdout
  cargo:rerun-if-env-changed=GLIB_2.0_NO_PKG_CONFIG
  ... (一串 PKG_CONFIG_* / HOST_PKG_CONFIG_* 的 rerun-if-env-changed)
  cargo:warning=Could not run `PKG_CONFIG_ALLOW_SYSTEM_CFLAGS=1 pkg-config --libs --cflags glib-2.0 'glib-2.0 >= 2.70'`
  The pkg-config command could not be found.

  Most likely, you need to install a pkg-config package for your OS.
  Try `apt install pkg-config`, or `yum install pkg-config`, or `brew install pkgconf`
  or `pkg install pkg-config`, or `apk add pkgconfig` depending on your distribution.

  If you've already installed it, ensure the pkg-config command is one of the
  directories in the PATH environment variable.

  If you did not expect this build to link to a pre-installed system library,
  then check documentation of the glib-sys crate for an option to
  build the library from source, or disable features or dependencies
  that require pkg-config.
warning: build failed, waiting for other jobs to finish...
```

确认了两件事：

- `which pkg-config` 退出码 `1`——**这台机器上连 `pkg-config` 这个可执行文件本身都没有**，
  连"缺 GTK/webkit2gtk 的 dev 头文件"这一步都没走到，卡在更前面一层。
- 这是 `tauri` → `tauri-runtime-wry` → `wry`/`tao` → `gtk`/`webkit2gtk-rs` 这条依赖链在 Linux
  上的**已知、结构性**要求：Tauri 2 的 Linux 后端基于 GTK + WebKitGTK，`glib-sys`/`gtk-sys`/
  `webkit2gtk-sys` 等 `*-sys` crate 的 build script 都要靠 `pkg-config` 去找系统库。这不是版本
  错配或某个 crate 的 bug，换 Tauri 版本、改 `Cargo.toml` 配置都绕不开——唯一的绕法是
  `apt install pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev ...` 一整套系统库，而简报明确
  要求不这么做。

按简报要求，没有安装任何系统库、没有降 Tauri 版本、没有改 `Cargo.toml` 去迁就，如实记录了失败。

## Step 4：结论

**① 前端工具链（Vite + React + TS）是否可用**：**可用，能装能 build**。`pnpm create vite`
脚手架、`pnpm install`、`pnpm build` 全部一次性通过，产物在 `dist/`，无需任何额外系统依赖。这台
Linux 机器可以正常承担 evowork 桌面外壳的整个前端开发与构建工作。

**② `@tauri-apps/api` 是否可装**：**可装，装完 `pnpm build` 仍然过**。它是纯 TS 包（浏览器侧
桥接 API 的类型声明 + 轻量 runtime），不带原生二进制、不触发任何编译期系统依赖，装前装后的构建
产物/耗时没有可观察差异。这意味着**只要不涉及 `src-tauri`，前端代码（包括调用
`@tauri-apps/api` 的 invoke/event 封装）可以在这台 Linux 机器上完整地写、跑单测、跑
`pnpm build`，唯一跑不了的是"in a real Tauri window"这件事。

**③ `src-tauri` 在 Linux 上能否 `cargo check`**：**不能**。确切错误：`glib-sys v0.18.1` 的
build script 因为找不到 `pkg-config` 这个可执行文件而失败（`pkg-config: command not found`，
而不是"pkg-config 找到了但库版本不够"）。这是 Tauri 2 在 Linux 上依赖 GTK/WebKitGTK 这条链路
最前端的一步，`cargo check` 走不到"检查 `src-tauri` 自己的代码"这一步就先卡在依赖的原生构建上。

**④ `src-tauri` 这一层在本次应当做到什么程度**：

**建议：`src-tauri` 的源码本次就写全（`tauri.conf.json`、`main.rs`/`lib.rs`、`Cargo.toml`、
`build.rs`、图标资源等，约 200 行），但不接入本机的 CI/构建流程去验证它——也就是说，写完之后
不要求、也不可能在这台 Linux 机器上跑通 `cargo check`/`cargo build`/`tauri build`，把"是否能
编译"这件事显式地推给拿到 Mac 之后的第一件事去做。**

理由：

1. **这层代码零业务逻辑、体量小（约 200 行）、修改面窄**：Tauri 的 Rust 侧在这个项目里只是一层
   壳（窗口配置、命令注册、可能的托盘/菜单），不涉及 evowork 的事件溯源核心逻辑。这种代码正确性
   主要靠"语法对不对、Tauri API 用得对不对"，靠人审 + 对照官方模板/文档就能做到较高把握，不需要
   本机编译器来兜底。
2. **本机没有可信的编译验证手段，装系统库反而制造假信号**：按简报要求不装 GTK/webkit2gtk，那
   `cargo check` 在这台机器上永远过不了；如果为了"绿一次"去装系统库，验证的是 Linux 后端
   （GTK/WebKitGTK）的编译可行性，而交付目标是 macOS 后端（WKWebView），两条链路的 `*-sys` crate
   完全不同——Linux 上装库通过了，不代表 macOS 上就一定通过，反而会给团队一个"已经验证过"的
   错觉，这比"明确知道没验证"更危险。
3. **"拿到 Mac 当天就能出 `.app`"这个目标，卡点不在"源码是否已经跑通编译"，而在"源码是否已经
   写完、逻辑是否已经过审"**：签名公证流程本身的 lead time（Apple 开发者账号、证书、
   notarization 排队）才是这次提前做的真正原因；`cargo build` 在 Mac 上跑起来通常是分钟级的
   事，源码本身如果已经写完并经过人工审查，拿到 Mac 后"写代码"这一步已经不存在，只剩"跑一次
   构建 + 走一次签名公证流程"，时间线不会因为本机没编译过而被拉长。
4. **如果连源码都推迟到拿到 Mac 才写，反而会把"抢 lead time"这个目的落空**：本任务存在的
   唯一理由就是提前把能提前做的事做掉，源码编写、`tauri.conf.json` 配置、图标/权限清单这些跟
   Linux/macOS 差异无关的工作，没有理由等到拿到 Mac 才开始——真正该等 Mac 的只是"编译验证 +
   签名公证"这两步，而不是"写代码"这一步。

一句话：**源码写全、走 code review，但不在这台机器上寻求 `cargo check` 通过；`src-tauri` 的
"构建绿灯"这件事本身就应该、也只能等 Mac 到手当天完成。**
