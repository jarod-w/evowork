#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== CI-10 构建产物/依赖目录未被跟踪 =="
# CI-9 在 m1-desktop-shell 分支上已被「外壳不渗进业务代码」检查
# （断言 @tauri-apps/ 家族的 import 只出现在 apps/ui/src/platform/）占用，
# 所以本分支的这条检查从编号 10 起。
#
# 事故背景：m1-desktop-shell 分支下 apps/ui/ 在本分支（m2-governance）是
# 未跟踪目录，管它的 apps/ui/.gitignore 也只在那条分支上被跟踪、这边看
# 不到，于是一次提交计划文档时用了 git add -A，把 node_modules 和
# apps/ui/src-tauri/target/debug/deps/*.d 这类构建产物整包收了进去
# （3781 个文件、150 万行）。已用 git filter-branch 清理，这里补一条检查
# 让同类事故当场暴露。
#
# 要查的是「有没有被 git 跟踪」，不是「磁盘上存不存在」——磁盘上有
# node_modules 完全正常（apps/ui 在别的分支上就有）。必须用
# git ls-files，绝不能用 find/ls 之类的文件系统遍历，否则会把别的分支
# 遗留、根本没被 git 跟踪的目录也当成命中。
#
# 匹配要精确到路径分量：用 (^|/)name(/|$)，不是子串匹配，防止误伤例如
# 恰好叫 target-something 的 crate 目录，或文档里恰好叫 dist 的路径。
# 除了要求的 node_modules/target/dist/.pnpm，再加两个 Rust 侧的构建
# 产物后缀：*.rlib（编译出的 Rust 静态库，正常只应出现在 target/ 下，
# 但既然要防的是「不该被跟踪的东西」，独立按后缀再挡一层不吃亏）、
# *.rs.bk（rustfmt 失败时留的源码备份文件，同样不该进版本库）。
tracked_offenders=$(git ls-files | grep -E '(^|/)(node_modules|target|dist|\.pnpm)(/|$)|\.rlib$|\.rs\.bk$' || true)
if [ -n "$tracked_offenders" ]; then
  offender_count=$(echo "$tracked_offenders" | wc -l | tr -d ' ')
  echo "FAIL: 有 ${offender_count} 个构建产物/依赖目录文件被 git 跟踪，前 20 条："
  echo "$tracked_offenders" | head -20
  echo "修复：git rm -r --cached <path>，确认 .gitignore 覆盖了它，再提交。"
  exit 1
fi
echo "ok"

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
# evo-exec* / evo-mcp / evo-runlog 只允许被组装点依赖：唯一的组装点是
# evo-daemon（运行时组装 Runtime；mkcase 要用的离线组装入口
# evo_daemon::casegen 也在这里，见 Task 19）。evo-runlog 是「唯一写 Run Log
# 的进程」手里的类型，只有 evo-daemon 允许依赖它——evo-cli 曾经直接依赖
# 它、它的测试还真的调了 RunLog::append（与之前修掉的 mkcase 是同一类
# 问题，见该 crate Cargo.toml 的历史），现在改成经 evo_daemon 暴露的入口
# 访问。
#
# 唯一的例外是 evo-exec-local 依赖 evo-exec——它就是 exec 的实现。这条
# 例外**只对 evo-exec 成立**：以前它写成无条件的
# `grep -v "crates/evo-exec-local/Cargo.toml"`，却放在遍历四个受管 crate 的
# 循环体里，等于把 evo-exec-local 从四条检查里全免了。实测：给
# crates/evo-exec-local/Cargo.toml 加上 evo-runlog 依赖、并在 lib.rs 里真的
# 调 RunLog::open 去读 Run Log，本检查照样打印 ok——执行器绕开组装点直接
# 读写 Run Log，正是这条检查存在的理由，却恰恰是它唯一免检的对象。
#
# 「怎么写出一条依赖」必须穷举。只认其中几种写法，检查会在别的写法下悄悄
# 漏判，变成一条摆设——本仓的 Cargo.toml 里点号写法（`name.workspace = true`）
# 与花括号写法（`name = { workspace = true }`）本来就混用，同一个文件里两种
# 都有。而 TOML 允许的写法比这两种多得多：键可以加引号，点号键可以摊平写在
# 顶层，表头里可以到处塞空白，依赖还可以改名。下面四条正则合起来覆盖：
#   1. 行首键：`name = ...`、`name.xxx = ...`，键上可带 TOML 引号
#      （`"name" = ...`）。吃掉 `{ workspace = true }`、
#      `{ path = "../evo-runlog" }`、`"0.1"` 这类版本号字符串等全部行内写法；
#   2. 作为点号键中间一段出现：`[dependencies.name]`、`[dev-dependencies.name]`、
#      `[target.'cfg(unix)'.dependencies.name]` 这些表头，以及摊平写在顶层的
#      `dependencies.name.workspace = true` / `dependencies.name = { ... }`。
#      判据是「前面有个点、后面跟着 . = 或 ]」，所以点号两侧的空白和键上的
#      引号都不影响；
#   3. 改名依赖：`别名 = { package = "name", ... }`——行首是别名，前两条都
#      看不见它，必须直接认 `package = "name"`，且它通常写在花括号里而不在
#      行首，所以左边界只能是行首/空白/逗号/左花括号；
#   4. 指向该 crate 目录的 path：`... path = "../evo-runlog"`——改名依赖的
#      另一半，也兜住把 crate vendor 到别处再依赖的写法。
# 右边界分别是 `[.=]`、`[]=.]` 和收尾的引号，所以查 evo-exec 时不会误伤
# evo-exec-local（`evo-exec-local` 的下一个字符是 `-`，`"../evo-exec-local"`
# 的引号前也不是 `evo-exec`）。
#
# 扫描面同理：原来只 glob 了 crates/*/Cargo.toml 一层，crates/ 二层下的
# crate、以及 crates/ 之外（apps/ 等）的 crate 全部漏网。改成枚举整个仓库
# 里被 git 认得的 Cargo.toml——已跟踪的加上「未跟踪且没被 .gitignore 排除
# 的」，后者让还没 git add 的新 crate 也当场被查，前者让 target/ 里的东西
# 不进来。只排掉根 workspace 清单：它的 [workspace.dependencies] 按定义就
# 列着所有 path 依赖，那不是依赖边。
#
# 归属按清单里的 package name 判断，不按路径——crate 挪了目录，检查不会
# 跟着失效。name 只从 [package] 表里取：TOML 的表可以任意顺序，`[[bin]]`
# 底下也有个 name 键，不限定表就能靠「把 [[bin]] 的 name 写成 evo-daemon 并
# 放在 [package] 前面」骗到组装点的豁免。取不到 name 时 owner 为空，等于
# 什么都不豁免——宁可误报也不漏报。
offenders=""
for manifest in $(git ls-files --cached --others --exclude-standard -- '*Cargo.toml' | grep -v '^Cargo\.toml$'); do
  owner=$(awk '
    /^[[:space:]]*\[/ { inpkg = ($0 ~ /^[[:space:]]*\[[[:space:]]*package[[:space:]]*\][[:space:]]*$/); next }
    inpkg && /^[[:space:]]*("name"|name)[[:space:]]*=/ {
      if (match($0, /=[[:space:]]*"[^"]*"/)) {
        v = substr($0, RSTART, RLENGTH); sub(/^=[[:space:]]*"/, "", v); sub(/"$/, "", v)
        print v; exit
      }
    }' "$manifest")
  # 唯一的组装点，允许依赖全部受管 crate
  if [ "$owner" = "evo-daemon" ]; then continue; fi
  for c in evo-exec evo-exec-local evo-mcp evo-runlog; do
    # crate 自己的清单
    if [ "$owner" = "$c" ]; then continue; fi
    # 唯一的例外，且只对 evo-exec 成立
    if [ "$c" = "evo-exec" ] && [ "$owner" = "evo-exec-local" ]; then continue; fi
    if grep -qE "^[[:space:]]*[\"']?${c}[\"']?[[:space:]]*[.=]|\.[[:space:]]*[\"']?${c}[\"']?[[:space:]]*[]=.]|(^|[[:space:],{])package[[:space:]]*=[[:space:]]*[\"']${c}[\"']|path[[:space:]]*=[[:space:]]*[\"'][^\"']*${c}[\"']" "$manifest"; then
      offenders="${offenders}  ${manifest}（package ${owner:-?}）依赖了 ${c}
"
    fi
  done
done
if [ -n "$offenders" ]; then
  echo "FAIL: 组装点（evo-daemon）之外的 crate 依赖了受管 crate："
  printf '%s' "$offenders"
  exit 1
fi
echo "ok"
