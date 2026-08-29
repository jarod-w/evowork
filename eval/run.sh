#!/usr/bin/env bash
# 一条命令跑全集。阶段 1 只有一条合成用例，跑的是回放自校验。
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build -p evo-cli --bins

for case_dir in eval/cases/*/; do
  echo "== 生成 ${case_dir} =="
  ./target/debug/mkcase "$case_dir"
done

# evo-cli 对「Log 里没有 checkpoint」会打印 VACUOUS 并以非 0 退出——
# 一条什么都没验到的用例不该让 CI 变绿。
echo "== 回放自校验（带快照）=="
./target/debug/evo-cli replay --verify eval/cases/*/runlog.sqlite

echo "== 回放自校验（删光快照）=="
./target/debug/evo-cli replay --verify --drop-snapshots eval/cases/*/runlog.sqlite

echo "全部通过"
