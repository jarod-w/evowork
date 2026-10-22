#!/usr/bin/env python3
"""已解析文本 → 台账或纪要。不识别图片，不访问网络。

每一格都要能在原文里对上，否则停。台账按行核对，避免把两行的金额和摘要拼在一起。

## 「对上」按值核对，不按字面（2026-10-22 评审后收紧）

最早的版本只问「这一格的字在原文这一行里出现过没有」。评审找出了七类照样放行的错账：
丢了负号、丢了「万」、同一行入账两次、把日期里的年份当金额、整份原文只有一行时
同一行约束形同虚设、纪要里把「不同意」读成「同意」、把缺席的人列进参会人。现在：

- 原文按行切开，每行先认出日期（连同单独的年、年月、月日、时刻），再认出数。
  **日期里的数不是金额。**
- 数带正负号（``-``、``−``、会计括号）和量级（万、亿、千……）。表里的数要和原文的**值**相等：
  ``1.2万`` 要写成 12000（或原样写 ``1.2万``），``(1,234.50)`` 要写成 -1234.50。
- 原文的每一行最多支撑台账的一行；一行里的每一处文字最多支撑一格。
- 一行原文太长、日期或数太多，就分不清哪几个数属于这一笔 —— 报「无法判定」，不放行。
- 原文一格一行（OCR 常见）时，按列的顺序连续几行、每行只有那一格，也算同一笔。

报错只写字段路径（``rows/3``），不写格子里的内容。
"""

from __future__ import annotations

import argparse
import bisect
import re
import sys
from datetime import datetime
from decimal import Decimal, InvalidOperation
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
MAX_COLUMNS = 12
KINDS = {"text", "number", "integer", "currency", "date"}
NUMERIC_KINDS = ("number", "integer", "currency")
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

#: 一行原文超过这么多字，就不再当成「一笔」核对。
MAX_LINE_CHARS = 200
#: 一行原文里的数可以比这一笔用到的多几个（序号、数量、余额……），再多就分不清。
EXTRA_NUMBERS_PER_LINE = 2
#: 对应关系的搜索步数上限。超过就报无法判定，不猜。
SEARCH_BUDGET = 200_000

#: 渲染器的上限（spreadsheets / documents 的 schema）。这里放行的，渲染器必须也放行 ——
#: 否则模型过了检查，到渲染那一步才失败，报错路径还对不回原字段。
TITLE_MAX = 120
HEADER_MAX = 40
FORMULA_MAX = 200
BULLETS_MAX = 30
BULLET_CHARS = 300
PARAGRAPH_CHARS = 4000
TABLE_ROWS_MAX = 200

# ── 原文规整 ───────────────────────────────────────────────────────────────
# 逐字一对一替换，长度不变，所以规整后的位置就是原文的位置。
# 「，」不换成「,」：中文里它是分句，不是千分位（「128，256」是两个数）。
# 制表符和全角空格不换成空格：它们多半是列分隔，换了就会把两列拼成一个千分位数。
_TRANSLATE: dict[int, int | str] = {code: code - 0xFEE0 for code in range(0xFF10, 0xFF1A)}
_TRANSLATE.update({code: code - 0xFEE0 for code in range(0xFF21, 0xFF3B)})
_TRANSLATE.update({code: code - 0xFEE0 for code in range(0xFF41, 0xFF5B)})
_TRANSLATE.update(
    {
        ord("．"): ".",
        ord("－"): "-",
        ord("−"): "-",  # −
        ord("﹣"): "-",
        ord("＋"): "+",
        ord("（"): "(",
        ord("）"): ")",
        ord("："): ":",
        ord("％"): "%",
        ord("＄"): "$",
        ord(" "): " ",
        ord(" "): " ",
        ord(" "): " ",
    }
)


def normalize(text: str) -> str:
    return text.translate(_TRANSLATE)


def _ascii_alnum(char: str) -> bool:
    return char.isascii() and char.isalnum()


CURRENCY = "¥￥$"
#: 量级单位。长的先比，免得把「千万」读成「千」。
UNITS = (("万亿", 12), ("千万", 7), ("百万", 6), ("亿", 8), ("万", 4), ("千", 3))
#: 「千克」「千米」里的千是计量单位的一部分，不是量级。
PHYSICAL_AFTER_QIAN = frozenset("克米瓦卡焦帕伏赫字兆")

NEGATIONS = frozenset("不未没无非否勿别")
#: 以「别」结尾、却不是否定的词。「分别通过」不是「别通过」。
NOT_NEGATION = frozenset(
    {"分别", "特别", "个别", "类别", "区别", "识别", "级别", "性别", "差别", "告别", "辨别", "鉴别", "派别", "离别", "判别"}
)
ABSENT_MARKERS = ("缺席", "请假", "未到", "未出席", "未参加", "未参会", "缺勤", "没来", "不在场")
_ABSENT_AFTER = re.compile(r"[ \t]*(?:" + "|".join(ABSENT_MARKERS) + ")")
_PAREN_AFTER = re.compile(r"[ \t]*\(([^()\n]{0,16})\)")

_YMD = re.compile(
    r"(?<!\d)(\d{4})(?:([-/.])(\d{1,2})\2(\d{1,2})|[ ]*年[ ]*(\d{1,2})[ ]*月[ ]*(\d{1,2})[ ]*[日号])(?!\d)"
)


def _year(text: str) -> bool:
    return 1900 <= int(text) <= 2199


def _month(text: str) -> bool:
    return 1 <= int(text) <= 12


#: 日期的组成部分：(正则, 是否算「一笔」的锚点, 校验)。
#: 锚点是完整日期和月日 —— 一行里有两个，多半挤着两笔；单独的年、年月、时刻不是。
_DATE_PARTS = (
    (
        re.compile(r"(?<!\d)(\d{1,2})[ ]*月[ ]*(\d{1,2})[ ]*[日号]"),
        True,
        lambda m: _month(m.group(1)) and 1 <= int(m.group(2)) <= 31,
    ),
    (
        re.compile(r"(?<!\d)(\d{4})[ ]*年[ ]*(\d{1,2})[ ]*月"),
        False,
        lambda m: _year(m.group(1)) and _month(m.group(2)),
    ),
    (
        re.compile(r"(?<!\d)(\d{4})[-/](\d{1,2})(?![\d.])"),
        False,
        lambda m: _year(m.group(1)) and _month(m.group(2)),
    ),
    (re.compile(r"(?<!\d)(\d{4})[ ]*年"), False, lambda m: _year(m.group(1))),
    (re.compile(r"(?<!\d)(\d{1,2})[ ]*月"), False, lambda m: _month(m.group(1))),
    (
        re.compile(r"(?<!\d)(\d{1,2}):(\d{2})(?::(\d{2}))?(?!\d)"),
        False,
        lambda m: int(m.group(1)) <= 23 and int(m.group(2)) <= 59,
    ),
)

#: 一个数：千分位逗号或不带分隔，可带小数。`1.2.3` 这种版本号不算数。
_NUMBER = re.compile(r"(?<!\d)(?<!\d\.)(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?(?!\d)(?!\.\d)")
#: 用单个空格做千分位的写法（`1 280.50`）。它和「两列各一个数」长得一样，见 _parse_line。
_SPACED = re.compile(r"(?<![\d,])(?<!\d\.)\d{1,3}(?: \d{3})+(?:\.\d+)?(?!\d)(?!\.\d)")
#: 表里写的数。千分位逗号、单个空格都可以，前导零不行。
_LEDGER_NUMBER = re.compile(r"(?:0|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d{0,2}(?: \d{3})+|[1-9]\d*)(?:\.\d+)?")
_PLAIN_NUMBER = re.compile(r"-?(?:0|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)(?:\.\d+)?")


class Num:
    """原文里的一个数。`value` 已带正负号、已按量级换算。"""

    __slots__ = ("start", "end", "value", "raw", "magnitude", "sign", "ambiguous")

    def __init__(self, start, end, value, raw, magnitude, sign, ambiguous):
        self.start = start
        self.end = end
        self.value: Decimal = value
        self.raw: Decimal = raw
        self.magnitude: int = magnitude
        #: "+" / "-" / "?"（括号里的整数：可能是负数，也可能是序号）
        self.sign: str = sign
        #: 读法不唯一（空格千分位）。对上它只能算「无法判定」。
        self.ambiguous: bool = ambiguous


class Parsed:
    __slots__ = ("nums", "dates", "anchors", "count")

    def __init__(self, nums, dates, anchors):
        self.nums: list[Num] = nums
        self.dates: list[tuple[int, int, tuple[int, int, int]]] = dates
        self.anchors: int = anchors
        self.count: int = sum(1 for num in nums if not num.ambiguous)


class _Spans:
    """互不重叠的区间，按起点排好。查重叠用二分 —— 原文可能是一整行两百万字。"""

    def __init__(self) -> None:
        self.starts: list[int] = []
        self.ends: list[int] = []

    def overlaps(self, start: int, end: int) -> bool:
        index = bisect.bisect_left(self.starts, end) - 1
        return index >= 0 and self.ends[index] > start

    def add(self, start: int, end: int) -> None:
        index = bisect.bisect_left(self.starts, start)
        self.starts.insert(index, start)
        self.ends.insert(index, end)


def _unit_after(text: str, end: int) -> tuple[int, int]:
    j = end + 1 if end < len(text) and text[end] == " " else end
    for unit, exponent in UNITS:
        if text.startswith(unit, j):
            after = text[j + len(unit) : j + len(unit) + 1]
            if unit == "千" and after and after in PHYSICAL_AFTER_QIAN:
                return 0, end
            return exponent, j + len(unit)
    return 0, end


def _sign_around(text: str, start: int, end: int, amount_like: bool) -> tuple[str, int, int]:
    p = start
    minus = False
    for _ in range(2):
        if p > 0 and text[p - 1] in CURRENCY:
            p -= 1
        elif p > 0 and text[p - 1] == "-" and not minus:
            p -= 1
            minus = True
        else:
            break
    if minus and p > 0 and _ascii_alnum(text[p - 1]):
        # `100-200`、`A-50` 里的是连字符，不是负号
        minus = False
        p = start
    q = end
    if q < len(text) and text[q] == "元":
        q += 1
    if p > 0 and text[p - 1] == "(" and q < len(text) and text[q] == ")":
        if minus or amount_like:
            return "-", p - 1, q + 1
        return "?", p - 1, q + 1
    return ("-" if minus else "+"), p, end


def _make_num(text: str, start: int, end: int, ambiguous: bool) -> Num:
    digits = text[start:end]
    raw = Decimal(digits.replace(",", "").replace(" ", ""))
    magnitude, unit_end = _unit_after(text, end)
    amount_like = any(mark in digits for mark in ". ,")
    sign, span_start, span_end = _sign_around(text, start, unit_end, amount_like)
    value = raw.scaleb(magnitude)
    if sign == "-":
        value = -value
    return Num(span_start, max(span_end, unit_end), value, raw, magnitude, sign, ambiguous)


def _parse_line(text: str) -> Parsed:
    taken = _Spans()
    dates: list[tuple[int, int, tuple[int, int, int]]] = []
    for match in _YMD.finditer(text):
        year = int(match.group(1))
        month = int(match.group(3) or match.group(5))
        day = int(match.group(4) or match.group(6))
        try:
            datetime(year, month, day)
        except ValueError:
            continue
        dates.append((match.start(), match.end(), (year, month, day)))
        taken.add(*match.span())
    anchors = len(dates)
    for pattern, anchor, valid in _DATE_PARTS:
        for match in pattern.finditer(text):
            if taken.overlaps(*match.span()) or not valid(match):
                continue
            taken.add(*match.span())
            if anchor:
                anchors += 1

    splits = [m.span() for m in _NUMBER.finditer(text) if not taken.overlaps(*m.span())]
    split_starts = [start for start, _ in splits]
    nums: list[Num] = []
    shadowed: set[tuple[int, int]] = set()
    for match in _SPACED.finditer(text):
        span = match.span()
        if taken.overlaps(*span):
            continue
        first = bisect.bisect_left(split_starts, span[0])
        inside = splits[first : bisect.bisect_left(split_starts, span[1])]
        glued = span[0] > 0 and text[span[0] - 1].isalnum()
        if len(inside) == len(splits) and not glued:
            # 这一行只有这一个数：`差旅费 1 280.50` 只能读成 1280.50。
            # 拆开读的那几个数留作对照 —— 对上它们只能算无法判定。
            nums.append(_make_num(text, span[0], span[1], ambiguous=False))
            shadowed.update(inside)
        else:
            # 一行里还有别的数（`办公用品 2 128.00 256.00` 更像数量、单价、金额），
            # 或者开头的数粘在字后面（`房间302 150.00` 里的 302 是房号）：按拆开读，
            # 合起来读的那个数留作对照。
            nums.append(_make_num(text, span[0], span[1], ambiguous=True))
    for start, end in splits:
        nums.append(_make_num(text, start, end, ambiguous=(start, end) in shadowed))
    return Parsed(nums, dates, anchors)


def is_negated(text: str, start: int) -> bool:
    if start == 0 or text[start - 1] not in NEGATIONS:
        return False
    return text[max(0, start - 2) : start] not in NOT_NEGATION


def occurrences(haystack: str, needle: str) -> list[tuple[int, int]]:
    """needle 在 haystack 里的位置。以数字开头或结尾的，不从更长的数字里截。"""
    found: list[tuple[int, int]] = []
    if not needle:
        return found
    start = 0
    while True:
        index = haystack.find(needle, start)
        if index < 0:
            return found
        end = index + len(needle)
        start = index + 1
        if needle[0].isdigit() and index > 0 and haystack[index - 1].isdigit():
            continue
        if needle[-1].isdigit() and end < len(haystack) and haystack[end].isdigit():
            continue
        found.append((index, end))


class Source:
    def __init__(self, text: str):
        self.lines = [normalize(line) for line in text.splitlines()] or [normalize(text)]
        self.joined = "\n".join(self.lines)
        self.starts: list[int] = []
        offset = 0
        for line in self.lines:
            self.starts.append(offset)
            offset += len(line) + 1
        self.parsed = [_parse_line(line) for line in self.lines]
        self.nonblank = [index for index, line in enumerate(self.lines) if line.strip()]
        self.nonblank_pos = {line: pos for pos, line in enumerate(self.nonblank)}
        #: 绝对值和换算前的值都进索引：正负号或单位对不上的行也要找出来，好报清楚是哪一种错。
        self.num_index: dict[Decimal, set[int]] = {}
        self.date_index: dict[tuple[int, int, int], set[int]] = {}
        for index, parsed in enumerate(self.parsed):
            for num in parsed.nums:
                for key in (abs(num.value), num.raw):
                    self.num_index.setdefault(key, set()).add(index)
            for _, _, ymd in parsed.dates:
                self.date_index.setdefault(ymd, set()).add(index)
        self._text_cache: dict[str, set[int]] = {}

    def text_lines(self, needle: str) -> set[int]:
        cached = self._text_cache.get(needle)
        if cached is None:
            cached = {bisect.bisect_right(self.starts, s) - 1 for s, _ in occurrences(self.joined, needle)}
            self._text_cache[needle] = cached
        return cached


# ── 一格 ───────────────────────────────────────────────────────────────────


class Cell:
    __slots__ = ("kind", "value")

    def __init__(self, kind: str, value):
        self.kind = kind  # "num" / "text" / "date"
        self.value = value


def loose_lines(source: Source, cell: Cell) -> set[int]:
    if cell.kind == "num":
        return source.num_index.get(abs(cell.value), set())
    if cell.kind == "date":
        return source.date_index.get(cell.value, set())
    return source.text_lines(cell.value)


def match_cell(cell: Cell, text: str, parsed: Parsed) -> tuple[list[tuple[int, int]], set[str]]:
    """这一格在这一行里能对上的位置；对不上时给出原因。"""
    if cell.kind == "date":
        return [(start, end) for start, end, ymd in parsed.dates if ymd == cell.value], {"missing"}
    if cell.kind == "text":
        good = []
        negated = False
        for start, end in occurrences(text, cell.value):
            if is_negated(text, start):
                negated = True
            else:
                good.append((start, end))
        return good, {"negated" if negated else "missing"}
    good = []
    why: set[str] = set()
    want: Decimal = cell.value
    for num in parsed.nums:
        if num.sign == "?":
            if abs(want) == num.value:
                why.add("undecidable")
            continue
        if num.value == want:
            if num.ambiguous:
                why.add("undecidable")
            else:
                good.append((num.start, num.end))
        elif not num.ambiguous and abs(num.value) == abs(want):
            why.add("sign")
        elif not num.ambiguous and num.magnitude and num.raw == abs(want):
            why.add("unit")
    return good, (why or {"missing"})


# ── 一组互不重叠的选择 ─────────────────────────────────────────────────────

TOO_MANY = object()


def assign(options: list[list[frozenset]], budget: int = SEARCH_BUDGET):
    """每一项从自己的候选里挑一个，彼此不共用资源。

    返回每一项挑中的序号；做不到返回 None；搜索太久返回 TOO_MANY（报无法判定，不猜）。
    """
    if any(not choices for choices in options):
        return None
    if all(len(record) == 1 for choices in options for record in choices):
        return _match_single(options)
    order = sorted(range(len(options)), key=lambda item: len(options[item]))
    chosen = [-1] * len(options)
    used: set = set()
    depth = 0
    steps = 0
    while 0 <= depth < len(order):
        item = order[depth]
        previous = chosen[item]
        if previous >= 0:
            used -= options[item][previous]
        candidate = previous + 1
        while candidate < len(options[item]) and not used.isdisjoint(options[item][candidate]):
            candidate += 1
            steps += 1
        steps += 1
        if steps > budget:
            return TOO_MANY
        if candidate < len(options[item]):
            chosen[item] = candidate
            used |= options[item][candidate]
            depth += 1
        else:
            chosen[item] = -1
            depth -= 1
    return chosen if depth >= 0 else None


def _match_single(options: list[list[frozenset]]) -> list[int] | None:
    """每个候选只占一行原文时就是二分图匹配：用增广路，几百行重复也不会指数爆炸。"""
    owner: dict = {}

    def augment(item: int, seen: set) -> bool:
        for choice, record in enumerate(options[item]):
            (resource,) = record
            if resource in seen:
                continue
            seen.add(resource)
            holder = owner.get(resource)
            if holder is None or augment(holder[0], seen):
                owner[resource] = (item, choice)
                return True
        return False

    for item in range(len(options)):
        if not augment(item, set()):
            return None
    chosen = [-1] * len(options)
    for item, choice in owner.values():
        chosen[item] = choice
    return chosen


def first_conflict(options: list[list[frozenset]]) -> int | None:
    for size in range(1, len(options) + 1):
        result = assign(options[:size])
        if result is TOO_MANY:
            return None
        if result is None:
            return size - 1
    return None


def positions(span: tuple[int, int]) -> frozenset:
    return frozenset(range(span[0], span[1]))


# ── 一笔（台账的一行 / 纪要的一条待办）对原文的哪一行 ────────────────────────

PRIORITY = ("undecidable", "sign", "unit", "negated", "overlap")


def crowded(text: str, parsed: Parsed, cells: list[Cell]) -> bool:
    date_cells = sum(1 for cell in cells if cell.kind == "date")
    num_cells = sum(1 for cell in cells if cell.kind == "num")
    return (
        len(text.strip()) > MAX_LINE_CHARS
        or parsed.anchors > max(1, date_cells)
        or parsed.count > num_cells + EXTRA_NUMBERS_PER_LINE
    )


def evaluate(source: Source, line: int, cells: list[Cell]) -> str:
    text = source.lines[line]
    parsed = source.parsed[line]
    # 先看这一行能不能当成「一笔」：每一格的值都在这一行里出现过（loose_lines 保证的），
    # 行太挤时不管对不对得上都分不清，不必逐格去配 —— 一整行两百万字时逐格配也太慢。
    if crowded(text, parsed, cells):
        return "undecidable"
    options = []
    problems: set[str] = set()
    for cell in cells:
        good, why = match_cell(cell, text, parsed)
        if not good:
            problems |= why
        options.append([positions(span) for span in good])
    if problems:
        return "missing" if "missing" in problems else next(p for p in PRIORITY if p in problems)
    result = assign(options, budget=10_000)
    if result is TOO_MANY:
        return "undecidable"
    return "overlap" if result is None else "ok"


def exclusive(text: str, span: tuple[int, int]) -> bool:
    rest = text[: span[0]] + text[span[1] :]
    return all(not char.isalnum() or char == "元" for char in rest)


def windows(source: Source, cells: list[Cell], first: set[int]) -> list[frozenset]:
    """一格一行：按列的顺序连续几行，每行只有那一格。"""
    found = []
    size = len(cells)
    for line in sorted(first):
        pos = source.nonblank_pos.get(line)
        if pos is None or pos + size > len(source.nonblank):
            continue
        block = source.nonblank[pos : pos + size]
        if all(
            any(
                exclusive(source.lines[index], span)
                for span in match_cell(cell, source.lines[index], source.parsed[index])[0]
            )
            for index, cell in zip(block, cells)
        ):
            found.append(frozenset(block))
    return found


def records(source: Source, cells: list[Cell]) -> tuple[list[frozenset], str | None]:
    loose = [loose_lines(source, cell) for cell in cells]
    found: list[frozenset] = []
    problems: set[str] = set()
    common = set.intersection(*loose) if loose else set()
    for line in sorted(common):
        status = evaluate(source, line, cells)
        if status == "ok":
            found.append(frozenset((line,)))
        else:
            problems.add(status)
    if not found and len(cells) > 1 and loose[0]:
        found.extend(windows(source, cells, loose[0]))
    if found:
        return found, None
    for problem in PRIORITY:
        if problem in problems:
            return [], problem
    if all(loose) and not common:
        return [], "scattered"
    return [], "missing"


MESSAGES = {
    "missing": "{where} 在原文里对不上：有一格原文里没有。按原文逐字抄，不要补原文没有的字或数；日期里的年、月、日不算金额。",
    "scattered": "{where} 在原文的同一行里对不上：这几格分散在原文不同的行。不要把两行拼在一起。"
    "原文一格一行时，要按列的顺序连续排着、每行只有那一格才认；别的排法本技能不核对，请告诉用户。",
    "undecidable": "{where} 无法判定：对得上的那一行原文太长（超过 "
    + str(MAX_LINE_CHARS)
    + " 字）、日期或数太多，可能挤着好几笔；或者那个数本身有两种读法（括号里的整数、用空格隔开的数字）。"
    "本技能不猜，不放行。请告诉用户这份原文需要一笔一行。",
    "sign": "{where} 和原文的正负号不一致：原文前面带 -、− 或写在会计括号里的是负数，表里要写成负数（例如 -12.30）；"
    "原文没有负号就不要加。",
    "unit": "{where} 漏了原文的单位：原文这个数后面跟着万、亿或千，表里要写换算后的数（例如 3.5万 写成 35000），"
    "或者连单位原样抄（3.5万），检查器会换算。",
    "negated": "{where} 的文字在原文里前面带着不、未、没、无、非、否、勿或别，意思相反，不算对上。",
    "overlap": "{where} 有两格用的是原文同一处文字。原文的每一处只能对应一格，不要把一个数抄进两列。",
    "duplicate": "{where} 和另一行用到了原文的同一行。原文一行只能对应一行：不要重复入账；一行原文里挤着两笔时告诉用户。",
    "budget": "可能的对应方式太多，无法判定每一行对应原文的哪一行。请告诉用户这份原文需要一笔一行。",
}


def place(source: Source, items: list[list[Cell]], where: str) -> None:
    options = []
    for index, cells in enumerate(items):
        if not cells:
            fail(EXIT_INVALID_CONTENT, f"{where}/{index} 没有一格能在原文里核对。整行都是公式的行不要写。")
        found, problem = records(source, cells)
        if not found:
            fail(EXIT_INVALID_CONTENT, MESSAGES[problem or "missing"].format(where=f"{where}/{index}"))
        options.append(found)
    result = assign(options)
    if result is TOO_MANY:
        fail(EXIT_INVALID_CONTENT, MESSAGES["budget"])
    if result is None:
        culprit = first_conflict(options)
        if culprit is None:
            fail(EXIT_INVALID_CONTENT, MESSAGES["budget"])
        fail(EXIT_INVALID_CONTENT, MESSAGES["duplicate"].format(where=f"{where}/{culprit}"))


# ── 内容 JSON ──────────────────────────────────────────────────────────────


def require_text(value: object, where: str, limit: int | None = None) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(EXIT_INVALID_CONTENT, f"{where} 不能为空。")
    text = value.strip()
    if limit is not None and len(text) > limit:
        fail(EXIT_INVALID_CONTENT, f"{where} 超过 {limit} 字。拆开或缩短，不要截断。")
    return text


def parse_date(value: str) -> tuple[int, int, int] | None:
    if ISO_DATE.fullmatch(value) is None:
        return None
    try:
        day = datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return None
    return (day.year, day.month, day.day)


def parse_amount(value: str) -> Decimal | None:
    """表里写的数。可以带负号、会计括号、货币符号、「元」和量级（会换算）。"""
    text = normalize(value).strip()
    negative = False
    if text.startswith("(") and text.endswith(")"):
        text = text[1:-1].strip()
        negative = True
    text = text.lstrip(CURRENCY)
    if text.startswith("-"):
        text = text[1:]
        negative = True
    elif text.startswith("+"):
        text = text[1:]
    text = text.lstrip(CURRENCY)
    if text.endswith("元"):
        text = text[:-1].rstrip()
    exponent = 0
    for unit, power in UNITS:
        if text.endswith(unit):
            text = text[: -len(unit)].rstrip()
            exponent = power
            break
    if _LEDGER_NUMBER.fullmatch(text) is None:
        return None
    try:
        amount = Decimal(text.replace(",", "").replace(" ", "")).scaleb(exponent)
    except InvalidOperation:
        return None
    return -amount if negative else amount


def plain_number(value: str) -> Decimal | None:
    """文本列里写的是一个数时，也按数核对（正负号、日期里的年份同样要管）。"""
    text = normalize(value)
    if _PLAIN_NUMBER.fullmatch(text) is None:
        return None
    return Decimal(text.replace(",", ""))


def json_number(amount: Decimal) -> int | float:
    if amount == amount.to_integral_value():
        return int(amount)
    return float(amount)


def reject_unknown(raw: dict, allowed: set[str]) -> None:
    extra = set(raw) - allowed
    if extra:
        fail(EXIT_INVALID_CONTENT, "内容 JSON 有未声明的字段。")


def sheet_column(column: dict) -> dict:
    emitted = {"header": column["header"], "type": column["type"]}
    if column["formula"]:
        emitted["formula"] = column["formula"]
    return emitted


def ledger(raw: dict, source: Source) -> dict:
    title = require_text(raw.get("title"), "title", TITLE_MAX)
    sheet_name = require_text(raw.get("sheet"), "sheet")
    if len(sheet_name) > 31 or re.search(r"[:\\/?*\[\]]", sheet_name):
        fail(EXIT_INVALID_CONTENT, "sheet 不能超过 31 字，也不能含 : \\ / ? * [ ]。")
    columns = raw.get("columns")
    rows = raw.get("rows")
    if not isinstance(columns, list) or not columns:
        fail(EXIT_INVALID_CONTENT, "columns 至少要有一列。")
    if len(columns) > MAX_COLUMNS:
        fail(EXIT_INVALID_CONTENT, f"列超过 {MAX_COLUMNS} 个。拆成两张表，不要截断。")
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
            if len(formula) > FORMULA_MAX:
                fail(EXIT_INVALID_CONTENT, f"columns/{index}/formula 超过 {FORMULA_MAX} 字。")
            if re.search(r"\d", formula):
                fail(EXIT_INVALID_CONTENT, "公式里不能写死数字。原文里的数请单独成列抄进来。")
            if kind not in NUMERIC_KINDS:
                fail(EXIT_INVALID_CONTENT, "只有数值列可以带公式。")
        if set(column) - {"header", "type", "formula"}:
            fail(EXIT_INVALID_CONTENT, f"columns/{index} 有未声明的字段。")
        parsed_columns.append(
            {
                "header": require_text(column.get("header"), f"columns/{index}/header", HEADER_MAX),
                "type": kind,
                "formula": formula,
            }
        )
    items: list[list[Cell]] = []
    emitted_rows = []
    for row_index, row in enumerate(rows):
        if not isinstance(row, list) or len(row) != len(parsed_columns):
            fail(EXIT_INVALID_CONTENT, f"rows/{row_index} 的列数和 columns 不一致。")
        cells: list[Cell] = []
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
            kind = column["type"]
            if kind == "date":
                ymd = parse_date(text)
                if ymd is None:
                    fail(EXIT_INVALID_CONTENT, "日期列必须是 YYYY-MM-DD。")
                cells.append(Cell("date", ymd))
                emitted.append(text)
            elif kind in NUMERIC_KINDS:
                amount = parse_amount(text)
                if amount is None:
                    fail(
                        EXIT_INVALID_CONTENT,
                        f"rows/{row_index}/{col_index} 要按原文写成数，例如 128.00、1,280.50、-12.30 或 3.5万（会换算）。",
                    )
                if kind == "integer" and amount != amount.to_integral_value():
                    fail(EXIT_INVALID_CONTENT, "整数列里出现了小数。")
                cells.append(Cell("num", amount))
                emitted.append(json_number(amount))
            else:
                number = plain_number(text)
                cells.append(Cell("num", number) if number is not None else Cell("text", normalize(text)))
                emitted.append(text)
        items.append(cells)
        emitted_rows.append(emitted)
    place(source, items, "rows")
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


def absent_marked(text: str, start: int, end: int) -> bool:
    """这一处名字是不是标了缺席：`张三（缺席）`、`张三请假`、`缺席：张三`。"""
    after = text[end : end + 24]
    paren = _PAREN_AFTER.match(after)
    if paren and any(marker in paren.group(1) for marker in ABSENT_MARKERS):
        return True
    if _ABSENT_AFTER.match(after):
        return True
    floor = max(0, start - MAX_LINE_CHARS)
    clause_start = max(max(text.rfind(sep, floor, start) for sep in ("\n", "。", ";", "；")) + 1, floor)
    clause = text[clause_start:start]
    colon = clause.rfind(":")
    if colon < 0:
        return False
    label = clause[clause.rfind(":", 0, colon) + 1 : colon]
    return any(marker in label for marker in ABSENT_MARKERS)


def minutes(raw: dict, source: Source) -> dict:
    title = require_text(raw.get("title"), "title", TITLE_MAX)
    date = require_text(raw.get("date"), "date")
    ymd = parse_date(date)
    if ymd is None:
        fail(EXIT_INVALID_CONTENT, "date 必须是 YYYY-MM-DD。")
    attendees = raw.get("attendees")
    decisions = raw.get("decisions")
    actions = raw.get("actions")
    if not isinstance(attendees, list) or not attendees:
        fail(EXIT_INVALID_CONTENT, "attendees 至少要有一个人。")
    if not isinstance(decisions, list) or not decisions:
        fail(EXIT_INVALID_CONTENT, "decisions 至少要有一条决议。")
    if len(decisions) > BULLETS_MAX:
        fail(EXIT_INVALID_CONTENT, f"decisions 超过 {BULLETS_MAX} 条。合并或拆成两份纪要，不要截断。")
    if not isinstance(actions, list) or not actions:
        fail(EXIT_INVALID_CONTENT, "actions 至少要有一条待办。")
    if len(actions) > TABLE_ROWS_MAX:
        fail(EXIT_INVALID_CONTENT, f"actions 超过 {TABLE_ROWS_MAX} 条。拆成两份纪要，不要截断。")
    people = [require_text(item, f"attendees/{index}") for index, item in enumerate(attendees)]
    if len("参会：" + "、".join(people)) > PARAGRAPH_CHARS:
        fail(EXIT_INVALID_CONTENT, f"attendees 合起来超过 {PARAGRAPH_CHARS} 字。")
    decision_items = [
        require_text(item, f"decisions/{index}", BULLET_CHARS) for index, item in enumerate(decisions)
    ]
    if ymd not in source.date_index:
        fail(EXIT_INVALID_CONTENT, "日期在原文里对不上。不要换算原文没有写出的那一天。")

    seen: set[str] = set()
    for index, person in enumerate(people):
        needle = normalize(person)
        if needle in seen:
            fail(EXIT_INVALID_CONTENT, f"attendees/{index} 重复了。")
        seen.add(needle)
        found = occurrences(source.joined, needle)
        if any(absent_marked(source.joined, start, end) for start, end in found):
            fail(
                EXIT_INVALID_CONTENT,
                f"attendees/{index} 在原文里标了缺席或请假，不要列进参会人。原文前后矛盾时问用户。",
            )
        if not any(not is_negated(source.joined, start) for start, _ in found):
            fail(EXIT_INVALID_CONTENT, "有参会人在原文里对不上。不要补原文没有的人。")

    options = []
    for index, item in enumerate(decision_items):
        found = occurrences(source.joined, normalize(item))
        good = [span for span in found if not is_negated(source.joined, span[0])]
        if not good:
            if found:
                fail(
                    EXIT_INVALID_CONTENT,
                    f"decisions/{index} 在原文里前面带着不、未、没、无、非、否、勿或别，意思相反。按原文抄完整，不要去掉否定。",
                )
            fail(EXIT_INVALID_CONTENT, "有决议在原文里对不上。不要补原文没有的决议。")
        options.append([positions(span) for span in good])
    result = assign(options)
    if result is None or result is TOO_MANY:
        culprit = first_conflict(options)
        fail(
            EXIT_INVALID_CONTENT,
            f"decisions/{culprit if culprit is not None else 0} 和另一条决议用的是原文同一处。"
            "不要重复写一条决议，也不要把一句拆成两条。",
        )

    items: list[list[Cell]] = []
    rows = []
    for index, action in enumerate(actions):
        if not isinstance(action, dict):
            fail(EXIT_INVALID_CONTENT, f"actions/{index} 必须是对象。")
        if set(action) - {"task", "owner", "due"}:
            fail(EXIT_INVALID_CONTENT, f"actions/{index} 有未声明的字段。")
        task = require_text(action.get("task"), f"actions/{index}/task")
        owner = require_text(action.get("owner"), f"actions/{index}/owner")
        due = require_text(action.get("due"), f"actions/{index}/due")
        due_ymd = parse_date(due)
        if due_ymd is None:
            fail(EXIT_INVALID_CONTENT, "待办截止日期必须是 YYYY-MM-DD。")
        items.append([Cell("text", normalize(task)), Cell("text", normalize(owner)), Cell("date", due_ymd)])
        rows.append([task, owner, due])
    place(source, items, "actions")
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
    source = Source(read_source(Path(source_path.strip()).expanduser()))
    content = ledger(raw, source) if output == "ledger" else minutes(raw, source)
    out_path = Path(args.out).resolve()
    write_extracted(content, out_path)
    succeeded(out_path, output=output)


if __name__ == "__main__":
    main()
