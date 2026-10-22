---
name: scan-to-ledger
description: 把工作区里已经解析好的文本整理成台账或会议纪要。金额、日期和事项必须能在原文同一行对上，不许补原文没有的行。用户给了识别结果、要入账或要根据扫描件写纪要时使用。
---

# scan-to-ledger —— 把已有文本收成台账或纪要

这个技能**不识别图片，也不调用云端 OCR**。原文必须已经是工作区里的文本文件（本机解析或用户贴进来的文字）。只有图片或 PDF 时，先走本机解析，拿到文本再来。

## 怎么用

```bash
python3 container_tools/check.py --content ledger.json --out ledger.content.json
```

`output` 为 `ledger` 时，`ledger.content.json` 交给 `spreadsheets` 渲染成 xlsx。
`output` 为 `minutes` 时，交给 `documents` 的 `memo` 模板渲染成 docx。

登记产物时用最终文件：台账 `--output-format xlsx`，纪要 `--output-format docx`。

## 台账

```json
{
    "output": "ledger",
    "source": "<工作区里的文本绝对路径>",
    "title": "报销台账",
    "sheet": "明细",
    "columns": [
        { "header": "日期", "type": "date" },
        { "header": "摘要", "type": "text" },
        { "header": "金额", "type": "currency" }
    ],
    "rows": [["2026-09-01", "出租车", "128.00"]]
}
```

每一行的格子必须都能在原文的**同一行**里找到。金额按原文抄（`128.00` 或 `1,280.50`），不要改成另一种写法，也不要把 `1000` 里的 `100` 拆出来。公式列不能写死数字，对应格子填 `null`。对不上就停，不截掉那一行。

## 纪要

```json
{
    "output": "minutes",
    "source": "<工作区里的文本绝对路径>",
    "title": "周例会纪要",
    "date": "2026-09-05",
    "attendees": ["甲"],
    "decisions": ["通过三季度预算"],
    "actions": [{ "task": "催收逾期款", "owner": "甲", "due": "2026-09-12" }]
}
```

决议、参会人、待办的事项和负责人按原文逐字抄。日期写成 `YYYY-MM-DD`，但原文里要有这一天（`2026-09-05` 或 `2026年9月5日` 都可以）。原文没有的决议不要补。
