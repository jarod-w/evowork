---
name: batch-files
description: 在工作区里批量重命名、按扩展名归类、把 docx 转成 PDF，或合并 csv / xlsx。用户要整理一批已经在工作区里的文件时使用。不处理工作区外的路径，也不跟随符号链接。
---

# batch-files —— 工作区里的批量文件

先用 `workspace-files` 的 `list_files` 看清有哪些文件。做完之后，新文件用 `register_file` 登记，要打开时用 `open_file`。

本技能只动工作区里面的真实文件。路径跳出工作区、经过符号链接，都会停。一次最多 50 个文件，多了就拆开，不截断。

- **在任务目录里运行**（不要先 cd 到技能目录）。`workspace` 填任务目录或它的子文件夹的绝对路径；`/`、`~`、任务目录之外的路径会被拒绝。
- **只差大小写或 Unicode 写法的名字算同名**（Mac 的磁盘默认不分大小写）：彼此冲突或与已有文件冲突时整批拒绝，不会覆盖。只改大小写的重命名是支持的；`group` 会沿用已有的、只差大小写的文件夹，报告里写的是文件真实所在的路径。
- **整批要么全做、要么不做**：中途出错会倒着撤回。撤回也失败时退出码 6，消息逐条列出哪些改动已经生效 —— 原样告诉用户，不要直接重跑。
- 不支持连环改名（目标正是另一个要挪走的文件），分两次做；不跨磁盘卷移动；不支持硬链接的盘（如 exFAT）上会拒绝。

## 怎么用

```bash
python3 <技能目录>/container_tools/run.py --content "<临时目录>/batch.json" --out "<临时目录>/batch-report.json"
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

`batch.json` 和报告都是中间文件，写进本任务的临时目录（第一次用 `mktemp -d "${TMPDIR:-/tmp}/evowork.XXXXXX"` 建）；报告写完才算成功，写报告失败时已做的改动也会撤回。

docx 转 PDF（需要本机 LibreOffice，`EVOWORK_OFFICE_CONVERTER` 与文档预览相同；转换在与预览相同的隔离里进行，目前只支持 macOS，其他平台退出码 3）。docx 原件保留；同一份 docx 列两次会被拒绝；转换失败是退出码 5，不留下 PDF：

```json
{
    "operation": "docx-to-pdf",
    "workspace": "<工作区绝对路径>",
    "files": ["周报.docx"]
}
```

合并表。csv 用标准库（必须是 UTF-8）；xlsx 需要办公扩展。表头不一致就停。源文件保留；合并结果可以写进还不存在的子文件夹：

```json
{
    "operation": "merge",
    "workspace": "<工作区绝对路径>",
    "sources": ["一月.csv", "二月.csv"],
    "out": "合计.csv"
}
```
