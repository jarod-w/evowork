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

echo "== fmt (src-tauri) =="
# apps/ui/src-tauri 用空 `[workspace]` 把自己隔离成独立 workspace 根（见
# 该 crate Cargo.toml 顶部注释），所以上面根目录的 `cargo fmt --all` 永远
# 到不了这个 crate——它默认只看仓库根这一个 workspace 的成员，
# apps/ui/src-tauri 不在里面。`cargo fmt --check` 不需要编译（不像
# `cargo check`/`cargo clippy`，不会碰到这台机器上装不了的 GTK 依赖链），
# 只是从没被接进 ci.sh，属于一条本来就免费、只是没人接的检查。
(
  cd apps/ui/src-tauri
  cargo fmt --all -- --check
)
echo "ok"

echo "== 前端构建与类型检查 =="
# ci.sh 不只是「在 CI 上跑」的脚本——00 号设计文档第六节把它定成本地可跑
# 的入口，理由是 daemon 要交付到客户机器上，出问题时要能在那台机器上直接
# 跑同一份脚本，而不是只在 CI 上是好的。客户机器上跑的是编译好的 Rust
# daemon 二进制，不代表装了前端开发工具链（node/pnpm）。
#
# 如果这里没装 node/pnpm 就直接 exit 1，客户机器上原本能跑、也最需要跑
# 的那七段 Rust 自查（fmt/clippy/test/CI-1/CI-4/CI-2+CI-8/CI-3）会被一起
# 拖垮——这违背了「同一份脚本能在客户机器上直接跑」这条初衷。所以这里
# 选择：没装 node/pnpm 时可以跳过本段，但跳过必须是显式、对自动化不静默
# 的——只看退出码的 CI（GitHub Actions / GitLab CI 的常规做法）不会去读
# 横幅，缺了 node 而退出码仍是 0，前端检查就会从此永久失效而 ci.sh 永远
# 绿。所以跳过必须由调用方显式设置 ALLOW_SKIP_FRONTEND=1 才成立；没设就
# 硬失败。这个项目已经吃过好几次「一条检查其实什么都没测、但看起来是
# 绿的」的亏（比如后面 CI-4 那条关于 workspace 写法的注释），跳过必须
# 跟静默通过划清界限。
#
# 注意：ALLOW_SKIP_FRONTEND 只在「工具缺失」时才有意义——工具齐备时会
# 直接进入 else 分支正常执行，不会去看这个变量。它不能变成一个能在工具
# 齐备的情况下也跳过前端检查的开关。
if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  missing=""
  command -v node >/dev/null 2>&1 || missing="${missing} node"
  command -v pnpm >/dev/null 2>&1 || missing="${missing} pnpm"
  if [ "${ALLOW_SKIP_FRONTEND:-}" = "1" ]; then
    echo "############################################################"
    echo "## SKIPPED -- 前端构建/类型检查/测试本次未执行"
    echo "## 缺少工具:${missing}"
    echo "## 这不是「通过」，是「跳过」——因为显式设置了 ALLOW_SKIP_FRONTEND=1 才允许跳过。"
    echo "## 要验证前端，请安装上述工具后重跑（不设该变量）。"
    echo "############################################################"
  else
    echo "FAIL: 缺少前端工具链，无法执行前端构建/类型检查/测试:${missing}"
    echo "如果这是交付到客户机器上的环境、本来就不该有前端工具链，"
    echo "请设置 ALLOW_SKIP_FRONTEND=1 后重跑以显式跳过本段。"
    exit 1
  fi
else
  (
    cd apps/ui
    pnpm install --frozen-lockfile
    pnpm build
    pnpm exec tsc -b --noEmit
    pnpm lint
    pnpm test
  )
  echo "ok"

  echo "== 产物纯净性：浏览器入口 chunk 不得渗入 Tauri 代码 =="
  # 独立脚本，不是内联在这里——见 scripts/check-entry-chunk-purity.sh
  # 顶部注释：它依赖上面 `pnpm build` 刚产出的 dist/，放进单独脚本是
  # 为了能在开发时脱离整条 ci.sh 单独重跑（比如改完 platform/ 之后想
  # 先只验这一条，不必等 clippy/cargo test 跑完）。
  ./scripts/check-entry-chunk-purity.sh
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
#
# 排除 node_modules/ 与 dist/：两者都在 apps/ui/.gitignore 里，是第三方
# 依赖代码和构建产物，根本不是「我们的代码」，grep 不感知 .gitignore 也
# 不会自动跳过它们（review 用 canary 文件实测确认过会被扫进去）。这条
# 检查要测的是「我们有没有把客户名字写进自己的代码」，不是「某个依赖包
# 的文档/测试夹具/贡献者名字里有没有偶然出现这两个字」——不排除的话，
# 未来任何一次 pnpm install 引入的新依赖都可能让 CI-4 因为跟代码泄漏
# 无关的原因变红。pnpm-lock.yaml 不在排除之列：它是已提交、进 code review
# 的文件，理应保持在扫描范围内。
#
# 同样排除 target/：这不在任何 .gitignore 顶层规则里统一处理，是
# apps/ui/src-tauri/.gitignore 单独声明的一条（因为 src-tauri 用空
# `[workspace]` 把自己隔离成独立 workspace 根，根 .gitignore 的
# `/target` 只挡得住仓库根的 target，挡不住 src-tauri 自己的）。第一次
# 在 Mac 上 `cargo build` 就会在 apps/ui/src-tauri/target/ 下生成几个 GB
# 的构建产物——同 node_modules/dist 一样，是第三方/生成物，不是「我们的
# 代码」，不排除的话 CI-4 会去扫几个 GB 的编译中间产物，纯粹浪费时间还
# 可能因为依赖 crate 的构建脚本/文档里偶然出现这两个词而被误伤。
if grep -riE --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=target 'yonyou|用友' crates/ apps/ 2>/dev/null; then
  echo "FAIL: crates/ apps/ 里出现客户专有名词"; exit 1
fi
echo "ok"

echo "== CI-5 协议同步 =="
./scripts/check-protocol-sync.sh
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
#
# 也匹配 `__TAURI` 前缀（不是精确匹配 `__TAURI__`）：Tauri 2 注入
# `window.__TAURI_INTERNALS__` 用于底层 IPC（`invoke()` 内部走的就是它），
# `app.withGlobalTauri` 配置项打开后还会额外注入 `window.__TAURI__`。
# 之前只精确匹配字面量 `__TAURI__`，注释还专门论证过它不是
# `__TAURI_INTERNALS__` 的子串——但这个论证本身没有换来任何东西：
# platform/ 本来就在下面被排除了，精确匹配唯一的效果是漏掉了业务代码里
# 直接写 `window.__TAURI_INTERNALS__.invoke('plugin:dialog|open', ...)`
# 这条最直接的绕过路径（完全不含任何 import 语句，`@tauri-apps/` 那半条
# 匹配不到）。放宽成前缀匹配后，platform/index.ts 里合法的
# `'__TAURI_INTERNALS__' in window` 探测不会被误伤——因为它就在下面被
# 排除的 platform/ 目录里，不是因为字符串本身不匹配（已实测验证过，见
# final-review-fix 报告）。
# 目标目录必须先存在，且失败要响亮：`grep ... apps/ui/src/ | grep -v ...`
# 这条流水线的退出码由最后一个 grep 决定，如果 apps/ui/src/ 被改名/移动
# 导致第一个 grep 报「No such file or directory」且不产出任何一行，
# 第二个 grep 面对空输入同样会以「无匹配」退出（码 1），被后面的
# `|| true` 一并吞掉——整条检查会在目标目录消失时静默变成空操作，永远
# 打印 "ok"（终审用 `mv apps/ui/src apps/ui/app` 实测过）。CI-4 用
# `crates/ apps/` 这种更宽的扫描面扛住了同一类目录搬迁，这里改成扫描
# 前显式校验目录存在、不存在就直接响亮失败，而不是依赖扫描范围本身
# 够宽。
if [ ! -d apps/ui/src ]; then
  echo "FAIL: apps/ui/src 目录不存在——CI-9 的扫描目标是硬编码路径，目录被改名/移动后必须先更新这条检查，而不是让它静默通过"
  exit 1
fi
offenders=$(grep -rlE '@tauri-apps/|ipcRenderer|__TAURI' apps/ui/src/ \
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
