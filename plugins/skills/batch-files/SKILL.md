---
name: batch-files
description: 在工作区里批量重命名、按扩展名归类、把 docx 转成 PDF，或合并 csv / xlsx。用户要整理一批已经在工作区里的文件时使用。不处理工作区外的路径，也不跟随符号链接。
---

# batch-files —— 工作区里的批量文件

先用 `workspace-files` 的 `list_files` 看清有哪些文件。做完之后，新文件用 `register_file` 登记，要打开时用 `open_file`。

本技能只动工作区里面的真实文件。路径跳出工作区、经过符号链接，都会停。一次最多 50 个文件，多了就拆开，不截断。

## 怎么用

```bash
python3 container_tools/run.py --content batch.json --out "<绝对路径>/batch-report.json"
```

`rename` 和 `group` 是明确的移动：原路径上的文件会离开原地。`docx-to-pdf` 和 `merge` 只新增文件，原件留着。

登记产物时，移动用 `--operation-kind edit`，新产生的 PDF 或合并表用 `--operation-kind create`。

## 四种操作

重命名：

```json
{
    "operation": "rename",
    "workspace": "<工作区绝对路径>",
    "items": [{ "from": "草稿.docx", "to": "周报.docx" }]
}
```

按扩展名归到文件夹（`docx/`、`pdf/`；没有扩展名的进 `no-extension/`）：

```json
{
    "operation": "group",
    "workspace": "<工作区绝对路径>",
    "files": ["周报.docx", "附件.pdf"]
}
```

docx 转 PDF（需要本机 LibreOffice，`EVOWORK_OFFICE_CONVERTER` 与文档预览相同）。docx 原件保留：

```json
{
    "operation": "docx-to-pdf",
    "workspace": "<工作区绝对路径>",
    "files": ["周报.docx"]
}
```

合并表。csv 用标准库；xlsx 需要办公扩展。表头不一致就停。源文件保留：

```json
{
    "operation": "merge",
    "workspace": "<工作区绝对路径>",
    "sources": ["一月.csv", "二月.csv"],
    "out": "合计.csv"
}
```
