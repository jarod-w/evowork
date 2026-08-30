#!/usr/bin/env bash
# CI-5 协议同步：ts-rs 生成结果必须与 packages/protocol/generated 已提交
# 内容一致（设计文档 00 §4 检查 5）。
#
# 本检查必须能失败。不要用「看一眼生成物在不在」这种永远绿的写法——
# 那正是本仓反复踩过的坑。这里的判据是：把当前 Rust 类型重新生成到临时
# 目录，与已提交的 generated/ 做 diff。Rust 侧改了类型却没重跑
# ./scripts/gen-protocol.sh，或者有人手改了 generated/，都会红。
#
# 反例（必须实测会 FAIL，见本文件底部「留证」）：
#   1. 在 packages/protocol/generated/HelloFrame.ts 末尾加一行注释
#      → diff 非空 → FAIL
#   2. 给 HelloFrame 加一个 Rust 字段、不重跑 gen-protocol.sh
#      → 新生成物多一个字段 → FAIL
# 修法：./scripts/gen-protocol.sh 后把 generated/ 一并提交。
#
# 留证（2026-08-30，本机实测）：
#
# 1) 生成物与 Rust 一致 → ok
#    $ ./scripts/check-protocol-sync.sh
#    wrote TypeScript bindings to /tmp/tmp.TTdNTQa6Dd
#    ok
#
# 2) 在 HelloFrame.ts 末尾加一行 `// canary-should-fail` → FAIL
#    diff -ru packages/protocol/generated/HelloFrame.ts <tmp>/HelloFrame.ts
#    --- packages/protocol/generated/HelloFrame.ts
#    +++ <tmp>/HelloFrame.ts
#    @@ -5,4 +5,3 @@
#     export type HelloFrame = { op: HelloOp, protocol_ver: string, daemon_ver: string, runlog_schema_ver: number, };
#    -// canary-should-fail
#    FAIL: packages/protocol/generated 与当前 Rust 类型生成的结果不一致。
#
# 3) ./scripts/gen-protocol.sh 恢复后 → ok
#
# 缺 packages/protocol/generated 目录本身也会 FAIL（脚本开头的存在性检查）。
set -euo pipefail
cd "$(dirname "$0")/.."

committed="packages/protocol/generated"
if [ ! -d "$committed" ]; then
  echo "FAIL: $committed 不存在——协议生成物尚未提交。先跑 ./scripts/gen-protocol.sh 并把产物加进 git。"
  exit 1
fi
if [ ! -f "$committed/index.ts" ]; then
  echo "FAIL: $committed/index.ts 不存在——生成物不完整。"
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# 同一个 bin、同一份代码，写到临时目录。
cargo run -q -p evo-protocol --bin export-protocol -- "$tmp"

if ! diff -ru --strip-trailing-cr "$committed" "$tmp"; then
  echo "FAIL: packages/protocol/generated 与当前 Rust 类型生成的结果不一致。"
  echo "修复：./scripts/gen-protocol.sh 后提交 packages/protocol/generated/"
  exit 1
fi
echo "ok"
