#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== fmt =="
cargo fmt --all -- --check

echo "== 前端构建与类型检查 =="
# ci.sh 不只是「在 CI 上跑」的脚本——00 号设计文档第六节把它定成本地可跑
# 的入口，理由是 daemon 要交付到客户机器上，出问题时要能在那台机器上直接
# 跑同一份脚本，而不是只在 CI 上是好的。客户机器上跑的是编译好的 Rust
# daemon 二进制，不代表装了前端开发工具链（node/pnpm）。
#
# 如果这里没装 node/pnpm 就直接 exit 1，客户机器上原本能跑、也最需要跑
# 的那七段 Rust 自查（fmt/clippy/test/CI-1/CI-4/CI-2+CI-8/CI-3）会被一起
# 拖垮——这违背了「同一份脚本能在客户机器上直接跑」这条初衷。所以这里
# 选择：没装 node/pnpm 时跳过本段，但把跳过打印得足够醒目、不会被当成
# 「通过」——这个项目已经吃过好几次「一条检查其实什么都没测、但看起来
# 是绿的」的亏（比如后面 CI-4 那条关于 workspace 写法的注释），跳过必须
# 跟静默通过划清界限。
if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  missing=""
  command -v node >/dev/null 2>&1 || missing="${missing} node"
  command -v pnpm >/dev/null 2>&1 || missing="${missing} pnpm"
  echo "############################################################"
  echo "## SKIPPED -- 前端构建/类型检查/测试本次未执行"
  echo "## 缺少工具:${missing}"
  echo "## 这不是「通过」，是「跳过」。要验证前端，请安装上述工具后重跑。"
  echo "############################################################"
else
  (
    cd apps/ui
    pnpm install --frozen-lockfile
    pnpm build
    pnpm exec tsc -b --noEmit
    pnpm test
  )
  echo "ok"
fi

echo "== clippy =="
cargo clippy --workspace --all-targets -- -D warnings

echo "== test =="
cargo test --workspace

echo "== CI-1 内核依赖隔离 =="
tree=$(cargo tree -p evo-kernel --edges normal --prefix none)
for forbidden in chrono time rand getrandom uuid tokio reqwest; do
  if echo "$tree" | grep -qE "^${forbidden} v"; then
    echo "FAIL: evo-kernel 依赖了 $forbidden"; exit 1
  fi
done
echo "ok"

echo "== CI-4 客户名词隔离 =="
# u8 不能直接 grep——它是 Rust 的基本类型，全仓都是。
# 00 §4 检查 4 的这一项要在阶段 3 换成对标识符边界的匹配。此处先只查另外两个词。
if grep -riE 'yonyou|用友' crates/ apps/ 2>/dev/null; then
  echo "FAIL: crates/ apps/ 里出现客户专有名词"; exit 1
fi
echo "ok"

echo "== CI-9 外壳不渗进业务代码 =="
# 外壳 API 的命中必须全部落在 apps/ui/src/platform/ 内。
# UI 里到处 invoke，就是「内核在 UI 进程里」这条红线的前置形态。
#
# 匹配整个 `@tauri-apps/` 家族，不是只匹配 `@tauri-apps/api`——
# Tauri 2 把能力拆进了 `@tauri-apps/plugin-*`（dialog / fs / notification /
# opener / process / autostart …），**没有一个包含 `api` 子串**。只匹配
# `/api` 的话，业务组件里 `import { open } from '@tauri-apps/plugin-dialog'`
# 会畅通无阻——那正是这条检查要挡的东西。
offenders=$(grep -rlE '@tauri-apps/|ipcRenderer' apps/ui/src/ 2>/dev/null \
            | grep -v '^apps/ui/src/platform/' || true)
if [ -n "$offenders" ]; then
  echo "FAIL: platform/ 之外出现了外壳 API：$offenders"; exit 1
fi
echo "ok"

echo "== CI-2 回放自校验 + CI-8 快照可丢弃 =="
./eval/run.sh
echo "ok"

echo "== CI-3 治理旁路 =="
# evo-exec* / evo-mcp / evo-runlog 只允许被组装点依赖：唯一的组装点是
# evo-daemon（运行时组装 Runtime；mkcase 要用的离线组装入口
# evo_daemon::casegen 也在这里，见 Task 19）。evo-exec-local 依赖 evo-exec
# 是允许的——它就是 exec 的实现。evo-runlog 是「唯一写 Run Log 的进程」
# 手里的类型，只有 evo-daemon 允许依赖它——evo-cli 曾经直接依赖它、
# 它的测试还真的调了 RunLog::append（与之前修掉的 mkcase 是同一类问题，
# 见该 crate Cargo.toml 的历史），现在改成经 evo_daemon 暴露的入口访问。
#
# 本仓的 Cargo.toml 里点号写法（`name.workspace = true`）与花括号写法
# （`name = { workspace = true }`）混用，甚至同一个文件里都两种都有——
# 只匹配其中一种，检查会在另一种写法下悄悄漏判，变成一条摆设。
for c in evo-exec evo-exec-local evo-mcp evo-runlog; do
  offenders=$(grep -rlE "^${c}\.workspace[[:space:]]*=[[:space:]]*true|^${c}[[:space:]]*=.*workspace[[:space:]]*=[[:space:]]*true" crates/*/Cargo.toml \
              | grep -v "crates/evo-daemon/Cargo.toml" \
              | grep -v "crates/${c}/Cargo.toml" \
              | grep -v "crates/evo-exec-local/Cargo.toml" || true)
  if [ -n "$offenders" ]; then
    echo "FAIL: $c 被组装点之外的 crate 依赖：$offenders"; exit 1
  fi
done
echo "ok"
