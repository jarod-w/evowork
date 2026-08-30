#!/usr/bin/env bash
# 从 evo-protocol 的 Rust 类型生成 packages/protocol/generated/。
# 生成物进 git，CI-5（scripts/check-protocol-sync.sh）负责断言
# 「工作区里的生成物」与「此刻 Rust 类型再生成一遍」一字不差。
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-packages/protocol/generated}"
mkdir -p "$out"
cargo run -q -p evo-protocol --bin export-protocol -- "$out"
echo "ok: wrote $out"
