#!/usr/bin/env python3
"""工作区内的批量文件操作。不跟随符号链接，不处理工作区外的路径。"""

from __future__ import annotations

import argparse
import csv
import importlib.util
import shutil
import sys
import tempfile
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT.parent / "_shared"))

from evowork_skill import (  # noqa: E402
    EXIT_INVALID_CONTENT,
    EXIT_RUNTIME_MISSING,
    fail,
    read_content,
    runtime_missing_message,
    succeeded,
    write_extracted,
)

MAX_FILES = 50
MAX_BYTES = 20 * 1024 * 1024


def require_text(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(EXIT_INVALID_CONTENT, f"{where} 不能为空。")
    return value.strip()


def workspace_root(raw: object) -> Path:
    text = require_text(raw, "workspace")
    path = Path(text)
    if not path.is_absolute():
        fail(EXIT_INVALID_CONTENT, "workspace 必须是绝对路径。")
    if path.is_symlink() or not path.is_dir():
        fail(EXIT_INVALID_CONTENT, "workspace 必须是真实目录。本技能不跟随符号链接。")
    reject_symlink(path)
    return path


def reject_symlink(path: Path) -> None:
    current = Path(path.anchor)
    for part in path.parts[1:]:
        current = current / part
        if current.is_symlink():
            fail(EXIT_INVALID_CONTENT, "路径上有符号链接。本技能不跟随符号链接。")
        if not current.exists():
            return


def place(root: Path, raw: object, where: str, *, must_exist: bool) -> Path:
    text = require_text(raw, where)
    candidate = Path(text)
    if not candidate.is_absolute():
        candidate = root / candidate
    parts: list[str] = []
    for part in candidate.parts:
        if part == "..":
            fail(EXIT_INVALID_CONTENT, "路径不能跳出工作区。")
        if part != ".":
            parts.append(part)
    lexical = Path(*parts)
    try:
        lexical.relative_to(root)
    except ValueError:
        fail(EXIT_INVALID_CONTENT, "路径超出工作区。")
    reject_symlink(lexical)
    if lexical.is_symlink():
        fail(EXIT_INVALID_CONTENT, "路径上有符号链接。本技能不跟随符号链接。")
    if must_exist:
        if not lexical.is_file():
            fail(EXIT_INVALID_CONTENT, "找不到要处理的文件。")
        if lexical.stat().st_size > MAX_BYTES:
            fail(EXIT_INVALID_CONTENT, f"文件超过 {MAX_BYTES} 字节。拆开再处理，不要截断。")
    return lexical


def cap(count: int) -> None:
    if count > MAX_FILES:
        fail(EXIT_INVALID_CONTENT, f"一次最多 {MAX_FILES} 个文件。拆开再跑，不要截断。")
    if count < 1:
        fail(EXIT_INVALID_CONTENT, "至少要有一个文件。")


def reject_unknown(raw: dict, allowed: set[str]) -> None:
    if set(raw) - allowed:
        fail(EXIT_INVALID_CONTENT, "内容 JSON 有未声明的字段。")


def rename_all(root: Path, raw: dict) -> list[dict]:
    items = raw.get("items")
    if not isinstance(items, list):
        fail(EXIT_INVALID_CONTENT, "items 必须是数组。")
    cap(len(items))
    planned: list[tuple[Path, Path]] = []
    seen_from: set[Path] = set()
    seen_to: set[Path] = set()
    for index, item in enumerate(items):
        if not isinstance(item, dict) or set(item) - {"from", "to"}:
            fail(EXIT_INVALID_CONTENT, f"items/{index} 只能有 from 和 to。")
        source = place(root, item.get("from"), f"items/{index}/from", must_exist=True)
        target = place(root, item.get("to"), f"items/{index}/to", must_exist=False)
        if source in seen_from or target in seen_to or source == target:
            fail(EXIT_INVALID_CONTENT, "重命名的来源或目标重复。")
        if target.exists():
            fail(EXIT_INVALID_CONTENT, "目标已经存在。不会覆盖。")
        seen_from.add(source)
        seen_to.add(target)
        planned.append((source, target))
    moved = []
    for source, target in planned:
        target.parent.mkdir(parents=True, exist_ok=True)
        source.rename(target)
        moved.append({"from": str(source.relative_to(root)), "to": str(target.relative_to(root))})
    return moved


def group_all(root: Path, raw: dict) -> list[dict]:
    files = raw.get("files")
    if not isinstance(files, list):
        fail(EXIT_INVALID_CONTENT, "files 必须是数组。")
    cap(len(files))
    planned: list[tuple[Path, Path]] = []
    seen_to: set[Path] = set()
    for index, item in enumerate(files):
        source = place(root, item, f"files/{index}", must_exist=True)
        folder_name = source.suffix.lower().lstrip(".") or "no-extension"
        if folder_name in {".", ".."} or "/" in folder_name or "\\" in folder_name:
            fail(EXIT_INVALID_CONTENT, "扩展名不能当作文件夹名。")
        target = place(root, str(Path(folder_name) / source.name), f"files/{index}", must_exist=False)
        folder = target.parent
        if folder.is_symlink() or (folder.exists() and not folder.is_dir()):
            fail(EXIT_INVALID_CONTENT, "归类用的文件夹不是真实目录。")
        if target in seen_to:
            fail(EXIT_INVALID_CONTENT, "两个文件会归到同一个路径。不会覆盖。")
        if target.exists() and target != source:
            fail(EXIT_INVALID_CONTENT, "目标已经存在。不会覆盖。")
        seen_to.add(target)
        planned.append((source, target))
    moved = []
    for source, target in planned:
        if source == target:
            moved.append({"from": str(source.relative_to(root)), "to": str(target.relative_to(root))})
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        source.rename(target)
        moved.append({"from": str(source.relative_to(root)), "to": str(target.relative_to(root))})
    return moved


def documents_pdf():
    path = SKILL_ROOT.parent / "documents" / "container_tools" / "render.py"
    spec = importlib.util.spec_from_file_location("evowork_documents_render", path)
    if spec is None or spec.loader is None:
        fail(EXIT_RUNTIME_MISSING, "找不到文档技能的 PDF 转换。")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def docx_to_pdf(root: Path, raw: dict) -> list[dict]:
    files = raw.get("files")
    if not isinstance(files, list):
        fail(EXIT_INVALID_CONTENT, "files 必须是数组。")
    cap(len(files))
    module = documents_pdf()
    if module.office_converter() is None:
        fail(
            EXIT_RUNTIME_MISSING,
            "需要本机 LibreOffice（soffice）才能把 docx 转成 PDF。安装后重试。",
        )
    planned: list[tuple[Path, Path]] = []
    for index, item in enumerate(files):
        source = place(root, item, f"files/{index}", must_exist=True)
        if source.suffix.lower() != ".docx":
            fail(EXIT_INVALID_CONTENT, "docx-to-pdf 只接受 .docx。")
        target = place(root, str(source.with_suffix(".pdf")), f"files/{index}", must_exist=False)
        if target.exists():
            fail(EXIT_INVALID_CONTENT, "PDF 已经存在。不会覆盖，docx 原件也还在。")
        planned.append((source, target))
    written = []
    with tempfile.TemporaryDirectory(prefix="evowork-batch-pdf-") as tmp:
        staged: list[tuple[Path, Path]] = []
        for source, target in planned:
            out = Path(tmp) / f"{len(staged)}.pdf"
            module.convert_docx_to_pdf(source, out)
            staged.append((out, target))
        for out, target in staged:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(out, target)
            written.append({"pdf": str(target.relative_to(root))})
    return written


def merge_csv(sources: list[Path], out: Path) -> None:
    rows: list[list[str]] = []
    header: list[str] | None = None
    for source in sources:
        with source.open(newline="", encoding="utf-8") as handle:
            data = list(csv.reader(handle))
        if not data or not any(any(cell.strip() for cell in row) for row in data):
            fail(EXIT_INVALID_CONTENT, "有一份 csv 是空的。")
        if header is None:
            header = data[0]
            rows.extend(data)
            continue
        if data[0] != header:
            fail(EXIT_INVALID_CONTENT, "csv 的表头不一致。不会把对不上的行并进去。")
        rows.extend(data[1:])
    with out.open("w", newline="", encoding="utf-8") as handle:
        csv.writer(handle).writerows(rows)


def merge_xlsx(sources: list[Path], out: Path) -> None:
    try:
        from openpyxl import Workbook, load_workbook
    except ModuleNotFoundError:
        fail(EXIT_RUNTIME_MISSING, runtime_missing_message("office", "合并 xlsx"))
    book = Workbook()
    default = book.active
    book.remove(default)
    used: set[str] = set()
    for source in sources:
        loaded = load_workbook(source)
        for sheet in loaded.worksheets:
            title = sheet.title
            if title in used:
                title = f"{source.stem}-{sheet.title}"[:31]
            if title in used or any(ch in title for ch in ":\\/?*[]"):
                fail(EXIT_INVALID_CONTENT, "工作表重名或名字不能用。不会覆盖已有的表。")
            used.add(title)
            target = book.create_sheet(title)
            for row in sheet.iter_rows(values_only=True):
                target.append(list(row))
        loaded.close()
    if not book.worksheets:
        fail(EXIT_INVALID_CONTENT, "没有可合并的工作表。")
    book.save(out)


def merge_all(root: Path, raw: dict) -> dict:
    sources_raw = raw.get("sources")
    if not isinstance(sources_raw, list):
        fail(EXIT_INVALID_CONTENT, "sources 必须是数组。")
    cap(len(sources_raw))
    if len(sources_raw) < 2:
        fail(EXIT_INVALID_CONTENT, "合并至少要两份文件。")
    sources = [place(root, item, f"sources/{index}", must_exist=True) for index, item in enumerate(sources_raw)]
    suffixes = {path.suffix.lower() for path in sources}
    if suffixes == {".csv"}:
        kind = "csv"
    elif suffixes == {".xlsx"}:
        kind = "xlsx"
    else:
        fail(EXIT_INVALID_CONTENT, "一次只能合并同一种文件：全是 csv，或全是 xlsx。")
    out = place(root, raw.get("out"), "out", must_exist=False)
    if out.suffix.lower() != f".{kind}":
        fail(EXIT_INVALID_CONTENT, "合并结果的扩展名要和源文件一致。")
    if out.exists() or out in sources:
        fail(EXIT_INVALID_CONTENT, "合并结果不能覆盖已有文件，也不能写回源文件。")
    partial = out.with_name(out.name + ".partial")
    if partial.exists():
        fail(EXIT_INVALID_CONTENT, "已经有一份未完成的合并结果。先移走它再重试。")
    try:
        if kind == "csv":
            merge_csv(sources, partial)
        else:
            merge_xlsx(sources, partial)
        partial.rename(out)
    finally:
        if partial.exists():
            partial.unlink()
    return {"out": str(out.relative_to(root)), "sources": len(sources)}


def main() -> None:
    parser = argparse.ArgumentParser(description="工作区内批量重命名、归类、转 PDF 或合并表格")
    parser.add_argument("--content", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    raw = read_content(Path(args.content).resolve())
    root = workspace_root(raw.get("workspace"))
    operation = raw.get("operation")
    if operation == "rename":
        reject_unknown(raw, {"operation", "workspace", "items"})
        result = {"operation": operation, "files": rename_all(root, raw)}
    elif operation == "group":
        reject_unknown(raw, {"operation", "workspace", "files"})
        result = {"operation": operation, "files": group_all(root, raw)}
    elif operation == "docx-to-pdf":
        reject_unknown(raw, {"operation", "workspace", "files"})
        result = {"operation": operation, "files": docx_to_pdf(root, raw)}
    elif operation == "merge":
        reject_unknown(raw, {"operation", "workspace", "sources", "out"})
        result = {"operation": operation, **merge_all(root, raw)}
    else:
        fail(EXIT_INVALID_CONTENT, "operation 只能是 rename、group、docx-to-pdf 或 merge。")
    out_path = Path(args.out).resolve()
    write_extracted(result, out_path)
    succeeded(out_path, operation=operation)


if __name__ == "__main__":
    main()
