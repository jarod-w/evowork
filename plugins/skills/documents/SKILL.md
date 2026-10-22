---
name: documents
description: 生成或修改 Word 文档（docx）、Markdown 或 PDF。用户要"写一份报告/方案/说明"并要可以直接发出去的文件时使用；会议纪要先用 minutes、周报先用 weekly-report 整理再交给本技能。PDF 由本机 LibreOffice 从 docx 转出。
---

# documents —— 生成文档

## 何时用

用户要**一份能直接发出去的文件**时用它：报告、方案、说明书、会议纪要、总结。
用户只是要在对话里读一段内容时不要用 —— 直接写出来更快。

## 怎么用

```bash
node container_tools/mark_artifact.mjs \
  --operation-kind create --expected-output-count 1 --output-format docx \
  --title "Q3 经营分析" --path "<绝对路径>/Q3经营分析.docx"

# 内容 JSON 是中间文件，写进本任务的临时目录，不要写进用户的目录：第一次用
# mktemp -d "${TMPDIR:-/tmp}/evowork.XXXXXX" 建一个、记下它打印的路径，之后的命令都沿用它
python3 container_tools/render.py --content "<临时目录>/content.json" --out "<绝对路径>/Q3经营分析.docx"
```

`.docx` 需要办公扩展，**`.md` 不需要**（内置渲染，属基础包）。
写进代码仓库的说明、发给同事的草稿，用 `.md` 更合适。

先跑一次 `--validate-only` 可以在不装扩展的情况下把内容改对。

## 导出 PDF

用户要 PDF 时，`--output-format` 用 `pdf`，输出路径用 `.pdf`。渲染器先生成 docx，再用本机 LibreOffice 转成 PDF。

```bash
node container_tools/mark_artifact.mjs \
  --operation-kind create --expected-output-count 1 --output-format pdf \
  --title "Q3 经营分析" --path "<绝对路径>/Q3经营分析.pdf"

python3 container_tools/render.py --content content.json --out "<绝对路径>/Q3经营分析.pdf"
```

本机没有 soffice 时退出码是 3。这时改交 `.docx` 或 `.md`。`EVOWORK_OFFICE_CONVERTER` 可以指向 soffice，和预览用的是同一个变量。

## 内容 JSON

```json
{
    "template": "report",
    "title": "Q3 经营分析",
    "subtitle": "财务部 · 2026 年 9 月",
    "author": "财务部",
    "date": "2026-09-05",
    "toc": true,
    "blocks": [
        { "block": "heading", "level": 1, "text": "总体情况" },
        { "block": "paragraph", "text": "本季营收 4,120 万元，同比增长 18%。" },
        { "block": "bullets", "items": ["A 线增长最快", "B 线毛利率回升"] },
        {
            "block": "table",
            "caption": "分产品线明细",
            "header": ["产品线", "营收", "同比"],
            "rows": [["A 线", "1,240 万", "+22%"]]
        },
        { "block": "image", "path": "charts/margin.png", "caption": "图 1 季度毛利率" },
        { "block": "pagebreak" },
        { "block": "heading", "level": 1, "text": "下一步" }
    ]
}
```

八种 `block`：`heading` · `paragraph` · `bullets` · `ordered` · `table` · `image` · `quote` · `pagebreak`。
**没有第九种** —— 需要别的表达时用最接近的一种。

## 四条内容要求

1. **标题层级只能逐级下降。** `h1` 之后是 `h2`，不能直接跳到 `h3` —— 跳级会让目录缺一层，
   Word 的导航窗格也会错位。校验器会拦。
2. **表格每行的格数必须等于表头列数。** 缺的格写 `null`，不要省略。
3. **图片必须已经存在。** `path` 指向 `charts` 技能已经生成好的文件；写一个还不存在的路径
   会以专用退出码失败，而不是产出一份缺图的文档。
4. **超过 6 个 heading 就开 `toc`。** 读的人需要知道这份文档有多长。

## 渲染之后：看版式检查

渲染成功的输出里带两组检查结果（`_shared/layout_check.py`，离线、不渲染，用字体度量与字形表估算）：

- `layout_warnings`：**要改的**。文字溢出文本框、字体里没有的字（会显示成方框，比如 `U+2212` 减号）、
  内容越出页面 / 表格超出版心、标题跳级。改内容 JSON（缩短文字、拆成两页、换成键盘上的普通字符）
  再渲染一次，直到它为空。
- `layout_notes`：**只是提示**。比如本机没装模板字体、按替代字体估算 —— 收件人的机器上多半有，不必改。

溢出是估算，差一两行的边缘情况可能误判；缺字是确定的。
**不是用这个技能生成的** pptx / docx 也能单独检查（同样不联网）：
`python3 <本技能目录>/../_shared/layout_check.py <文件>`。

## 三个模板

| id        | 用在                 | 特征                                       |
| --------- | -------------------- | ------------------------------------------ |
| `report`  | 对外报告、正式方案   | 有封面页、页眉写标题、正文 11pt/1.5 倍行距 |
| `memo`    | 内部备忘、周报       | 无封面，标题直接起在第一页，信息密度高     |
| `minimal` | 会被别人接着编辑的稿 | 无页眉页脚、无表格底色，装饰最少           |

不确定用哪个就用 `report`。

## 关于目录

docx 的目录是 Word 的**域**，不是一段文字。用 python-docx 写进去之后，
用户第一次打开时目录区域是空的，**需要按 F9 或右键「更新域」**才会出现页码。
渲染器会在目录下方留一行提示说明这件事 —— 你不需要另外解释，但如果用户问起"目录怎么是空的"，
答案就是这个。

## 改已有文件

用户拿出的是一份已经存在的 docx 或 Markdown 时，**不要另起一份内容 JSON 重写**。先提取，再改，再写回：

```bash
python3 container_tools/render.py --extract "<绝对路径>/周报.docx" --out "<绝对路径>/周报.content.json"

node container_tools/mark_artifact.mjs \
  --operation-kind edit --expected-output-count 1 --output-format docx \
  --title "周报" --path "<绝对路径>/周报.docx"

python3 container_tools/render.py --content "<绝对路径>/周报.content.json" --out "<绝对路径>/周报.docx"
```

提取结果就是生成时用的内容 JSON。我们自己生成的文件会带上模板标记，提取后仍用原来的 `report` / `memo` / `minimal`。别人做的文件没有标记时，渲染用默认的 `report`。

提取能收回的是标题、大纲级别（或「标题 1」样式）、项目符号、表格和正文。引用块、文本框和封面装饰收不回来，会变成普通段落或被跳过；封面和目录自带的分页不进入正文。图片会抽到内容 JSON 旁边的 `extracted-media/`。超过 400 个块、表超过 10 列或 200 行时停下来，不截断。

## 需要办公扩展

`.docx` 依赖本机的**办公扩展**（Python + python-docx，约 120MB，按需下载）。
未安装时可以改输出 `.md`（不需要扩展），或者告诉用户安装。
**不要用 zip 手工拼 docx**，那几乎一定产出打不开的文件。
