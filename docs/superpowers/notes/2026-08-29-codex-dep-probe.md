# codex 依赖可行性实测（Linux + rustc 1.95）

> 对应 M1 阶段 0 · Task 0。目的：在写任何业务代码之前，验证 `codex-network-proxy` /
> `codex-execpolicy` 能否在这台 Linux 开发机上编译，为阶段 2 出口代理的形态决策提供依据。

## 环境

- `rustc 1.95.0 (59807616e 2026-04-14)` / `cargo 1.95.0 (f2d3ce0bd 2026-03-21)`，`$HOME/.cargo/bin`
- 平台：Linux（`uname`：6.8.0-101-generic，x86_64）
- 探针 crate：`/tmp/dep-probe`（临时，不进版本库）
- pin 的 rev：`c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3`（与 08 §1 一致，`openai/codex` 仓库通过网络直接拉取，未使用本地 checkout `/root/develop/evowork/codex`，该本地 checkout 仅用于跑 `codex-closure.py`）

## Step 1：探针 crate

```toml
[package]
name = "dep-probe"
version = "0.0.0"
edition = "2024"

[dependencies]
codex-network-proxy = { git = "https://github.com/openai/codex.git", rev = "c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3" }
codex-execpolicy    = { git = "https://github.com/openai/codex.git", rev = "c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3" }
```

`src/main.rs`: `fn main() {}`

## Step 2：`cargo build`

```
cd /tmp/dep-probe && cargo build
```

**结果：编译通过。** 无警告、无版本冲突、无平台门控失败、无缺失系统库。

耗时：`5m6.564s`（`user 6m48.317s`，`sys 0m55.314s`，首次全量下载 + 编译，无缓存）。

尾部输出：

```
   Compiling codex-utils-rustls-provider v0.0.0 (https://github.com/openai/codex.git?rev=c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3#c6bf330b)
   Compiling tempfile v3.27.0
   Compiling multimap v0.10.1
   Compiling shlex v1.3.0
   Compiling codex-network-proxy v0.0.0 (https://github.com/openai/codex.git?rev=c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3#c6bf330b)
   Compiling codex-execpolicy v0.0.0 (https://github.com/openai/codex.git?rev=c6bf330b42ed6fcbdcc902dc06ef38306b2e02f3#c6bf330b)
   Compiling dep-probe v0.0.0 (/tmp/dep-probe)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 5m 03s
```

### 产出规模

- `Cargo.lock` 总计 **429** 个 package（`grep -c '^name = ' Cargo.lock`）。
- 全部 `rama-*` crate（`rama-core` / `rama-dns` / `rama-error` / `rama-http` / `rama-http-backend` /
  `rama-http-core` / `rama-http-headers` / `rama-http-types` / `rama-macros` / `rama-net` /
  `rama-socks5` / `rama-tcp` / `rama-tls-rustls` / `rama-udp` / `rama-unix` / `rama-utils`，共 16 个）
  锁定的版本**全部**是 `0.3.0-alpha.4`，与 08 §1「`codex-network-proxy` 用 `=0.3.0-alpha.4` 精确锁定整套
  `rama-*`」的说法一致——没有出现版本分裂或需要 `cargo update` 强制对齐的情况。
- 未观察到与本机已装库（openssl/libc 等）相关的系统库缺失错误；`rustls-native-certs` /
  `openssl-probe` 等 crate 正常编译通过，说明该 rev 在这台机器上对 TLS/证书这条链路没有额外的系统依赖门槛。

## Step 3：闭包基线

```
python3 /root/develop/evowork/evowork/scripts/codex-closure.py \
  /root/develop/evowork/codex/codex-rs codex-network-proxy codex-execpolicy
```

输出：

```
codex-network-proxy        closure= 3  core=no  otel=no
    codex-utils-absolute-path, codex-utils-home-dir, codex-utils-rustls-provider
codex-execpolicy           closure= 1  core=no  otel=no
    codex-utils-absolute-path
```

**与 08 §1 的表完全一致**：`codex-network-proxy` 闭包 3、`codex-execpolicy` 闭包 1，均不含
`codex-core`、不含 `codex-otel`。说明本地 checkout（HEAD 为 `0ae94fdd`，但 pin 的
`c6bf330b` 在其历史中确实存在）用的 rev 是对的，闭包统计结果可信。

## Step 4：结论

① **`cargo build` 是否通过**：**通过**。在 Linux + rustc 1.95.0 上，`codex-network-proxy` 与
`codex-execpolicy` 均能干净编译，无需修改任何上游代码、放宽版本约束或更换 rev。

② **闭包数字是否与 08 §1 一致**：**一致**。`codex-network-proxy` = 3，`codex-execpolicy` = 1，
且均不含 core/otel，与 08 §1 实测结论表逐条吻合。

③ **如果不通过，阶段 2 的出口代理改走哪条路**：不适用，编译通过。阶段 2 的出口代理可以按 08
文档既定方案，直接以 git rev 依赖 `codex-network-proxy`（`=0.3.0-alpha.4` 精确锁定 `rama-*`），
不需要自写最小 forward proxy，也不需要更换实现或升级 rev。

## 对后续阶段的判断

- 阶段 2 出口代理的形态按 08 §1 既定方案推进即可：直接 git rev 依赖 `codex-network-proxy` +
  `codex-execpolicy`，不必自研或换实现。
- `Cargo.lock` 429 个 package 属于「一次性下载编译成本」，后续增量编译不会重复付出（cargo 有
  registry/git 缓存）；仍需在 evowork 自己的 workspace 里把 `Cargo.lock` 提交进版本库（08 §2
  约束 2），保证构建可复现。
- 本次探针只验证了「能否编译」，未验证运行时行为（是否真的不漏出口、`rama-socks5` /
  `rama-http-backend` 等在客户机器上的实际网络行为）。这部分仍要在阶段 2 用回放自校验去验证，
  编译通过不等于行为正确。
- 未做的事：没有验证 macOS 平台编译（08 §3 提到的 `codex-sandboxing` 决策与本任务无关，
  本任务只覆盖 `codex-network-proxy` / `codex-execpolicy` 这两个 crate 在 Linux 上的可行性）。
