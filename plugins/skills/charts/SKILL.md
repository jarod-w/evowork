---
name: charts
description: 生成图表（svg / png）。当需要把数据画成柱状图/折线图/饼图/散点图时使用，也用于给 PPT 与文档提供配图。
---

# charts —— 把数据画成图

## 何时用

- 用户要"看趋势/对比/占比"时；
- **给 `presentations` 或 `documents` 提供配图时** —— 那两个技能的 `chart_ref` / `image`
  引用的就是这里产出的文件，所以要先跑这个再跑那个。

数据只有两三个数、一句话能说清时不要画图。

## 怎么用

```bash
node container_tools/mark_artifact.mjs \
  --operation-kind create --expected-output-count 1 --output-format png \
  --title "季度毛利率" --path "<绝对路径>/charts/margin.png"

python3 container_tools/render.py --content chart.json --out "<绝对路径>/charts/margin.png"
```

输出格式由 `--out` 的扩展名决定：**`.svg` 用于文档里的矢量插图，`.png` 用于 PPT**
（python-pptx 对 svg 支持不好）。不确定就用 png。

先跑一次 `--validate-only` 可以在不装办公扩展的情况下把内容改对。

## 内容 JSON

```json
{
    "chart": "bar",
    "title": "分产品线季度营收",
    "x_label": "季度",
    "y_label": "营收（万元）",
    "categories": ["Q1", "Q2", "Q3"],
    "series": [
        { "name": "A 线", "values": [1240, 1380, 1510] },
        { "name": "B 线", "values": [860, 910, 1020] }
    ],
    "value_format": "thousands",
    "source": "财务系统导出的 revenue.xlsx，Sheet1"
}
```

五种 `chart`：`bar` · `stacked-bar` · `line` · `pie` · `scatter`。**没有第六种。**

| 种类          | 必填                                   | 注意                                |
| ------------- | -------------------------------------- | ----------------------------------- |
| `bar`         | `categories` + 每个 series 的 `values` | values 与 categories **必须一样长** |
| `stacked-bar` | 同上                                   | 表达"总量的构成"，不是"多组对比"    |
| `line`        | 同上                                   | 表达随时间的变化                    |
| `pie`         | `categories` + **恰好一个** series     | 数值不能为负；超过 7 块就该改用 bar |
| `scatter`     | 每个 series 的 `x_values` + `values`   | 两者必须一样长                      |

## 三条内容要求

1. **写 `source`。** 它会渲染在图的左下角。用户拿去汇报时会被问"这个数哪来的"，
   而那时你已经不在场了。
2. **写 `y_label` 并带单位。** "营收"和"营收（万元）"差一个量级的误解。
3. **`series` 最多 8 条。** 超过 8 条的折线图没人看得懂，该拆图或改成表格。

## 你不决定的东西

配色、字号、网格、图例位置、留白**都由渲染器决定** —— 配色直接取自 EvoWork 的
design token，所以图放进 PPT 和文档里颜色是一致的。不要试图在内容 JSON 里指定颜色，
schema 里没有这个字段。

## 中文与字体

渲染器在画之前会先探测本机的中文字体。**没有中文字体时它会停下来报错，而不是画一张方框图** ——
因为方框图不报错，等用户打开文件才发现就晚了。遇到这个错误时告诉用户装办公扩展，
不要改用别的方式画图。
