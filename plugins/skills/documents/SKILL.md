---
name: documents
description: 生成 Word 文档（docx）或 Markdown。当用户要"写一份报告/方案/说明/纪要/总结"并要可以直接发出去的文件时使用。
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

python3 container_tools/render.py --content content.json --out "<绝对路径>/Q3经营分析.docx"
```

`.docx` 需要办公扩展，**`.md` 不需要**（内置渲染，属基础包）。
写进代码仓库的说明、发给同事的草稿，用 `.md` 更合适。

先跑一次 `--validate-only` 可以在不装扩展的情况下把内容改对。

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

## 需要办公扩展

`.docx` 依赖本机的**办公扩展**（Python + python-docx，约 120MB，按需下载）。
未安装时可以改输出 `.md`（不需要扩展），或者告诉用户安装。
**不要用 zip 手工拼 docx**，那几乎一定产出打不开的文件。
