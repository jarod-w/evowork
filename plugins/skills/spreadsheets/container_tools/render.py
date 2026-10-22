#!/usr/bin/env python3
"""内容 JSON → xlsx / csv。08 §5.2 的第二个技能。

## 这个技能的立身之本：**公式而非硬编码结果**

08 §5.2 把它列为关键质量点，而它的落点就在这个文件与 schema 里：
计算列在内容 JSON 里给的是**公式模板**（`"=B{row}*C{row}"`），渲染器按行展开写进单元格。

为什么这条比"数字对不对"更重要：用户拿到表之后会改数。如果单元格里是算好的常量，
改了输入列，合计与占比纹丝不动 —— 而它看起来完全正常。这种错会一路带进汇报。
所以 schema 强制"给了 formula 的列，rows 里对应位置必须是 null"，
渲染器再校验一次（schema 表达不了这种跨字段约束）。

csv 属于**基础包**（不需要办公扩展），xlsx 需要 openpyxl。这一点在 SKILL.md 里说清了，
因为它决定了"没装扩展时还能不能干活"。
"""

from __future__ import annotations

import argparse
import bisect
import csv
import datetime
import math
import posixpath
import re
import sys
import warnings
import zipfile
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from xml.etree import ElementTree

SKILL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT.parent / "_shared"))

from evowork_skill import (  # noqa: E402
    ensure_office_runtime,
    EXIT_INVALID_CONTENT,
    EXIT_RUNTIME_MISSING,
    fail,
    lossy_extraction,
    refuse_overwrite,
    read_content,
    runtime_missing_message,
    succeeded,
    validate_content,
    write_extracted,
)

MAX_COLUMNS = 60


def load_template() -> dict:
    return read_content(SKILL_ROOT / "templates" / "default" / "template.json")


def column_letter(index: int) -> str:
    """0 → A、25 → Z、26 → AA。自己写是为了让 csv 路径不依赖 openpyxl。"""
    letters = ""
    index += 1
    while index > 0:
        index, rem = divmod(index - 1, 26)
        letters = chr(ord("A") + rem) + letters
    return letters


def validate(content: dict) -> None:
    validate_content(content, SKILL_ROOT / "schema" / "content.schema.json")

    for sheet_index, sheet in enumerate(content["sheets"]):
        columns = sheet["columns"]
        where = f"sheets/{sheet_index}"
        formula_positions = [i for i, c in enumerate(columns) if c.get("formula")]

        for row_index, row in enumerate(sheet["rows"]):
            if len(row) != len(columns):
                fail(
                    EXIT_INVALID_CONTENT,
                    f"{where}/rows/{row_index}: 这一行有 {len(row)} 个单元格，"
                    f"但 columns 有 {len(columns)} 列，两者必须一样长"
                    f"（计算列的位置写 null）。",
                )
            for position in formula_positions:
                if row[position] is not None:
                    # 这条就是这个技能存在的理由，所以报错要说清"为什么"
                    fail(
                        EXIT_INVALID_CONTENT,
                        f"{where}/rows/{row_index}/{position}: 「{columns[position]['header']}」"
                        f"是计算列（有 formula），这里必须是 null。"
                        f"填算好的数会让用户改了输入列之后结果不更新，而且看不出来。",
                    )

        headers = [c["header"] for c in columns]
        if len(set(headers)) != len(headers):
            fail(EXIT_INVALID_CONTENT, f"{where}/columns: 表头有重名，公式与条件格式会指错列。")

        for fmt_index, fmt in enumerate(sheet.get("conditional_formats", [])):
            if fmt["column"] not in headers:
                fail(
                    EXIT_INVALID_CONTENT,
                    f"{where}/conditional_formats/{fmt_index}: 找不到列「{fmt['column']}」。",
                )

    problem = unmatched_criteria(content)
    if problem:
        fail(EXIT_INVALID_CONTENT, problem)


# ─────────────────────────── 条件汇总的条件一个都对不上 ───────────────────────────
#
# 2026-09-28 外部测试 A4：汇总表写成 `=SUMIF(存款!$A$2:$A$19, A2, 存款!$C$2:$C$19)`，
# A2 是「华北区」，而存款!A 列装的是 B001…B018 —— 条件永远不成立，三个区域的合计**全是 0**。
# 两轮都是这样交付的，模型自己的核对脚本也是绿的：它按原始数据重算了一遍区域合计，
# 却没有去算单元格里的公式（本机没有公式引擎），于是"我算的对"与"表里的公式对"被当成了一回事。
#
# 渲染器手里有每一格的值，所以这件事在这里判得出来，不需要公式引擎：
# 条件取自单元格（每行一个键，典型的"按区域汇总"）、而**这一列没有任何一行**在条件区域里找到
# 同样的值 —— 那几乎一定是条件区域指错了列。只要有一行对上就放行（某个分组本来就可以是 0）；
# 条件是字面量（`"逾期"`）时也放行：「没有逾期」是一个合法的 0。

CONDITIONAL_AGGREGATES = {
    # 函数名 → 从哪个参数开始是 (条件区域, 条件) 对、步长
    "SUMIF": (0, None),
    "COUNTIF": (0, None),
    "AVERAGEIF": (0, None),
    "SUMIFS": (1, 2),
    "AVERAGEIFS": (1, 2),
    "COUNTIFS": (0, 2),
}
FUNCTION_CALL = re.compile(
    r"(?<![A-Za-z0-9_.])(SUMIFS|SUMIF|COUNTIFS|COUNTIF|AVERAGEIFS|AVERAGEIF)\s*\(", re.IGNORECASE
)
SHEET_PREFIX = r"(?:'(?P<quoted>(?:[^']|'')+)'|(?P<bare>[^\s!'(),:;&=<>+\-*/^\"]+))!"
CELL = r"\$?(?P<{0}c>[A-Za-z]{{1,3}})\$?(?P<{0}r>\d+)"
CELL_REF = re.compile(rf"^(?:{SHEET_PREFIX})?{CELL.format('a')}$")
RANGE_REF = re.compile(
    rf"^(?:{SHEET_PREFIX})?(?:{CELL.format('a')}:{CELL.format('b')}"
    r"|\$?(?P<acol>[A-Za-z]{1,3}):\$?(?P<bcol>[A-Za-z]{1,3}))$"
)
UNKNOWN = object()  # 公式格：值要等 Excel 算，这里不知道


def column_index(letters: str) -> int:
    index = 0
    for char in letters.upper():
        index = index * 26 + (ord(char) - ord("A") + 1)
    return index - 1


def sheet_grid(sheet: dict) -> dict[tuple[int, int], object]:
    """(Excel 行号, 列下标) → 渲染后那一格的值，与 `render_xlsx` 写的位置一一对应。"""
    columns = sheet["columns"]
    grid: dict[tuple[int, int], object] = {}
    for col_index, column in enumerate(columns):
        grid[(1, col_index)] = column["header"]
    for row_index, row in enumerate(sheet["rows"]):
        for col_index, column in enumerate(columns):
            grid[(row_index + 2, col_index)] = UNKNOWN if column.get("formula") else row[col_index]
    last_row = len(sheet["rows"]) + 1
    if sheet.get("total_row") and last_row >= 2:
        grid[(last_row + 1, 0)] = "合计"
        for col_index, column in enumerate(columns):
            if col_index > 0 and column.get("type", "text") in ("number", "integer", "currency"):
                grid[(last_row + 1, col_index)] = UNKNOWN
    if sheet.get("note"):
        grid[(last_row + 3, 0)] = sheet["note"]
    return grid


def split_arguments(formula: str, open_paren: int) -> list[str] | None:
    """从 `(` 之后切到配对的 `)`，按顶层逗号分参数。引号里的逗号与括号不算。"""
    args, depth, start, index, in_string = [], 0, open_paren + 1, open_paren + 1, False
    while index < len(formula):
        char = formula[index]
        if in_string:
            if char == '"':
                if formula[index + 1 : index + 2] == '"':
                    index += 1
                else:
                    in_string = False
        elif char == '"':
            in_string = True
        elif char == "(":
            depth += 1
        elif char == ")":
            if depth == 0:
                args.append(formula[start:index].strip())
                return args
            depth -= 1
        elif char == "," and depth == 0:
            args.append(formula[start:index].strip())
            start = index + 1
        index += 1
    return None


def ref_sheet(match: re.Match, here: str) -> str:
    if match.group("quoted") is not None:
        return match.group("quoted").replace("''", "'")
    return match.group("bare") or here


def range_values(ref: str, here: str, grids: dict) -> tuple[str, str, list] | None:
    match = RANGE_REF.match(ref)
    if not match:
        return None
    sheet = ref_sheet(match, here)
    grid = grids.get(sheet)
    if grid is None:
        return None
    if match.group("acol"):
        first, last = column_index(match.group("acol")), column_index(match.group("bcol"))
        rows = range(1, max((r for r, _ in grid), default=1) + 1)
    else:
        first, last = column_index(match.group("ac")), column_index(match.group("bc"))
        rows = range(int(match.group("ar")), int(match.group("br")) + 1)
    values = [grid.get((r, c)) for r in rows for c in range(first, last + 1)]
    if any(value is UNKNOWN for value in values):
        return None
    headers = [grid.get((1, c)) for c in range(first, last + 1)]
    return sheet, ref.split("!")[-1], values, [h for h in headers if h]


def criterion_value(ref: str, here: str, grids: dict) -> tuple[object, str, object, str] | None:
    """只认"条件就是一个单元格"：`A2` / `汇总!$A2`。其余（字面量、拼接、带运算符）一律不判。"""
    match = CELL_REF.match(ref)
    if not match:
        return None
    sheet = ref_sheet(match, here)
    grid = grids.get(sheet)
    if grid is None:
        return None
    column = column_index(match.group("ac"))
    value = grid.get((int(match.group("ar")), column))
    if value is UNKNOWN or value is None:
        return None
    if isinstance(value, str) and (value[:1] in "<>=" or any(ch in value for ch in "*?~")):
        return None  # 运算符与通配符：语义是"满足条件"，不是"等于"
    return value, sheet, grid.get((1, column)), f"{match.group('ac').upper()}{match.group('ar')}"


def normalized(value: object) -> object:
    """Excel 的条件比较：文本不分大小写；"1001" 与 1001 视为相等。"""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    try:
        return float(text)
    except ValueError:
        return text.casefold()


def unmatched_criteria(content: dict) -> str | None:
    grids = {sheet["name"]: sheet_grid(sheet) for sheet in content["sheets"]}
    for sheet in content["sheets"]:
        for column in sheet["columns"]:
            template = column.get("formula")
            if not template:
                continue
            # 同一列里第 k 个条件对：每一行都对不上才算问题
            checked: dict[int, dict] = {}
            for row_index in range(len(sheet["rows"])):
                formula = expand_formula(template, row_index + 2)
                pair_index = 0
                for call in FUNCTION_CALL.finditer(formula):
                    args = split_arguments(formula, call.end() - 1)
                    if args is None:
                        continue
                    first, step = CONDITIONAL_AGGREGATES[call.group(1).upper()]
                    pairs = [(first, first + 1)] if step is None else [
                        (i, i + 1) for i in range(first, len(args) - 1, step)
                    ]
                    for range_at, criterion_at in pairs:
                        pair_index += 1
                        if criterion_at >= len(args):
                            continue
                        span = range_values(args[range_at], sheet["name"], grids)
                        wanted = criterion_value(args[criterion_at], sheet["name"], grids)
                        if span is None or wanted is None:
                            continue
                        state = checked.setdefault(
                            pair_index,
                            {"call": call.group(1).upper(), "span": span, "keys": [], "hit": False},
                        )
                        keys = {normalized(v) for v in span[2] if v is not None and v != ""}
                        state["keys"].append(wanted)
                        state["hit"] = state["hit"] or normalized(wanted[0]) in keys
            for state in checked.values():
                if state["hit"] or not state["keys"]:
                    continue
                # **报错里只有表名、列名与地址，不带单元格里的值**（本技能「失败输出不含用户内容」
                # 那条，Q14 同口径）。列名已经足够让模型看出"区域 ≠ 机构代码"
                target_sheet, target_ref, _values, target_headers = state["span"]
                _value, key_sheet, key_header, _cell = state["keys"][0]
                cells = [key[3] for key in state["keys"]]
                where_keys = cells[0] if len(cells) == 1 else f"{cells[0]}…{cells[-1]}"
                key_column = f"「{key_header}」列" if key_header else "那几格"
                target_column = (
                    "、".join(f"「{h}」" for h in target_headers) + "列" if target_headers else "那片区域"
                )
                return (
                    f"「{sheet['name']}」的「{column['header']}」用 {state['call']} 拿 "
                    f"{key_sheet}!{where_keys}（{key_column}）去 {target_sheet}!{target_ref}"
                    f"（{target_column}）里找，{len(cells)} 行一行都对不上 "
                    f"—— 这些格子在 Excel 里全会算成 0，而表看起来完全正常。"
                    f"条件与条件区域装的不是同一种值：条件区域指错了列。"
                    f"按分组汇总时，先让明细表里有分组那一列（比如在明细表加「区域」列），"
                    f"再对那一列写条件。"
                )
    return None


def expand_formula(template: str, row_number: int) -> str:
    return template.replace("{row}", str(row_number))


ISO_DATE = re.compile(
    r"^([0-9]{4})[-/]([0-9]{1,2})[-/]([0-9]{1,2})(?:[ T]([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?)?$"
)


def date_cell_value(value: object) -> object:
    """date 列里的 `2026-09-05` 写成**真日期**，不是一串字。

    2026-10-22 之前这里原样写字符串，再套 yyyy-mm-dd 格式 —— 看起来是日期，
    但 Excel 里不能按日期排序筛选、不能相减，提取再写回时用户原来的真日期也会变成字。
    写不成日期的字（「待定」、`2026-02-30`）原样保留。
    """
    if not isinstance(value, str):
        return value
    match = ISO_DATE.match(value.strip())
    if match is None:
        return value
    year, month, day, hour, minute, second = match.groups()
    try:
        if hour is None:
            return datetime.date(int(year), int(month), int(day))
        return datetime.datetime(
            int(year), int(month), int(day), int(hour), int(minute), int(second or 0)
        )
    except ValueError:
        return value


def write_csv(sheet: dict, out_path: Path) -> None:
    """csv 没有公式，所以计算列**留空并在表头标注**，而不是悄悄算一个值填进去。

    这是一次显式降级（D2 的同一条原则）：用户看到空列会去问，看到一个算好的数不会。
    """
    columns = sheet["columns"]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8-sig", newline="") as handle:
        # utf-8-sig：Excel 打开无 BOM 的 UTF-8 csv 会把中文显示成乱码
        writer = csv.writer(handle)
        writer.writerow(
            [f"{c['header']}（公式列，csv 不支持）" if c.get("formula") else c["header"] for c in columns]
        )
        for row in sheet["rows"]:
            writer.writerow(["" if value is None else value for value in row])


def render_xlsx(content: dict, out_path: Path) -> None:
    try:
        from openpyxl import Workbook
        from openpyxl.formatting.rule import CellIsRule, DataBarRule
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter
    except ModuleNotFoundError:
        fail(EXIT_RUNTIME_MISSING, runtime_missing_message("office", "生成 xlsx"))

    template = load_template()
    formats = template["number_formats"]
    widths = template["default_widths"]
    header_spec = template["header"]
    colors = template["colors"]

    book = Workbook()
    book.remove(book.active)

    for sheet_spec in content["sheets"]:
        sheet = book.create_sheet(sheet_spec["name"])
        columns = sheet_spec["columns"]

        for index, column in enumerate(columns):
            cell = sheet.cell(row=1, column=index + 1, value=column["header"])
            cell.font = Font(
                bold=header_spec["bold"],
                color=header_spec["font_color"],
                name=header_spec["font_cjk"],
            )
            cell.fill = PatternFill("solid", fgColor=header_spec["fill"])
            cell.alignment = Alignment(vertical="center", wrap_text=True)
            kind = column.get("type", "text")
            sheet.column_dimensions[get_column_letter(index + 1)].width = column.get(
                "width", widths[kind]
            )

        for row_index, row in enumerate(sheet_spec["rows"]):
            excel_row = row_index + 2
            for col_index, column in enumerate(columns):
                kind = column.get("type", "text")
                if column.get("formula"):
                    value = expand_formula(column["formula"], excel_row)
                elif kind == "date":
                    value = date_cell_value(row[col_index])
                else:
                    value = row[col_index]
                cell = sheet.cell(row=excel_row, column=col_index + 1, value=value)
                cell.number_format = formats[kind]
                if kind != "text":
                    cell.font = Font(name=header_spec["font_cjk"])

        last_row = len(sheet_spec["rows"]) + 1

        if sheet_spec.get("total_row") and last_row >= 2:
            total_row = last_row + 1
            sheet.cell(row=total_row, column=1, value="合计").font = Font(bold=True)
            for col_index, column in enumerate(columns):
                # A 列放「合计」两个字。第一列是数字（序号）时也不在这里写 SUM ——
                # 2026-10-22 之前会把「合计」覆盖成序号之和，合计行就认不出来了
                if col_index > 0 and column.get("type", "text") in ("number", "integer", "currency"):
                    letter = get_column_letter(col_index + 1)
                    # 合计也是公式：用户删掉几行之后它要跟着变
                    cell = sheet.cell(
                        row=total_row,
                        column=col_index + 1,
                        value=f"=SUM({letter}2:{letter}{last_row})",
                    )
                    cell.number_format = formats[column.get("type", "number")]
                    cell.font = Font(bold=True, name=header_spec["font_cjk"])

        # 冻结首行默认开：表格超过一屏时不冻结就没法看
        if sheet_spec.get("freeze_header", True):
            sheet.freeze_panes = "A2"

        headers = [c["header"] for c in columns]
        for fmt in sheet_spec.get("conditional_formats", []):
            letter = get_column_letter(headers.index(fmt["column"]) + 1)
            span = f"{letter}2:{letter}{last_row}"
            rule = fmt["rule"]
            if rule == "negative-red":
                sheet.conditional_formatting.add(
                    span,
                    CellIsRule(operator="lessThan", formula=["0"], font=Font(color=colors["negative"])),
                )
            elif rule == "above-average-green":
                sheet.conditional_formatting.add(
                    span,
                    CellIsRule(
                        operator="greaterThan",
                        formula=[f"AVERAGE({span})"],
                        font=Font(color=colors["positive"]),
                    ),
                )
            elif rule == "top10-green":
                sheet.conditional_formatting.add(
                    span,
                    CellIsRule(
                        operator="greaterThanOrEqual",
                        formula=[f"LARGE({span},10)"],
                        font=Font(color=colors["positive"]),
                    ),
                )
            elif rule == "data-bar":
                # 起止两端必须给：只给颜色时 openpyxl 直接抛 ValueError（2026-10-22 之前
                # SKILL.md 示例里的 data-bar 一用就是一屏堆栈）
                sheet.conditional_formatting.add(
                    span, DataBarRule(start_type="min", end_type="max", color=colors["data_bar"])
                )

        if sheet_spec.get("note"):
            sheet.cell(row=last_row + 3, column=1, value=sheet_spec["note"])

    out_path.parent.mkdir(parents=True, exist_ok=True)
    book.save(out_path)


# ─────────────────────────── 提取：已有文件 → 内容 JSON ───────────────────────────
#
# 改已有文件的流程是「提取 → 改 JSON → 重新渲染」。渲染器写得出来的东西是有限的：
# 从 A1 开始的一行表头、数据行、可选的合计行与备注、四种条件格式、冻结首行。
# 用户的文件远不止这些，所以提取只守一条纪律：**收得回来的原样收回，收不回来的报出来**
# （`_dropped` → evowork_skill.lossy_extraction：默认拒绝，`--allow-lossy` 才继续）。
#
# 2026-10-22 修的几处，都是"返回 ok，但内容已经变了"：
#   · 第一行是合并的标题（A1:D1）→ 标题被当成表头，B–D 列整列不见；
#   · 公式模板按字符串替换行号 → 一行数据时 `=A2*1.2` 收成 `=A{row}*1.{row}`，
#     新加的行里常量跟着行号变；多行时 `=A2/A$12` 又被误判成"各行模板不同"；
#   · 本技能自己写的备注读回来变成一行数据，前面还垫两行空行；
#   · `"¥"#,##0.00` 这种常见的货币格式不认识，合计行的 SUM 被说成"写死的数"；真日期读回来成了字。

FORMULA_HEADER_MARK = "（公式列，csv 不支持）"
TOTAL_LABEL = "合计"
NUMERIC_KINDS = ("number", "integer", "currency")
MAX_DATA_ROWS = 50000
MAX_NOTE = 300  # schema 的 note.maxLength


def _missing(path: Path) -> None:
    if not path.is_file():
        fail(EXIT_INVALID_CONTENT, f"找不到要提取的文件：{path.name}。")


# ── 公式切词 ──
#
# 行号只能在**单元格引用**里改，而且只改相对行号：字符串（`"第2档"`）、数字常量（`1.2`）、
# 函数名（`LOG10(`）、名称（`Q3销量`）里都可能出现和行号一样的数字，`$12` 的 2 也不是行号。
# 所以先切词，再只动 ref 里的行号。

_CELL_PART = r"(?P<{p}cd>\$?)(?P<{p}c>[A-Za-z]{{1,3}})(?P<{p}rd>\$?)(?P<{p}r>[0-9]+)"
REF_AT = re.compile(
    r"(?:(?P<sheet>'(?:[^']|'')+'|[^\W\d][\w.]*)!)?"
    r"(?:"
    + _CELL_PART.format(p="a")
    + r"(?::"
    + _CELL_PART.format(p="b")
    + r")?"
    r"|(?P<kd>\$?)(?P<k>[A-Za-z]{1,3}):(?P<ld>\$?)(?P<l>[A-Za-z]{1,3})"
    r"|(?P<md>\$?)(?P<m>[0-9]+):(?P<nd>\$?)(?P<n>[0-9]+)"
    r")(?![\w.(!\[])"
)
NAME_AT = re.compile(r"[^\W\d][\w.]*")
NUMBER_AT = re.compile(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")
ERROR_AT = re.compile(
    r"#(?:NULL!|DIV/0!|VALUE!|REF!|NAME\?|NUM!|N/A|GETTING_DATA|SPILL!|CALC!|FIELD!|BLOCKED!"
    r"|CONNECT!|BUSY!|UNKNOWN!)",
    re.IGNORECASE,
)
EXTERNAL_AT = re.compile(r"\[[0-9]+\][^\s,;()+\-*/^&=<>\"{}]*")
QUOTED_AT = re.compile(r"'(?:[^']|'')*'")


def _bracket_end(formula: str, start: int) -> int:
    depth = 0
    for index in range(start, len(formula)):
        if formula[index] == "[":
            depth += 1
        elif formula[index] == "]":
            depth -= 1
            if depth == 0:
                return index + 1
    return len(formula)


def formula_tokens(formula: str):  # noqa: ANN201
    """切成 (种类, 原文, 匹配)。种类：string · error · external · structured · ref ·
    function · name · number · other。拼回去与原文逐字相同。"""
    index = 0
    while index < len(formula):
        char = formula[index]
        if char == '"':
            end = index + 1
            while end < len(formula):
                if formula[end] == '"':
                    if formula[end + 1 : end + 2] == '"':
                        end += 2
                        continue
                    break
                end += 1
            yield "string", formula[index : end + 1], None
            index = end + 1
            continue
        if char == "#":
            match = ERROR_AT.match(formula, index)
            if match:
                yield "error", match.group(0), None
                index = match.end()
                continue
        if char == "[":
            match = EXTERNAL_AT.match(formula, index)
            end = match.end() if match else _bracket_end(formula, index)
            # `[1]Sheet1!A1` 是别的工作簿；`[@金额]` 是套用格式表格的结构化引用
            yield ("external" if match else "structured"), formula[index:end], None
            index = end
            continue
        match = REF_AT.match(formula, index)
        if match:
            yield "ref", match.group(0), match
            index = match.end()
            continue
        if char == "'":
            match = QUOTED_AT.match(formula, index)
            end = match.end() if match else len(formula)
            yield "other", formula[index:end], None
            index = end
            continue
        match = NAME_AT.match(formula, index)
        if match:
            end = match.end()
            following = formula[end : end + 1]
            if following == "(":
                yield "function", match.group(0), None
            elif following == "[":
                end = _bracket_end(formula, end)
                yield "structured", formula[index:end], None
            else:
                yield "name", match.group(0), None
            index = end
            continue
        match = NUMBER_AT.match(formula, index)
        if match:
            yield "number", match.group(0), None
            index = match.end()
            continue
        yield "other", char, None
        index += 1


def _sheet_name(text: str) -> str:
    return text[1:-1].replace("''", "'") if text.startswith("'") else text


# ── 表格区域 ──


@dataclass
class _Region:
    """一张表里渲染器写得回去的那一块。行号都是**原文件**里的行号。"""

    cells: dict
    header_row: int
    width: int
    data_last: int  # 最后一个数据行；没有数据行时等于 header_row
    total_row: int | None = None
    note: str | None = None
    note_row: int | None = None
    preamble_rows: int = 0  # 表头上面有字的行：标题、「单位：元」
    outside: int = 0  # 区域外有内容的格子
    lost: dict = field(default_factory=dict)  # 列 → 写不回去的行号（排好序），给公式引用检查用

    @property
    def shift(self) -> int:
        """渲染器的表头在第 1 行：原文件的第 header_row 行写回去之后是第 1 行。"""
        return self.header_row - 1

    def touches(self, top: float, bottom: float, left: float, right: float) -> bool:
        for column, rows in self.lost.items():
            if left <= column <= right:
                at = bisect.bisect_left(rows, top)
                if at < len(rows) and rows[at] <= bottom:
                    return True
        return False


def _filled(value: object) -> bool:
    return value is not None and not (isinstance(value, str) and value == "")


def _locate_table(sheet) -> _Region | None:  # noqa: ANN001
    """找出表头、数据行、合计行与备注；其余有内容的格子都算在区域外。

    表头是**第一行有两格以上的字**的那一行。它上面的行最多一格字 —— 标题（合并到表宽或没合并）、
    「单位：元」这类说明 —— 渲染器写不出来，报成「标题行」，而不是把标题当成表头、把右边的列丢掉。
    """
    cells = {
        (cell.row, cell.column): cell for cell in sheet._cells.values() if _filled(cell.value)
    }
    if not cells:
        return None
    per_row = Counter(row for row, _ in cells)
    rows = sorted(per_row)
    header_row = next((row for row in rows if per_row[row] >= 2), rows[0])
    if (header_row, 1) not in cells:
        fail(
            EXIT_INVALID_CONTENT,
            f"「{sheet.title}」第 {header_row} 行的表头不是从 A 列开始的。"
            f"渲染器只会从 A 列写起，提取不会把整张表挪个位置再说成功。",
        )
    width = 1
    while (header_row, width + 1) in cells:
        width += 1
    if width > MAX_COLUMNS:
        fail(EXIT_INVALID_CONTENT, f"「{sheet.title}」超过 {MAX_COLUMNS} 列。")

    body = sorted({row for row, column in cells if row > header_row and column <= width})
    last = body[-1] if body else header_row
    gap = width + 1
    if any(column == gap and header_row < row <= last for row, column in cells):
        fail(
            EXIT_INVALID_CONTENT,
            f"「{sheet.title}」第 {header_row} 行的表头在 {column_letter(gap - 1)} 列是空的，"
            f"但这一列下面有数据。提取只认表头连续的列，会把这一列和右边的列一起丢掉；"
            f"先补上表头再提取。",
        )

    # 备注：渲染器把它写在数据（或合计行）下面隔开的一行、只占 A 列
    note = note_row = None
    if width >= 2 and last >= header_row + 2:
        anchor = cells.get((last, 1))
        alone = anchor is not None and all((last, c) not in cells for c in range(2, width + 1))
        blank_above = all((last - 1, c) not in cells for c in range(1, width + 1))
        if alone and blank_above and anchor.data_type == "s" and len(anchor.value) <= MAX_NOTE:
            note, note_row = anchor.value, last
            last = max((row for row in body if row < note_row), default=header_row)

    total_row = None
    label = cells.get((last, 1))
    if (
        last >= header_row + 2
        and label is not None
        and isinstance(label.value, str)
        and label.value.strip() == TOTAL_LABEL
    ):
        total_row = last
    data_last = last - 1 if total_row else last
    if data_last - header_row > MAX_DATA_ROWS:
        fail(
            EXIT_INVALID_CONTENT,
            f"「{sheet.title}」超过 {MAX_DATA_ROWS} 行。把原始数据留给用户，不要提取成内容 JSON。",
        )

    preamble_rows: set[int] = set()
    lost: list[tuple[int, int]] = []
    outside = 0
    for row, column in cells:
        if row < header_row:
            preamble_rows.add(row)
            lost.append((row, column))
        elif column <= width and (row <= data_last or row == total_row):
            continue
        elif (row, column) == (note_row, 1):
            # 渲染器把备注写在最后一个数据行往下第 3 行；位置变了，引用它的公式就指错了
            if note_row != data_last + 3:
                lost.append((row, column))
        else:
            outside += 1
            lost.append((row, column))
    by_column: dict[int, list[int]] = {}
    for row, column in sorted(lost):
        by_column.setdefault(column, []).append(row)
    return _Region(
        cells=cells,
        header_row=header_row,
        width=width,
        data_last=data_last,
        total_row=total_row,
        note=note,
        note_row=note_row,
        preamble_rows=len(preamble_rows),
        outside=outside,
        lost=by_column,
    )


# ── 公式改写成模板 ──


def _rewrite_ref(match: re.Match, here: str, current: int, regions: dict) -> tuple[str, bool]:
    """把一个引用改写成重新渲染之后的样子；第二个值是"它引用了写不回去的东西"。

    写回去之后整张表往上挪 `shift` 行，所以**所有**行号都要减掉目标表的 shift —— 绝对行号也一样
    （`$D$12` 指的是合计行，合计行跟着挪了）。只有相对行号、且挪完正好是当前行时才收成 `{row}`。
    """
    sheet_text = match.group("sheet")
    target = here if sheet_text is None else _sheet_name(sheet_text)
    region = regions.get(target.casefold())
    if target.startswith("[") or region is None:
        # 别的工作簿，或这份工作簿里提取不回来的表：重新渲染之后这个引用就悬空了
        return match.group(0), True
    lost = False

    def row(digits: str, dollar: str) -> str:
        nonlocal lost
        moved = int(digits) - region.shift
        if moved < 1:  # 指向标题行：那几行不会写回去
            lost = True
            moved = 1
        return "{row}" if not dollar and moved == current else str(moved)

    prefix = "" if sheet_text is None else f"{sheet_text}!"
    if match.group("ac"):
        rows = [int(match.group("ar"))]
        columns = [column_index(match.group("ac")) + 1]
        text = f"{match.group('acd')}{match.group('ac')}{match.group('ard')}"
        text += row(match.group("ar"), match.group("ard"))
        if match.group("bc"):
            rows.append(int(match.group("br")))
            columns.append(column_index(match.group("bc")) + 1)
            text += f":{match.group('bcd')}{match.group('bc')}{match.group('brd')}"
            text += row(match.group("br"), match.group("brd"))
        top, bottom, left, right = min(rows), max(rows), min(columns), max(columns)
    elif match.group("k"):
        text = match.group(0)[len(prefix) :]
        columns = [column_index(match.group("k")) + 1, column_index(match.group("l")) + 1]
        top, bottom, left, right = 1, math.inf, min(columns), max(columns)
    else:
        text = f"{match.group('md')}{row(match.group('m'), match.group('md'))}:"
        text += f"{match.group('nd')}{row(match.group('n'), match.group('nd'))}"
        rows = [int(match.group("m")), int(match.group("n"))]
        top, bottom, left, right = min(rows), max(rows), 1, math.inf
    if region.touches(top, bottom, left, right):
        lost = True
    return prefix + text, lost


def _template(formula: str, here: str, row: int, regions: dict, names: set) -> tuple[str, bool]:
    region = regions[here.casefold()]
    current = row - region.shift
    parts: list[str] = []
    lost = False
    for kind, text, match in formula_tokens(formula):
        if kind == "ref":
            text, touched = _rewrite_ref(match, here, current, regions)
            lost = lost or touched
        elif kind in ("external", "structured") or (kind == "name" and text.casefold() in names):
            lost = True  # 别的工作簿、套用格式的表格、定义的名称：都不会写回去
        parts.append(text)
    template = "".join(parts)
    return (template if template.startswith("=") else f"={template}"), lost


SUM_CALL = re.compile(r"^=\s*SUM\s*\(\s*(.+?)\s*\)\s*$", re.IGNORECASE)


def _sums_column(formula: str, here: str, column: int, region: _Region) -> bool:
    """合计格是不是「对本列数据行的 SUM」—— 渲染器写回去的就是这个。"""
    call = SUM_CALL.match(formula)
    ref = REF_AT.fullmatch(call.group(1)) if call else None
    if ref is None or not ref.group("bc"):
        return False
    if ref.group("sheet") is not None and _sheet_name(ref.group("sheet")).casefold() != here.casefold():
        return False
    columns = {column_index(ref.group("ac")) + 1, column_index(ref.group("bc")) + 1}
    top, bottom = sorted((int(ref.group("ar")), int(ref.group("br"))))
    return (
        columns == {column}
        and region.header_row <= top <= region.header_row + 1
        and bottom == region.data_last
    )


# ── 数字格式 → 列类型 ──

RMB_SYMBOLS = ("¥", "￥", "元", "CNY", "RMB")
CURRENCY_SYMBOLS = (*RMB_SYMBOLS, "$", "US$", "HK$", "€", "£", "₩", "₹", "USD", "HKD", "EUR", "JPY", "GBP")


@dataclass
class _Format:
    kind: str | None  # None：General 或认不出类型，交给值去推断
    lossy: bool = False  # 渲染器的六种格式表达不了它的意思（别的货币、单位、缩放、时长……）
    shows_time: bool = False


def _number_format(code: str | None) -> _Format:
    """只看第一节（正数那一节）。颜色与负数写法属于外观，不算丢了意思。"""
    text = (code or "").strip()
    if not text or text.lower() == "general":
        return _Format(None)
    if text == "@":
        return _Format("text")
    plain: list[str] = []
    literals: list[str] = []
    symbols: list[str] = []
    tags: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char == ";":
            break
        if char == '"':
            end = text.find('"', index + 1)
            end = len(text) if end < 0 else end
            literals.append(text[index + 1 : end])
            index = end + 1
            continue
        if char == "\\":
            literals.append(text[index + 1 : index + 2])
            index += 2
            continue
        if char in "_*":  # 对齐占位与填充字符
            index += 2
            continue
        if char == "[":
            end = text.find("]", index)
            end = len(text) if end < 0 else end
            tag = text[index + 1 : end]
            if tag.startswith("$"):
                symbols.append(tag[1:].split("-")[0])  # [$¥-804]、[$USD]
            else:
                tags.append(tag.lower())  # [Red]、[>=100]、[h]、[DBNum1]
            index = end + 1
            continue
        plain.append(char)
        index += 1
    body = "".join(plain)
    worded = False
    for literal in literals:
        if literal.strip() in CURRENCY_SYMBOLS:
            symbols.append(literal.strip())
        elif literal.strip():
            worded = True  # 0"件"、#,##0"万元"：单位是意思的一部分
    symbols.extend(char for char in body if char in "¥￥$€£₩₹")
    lowered = body.lower().replace("am/pm", "").replace("a/p", "")
    if lowered.strip() == "general":
        return _Format(None, lossy=worded)
    if any(tag in ("h", "hh", "m", "mm", "s", "ss") for tag in tags):
        return _Format(None, lossy=True)  # [h]:mm 时长
    special = any(tag.startswith(("dbnum", "<", ">", "=")) for tag in tags)
    if "%" in body:
        return _Format("percent", lossy=worded or special)
    timed = "h" in lowered or "s" in lowered
    # m 挨着 h / s 时是分钟（h:mm、mm:ss），不是月份
    if "y" in lowered or "d" in lowered or ("m" in lowered and not timed):
        return _Format("date", shows_time=timed)
    if timed:
        return _Format(None, lossy=True)  # 只有时间
    placeholders = [body.rfind(char) for char in "0#?"]
    if max(placeholders) < 0:
        return _Format(None, lossy=True)  # `;;;` 把值藏起来、或只显示一段字
    scaled = "," in body[max(placeholders) + 1 :]  # #,##0, 按千显示
    decimals = sum(1 for char in body.split(".", 1)[1] if char in "0#?") if "." in body else 0
    foreign = any(symbol not in RMB_SYMBOLS for symbol in symbols)
    kind = "currency" if symbols else ("number" if decimals else "integer")
    return _Format(kind, lossy=scaled or worded or foreign or special)


def _constant(raw: object, dropped: Counter) -> tuple[object, str, bool]:
    """单元格常量 → (JSON 值, 推断类型用的种类, 是否带时刻)。"""
    if isinstance(raw, bool) or raw is None:
        return raw, "text", False
    if isinstance(raw, int):
        return raw, "int", False
    if isinstance(raw, float):
        if raw.is_integer() and abs(raw) < 2**53:
            return int(raw), "int", False
        return raw, "float", False
    if isinstance(raw, datetime.datetime):
        day = f"{raw.year:04d}-{raw.month:02d}-{raw.day:02d}"
        if raw.time() == datetime.time(0):
            return day, "date", False
        return f"{day} {raw.hour:02d}:{raw.minute:02d}:{raw.second:02d}", "date", True
    if isinstance(raw, datetime.date):
        return f"{raw.year:04d}-{raw.month:02d}-{raw.day:02d}", "date", False
    if isinstance(raw, (datetime.time, datetime.timedelta)):
        dropped["时间值"] += 1  # 渲染器没有时间 / 时长类型，写回去是一串字
        return str(raw), "text", False
    if isinstance(raw, str):
        return raw, "text", False
    dropped["认不出的单元格值"] += 1
    return str(raw), "text", False


def _infer_kind(seen: set) -> str:
    if seen == {"date"}:
        return "date"
    if seen and seen <= {"int"}:
        return "integer"
    if seen and seen <= {"int", "float"}:
        return "number"
    return "text"


def _plain_color(color, background: bool) -> bool:  # noqa: ANN001
    if color is None:
        return True
    kind = getattr(color, "type", None)
    if kind == "auto":
        return True
    if kind == "rgb":
        return str(color.rgb).upper() in (("FFFFFFFF", "00FFFFFF") if background else ("FF000000",))
    if kind == "theme":
        return not color.tint and color.theme == (0 if background else 1)
    if kind == "indexed":
        return color.indexed in ((9, 65) if background else (8, 64))
    return False


def _style_marked(cell, cache: dict) -> bool:  # noqa: ANN001
    """底色、字体颜色、加粗、斜体、下划线、删除线 —— 用户拿来做标记的东西，重新渲染不保留。"""
    if not cell.has_style:
        return False
    key = tuple(cell._style)
    if key not in cache:
        fill, font = cell.fill, cell.font
        fill_type = getattr(fill, "fill_type", "gradient")
        filled = fill_type not in (None, "none") and not (
            fill_type == "solid" and _plain_color(getattr(fill, "fgColor", None), background=True)
        )
        underline = font.u not in (None, "none")
        cache[key] = bool(
            filled
            or font.b
            or font.i
            or font.strike
            or underline
            or not _plain_color(font.color, background=False)
        )
    return cache[key]


def _header_text(value: object) -> str:
    plain, _, _ = _constant(value, Counter())
    return str(plain).strip()


# ── 条件格式 ──

CF_RANGE = re.compile(r"^\$?([A-Za-z]{1,3})\$?[0-9]+(?::\$?([A-Za-z]{1,3})\$?[0-9]+)?$")
CF_SPAN = re.compile(
    r"^(AVERAGE|LARGE)\(\s*\$?([A-Za-z]{1,3})\$?[0-9]+:\$?([A-Za-z]{1,3})\$?[0-9]+\s*(,\s*10\s*)?\)$",
    re.IGNORECASE,
)


def _rule_name(rule, letter: str) -> str | None:  # noqa: ANN001
    formula = " ".join(str(item) for item in (getattr(rule, "formula", None) or [])).strip()
    kind = getattr(rule, "type", "")
    operator = getattr(rule, "operator", "")
    if kind == "dataBar":
        return "data-bar"
    if kind != "cellIs":
        return None
    if operator == "lessThan" and formula == "0":
        return "negative-red"
    span = CF_SPAN.match(formula)
    if span is None or not (span.group(2).upper() == span.group(3).upper() == letter):
        return None  # 拿别的列算平均 / 前 10：语义不是渲染器那一种
    if operator == "greaterThan" and span.group(1).upper() == "AVERAGE" and not span.group(4):
        return "above-average-green"
    if operator == "greaterThanOrEqual" and span.group(1).upper() == "LARGE" and span.group(4):
        return "top10-green"
    return None


def _conditional_formats(sheet, headers: list[str], dropped: Counter) -> list[dict]:  # noqa: ANN001
    """认得出的收回来；认不出的（别的规则、跨几列、表外）报成「条件格式」，不再整份拒绝。"""
    found: list[dict] = []
    for formatting, rules in getattr(sheet.conditional_formatting, "_cf_rules", {}).items():
        columns: set[int] = set()
        for part in str(formatting.sqref).split():
            match = CF_RANGE.match(part)
            if match is None:
                columns = set()
                break
            first = column_index(match.group(1))
            last = column_index(match.group(2) or match.group(1))
            if first != last or first >= len(headers):
                columns = set()
                break
            columns.add(first)
        if len(columns) != 1:
            dropped["条件格式"] += len(rules)
            continue
        index = columns.pop()
        for rule in rules:
            name = _rule_name(rule, column_letter(index))
            if name is None:
                dropped["条件格式"] += 1
            else:
                found.append({"column": headers[index], "rule": name})
    return found


# ── 一张表 ──


def _extract_sheet(sheet, region: _Region, regions: dict, names: set, dropped: Counter) -> dict:  # noqa: ANN001
    from openpyxl.worksheet.formula import ArrayFormula

    title, cells = sheet.title, region.cells
    headers = [_header_text(cells[(region.header_row, col)].value) for col in range(1, region.width + 1)]
    data_rows = range(region.header_row + 1, region.data_last + 1)
    grid: list[list[object]] = [[] for _ in data_rows]
    columns: list[dict] = []
    styles: dict = {}
    for col in range(1, region.width + 1):
        header = headers[col - 1]
        templates: list[str] = []
        values: list[object] = []
        seen: set[str] = set()
        blanks = 0
        has_time = False
        number_format = None
        for row in data_rows:
            cell = cells.get((row, col))
            if cell is None:
                values.append(None)
                blanks += 1
                continue
            if number_format is None:
                number_format = cell.number_format
            if _style_marked(cell, styles):
                dropped["单元格颜色或字体标记"] += 1
            raw = cell.value
            if cell.data_type != "f":
                value, kind_seen, timed = _constant(raw, dropped)
                seen.add(kind_seen)
                has_time = has_time or timed
                values.append(value)
                continue
            if isinstance(raw, ArrayFormula):
                dropped["数组公式"] += 1  # 写回去是普通公式，计算方式不一样
                raw = raw.text
            if not isinstance(raw, str) or not raw.strip("= "):
                dropped["认不出的公式"] += 1  # 模拟运算表之类
                values.append(None)
                blanks += 1
                continue
            template, lost = _template(raw, title, row, regions, names)
            if lost:
                dropped["引用表外内容的公式"] += 1
            templates.append(template)
            values.append(None)
        if templates and seen:
            fail(
                EXIT_INVALID_CONTENT,
                f"「{title}」的「{header}」既有公式又有常量，提取不会把常量当成公式。",
            )
        fmt = _number_format(number_format)
        if templates:
            if len(set(templates)) != 1:
                fail(
                    EXIT_INVALID_CONTENT,
                    f"「{title}」的「{header}」各行公式不是同一个模板，提取会丢掉差异。",
                )
            kind = fmt.kind or "number"
            # 渲染器给公式列的每一行都写公式：原来空着的格子写回去会冒出一个 0
            dropped["公式列里空着的格子（会补上公式）"] += blanks
        else:
            kind = fmt.kind or _infer_kind(seen)
        if fmt.lossy or (kind == "date" and fmt.shows_time and has_time):
            dropped["数字格式"] += 1
        column: dict = {"header": header, "type": kind}
        if templates:
            column["formula"] = templates[0]
        columns.append(column)
        for index, value in enumerate(values):
            grid[index].append(value)

    if region.total_row:
        for col in range(2, region.width + 1):
            cell = cells.get((region.total_row, col))
            header = headers[col - 1]
            if columns[col - 1]["type"] not in NUMERIC_KINDS:
                if cell is not None:
                    dropped["合计行里的其他内容"] += 1  # 渲染器只给数字列写 SUM
                continue
            if cell is None:
                dropped["合计行里空着的数字列（会补上 SUM）"] += 1
            elif cell.data_type != "f" or not isinstance(cell.value, str):
                fail(
                    EXIT_INVALID_CONTENT,
                    f"「{title}」合计行的「{header}」是写死的数，不是公式。"
                    f"提取不会把它当成公式合计 —— 重新渲染会换成 SUM，数可能对不上。",
                )
            elif not _sums_column(cell.value, title, col, region):
                fail(
                    EXIT_INVALID_CONTENT,
                    f"「{title}」合计行的「{header}」不是对本列数据行的 SUM。"
                    f"重新渲染只会写 SUM，提取不会替你把它换掉。",
                )

    expected_freeze = f"A{region.header_row + 1}"
    if sheet.freeze_panes not in (None, expected_freeze):
        dropped["冻结窗格"] += 1  # 渲染器只会冻结表头那一行
    spec: dict = {
        "name": title,
        "columns": columns,
        "rows": grid,
        "freeze_header": sheet.freeze_panes == expected_freeze,
    }
    if region.total_row:
        spec["total_row"] = True
    formats = _conditional_formats(sheet, headers, dropped)
    if formats:
        spec["conditional_formats"] = formats
    if region.note:
        spec["note"] = region.note
    return spec


def _has_header_footer(sheet) -> bool:  # noqa: ANN001
    footer = sheet.HeaderFooter
    for part in (
        footer.oddHeader,
        footer.oddFooter,
        footer.evenHeader,
        footer.evenFooter,
        footer.firstHeader,
        footer.firstFooter,
    ):
        for side in (getattr(part, "left", None), getattr(part, "center", None), getattr(part, "right", None)):
            if side is not None and side.text:
                return True
    return False


def _sheet_extras(sheet, region: _Region, dropped: Counter) -> None:  # noqa: ANN001
    """表格以外、渲染器写不出来的东西。"""
    dropped["标题行"] += region.preamble_rows
    dropped["表格区域外的单元格"] += region.outside
    # 标题行里的合并（A1:D1）算在标题里；其余合并写回去会拆开
    dropped["合并单元格"] += sum(
        1 for merged in sheet.merged_cells.ranges if merged.max_row >= region.header_row
    )
    for cell in sheet._cells.values():
        if getattr(cell, "comment", None) is not None:
            dropped["批注"] += 1
        if getattr(cell, "hyperlink", None) is not None:
            dropped["超链接"] += 1
    dropped["数据验证（下拉列表等）"] += len(sheet.data_validations.dataValidation)
    hidden = sum(1 for dimension in sheet.row_dimensions.values() if dimension.hidden)
    for dimension in sheet.column_dimensions.values():
        if dimension.hidden:
            first = dimension.min or 1
            hidden += max(1, (dimension.max or first) - first + 1)
    dropped["隐藏的行或列"] += hidden
    if sheet.auto_filter.ref:
        dropped["自动筛选"] += 1
    dropped["套用格式的表格"] += len(sheet.tables)
    dropped["数据透视表"] += len(getattr(sheet, "_pivots", ()))
    dropped["定义的名称"] += len(sheet.defined_names)
    if sheet.print_area or sheet.print_title_rows or sheet.print_title_cols:
        dropped["打印区域或打印标题"] += 1
    if _has_header_footer(sheet):
        dropped["页眉页脚"] += 1
    if sheet.protection.sheet:
        dropped["工作表保护"] += 1
    if sheet.sheet_state != "visible":
        dropped["隐藏的工作表"] += 1


# ── 包里的绘图层 ──

_PACKAGE_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}Relationship"


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _part_rels(archive: zipfile.ZipFile, part: str) -> dict[str, tuple[str, str]]:
    folder, name = posixpath.split(part)
    try:
        root = ElementTree.fromstring(archive.read(posixpath.join(folder, "_rels", f"{name}.rels")))
    except KeyError:
        return {}
    found: dict[str, tuple[str, str]] = {}
    for rel in root.iter(_PACKAGE_REL):
        if rel.get("TargetMode") == "External":
            continue
        target = rel.get("Target", "")
        if target.startswith("/"):
            path = target.lstrip("/")
        else:
            path = posixpath.normpath(posixpath.join(folder, target))
        found[rel.get("Id", "")] = (rel.get("Type", ""), path)
    return found


def _drawing_kind(element) -> str | None:  # noqa: ANN001
    name = _local(element.tag)
    if name in ("AlternateContent", "Choice", "twoCellAnchor", "oneCellAnchor", "absoluteAnchor"):
        for child in element:
            if _local(child.tag) == "Fallback":
                continue
            kind = _drawing_kind(child)
            if kind:
                return kind
        return None
    if name == "pic":
        return "图片"
    if name == "graphicFrame":
        return "图表" if any(_local(node.tag) == "chart" for node in element.iter()) else "形状或文本框"
    if name in ("sp", "grpSp", "cxnSp", "contentPart"):
        return "形状或文本框"
    return None


def _sheet_controls(stream) -> int:  # noqa: ANN001
    """表单控件与嵌入对象。逐个元素读、读完就清，大表不会整份进内存。"""
    count = 0
    fallback = 0
    for event, element in ElementTree.iterparse(stream, events=("start", "end")):
        name = _local(element.tag)
        if event == "start":
            if name == "Fallback":
                fallback += 1
            elif not fallback and name in ("control", "oleObject"):
                count += 1
        else:
            if name == "Fallback":
                fallback -= 1
            element.clear()
    return count


def _drawing_objects(path: Path) -> Counter:
    """图表、图片、形状与文本框、控件 —— 直接从 xlsx 包里数，不靠 openpyxl。

    openpyxl 遇到形状会把那一整层绘图丢掉（只发一句 warning），没装 Pillow 时图片也是静默不读：
    靠它的 `_charts` / `_images` 数，丢得最多的时候报得最少。
    """
    found: Counter = Counter()
    try:
        with zipfile.ZipFile(path) as archive:
            for kind, part in _part_rels(archive, "xl/workbook.xml").values():
                if not kind.endswith("/worksheet"):
                    continue
                with archive.open(part) as stream:
                    found["控件或嵌入对象"] += _sheet_controls(stream)
                for rel_kind, target in _part_rels(archive, part).values():
                    if not rel_kind.endswith("/drawing"):
                        continue
                    for anchor in ElementTree.fromstring(archive.read(target)):
                        label = _drawing_kind(anchor)
                        if label:
                            found[label] += 1
    except (KeyError, zipfile.BadZipFile, ElementTree.ParseError):
        fail(EXIT_INVALID_CONTENT, "读不出这份 xlsx 里的图表与图片，提取不会当它们不存在。")
    return found


# openpyxl 读的时候扔掉东西只发 warning。认得的按种类报，认不得的也报 —— 宁可多问一句
WARNING_KINDS = (
    ("Conditional Formatting extension", "条件格式"),
    ("Failed to load a conditional formatting rule", "条件格式"),
    ("Data Validation extension", "数据验证（下拉列表等）"),
    ("Sparkline Group extension", "迷你图"),
    ("Slicer List extension", "切片器或日程表"),
    ("Timeline Ref extension", "切片器或日程表"),
    ("Protected Range extension", "工作表保护"),
    ("Ignored Error extension", None),  # 只是"忽略这个绿三角"的标记
    ("extension is not supported", "Excel 扩展功能"),
    ("is part of a merged range but has a comment", "批注"),
    ("is marked as a date but the serial value", "超出范围的日期"),
    ("Defined names for sheet index", "定义的名称"),
    ("Print area cannot be set", "打印区域或打印标题"),
    ("invalid specification", "读不出来的工作表"),
    # 绘图层在 _drawing_objects 里从包里数，这里不重复
    ("DrawingML", None),
    ("Unable to read chart", None),
    ("image", None),
    ("default style", None),
    ("no stylesheet", None),
    ("more than 31 characters", None),
)


def _warning_kind(message: str) -> str | None:
    for needle, kind in WARNING_KINDS:
        if needle in message:
            return kind
    return "其他读不出来的内容"


def extract_xlsx(path: Path) -> dict:
    _missing(path)
    try:
        from openpyxl import load_workbook
    except ModuleNotFoundError:
        fail(EXIT_RUNTIME_MISSING, runtime_missing_message("office", "读取 xlsx"))

    dropped: Counter = Counter()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        try:
            book = load_workbook(path, data_only=False)
        except Exception:  # noqa: BLE001 —— 坏文件只报一句话，不带堆栈
            fail(EXIT_INVALID_CONTENT, f"读不了 {path.name}：文件损坏，或不是 xlsx。")
    for warning in caught:
        if issubclass(warning.category, UserWarning):
            kind = _warning_kind(str(warning.message))
            if kind:
                dropped[kind] += 1

    regions: dict[str, _Region] = {}
    for sheet in book.worksheets:
        region = _locate_table(sheet)
        if region is None:
            dropped["空白工作表"] += 1
        else:
            regions[sheet.title.casefold()] = region
    if not regions:
        fail(EXIT_INVALID_CONTENT, "这个工作簿没有表。")

    names = {str(name).casefold() for name in book.defined_names}
    for sheet in book.worksheets:
        names.update(str(name).casefold() for name in sheet.defined_names)

    sheets = []
    for sheet in book.worksheets:
        region = regions.get(sheet.title.casefold())
        if region is None:
            continue
        sheets.append(_extract_sheet(sheet, region, regions, names, dropped))
        _sheet_extras(sheet, region, dropped)

    dropped["图表工作表"] += len(book.chartsheets)
    dropped["定义的名称"] += len(book.defined_names)
    dropped["外部链接"] += len(getattr(book, "_external_links", ()))
    security = getattr(book, "security", None)
    if security is not None and (security.lockStructure or security.lockWindows):
        dropped["工作簿保护"] += 1
    dropped.update(_drawing_objects(path))

    content: dict = {"sheets": sheets}
    lost = {kind: count for kind, count in dropped.items() if count > 0}
    if lost:
        content["_dropped"] = lost
    return content


# ── csv ──

CSV_NUMBER = re.compile(r"^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")
CSV_DATE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")


def _csv_number(text: str) -> int | float | None:
    if not CSV_NUMBER.match(text):
        return None
    digits = text.lstrip("+-")
    if len(digits) > 1 and digits[0] == "0" and digits[1] != ".":
        return None  # 001、0571：前导零是内容（编号、区号），当成数就没了
    if "." in text or "e" in text.lower():
        number = float(text)
        return number if math.isfinite(number) else None
    if len(digits) > 15:
        return None  # 身份证号、卡号：超过 Excel 的 15 位精度，写成数会被改掉末几位
    return int(text)


def extract_csv(path: Path) -> dict:
    _missing(path)
    with path.open(encoding="utf-8-sig", newline="") as handle:
        rows = [list(row) for row in csv.reader(handle)]
    while rows and not any(cell.strip() for cell in rows[-1]):
        rows.pop()
    if not rows:
        fail(EXIT_INVALID_CONTENT, "这份 csv 是空的。")
    dropped: Counter = Counter()
    filled = [[index for index, cell in enumerate(row) if cell.strip()] for row in rows]
    first = next(index for index, cells in enumerate(filled) if cells)
    header_at = next((index for index, cells in enumerate(filled) if len(cells) >= 2), first)
    dropped["标题行"] += sum(1 for cells in filled[:header_at] if cells)

    headers = rows[header_at]
    if any(header.endswith(FORMULA_HEADER_MARK) for header in headers):
        fail(
            EXIT_INVALID_CONTENT,
            "csv 里没有公式，计算列只留下了空单元格。请改从原来的 xlsx 提取，不要把空列当成结果。",
        )
    if not headers[0].strip():
        fail(EXIT_INVALID_CONTENT, "csv 的表头不是从第一列开始的，提取不会把整张表挪个位置。")
    width = 1
    while width < len(headers) and headers[width].strip():
        width += 1
    body = rows[header_at + 1 :]
    if any(width < len(row) and row[width].strip() for row in body):
        fail(
            EXIT_INVALID_CONTENT,
            f"csv 的表头第 {width + 1} 列是空的，但这一列下面有数据。"
            f"提取只认表头连续的列，会把这一列和右边的列一起丢掉；先补上表头再提取。",
        )
    # 比表头宽的行：多出来的格子渲染器写不回去
    dropped["表格区域外的单元格"] += sum(
        1 for cells in filled[header_at:] for index in cells if index >= width
    )

    columns = []
    parsed_columns: list[list[object]] = []
    for index in range(width):
        texts = [row[index] if index < len(row) else "" for row in body]
        present = [text.strip() for text in texts if text.strip()]
        numbers = [_csv_number(text) for text in present]
        if present and all(number is not None for number in numbers):
            values = [_csv_number(text.strip()) if text.strip() else None for text in texts]
            kind = "number" if any(isinstance(value, float) for value in values) else "integer"
        elif present and all(CSV_DATE.match(text) for text in present):
            values = [text.strip() or None for text in texts]
            kind = "date"
        else:
            values = [text if text.strip() else None for text in texts]
            kind = "text"
        columns.append({"header": headers[index].strip(), "type": kind})
        parsed_columns.append(values)
    grid = [list(row) for row in zip(*parsed_columns)] if body else []
    name = re.sub(r"[:\\/?*\[\]]+", "-", path.stem).strip()[:31] or "Sheet1"
    content: dict = {"sheets": [{"name": name, "columns": columns, "rows": grid, "freeze_header": True}]}
    lost = {kind: count for kind, count in dropped.items() if count > 0}
    if lost:
        content["_dropped"] = lost
    return content


def extract_spreadsheet(path: Path) -> dict:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return extract_csv(path)
    if suffix == ".xlsx":
        return extract_xlsx(path)
    fail(EXIT_INVALID_CONTENT, f"提取只支持 .xlsx 与 .csv，收到 {suffix or '(无扩展名)'}。")


def main() -> None:
    parser = argparse.ArgumentParser(description="内容 JSON → xlsx / csv，或从已有文件提取内容 JSON")
    parser.add_argument("--content", help="要渲染的内容 JSON")
    parser.add_argument("--extract", help="已有的 .xlsx / .csv，提取成内容 JSON")
    parser.add_argument("--out", required=True, help="渲染：.xlsx / .csv。提取：.json")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--overwrite", action="store_true", help="目标已存在时允许写回（默认拒绝）")
    parser.add_argument("--allow-lossy", action="store_true", help="提取有收不回的内容时仍写出（默认拒绝）")
    args = parser.parse_args()

    if bool(args.extract) == bool(args.content):
        fail(EXIT_INVALID_CONTENT, "提取用 --extract，生成用 --content，不要同时给，也不要都不给。")
    if args.extract and args.validate_only:
        fail(EXIT_INVALID_CONTENT, "提取会直接写出 JSON，没有 --validate-only。")

    if args.extract and Path(args.extract).suffix.lower() == ".xlsx":
        ensure_office_runtime(("openpyxl",))
    elif not args.extract:
        # 缺办公扩展的模块时换到扩展的解释器重跑（见 evowork_skill.ensure_office_runtime）。
        # --validate-only 不需要它，但提前换掉更简单，也让两条路径的行为一致
        ensure_office_runtime(("openpyxl",))

    if args.extract:
        content = extract_spreadsheet(Path(args.extract).resolve())
        lossy = lossy_extraction(content.pop("_dropped", {}), args.allow_lossy)
        validate(content)
        out_path = Path(args.out).resolve()
        write_extracted(content, out_path)
        succeeded(
            out_path, sheets=len(content["sheets"]), format="json", operation="extract", **lossy
        )
        return

    content = read_content(Path(args.content).resolve())
    validate(content)

    if args.validate_only:
        succeeded(sheets=len(content["sheets"]), validated=True)
        return

    out_path = Path(args.out).resolve()
    refuse_overwrite(out_path, args.overwrite)
    suffix = out_path.suffix.lower()
    if suffix == ".csv":
        if len(content["sheets"]) > 1:
            fail(
                EXIT_INVALID_CONTENT,
                "csv 只能装一张表，但内容里有多张。要么输出 xlsx，要么每张表各写一个 csv。",
            )
        write_csv(content["sheets"][0], out_path)
        succeeded(out_path, rows=len(content["sheets"][0]["rows"]), format="csv")
        return
    if suffix != ".xlsx":
        fail(EXIT_INVALID_CONTENT, f"输出格式只支持 .xlsx 与 .csv，收到 {suffix or '(无扩展名)'}。")

    render_xlsx(content, out_path)
    succeeded(out_path, sheets=len(content["sheets"]), format="xlsx")


if __name__ == "__main__":
    main()
