---
name: data-analysis
description: 分析用户给出的表格或数据文件。先写口径、对比、异常和结论，再让 charts 画图、spreadsheets 出可计算的表。用户要分析、对比、找异常或解释一份数据时使用。
---

# data-analysis —— 数据分析

这个技能不负责画图，也不负责把合计写死在单元格里。它只检查分析有没有口径、有没有来源、有没有结论。

## 怎么用

中间文件写进本任务的临时目录（第一次用 `mktemp -d "${TMPDIR:-/tmp}/evowork.XXXXXX"` 建，记下路径沿用），不要写进用户的目录。

```bash
python3 container_tools/check.py --content "<临时目录>/analysis.json" --out "<临时目录>/analysis.content.json"
```

检查通过后：

1. 每个 `charts` 条目用 `charts` 技能出一张图。`source` 原样写进图表 JSON 的 `source`。
2. 每个 `tables` 条目用 `spreadsheets` 技能出一张表。计算列写公式，不写算好的数。
3. 把 `<临时目录>/analysis.content.json` 交给 `documents` 技能，用 `memo` 模板出报告。图已经生成后再引用。

## 内容 JSON

```json
{
    "question": "这个季度毛利率为什么下降",
    "sources": [{ "file": "revenue.xlsx", "sheet": "明细" }],
    "definitions": [{ "name": "毛利率", "formula": "毛利 / 营收" }],
    "comparisons": [{ "name": "同比", "baseline": "去年同季", "finding": "下降 2 个百分点" }],
    "anomalies": ["华东区毛利率为负"],
    "conclusions": ["先核对华东区的折扣，再决定要不要改价"],
    "charts": [{ "title": "分区域毛利率", "source": "revenue.xlsx / 明细" }],
    "tables": [{ "title": "分区域明细", "source": "revenue.xlsx / 明细" }]
}
```

没有来源文件就不要分析：`sources[].file` 写绝对路径或相对当前目录的路径，文件必须真的存在。每张图、每张表都必须写 `source`，而且只能是 `sources` 里的 `file` 或 `file / sheet`。每个列表最多 30 条、每条最多 300 字。没有异常就写「没有超出口径的异常」，不要省掉。结论至少一条，而且要能对应到上面的对比或异常，不要另起一套数字。
