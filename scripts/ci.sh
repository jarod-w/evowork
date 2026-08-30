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
