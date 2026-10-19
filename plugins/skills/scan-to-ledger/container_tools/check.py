#!/usr/bin/env python3
"""已解析文本 → 台账或纪要。不识别图片，不访问网络。

每一格都要能在原文里对上，否则停。台账按行核对，避免把两行的金额和摘要拼在一起。
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT.parent / "_shared"))

from evowork_skill import (  # noqa: E402
    EXIT_INVALID_CONTENT,
    fail,
    read_content,
    succeeded,
    write_extracted,
)

MAX_SOURCE_CHARS = 2_000_000
MAX_ROWS = 200
KINDS = {"text", "number", "integer", "currency", "date"}
PLAIN_NUMBER = re.compile(r"-?(?:0|[1-9]\d*)(?:\.\d+)?")
COMMA_NUMBER = re.compile(r"-?(?:0|[1-9]\d{0,2})(?:,\d{3})+(?:\.\d+)?")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def require_text(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(EXIT_INVALID_CONTENT, f"{where} 不能为空。")
    return value.strip()


def numeric_key(value: str) -> str | None:
    if PLAIN_NUMBER.fullmatch(value) or COMMA_NUMBER.fullmatch(value):
        return value.replace(",", "")
    return None


def numeric_pattern(key: str) -> re.Pattern[str]:
    negative = key.startswith("-")
    body = key[1:] if negative else key
    whole, _, frac = body.partition(".")
    groups: list[str] = []
    rest = whole
    while rest:
        groups.append(re.escape(rest[-3:]))
        rest = rest[:-3]
    pattern = ",?".join(reversed(groups))
    if frac:
        pattern += r"\." + re.escape(frac)
    if negative:
        pattern = "-" + pattern
    return re.compile(pattern)


def touches_number(char: str) -> bool:
    # 空字符串是任何字符串的子串，不能拿 `char in ".,"` 判断行首行尾。
    return bool(char) and (char.isdigit() or char in ".,")


def spans(needle: str, haystack: str, *, bound_digits: bool) -> list[tuple[int, int]]:
    found: list[tuple[int, int]] = []
    start = 0
    while True:
        index = haystack.find(needle, start)
        if index < 0:
            return found
        end = index + len(needle)
        if bound_digits:
            before = haystack[index - 1] if index else ""
            after = haystack[end] if end < len(haystack) else ""
            if touches_number(before) or touches_number(after):
                start = index + 1
                continue
        found.append((index, end))
        start = index + 1


def numeric_spans(key: str, haystack: str) -> list[tuple[int, int]]:
    found: list[tuple[int, int]] = []
    for match in numeric_pattern(key).finditer(haystack):
        start, end = match.span()
        before = haystack[start - 1] if start else ""
        after = haystack[end] if end < len(haystack) else ""
        if touches_number(before) or touches_number(after):
            continue
        found.append((start, end))
    return found


def date_forms(value: str) -> list[str] | None:
    if ISO_DATE.fullmatch(value) is None:
        return None
    try:
        day = datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return None
    year, month, day_num = day.year, day.month, day.day
    forms = [
        f"{year:04d}-{month:02d}-{day_num:02d}",
        f"{year:04d}/{month:02d}/{day_num:02d}",
        f"{year:04d}.{month:02d}.{day_num:02d}",
        f"{year:04d}/{month}/{day_num}",
        f"{year:04d}.{month}.{day_num}",
        f"{year}年{month}月{day_num}日",
        f"{year}年{month:02d}月{day_num:02d}日",
    ]
    seen: set[str] = set()
    unique: list[str] = []
    for form in forms:
        if form not in seen:
            seen.add(form)
            unique.append(form)
    return unique


def cell_spans(value: str, kind: str, haystack: str) -> list[tuple[int, int]]:
    if kind == "date":
        forms = date_forms(value)
        if not forms:
            return []
        found: list[tuple[int, int]] = []
        for form in forms:
            found.extend(spans(form, haystack, bound_digits=form[-1].isdigit()))
        return found
    key = numeric_key(value)
    if key is not None and kind in ("text", "number", "integer", "currency"):
        return numeric_spans(key, haystack)
    if kind == "text":
        return spans(value, haystack, bound_digits=False)
    return []


def fits(haystack: str, cells: list[tuple[str, str]]) -> bool:
    """同一段文字里要同时出现这些格子。顺序不限，但不能跨段拼。"""
    located = [cell_spans(value, kind, haystack) for value, kind in cells]
    if any(not item for item in located):
        return False
    return True


def read_source(path: Path) -> str:
    if not path.is_file():
        fail(
            EXIT_INVALID_CONTENT,
            "找不到原文。本技能只读工作区里已经解析好的文本，不识别图片，也不调用云端识别。",
        )
    data = path.read_bytes()
    if data.startswith((b"\x89PNG", b"\xff\xd8\xff", b"%PDF", b"PK")):
        fail(
            EXIT_INVALID_CONTENT,
            "原文是图片、PDF 或压缩包。本技能不识别，也不调用云端识别。请先用本机解析得到文本。",
        )
    if b"\x00" in data[:4096]:
        fail(
            EXIT_INVALID_CONTENT,
            "原文不是文本。本技能不识别图片，也不调用云端识别。",
        )
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        fail(EXIT_INVALID_CONTENT, "原文不是 UTF-8 文本。本技能不转写，也不调用云端识别。")
    if len(text) > MAX_SOURCE_CHARS:
        fail(
            EXIT_INVALID_CONTENT,
            f"原文超过 {MAX_SOURCE_CHARS} 字。本技能不会截断后再核对，请先把文本拆开。",
        )
    if not text.strip():
        fail(EXIT_INVALID_CONTENT, "原文是空的。")
    return text


def reject_unknown(raw: dict, allowed: set[str]) -> None:
    extra = set(raw) - allowed
    if extra:
        fail(EXIT_INVALID_CONTENT, "内容 JSON 有未声明的字段。")


def as_number(value: str, kind: str) -> int | float:
    key = numeric_key(value)
    if key is None:
        fail(EXIT_INVALID_CONTENT, f"{kind} 列要按原文抄成数字，不要改写成别的格式。")
    if kind == "integer" and "." in key:
        fail(EXIT_INVALID_CONTENT, "整数列里出现了小数。")
    if "." in key:
        return float(key)
    return int(key)


def sheet_column(column: dict) -> dict:
    emitted = {"header": column["header"], "type": column["type"]}
    if column["formula"]:
        emitted["formula"] = column["formula"]
    return emitted


def ledger(raw: dict, source: str) -> dict:
    title = require_text(raw.get("title"), "title")
    sheet_name = require_text(raw.get("sheet"), "sheet")
    if len(sheet_name) > 31 or re.search(r"[:\\/?*\[\]]", sheet_name):
        fail(EXIT_INVALID_CONTENT, "sheet 不能超过 31 字，也不能含 : \\ / ? * [ ]。")
    columns = raw.get("columns")
    rows = raw.get("rows")
    if not isinstance(columns, list) or not columns:
        fail(EXIT_INVALID_CONTENT, "columns 至少要有一列。")
    if len(columns) > 12:
        fail(EXIT_INVALID_CONTENT, "列超过 12 个。拆成两张表，不要截断。")
    if not isinstance(rows, list) or not rows:
        fail(EXIT_INVALID_CONTENT, "rows 至少要有一行。")
    if len(rows) > MAX_ROWS:
        fail(EXIT_INVALID_CONTENT, f"行超过 {MAX_ROWS}。拆开再入账，不要截断。")
    parsed_columns = []
    for index, column in enumerate(columns):
        if not isinstance(column, dict):
            fail(EXIT_INVALID_CONTENT, f"columns/{index} 必须是对象。")
        kind = column.get("type", "text")
        if kind not in KINDS:
            fail(EXIT_INVALID_CONTENT, f"columns/{index}/type 不支持。")
        formula = column.get("formula")
        if formula is not None:
            if not isinstance(formula, str) or not formula.startswith("="):
                fail(EXIT_INVALID_CONTENT, f"columns/{index}/formula 必须以 = 开头。")
            if re.search(r"\d", formula):
                fail(EXIT_INVALID_CONTENT, "公式里不能写死数字。原文里的数请单独成列抄进来。")
            if kind not in ("number", "integer", "currency"):
                fail(EXIT_INVALID_CONTENT, "只有数值列可以带公式。")
        known = {"header", "type", "formula"}
        if set(column) - known:
            fail(EXIT_INVALID_CONTENT, f"columns/{index} 有未声明的字段。")
        parsed_columns.append(
            {
                "header": require_text(column.get("header"), f"columns/{index}/header"),
                "type": kind,
                "formula": formula,
            }
        )
    lines = source.splitlines() or [source]
    emitted_rows = []
    for row_index, row in enumerate(rows):
        if not isinstance(row, list) or len(row) != len(parsed_columns):
            fail(EXIT_INVALID_CONTENT, f"rows/{row_index} 的列数和 columns 不一致。")
        grounded: list[tuple[str, str]] = []
        emitted: list[object] = []
        for col_index, column in enumerate(parsed_columns):
            value = row[col_index]
            if column["formula"]:
                if value is not None:
                    fail(EXIT_INVALID_CONTENT, f"rows/{row_index} 的公式列必须是 null。")
                emitted.append(None)
                continue
            if not isinstance(value, str) or not value.strip():
                fail(EXIT_INVALID_CONTENT, f"rows/{row_index} 有空格子。不要用空字符串占位。")
            text = value.strip()
            if column["type"] == "date" and date_forms(text) is None:
                fail(EXIT_INVALID_CONTENT, "日期列必须是 YYYY-MM-DD。")
            if column["type"] in ("number", "integer", "currency") and numeric_key(text) is None:
                fail(EXIT_INVALID_CONTENT, "数值列要按原文抄，例如 128.00 或 1,280.50。")
            grounded.append((text, column["type"]))
            if column["type"] in ("number", "integer", "currency"):
                emitted.append(as_number(text, column["type"]))
            else:
                emitted.append(text)
        if not any(fits(line, grounded) for line in lines):
            fail(
                EXIT_INVALID_CONTENT,
                "有一行在原文的同一行里对不上。按原文逐字抄，不要把两行拼在一起，也不要补原文没有的数。",
            )
        emitted_rows.append(emitted)
    sheet: dict = {
        "name": sheet_name,
        "columns": [sheet_column(column) for column in parsed_columns],
        "rows": emitted_rows,
        "freeze_header": True,
    }
    if raw.get("total_row") is True:
        sheet["total_row"] = True
    elif raw.get("total_row") not in (None, False):
        fail(EXIT_INVALID_CONTENT, "total_row 只能是 true 或 false。")
    return {"title": title, "sheets": [sheet]}


def minutes(raw: dict, source: str) -> dict:
    title = require_text(raw.get("title"), "title")
    date = require_text(raw.get("date"), "date")
    if date_forms(date) is None:
        fail(EXIT_INVALID_CONTENT, "date 必须是 YYYY-MM-DD。")
    attendees = raw.get("attendees")
    decisions = raw.get("decisions")
    actions = raw.get("actions")
    if not isinstance(attendees, list) or not attendees:
        fail(EXIT_INVALID_CONTENT, "attendees 至少要有一个人。")
    if not isinstance(decisions, list) or not decisions:
        fail(EXIT_INVALID_CONTENT, "decisions 至少要有一条决议。")
    if not isinstance(actions, list) or not actions:
        fail(EXIT_INVALID_CONTENT, "actions 至少要有一条待办。")
    people = [require_text(item, f"attendees/{index}") for index, item in enumerate(attendees)]
    decision_items = [require_text(item, f"decisions/{index}") for index, item in enumerate(decisions)]
    if not fits(source, [(date, "date")]):
        fail(EXIT_INVALID_CONTENT, "日期在原文里对不上。不要换算原文没有写出的那一天。")
    for person in people:
        if not fits(source, [(person, "text")]):
            fail(EXIT_INVALID_CONTENT, "有参会人在原文里对不上。不要补原文没有的人。")
    for item in decision_items:
        if not fits(source, [(item, "text")]):
            fail(EXIT_INVALID_CONTENT, "有决议在原文里对不上。不要补原文没有的决议。")
    rows = []
    for index, action in enumerate(actions):
        if not isinstance(action, dict):
            fail(EXIT_INVALID_CONTENT, f"actions/{index} 必须是对象。")
        if set(action) - {"task", "owner", "due"}:
            fail(EXIT_INVALID_CONTENT, f"actions/{index} 有未声明的字段。")
        task = require_text(action.get("task"), f"actions/{index}/task")
        owner = require_text(action.get("owner"), f"actions/{index}/owner")
        due = require_text(action.get("due"), f"actions/{index}/due")
        if date_forms(due) is None:
            fail(EXIT_INVALID_CONTENT, "待办截止日期必须是 YYYY-MM-DD。")
        cells = [(task, "text"), (owner, "text"), (due, "date")]
        if not any(fits(line, cells) for line in source.splitlines()):
            fail(
                EXIT_INVALID_CONTENT,
                "有待办在原文的同一行里对不上。事项、负责人和日期都要按原文抄，不要拼到一起。",
            )
        rows.append([task, owner, due])
    return {
        "template": "memo",
        "title": title,
        "date": date,
        "blocks": [
            {"block": "paragraph", "text": "参会：" + "、".join(people)},
            {"block": "heading", "level": 1, "text": "决议"},
            {"block": "bullets", "items": decision_items},
            {"block": "heading", "level": 1, "text": "待办"},
            {"block": "table", "header": ["事项", "负责人", "截止日期"], "rows": rows},
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="把已解析文本核对成台账或纪要内容 JSON")
    parser.add_argument("--content", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    raw = read_content(Path(args.content).resolve())
    output = raw.get("output")
    if output == "ledger":
        reject_unknown(raw, {"output", "source", "title", "sheet", "columns", "rows", "total_row"})
    elif output == "minutes":
        reject_unknown(raw, {"output", "source", "title", "date", "attendees", "decisions", "actions"})
    else:
        fail(EXIT_INVALID_CONTENT, "output 只能是 ledger 或 minutes。")
    source_path = raw.get("source")
    if not isinstance(source_path, str) or not source_path.strip():
        fail(EXIT_INVALID_CONTENT, "source 必须是工作区里的文本路径。不要把原文嵌进 JSON。")
    source = read_source(Path(source_path.strip()).expanduser())
    content = ledger(raw, source) if output == "ledger" else minutes(raw, source)
    out_path = Path(args.out).resolve()
    write_extracted(content, out_path)
    succeeded(out_path, output=output)


if __name__ == "__main__":
    main()
