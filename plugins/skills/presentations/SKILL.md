---
name: presentations
description: 生成 PowerPoint 幻灯片（pptx）。当用户要"做一份汇报/PPT/幻灯片/演示"时使用。
---

# presentations —— 生成幻灯片

## 何时用

用户要**可以直接发出去的演示文件**时用它：汇报、周报、方案介绍、评审材料。
用户只是要"讲讲思路"时不要用 —— 那时直接回答更快。

## 怎么用（**这一节是硬要求，不是建议**）

你的输出**不是 pptx，也不是 python 代码**，而是一份受约束的**内容 JSON**：

```bash
# ① 先声明你要产出什么（让产物被收集进结果区）
node container_tools/mark_artifact.mjs \
  --operation-kind create --expected-output-count 1 --output-format pptx \
  --title "Q3 业绩汇报" --path "<绝对路径>/Q3业绩汇报.pptx"

# ② 把内容 JSON 交给渲染器。内容 JSON 是中间文件，写进本任务的临时目录、不要写进用户的目录：
#    第一次用 mktemp -d "${TMPDIR:-/tmp}/evowork.XXXXXX" 建一个、记下它打印的路径，之后沿用
python3 container_tools/render.py --content "<临时目录>/content.json" --out "<绝对路径>/Q3业绩汇报.pptx"
```

`content.json` 的形状由 `schema/content.schema.json` 约束，渲染器**先校验再渲染**。
校验失败时它会告诉你**具体哪一条不合法**，改完再跑一次即可（不要绕过校验自己写 pptx）。

### 为什么不让你直接写 python-pptx 代码

不是因为不信任你，而是因为实测下来这条路的失败模式很固定：缩进错、API 记错版本、
文字溢出文本框、中文字体没设导致方框乱码。这些错误在生成时不报错，
只在用户打开文件时才显现 —— 那时已经晚了。

**排版、字号、留白、配色由模板决定，不由你决定。** 你负责内容与结构。

## 内容 JSON 的骨架

```json
{
    "template": "business",
    "title": "Q3 业绩汇报",
    "subtitle": "2026 年第三季度 · 财务部",
    "slides": [
        { "layout": "title", "title": "Q3 业绩汇报", "subtitle": "财务部 · 2026-09" },
        {
            "layout": "bullets",
            "title": "本季要点",
            "bullets": ["营收同比 +18%", "毛利率回升至 34%"]
        },
        {
            "layout": "chart",
            "title": "季度毛利率",
            "chart_ref": "charts/margin.png",
            "caption": "数据来源：财务系统导出的三张表"
        },
        {
            "layout": "table",
            "title": "分产品线明细",
            "table": {
                "header": ["产品线", "营收", "同比"],
                "rows": [["A 线", "1,240 万", "+22%"]]
            }
        },
        { "layout": "section", "title": "下一步" }
    ]
}
```

五种 layout：`title` · `bullets` · `chart` · `table` · `section`。**没有第六种** ——
需要别的表达方式时，用这五种里最接近的一种，或者拆成两页。

## 三条内容质量要求

1. **每页一个观点**。`bullets` 超过 6 条就拆页；单条超过 40 字就压缩 ——
   模板会尽量缩字号，但缩到看不清就不是"排版问题"而是内容问题了。
2. **图表引用真实文件**。`chart_ref` 指向已经生成好的图（用 `charts` 技能先做出来），
   不要写一个还不存在的路径。
3. **数字要有来源**。用户拿去汇报时会被问"这个数哪来的"，所以在 `caption` 或备注里
   写清它来自哪个文件的哪张表。

## 渲染之后：看版式检查

渲染成功的输出里带两组检查结果（`_shared/layout_check.py`，离线、不渲染，用字体度量与字形表估算）：

- `layout_warnings`：**要改的**。文字溢出文本框、字体里没有的字（会显示成方框，比如 `U+2212` 减号）、
  内容越出页面 / 表格超出版心、标题跳级。改内容 JSON（缩短文字、拆成两页、换成键盘上的普通字符）
  再渲染一次，直到它为空。
- `layout_notes`：**只是提示**。比如本机没装模板字体、按替代字体估算 —— 收件人的机器上多半有，不必改。

溢出是估算，差一两行的边缘情况可能误判；缺字是确定的。
**不是用这个技能生成的** pptx / docx 也能单独检查（同样不联网）：
`python3 <本技能目录>/../_shared/layout_check.py <文件>`。

## 模板

| id           | 用在           | 特征                                  |
| ------------ | -------------- | ------------------------------------- |
| `business`   | 对外汇报、评审 | 标题页带色块，正文 24pt，每页留白较大 |
| `minimal`    | 内部同步       | 无装饰，信息密度高                    |
| `data-heavy` | 数据评审       | 表格与图表优先，字号更紧凑            |

不确定用哪个就用 `business`。

## 需要办公扩展

渲染依赖本机的**办公扩展**（Python + python-pptx，约 120MB，按需下载）。
未安装时渲染器会退出并给出明确提示，此时告诉用户需要安装，**不要改用其他方式硬造 pptx** ——
用 zip 手工拼 Office 文件几乎一定会产出打不开的文件。
