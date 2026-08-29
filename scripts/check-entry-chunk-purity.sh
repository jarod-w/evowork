#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps/ui"

# 必修 1（final-review-fix）：产物纯净性此前完全没有守护。终审用一行
# 静态 `import { createDesktopPlatform } from './tauri'`（放在
# `platform/index.ts` 顶部）就能把 `getPlatform()` 改回同步调用，让
# Rollup 把整个 Tauri JS 绑定家族（`@tauri-apps/plugin-*`）打进浏览器
# 也会加载的入口 chunk——`pnpm build`、`tsc -b`、全部测试、CI-9 都测
# 不出来，因为那行 import 就在 CI-9 唯一豁免的 `platform/` 目录里。
#
# 这条检查直接盯着 `dist/` 里真正产出的字节：
#   1. 从 `dist/index.html` 解析出真实的入口 chunk 文件名（不硬编码
#      hash——每次 build 的 hash 都不同）。
#   2. 断言入口 chunk 里不含任何 `plugin:<名字>|` 形态的字符串——这是
#      Tauri IPC 的 invoke 命令名，压缩产物依然会完整保留这类字符串
#      字面量（不像 `@tauri-apps` 这个 npm scope，压缩后不留痕迹，见
#      下面「反例」）。
#   3. 断言 dist/assets 里存在另一个（非入口）chunk 确实带着这些
#      `plugin:xxx|` 字符串——证明 Tauri 代码被拆进了独立的、浏览器
#      构建不会主动加载的桌面 chunk，而不是「入口干净」只是因为
#      Tauri 代码根本没被打包。
#
# 为什么不用 `grep -c "tauri-apps" dist/assets/*.js`：这是本仓库第五个
# 「永远通过的检查」的死法——minifier 不保留 npm scope 字符串，这个
# grep 在有问题和没问题时都恒为 0。`plugin:xxx|` 是运行时 IPC 命令名，
# 是被 `invoke()` 调用时实际传递的字符串字面量，minifier 没有理由（也
# 不允许，因为字符串字面量的内容是可观察的运行时行为）改写它。

if [ ! -f dist/index.html ]; then
  echo "FAIL: dist/index.html 不存在——本检查必须在 pnpm build 之后运行"
  exit 1
fi

entry_src=$(grep -oE '<script[^>]*type="module"[^>]*src="[^"]+"' dist/index.html | head -1 | grep -oE 'src="[^"]+"' | sed -E 's/^src="//; s/"$//')
if [ -z "$entry_src" ]; then
  echo "FAIL: 无法从 dist/index.html 解析出入口 <script type=\"module\"> 的 src"
  exit 1
fi

entry_file="dist${entry_src}"
if [ ! -f "$entry_file" ]; then
  echo "FAIL: 从 dist/index.html 解析出的入口 chunk 不存在: $entry_file"
  exit 1
fi

PLUGIN_PATTERN='plugin:[A-Za-z_-]+\|'

if grep -qE "$PLUGIN_PATTERN" "$entry_file"; then
  echo "FAIL: 入口 chunk ($entry_file) 里出现了 Tauri plugin 调用字符串（$PLUGIN_PATTERN）——Tauri 代码泄漏进了每台手机都会下载的浏览器入口"
  exit 1
fi

desktop_chunk=""
for f in dist/assets/*.js; do
  [ "$f" = "$entry_file" ] && continue
  if grep -qE "$PLUGIN_PATTERN" "$f"; then
    desktop_chunk="$f"
    break
  fi
done

if [ -z "$desktop_chunk" ]; then
  echo "FAIL: dist/assets 里没有任何一个非入口 chunk 携带 Tauri plugin 调用字符串——独立的桌面 chunk 消失了（动态 import 没有被 Rollup 拆分出去，或者桌面代码整体丢了）"
  exit 1
fi

echo "ok (入口 chunk: $entry_src 干净；独立桌面 chunk: ${desktop_chunk#dist/})"
