#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

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
