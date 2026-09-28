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
import csv
import re
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT.parent / "_shared"))

from evowork_skill import (  # noqa: E402
    ensure_office_runtime,
    EXIT_INVALID_CONTENT,
    EXIT_RUNTIME_MISSING,
    fail,
    read_content,
    runtime_missing_message,
    succeeded,
    validate_content,
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
            if column.get("type", "text") in ("number", "integer", "currency"):
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
                if column.get("type", "text") in ("number", "integer", "currency"):
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
                sheet.conditional_formatting.add(span, DataBarRule(color=colors["data_bar"]))

        if sheet_spec.get("note"):
            sheet.cell(row=last_row + 3, column=1, value=sheet_spec["note"])

    out_path.parent.mkdir(parents=True, exist_ok=True)
    book.save(out_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="内容 JSON → xlsx / csv")
    parser.add_argument("--content", required=True)
    parser.add_argument("--out", required=True, help="输出路径，扩展名决定格式（.xlsx / .csv）")
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()

    # 缺办公扩展的模块时换到扩展的解释器重跑（见 evowork_skill.ensure_office_runtime）。
    # --validate-only 不需要它，但提前换掉更简单，也让两条路径的行为一致
    ensure_office_runtime(("openpyxl",))

    content = read_content(Path(args.content).resolve())
    validate(content)

    if args.validate_only:
        succeeded(sheets=len(content["sheets"]), validated=True)
        return

    out_path = Path(args.out).resolve()
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
