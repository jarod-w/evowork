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
# final_state_hash。这个 expect: 块此前从未被任何代码读过——现在真的读、
# 真的断言。
fail=0
for case_dir in eval/cases/*/; do
  yaml="${case_dir}case.yaml"
  run_id=$(sed -nE 's/^run_id:[[:space:]]*//p' "$yaml" | head -1)
  expect_turns=$(sed -nE 's/^[[:space:]]*turns:[[:space:]]*//p' "$yaml" | head -1)
  expect_ckpt=$(sed -nE 's/^[[:space:]]*checkpoints_at_least:[[:space:]]*//p' "$yaml" | head -1)
  expect_hash=$(sed -nE 's/^[[:space:]]*final_state_hash:[[:space:]]*//p' "$yaml" | head -1)

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
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "全部通过"
