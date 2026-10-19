---
name: weekly-report
description: 写周报。必须分成本期、风险、下周三节，每节都有内容。用户要周报、周总结或本周进展时使用，不要用在会议纪要上。
---

# weekly-report —— 周报

周报和纪要不是一份文件。纪要用 `minutes`。这里只写本期做了什么、风险是什么、下周做什么。

## 怎么用

```bash
python3 container_tools/check.py --content weekly.json --out weekly.content.json

node container_tools/mark_artifact.mjs \
  --operation-kind create --expected-output-count 1 --output-format docx \
  --title "财务部周报" --path "<绝对路径>/财务部周报.docx"

python3 ../documents/container_tools/render.py \
  --content weekly.content.json --out "<绝对路径>/财务部周报.docx"
```

## 内容 JSON

```json
{
  "title": "财务部周报",
  "date": "2026-09-05",
  "period": ["完成三季度对账"],
  "risks": ["逾期款还没有回款计划"],
  "next": ["周五前发出催收函"]
}
```

`period`、`risks`、`next` 都至少一条。没有风险就写「本周没有新的风险」，不要省掉这一节。材料里没有的进展不要补。
