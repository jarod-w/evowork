#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== fmt =="
cargo fmt --all -- --check

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
if grep -riE 'yonyou|用友' crates/ 2>/dev/null; then
  echo "FAIL: crates/ 里出现客户专有名词"; exit 1
fi
echo "ok"

echo "== CI-2 回放自校验 + CI-8 快照可丢弃 =="
./eval/run.sh
echo "ok"

echo "== CI-3 治理旁路 =="
# evo-exec* 与 evo-mcp 只允许被组装点依赖：唯一的组装点是 evo-daemon
# （运行时组装 Runtime；mkcase 要用的离线组装入口 evo_daemon::casegen
# 也在这里，见 Task 19）。evo-exec-local 依赖 evo-exec 是允许的——
# 它就是 exec 的实现。
#
# 本仓的 Cargo.toml 里点号写法（`name.workspace = true`）与花括号写法
# （`name = { workspace = true }`）混用，甚至同一个文件里都两种都有——
# 只匹配其中一种，检查会在另一种写法下悄悄漏判，变成一条摆设。
for c in evo-exec evo-exec-local evo-mcp; do
  offenders=$(grep -rlE "^${c}\.workspace[[:space:]]*=[[:space:]]*true|^${c}[[:space:]]*=.*workspace[[:space:]]*=[[:space:]]*true" crates/*/Cargo.toml \
              | grep -v "crates/evo-daemon/Cargo.toml" \
              | grep -v "crates/${c}/Cargo.toml" \
              | grep -v "crates/evo-exec-local/Cargo.toml" || true)
  if [ -n "$offenders" ]; then
    echo "FAIL: $c 被组装点之外的 crate 依赖：$offenders"; exit 1
  fi
done
echo "ok"
