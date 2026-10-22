---
name: minutes
description: 把会议材料整理成纪要。必须写出决议，以及每条待办的事项、负责人和截止日期。用户要纪要、会议记录或行动项时使用。
---

# minutes —— 会议纪要

用户要的是一份能发出去的纪要，不是对话里的一段摘要。

## 怎么用

先把材料收成下面这份 JSON，再交给检查器。检查器通过后才会写出 `documents` 技能能渲染的内容 JSON。
中间文件写进本任务的临时目录（第一次用 `mktemp -d "${TMPDIR:-/tmp}/evowork.XXXXXX"` 建，记下路径沿用），不要写进用户的目录。

```bash
python3 container_tools/check.py --content "<临时目录>/minutes.json" --out "<临时目录>/minutes.content.json"

node container_tools/mark_artifact.mjs \
  --operation-kind create --expected-output-count 1 --output-format docx \
  --title "周例会纪要" --path "<绝对路径>/周例会纪要.docx"

python3 ../documents/container_tools/render.py \
  --content "<临时目录>/minutes.content.json" --out "<绝对路径>/周例会纪要.docx"
```

`mark_artifact.mjs` 用 documents 技能那一份。本技能不渲染 docx。

## 内容 JSON

```json
{
    "title": "周例会纪要",
    "date": "2026-09-05",
    "attendees": ["甲", "乙"],
    "absent": ["丙"],
    "decisions": ["通过三季度预算"],
    "actions": [{ "task": "催收逾期款", "owner": "甲", "due": "2026-09-12" }]
}
```

四条硬要求：

1. `decisions` 至少一条。没有决议就不要写纪要。
2. 每条待办都要有事项、负责人和截止日期。材料里没定的写「待定」或「未定」，**不要编一个人名或日期**，也不要写「-」「无」「TBD」；截止日期用 `YYYY-MM-DD`，不能早于会议日期。成功输出里的 `undecided` 是待定的条数，要告诉用户。
   上限与 documents 一致：决议最多 30 条、每条最多 300 字，标题最多 120 字。
3. 材料里没出现的决议或待办不要补。写不出来就问用户。
4. 只出文件，不发送、不写进日历。

材料里标了请假、缺席、未到的人写进 `absent`（可省略），不要列进 `attendees`，也不要过了检查再往内容 JSON 里补一段。
