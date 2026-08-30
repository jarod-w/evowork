#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# 建议 6（final-review-fix 交付说明第二条）：`tauri.conf.json5` 能否反
# 序列化成 `tauri_utils::config::Config`，以及窗口 label 是否与
# `capabilities/default.json` 的 "windows" 数组匹配，此前被记在「未验
# 清单」里当作「本机结构性做不到」的一项——但 `tauri-utils` 是纯 Rust、
# 不拉 GTK/WebKitGTK，在这台 Linux 机器上能编译。这个脚本把这件事做成
# 可重复执行的检查：临时生成一个只依赖 `tauri-utils`（版本钉死为
# apps/ui/src-tauri/Cargo.lock 里锁定的那个）的独立 Cargo 项目，不接入
# 仓库任何 workspace，用完即删。
#
# 这条检查证明的是「配置文件语法正确、窗口 label 对得上」，不证明
# `src-tauri` 整个 crate（依赖了会拉 GTK 的 `tauri`/`wry`/`tao`）能编译
# ——那一条仍然是未验清单里唯一没法在这台机器上做的部分（见交付说明）。

SRC_TAURI="apps/ui/src-tauri"
LOCKFILE="$SRC_TAURI/Cargo.lock"
CONF="$SRC_TAURI/tauri.conf.json5"
CAPS="$SRC_TAURI/capabilities/default.json"

for f in "$LOCKFILE" "$CONF" "$CAPS"; do
  if [ ! -f "$f" ]; then
    echo "FAIL: $f 不存在"
    exit 1
  fi
done

TAURI_UTILS_VERSION=$(awk '/name = "tauri-utils"/{getline; print; exit}' "$LOCKFILE" | sed -E 's/version = "(.*)"/\1/')
if [ -z "$TAURI_UTILS_VERSION" ]; then
  echo "FAIL: 在 $LOCKFILE 里找不到 tauri-utils 的锁定版本"
  exit 1
fi

conf_abs="$(pwd)/$CONF"
caps_abs="$(pwd)/$CAPS"

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

mkdir -p "$workdir/src"

# 独立的空 [workspace]：不让这个临时项目被误认成仓库里任何一个 workspace
# 的成员（同一个手法 apps/ui/src-tauri/Cargo.toml 也用来隔离 GTK 依赖链，
# 见该文件顶部注释）。
cat >"$workdir/Cargo.toml" <<EOF
[workspace]

[package]
name = "verify-tauri-config"
version = "0.0.0"
edition = "2021"
publish = false

[dependencies]
tauri-utils = { version = "=${TAURI_UTILS_VERSION}", features = ["config-json5"] }
serde_json = "1"
EOF

cat >"$workdir/src/main.rs" <<'EOF'
use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = env::args().skip(1);
    let conf_path = PathBuf::from(
        args.next()
            .expect("usage: verify-tauri-config <tauri.conf.json5> <capabilities/default.json>"),
    );
    let caps_path = PathBuf::from(
        args.next()
            .expect("usage: verify-tauri-config <tauri.conf.json5> <capabilities/default.json>"),
    );

    let raw = fs::read_to_string(&conf_path).unwrap_or_else(|e| panic!("reading {:?}: {}", conf_path, e));
    let config = match tauri_utils::config::parse::parse_json5(&raw, &conf_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!(
                "FAIL: {:?} did not deserialize into tauri_utils::config::Config: {}",
                conf_path, e
            );
            return ExitCode::FAILURE;
        }
    };
    println!("ok: {:?} deserializes into tauri_utils::config::Config", conf_path);

    let config_labels: Vec<String> = config.app.windows.iter().map(|w| w.label.clone()).collect();

    let caps_raw = fs::read_to_string(&caps_path).unwrap_or_else(|e| panic!("reading {:?}: {}", caps_path, e));
    let caps: serde_json::Value =
        serde_json::from_str(&caps_raw).unwrap_or_else(|e| panic!("parsing {:?}: {}", caps_path, e));
    let caps_windows: Vec<String> = caps["windows"]
        .as_array()
        .unwrap_or_else(|| panic!("{:?} has no \"windows\" array", caps_path))
        .iter()
        .map(|v| v.as_str().expect("windows[] entries must be strings").to_string())
        .collect();

    if config_labels.is_empty() {
        eprintln!("FAIL: {:?} declares no app.windows entries", conf_path);
        return ExitCode::FAILURE;
    }

    let mut mismatched = false;
    for label in &caps_windows {
        if !config_labels.contains(label) {
            eprintln!(
                "FAIL: capabilities window label \"{}\" (from {:?}) has no matching app.windows[].label in \
                 {:?} (found: {:?}) -- a label mismatch means every one of this capability file's grants \
                 would be silently unreachable on a real machine",
                label, caps_path, conf_path, config_labels
            );
            mismatched = true;
        }
    }

    if mismatched {
        return ExitCode::FAILURE;
    }

    println!(
        "ok: capabilities window label(s) {:?} all match a window label declared in {:?} ({:?})",
        caps_windows, conf_path, config_labels
    );
    ExitCode::SUCCESS
}
EOF

echo "== 验证 tauri.conf.json5 <-> tauri_utils::config::Config <-> capabilities/default.json 窗口 label (tauri-utils ${TAURI_UTILS_VERSION}，纯 Rust) =="
(
  cd "$workdir"
  # 先只编译（不跑），把「本地 registry 缓存不够、需要联网」这类问题
  # 和「配置文件本身解析失败/label 不匹配」这类真正要报的 FAIL 分开，
  # 避免重试逻辑把后者的输出打印两遍。
  if ! cargo build --quiet --offline 2>/tmp/verify-tauri-config-build.log; then
    echo "-- 本地 registry 缓存不足以离线编译，改为允许联网重试一次 --"
    cargo build --quiet
  fi
  cargo run --quiet --offline -- "$conf_abs" "$caps_abs"
)
