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
# evo-exec* 与 evo-mcp 只允许被 evo-daemon（组装点）依赖
for c in evo-exec evo-exec-local evo-mcp; do
  offenders=$(grep -rl "^${c}\.workspace = true" crates/*/Cargo.toml \
              | grep -v "crates/evo-daemon/Cargo.toml" \
              | grep -v "crates/${c}/Cargo.toml" \
              | grep -v "crates/evo-exec-local/Cargo.toml" || true)
  if [ -n "$offenders" ]; then
    echo "FAIL: $c 被 evo-daemon 之外的 crate 依赖：$offenders"; exit 1
  fi
done
echo "ok"
