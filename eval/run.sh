#!/usr/bin/env bash
# 一条命令跑全集。阶段 1 只有一条合成用例，跑的是回放自校验。
#
# 三条独立路径必须给出**同一个**最终状态哈希，任何一条不一致都要让这条
# 脚本非 0 退出——这是判据 3（回放一条历史 Run Log，结果必须与原始执行
# 完全一致）与「快照只是加速，删光后回放结果必须不变」这两条红线的字面
# 执行处，不是摆设：
#   第 1 轮 replay --verify         —— 全量 fold，逐 checkpoint 比对
#   第 2 轮 replay                  —— 走快照恢复（唯一真正消费 snapshots
#                                       表的路径）
#   第 3 轮 replay --drop-snapshots —— 快照被删光后，退回全量 fold
#
# 只跑 --verify 两次（带/不带 --drop-snapshots）挡不住这类问题：
#   - verify() 从不读 snapshots 表，两轮是完全相同的计算，「删光快照」
#     那一半形同虚设；
#   - 各轮打出的 final= 只打印、不比较，全仓没有任何地方钉住期望值；
#   - verify() 只在 checkpoint 处比对，最后一个 checkpoint 之后的非确定性
#     没人校验。
# 下面的三轮比对 + 与 case.yaml 里钉住的期望哈希比对，三条一起堵上。
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build -p evo-cli --bins

for case_dir in eval/cases/*/; do
  echo "== 生成 ${case_dir} =="
  ./target/debug/mkcase "$case_dir"
done

# evo-cli 对「Log 里没有 checkpoint」会打印 VACUOUS 并以非 0 退出——
# 一条什么都没验到的用例不该让 CI 变绿。三轮里任何一轮本身非 0 退出
# （VACUOUS、mismatch、快照解码失败……）都会在这里直接终止脚本（set -e）。
echo "== 第 1 轮：回放自校验（全量 fold + 逐 checkpoint 比对）=="
round1=$(./target/debug/evo-cli replay --verify eval/cases/*/runlog.sqlite)
echo "$round1"

echo "== 第 2 轮：回放（走快照——唯一真正消费 snapshots 表的路径）=="
round2=$(./target/debug/evo-cli replay eval/cases/*/runlog.sqlite)
echo "$round2"

echo "== 第 3 轮：回放（删光快照，退回全量 fold）=="
round3=$(./target/debug/evo-cli replay --drop-snapshots eval/cases/*/runlog.sqlite)
echo "$round3"

# 把每一行规约成 "path=... run=... final=..." 三元组，跟 token 在行里
# 出现的顺序、其余 token（checkpoints=/status=/turn=/last_seq=）无关。
extract_finals() {
  awk '{
    p = ""; r = ""; f = "";
    for (i = 1; i <= NF; i++) {
      if ($i ~ /^path=/)  p = $i;
      if ($i ~ /^run=/)   r = $i;
      if ($i ~ /^final=/) f = $i;
    }
    if (p != "" && r != "" && f != "") print p, r, f;
  }' <<< "$1" | sort
}

finals1=$(extract_finals "$round1")
finals2=$(extract_finals "$round2")
finals3=$(extract_finals "$round3")

if [ -z "$finals1" ] || [ -z "$finals2" ] || [ -z "$finals3" ]; then
  echo "FAIL：三轮回放里至少有一轮没有产出任何 run 的最终状态哈希"
  exit 1
fi

if [ "$finals1" != "$finals2" ] || [ "$finals1" != "$finals3" ]; then
  echo "FAIL：三条回放路径的最终状态哈希不一致——判据 3 与「快照只是加速」都不成立"
  echo "-- 第 1 轮（--verify，全量 fold）--"
  echo "$finals1"
  echo "-- 第 2 轮（走快照）--"
  echo "$finals2"
  echo "-- 第 3 轮（删光快照，全量 fold）--"
  echo "$finals3"
  exit 1
fi
echo "ok：三条回放路径最终状态哈希一致"

# 逐 case 核对 case.yaml 里钉住的期望：turns、checkpoints_at_least、
# final_state_hash、artifacts。这个 expect: 块此前从未被任何代码读过——
# 现在真的读、真的断言，四个键一个不漏。
#
# artifacts 是四个键里最后一个补上的，也是唯一一个对「Agent 到底在磁盘上
# 做了什么」有感觉的。前三个键全是从 Run Log 折叠出来的 RunState 上取的，
# 而 `RunState` 终态里 `last_plan` 已是 finish plan、`pending_effects` 空、
# `artifacts` 字段从没被填过——实测把 fixtures 里 fs.write 的 target 从
# report.txt 改成 pwned.txt，report.txt 根本没被创建，钉住的 final hash 却
# 一字不变，整条 eval 全绿。所以这里不看状态哈希，直接去工作区里看文件在
# 不在。
#
# 三条数值断言原来都写成 `[ -n "$expect_x" ] && ...`：键不存在就静默跳过，
# 于是「把 case.yaml 里 final_state_hash: 整行删掉」就等于把这条检查关掉，
# 实测 EXIT=0。删掉钉子不能等于关掉检查，所以先断言钉子存在，再断言值相等。
#
# 取出来的值要归一化再比：YAML 里 `final_state_hash: "3fa2..."`（标准引号
# 写法）和不带引号是同一个值，裸字符串比较会假红；行尾注释同理。

# 去掉行尾注释（YAML 要求 # 前有空白）、去掉首尾空白、脱掉成对的引号。
yaml_norm() {
  sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^\x27(.*)\x27$/\1/'
}

# 取 `<key>:` 的标量值（第一处）。
yaml_scalar() {
  sed -nE "s/^[[:space:]]*$2:[[:space:]]*//p" "$1" | head -1 | yaml_norm
}

# 取 `<key>:` 的列表值，两种合法 YAML 写法都认：行内的 flow 写法
# `key: [a, b]`，以及下面那串缩进的 `- item`（遇到第一个既不是列表项也不是
# 空行/注释行的行就停）。只认其中一种的话，另一种会被当成「键不存在」，
# 于是一条写法完全合法的 case 反而报「缺了钉子」——和裸字符串比哈希的假红
# 是同一类问题。
yaml_list() {
  awk -v key="$2" '
    $0 ~ "^[[:space:]]*" key ":[[:space:]]*\\[" {
      line = $0
      sub(/^[^[]*\[/, "", line)
      sub(/\][[:space:]]*(#.*)?$/, "", line)
      n = split(line, items, ",")
      for (i = 1; i <= n; i++) print items[i]
      exit
    }
    $0 ~ "^[[:space:]]*" key ":[[:space:]]*$" { inlist = 1; next }
    inlist && /^[[:space:]]*-[[:space:]]*/    { sub(/^[[:space:]]*-[[:space:]]*/, ""); print; next }
    inlist && /^[[:space:]]*(#.*)?$/          { next }
    inlist                                    { exit }
  ' "$1" | yaml_norm
}

fail=0
for case_dir in eval/cases/*/; do
  yaml="${case_dir}case.yaml"
  run_id=$(yaml_scalar "$yaml" run_id)
  expect_turns=$(yaml_scalar "$yaml" turns)
  expect_ckpt=$(yaml_scalar "$yaml" checkpoints_at_least)
  expect_hash=$(yaml_scalar "$yaml" final_state_hash)
  expect_artifacts=$(yaml_list "$yaml" artifacts)

  # 钉子必须存在——缺一个就是 FAIL，不是静默跳过
  missing=""
  [ -n "$run_id" ]           || missing="${missing} run_id"
  [ -n "$expect_turns" ]     || missing="${missing} expect.turns"
  [ -n "$expect_ckpt" ]      || missing="${missing} expect.checkpoints_at_least"
  [ -n "$expect_hash" ]      || missing="${missing} expect.final_state_hash"
  [ -n "$expect_artifacts" ] || missing="${missing} expect.artifacts"
  if [ -n "$missing" ]; then
    echo "FAIL: ${yaml} 缺了钉子：${missing}。删掉钉子等于关掉检查，这里不允许静默跳过。"
    fail=1
  fi
  [ -n "$run_id" ] || continue

  verify_row=$(echo "$round1" | grep -E "run=${run_id}( |\$)" || true)
  replay_row=$(echo "$round2" | grep -E "run=${run_id}( |\$)" || true)

  if [ -z "$verify_row" ] || [ -z "$replay_row" ]; then
    echo "FAIL: ${yaml} 期望的 run_id=${run_id} 没有出现在回放输出里"
    fail=1
    continue
  fi

  actual_ckpt=$(echo "$verify_row" | grep -oE 'checkpoints=[0-9]+' | cut -d= -f2)
  actual_hash=$(echo "$verify_row" | grep -oE 'final=[0-9a-f]+' | cut -d= -f2)
  actual_turns=$(echo "$replay_row" | grep -oE 'turn=[0-9]+' | cut -d= -f2)

  if [ -n "$expect_ckpt" ] && [ "$actual_ckpt" -lt "$expect_ckpt" ]; then
    echo "FAIL: ${yaml} 期望 checkpoints_at_least=${expect_ckpt}，实得 checkpoints=${actual_ckpt}"
    fail=1
  fi
  if [ -n "$expect_hash" ] && [ "$actual_hash" != "$expect_hash" ]; then
    echo "FAIL: ${yaml} 期望 final_state_hash=${expect_hash}，实得 final=${actual_hash}"
    fail=1
  fi
  if [ -n "$expect_turns" ] && [ "$actual_turns" != "$expect_turns" ]; then
    echo "FAIL: ${yaml} 期望 turns=${expect_turns}，实得 turn=${actual_turns}"
    fail=1
  fi

  # expect.artifacts：跑完之后工作区里这些文件必须真的在。工作区根目录是
  # DaemonConfig::for_test(case_dir) 里的 <case_dir>/workspaces，每条 run 一个
  # 以 run_id 命名的子目录；mkcase 每次生成前会把它整个删掉重建，所以这里
  # 看到的一定是本次跑出来的结果，不是上一次的残留。
  # 钉子本身也不能写成一条永远成立的断言：路径必须是工作区内的相对路径
  # （`.`、`..`、绝对路径都能让「文件存在」恒真），且必须是普通文件。
  ws_dir="${case_dir}workspaces/${run_id}"
  while IFS= read -r artifact; do
    [ -n "$artifact" ] || continue
    case "$artifact" in
      /* | . | .. | ./* | ../* | */.. | */../* | */. )
        echo "FAIL: ${yaml} 的 artifact 路径 ${artifact} 不合法：必须是工作区内的相对路径，不能是绝对路径，也不能含 . 或 .. 路径分量"
        fail=1
        continue
        ;;
    esac
    if [ ! -f "${ws_dir}/${artifact}" ]; then
      echo "FAIL: ${yaml} 期望产出 artifact ${artifact}，但 ${ws_dir}/${artifact} 不存在"
      echo "      工作区实有：$(ls -A "$ws_dir" 2>/dev/null | tr '\n' ' ')"
      fail=1
    fi
  done <<< "$expect_artifacts"
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "全部通过"
