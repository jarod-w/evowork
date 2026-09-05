---
name: spreadsheets
description: 生成 Excel 表格（xlsx）或 csv。当用户要"做个表/统计/台账/预算表/对账"时使用。
---

# spreadsheets —— 生成表格

## 何时用

用户要**一份能继续改、能继续算的表**时用它：台账、预算、对账、统计汇总。
只是要在对话里看几个数时不要用 —— 直接列出来更快。

## 怎么用

```bash
node container_tools/mark_artifact.mjs \
  --operation-kind create --expected-output-count 1 --output-format xlsx \
  --title "Q3 应收对账" --path "<绝对路径>/Q3应收对账.xlsx"

python3 container_tools/render.py --content content.json --out "<绝对路径>/Q3应收对账.xlsx"
```

输出格式由 `--out` 的扩展名决定：`.xlsx`（需要办公扩展）或 `.csv`（不需要，属基础包）。

## **最重要的一条：计算列给公式，不给算好的数**

```json
{
    "sheets": [
        {
            "name": "明细",
            "columns": [
                { "header": "产品", "type": "text" },
                { "header": "单价", "type": "currency" },
                { "header": "数量", "type": "integer" },
                { "header": "金额", "type": "currency", "formula": "=B{row}*C{row}" },
                { "header": "占比", "type": "percent", "formula": "=D{row}/SUM($D$2:$D$100)" }
            ],
            "rows": [
                ["A 线", 12.5, 100, null, null],
                ["B 线", 8.0, 200, null, null]
            ],
            "total_row": true,
            "conditional_formats": [{ "column": "金额", "rule": "data-bar" }]
        }
    ]
}
```

- 计算列写 `formula`，`{row}` 会被替换成当前行号；
- 这些列在 `rows` 里对应位置**必须写 `null`** —— 校验器会拦，且这是硬规则；
- `total_row: true` 会追加一行 `SUM` 公式合计（同样不是算好的数）。

**为什么这条不能通融**：用户拿到表之后会改数。单元格里如果是常量，改了单价之后
金额、合计、占比全都纹丝不动 —— 而它看起来完全正常，一路带进汇报才被发现。
你算得对不对不重要，重要的是**这张表在用户手里还能不能继续算**。

## 列类型决定数字格式

| `type`     | 显示         | 用在                                        |
| ---------- | ------------ | ------------------------------------------- |
| `text`     | 原样         | 名称、备注、编号                            |
| `integer`  | `1,234`      | 数量、件数                                  |
| `number`   | `1,234.56`   | 一般数值                                    |
| `currency` | `¥1,234.56`  | 金额                                        |
| `percent`  | `12.3%`      | 占比、增长率（**写小数 0.123，不是 12.3**） |
| `date`     | `2026-09-05` | 日期                                        |

`percent` 那一行最容易错：Excel 的百分比格式会把 `0.123` 显示成 `12.3%`。
写成 `12.3` 会显示成 `1230%`。

## 其他

- **冻结首行默认开**（超过一屏的表不冻结就没法看），不想要就写 `"freeze_header": false`。
- 条件格式四种：`negative-red`（负数标红）· `above-average-green` · `top10-green` · `data-bar`。
- 一个 `sheets` 数组可以放多张表；**csv 只能装一张**，多张时渲染器会让你改成 xlsx。
- 大表（几千行）没问题，但超过 5 万行应该考虑给用户原始数据文件而不是生成表格。

## csv 的降级是显式的

csv 没有公式。输出 csv 时计算列会**留空并在表头标注"（公式列，csv 不支持）"**，
而不是悄悄填一个算好的值 —— 用户看到空列会来问，看到一个数不会。
需要公式就输出 xlsx。

## 需要办公扩展

`.xlsx` 依赖本机的**办公扩展**（Python + openpyxl，约 120MB，按需下载）。
未安装时渲染器会退出并给出提示 —— 此时可以改输出 `.csv`（不需要扩展），
或者告诉用户安装。**不要用 zip 手工拼 xlsx**，那几乎一定产出打不开的文件。
