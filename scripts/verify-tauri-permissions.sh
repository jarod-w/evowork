#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# 建议 6（final-review-fix 交付说明第二条）：在这台 Linux 机器上，把
# capabilities/default.json 里 9 条权限标识符，对着 Cargo.lock 锁定版本
# 的 tauri-plugin-* crate 源码（permissions/**/*.toml）逐条核实一遍。这
# 件事此前只在 code review 里手工做过一次（见
# docs/superpowers/notes/2026-08-29-desktop-shell-status.md 未验清单第 4
# 条），现在做成可重复执行的脚本，把「手工核对过」缩小成「工具能验的部分
# 已验」。
#
# 这条检查证明的是「权限标识符对 Cargo.lock 锁定的这个版本的 plugin crate
# 是合法的」，不证明「Tauri 运行时接受这个标识符」——真正的运行时合法性
# 仍然只有真机 IPC 往返能验证（未验清单第 4 条剩下的部分，见交付说明）。

LOCKFILE="apps/ui/src-tauri/Cargo.lock"
CAPS="apps/ui/src-tauri/capabilities/default.json"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
REGISTRY_SRC="$CARGO_HOME_DIR/registry/src"

if [ ! -f "$LOCKFILE" ]; then
  echo "FAIL: $LOCKFILE 不存在，无法核对权限标识符对应的锁定版本"
  exit 1
fi
if [ ! -f "$CAPS" ]; then
  echo "FAIL: $CAPS 不存在"
  exit 1
fi
if [ ! -d "$REGISTRY_SRC" ]; then
  echo "FAIL: 本机没有 cargo registry 源码缓存 ($REGISTRY_SRC 不存在)——先跑一次任意 cargo 命令让依赖源码落到本地缓存"
  exit 1
fi

permissions=$(node -e "
const fs = require('fs')
const caps = JSON.parse(fs.readFileSync('$CAPS', 'utf8'))
for (const p of caps.permissions) console.log(p)
")

fail=0
while IFS= read -r perm; do
  [ -z "$perm" ] && continue
  prefix="${perm%%:*}"
  identifier="${perm#*:}"
  crate="tauri-plugin-${prefix}"

  version=$(awk -v name="$crate" '$0 ~ "name = \""name"\""{getline; print; exit}' "$LOCKFILE" | sed -E 's/version = "(.*)"/\1/')
  if [ -z "$version" ]; then
    echo "FAIL: $perm -- 在 $LOCKFILE 里找不到 crate $crate 的锁定版本"
    fail=1
    continue
  fi

  crate_dir=$(find "$REGISTRY_SRC" -maxdepth 2 -type d -name "${crate}-${version}" | head -1)
  if [ -z "$crate_dir" ] || [ ! -d "$crate_dir/permissions" ]; then
    echo "FAIL: $perm -- 本地 registry 缓存里没有 ${crate}-${version}/permissions（源码未下载到本机，先跑一次 cargo fetch）"
    fail=1
    continue
  fi

  if grep -rqE "identifier[[:space:]]*=[[:space:]]*\"${identifier}\"" "$crate_dir/permissions"; then
    echo "ok: $perm （对照 $crate $version 的 permissions/*.toml 核实存在）"
  else
    echo "FAIL: $perm -- $crate_dir/permissions 下没有任何 *.toml 声明 identifier \"${identifier}\""
    fail=1
  fi
done <<<"$permissions"

exit $fail
