"""xlsx 公式求值（验收检查 A4 用）。

本机没有 LibreOffice，而表格技能写出的 xlsx 只有公式、没有缓存值 —— 不求值就判不了
「汇总表的数和明细对不对得上」。这里只支持验收里会出现的那一小部分 Excel：
算术、比较、单元格与区域（含跨表）、SUM / SUMIF(S) / COUNTIF(S) / AVERAGE(IF(S)) /
MIN / MAX / COUNT(A) / ROUND / ABS / IF / IFERROR / OFFSET / INDEX / MATCH(精确) /
VLOOKUP(精确) / SUMPRODUCT。**遇到不支持的写法抛 Unsupported**，由调用方如实报 ERROR，不猜。
"""

from __future__ import annotations

import math
import re


class Unsupported(Exception):
    pass


class ExcelError:
    def __init__(self, code: str):
        self.code = code

    def __repr__(self) -> str:
        return self.code


def _to_float(text):
    m = re.fullmatch(r"\s*-?\d+(\.\d+)?\s*", str(text))
    return float(text) if m else None


def col_index(letters: str) -> int:
    n = 0
    for ch in letters.upper():
        n = n * 26 + ord(ch) - 64
    return n


def split_ref(ref: str) -> tuple[int, int]:
    m = re.fullmatch(r"\$?([A-Za-z]{1,3})\$?(\d+)", ref)
    return int(m.group(2)), col_index(m.group(1))


class Workbook:
    def __init__(self, path):
        from openpyxl import load_workbook

        self.wb = load_workbook(path, data_only=False)
        self.memo: dict = {}
        self.active: set = set()

    @property
    def sheetnames(self):
        return self.wb.sheetnames

    def value(self, sheet, r, c):
        key = (sheet, r, c)
        if key in self.memo:
            return self.memo[key]
        if sheet not in self.wb.sheetnames:
            raise Unsupported(f"引用了不存在的工作表 {sheet}")
        raw = self.wb[sheet].cell(row=r, column=c).value
        if isinstance(raw, str) and raw.startswith("="):
            if key in self.active:
                return ExcelError("#CIRC!")
            self.active.add(key)
            try:
                result = evaluate(raw, sheet, self)
            except Unsupported:
                raise
            except ZeroDivisionError:
                result = ExcelError("#DIV/0!")
            except Exception:
                result = ExcelError("#VALUE!")
            finally:
                self.active.discard(key)
        else:
            result = raw
        if isinstance(result, Ref):
            result = result.get()
        if isinstance(result, Rng):
            result = result.first()
        self.memo[key] = result
        return result

    def grid(self, sheet):
        ws = self.wb[sheet]
        return [
            [self.value(sheet, r, c) for c in range(1, ws.max_column + 1)]
            for r in range(1, ws.max_row + 1)
        ]


def unwrap(x):
    return x.get() if isinstance(x, Ref) else x


def is_number(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def num_of(x) -> float:
    x = unwrap(x)
    if x is None or x == "":
        return 0.0
    if isinstance(x, bool):
        return 1.0 if x else 0.0
    if is_number(x):
        return float(x)
    if isinstance(x, ExcelError):
        raise ValueError(x.code)
    value = _to_float(str(x).replace(",", ""))
    if value is None:
        raise ValueError("#VALUE!")
    return value


class Ref:
    """单元格引用：参与运算时表现为它的值，交给 OFFSET / INDEX 时是一个位置。"""

    def __init__(self, wb, sheet, r, c):
        self.wb, self.sheet, self.r, self.c = wb, sheet, r, c

    def get(self):
        return self.wb.value(self.sheet, self.r, self.c)

    def _arith(self, other, op, reverse=False):
        a, b = num_of(self), num_of(other)
        return op(b, a) if reverse else op(a, b)

    def __add__(self, o):
        return self._arith(o, lambda a, b: a + b)

    def __radd__(self, o):
        return self._arith(o, lambda a, b: a + b, True)

    def __sub__(self, o):
        return self._arith(o, lambda a, b: a - b)

    def __rsub__(self, o):
        return self._arith(o, lambda a, b: a - b, True)

    def __mul__(self, o):
        return self._arith(o, lambda a, b: a * b)

    def __rmul__(self, o):
        return self._arith(o, lambda a, b: a * b, True)

    def __truediv__(self, o):
        return self._arith(o, lambda a, b: a / b)

    def __rtruediv__(self, o):
        return self._arith(o, lambda a, b: a / b, True)

    def __pow__(self, o):
        return self._arith(o, lambda a, b: a**b)

    def __rpow__(self, o):
        return self._arith(o, lambda a, b: a**b, True)

    def __neg__(self):
        return -num_of(self)

    def __pos__(self):
        return num_of(self)

    def _compare(self, other, op):
        a, b = unwrap(self), unwrap(other)
        if is_number(a) and is_number(b):
            return op(a, b)
        return op(str("" if a is None else a).lower(), str("" if b is None else b).lower())

    def __eq__(self, o):
        return self._compare(o, lambda a, b: a == b)

    def __ne__(self, o):
        return self._compare(o, lambda a, b: a != b)

    def __lt__(self, o):
        return self._compare(o, lambda a, b: a < b)

    def __le__(self, o):
        return self._compare(o, lambda a, b: a <= b)

    def __gt__(self, o):
        return self._compare(o, lambda a, b: a > b)

    def __ge__(self, o):
        return self._compare(o, lambda a, b: a >= b)

    __hash__ = object.__hash__

    def __float__(self):
        return num_of(self)

    def __bool__(self):
        return bool(unwrap(self))


class Rng:
    def __init__(self, wb, sheet, r1, c1, r2, c2):
        self.wb, self.sheet = wb, sheet
        self.r1, self.r2 = min(r1, r2), max(r1, r2)
        self.c1, self.c2 = min(c1, c2), max(c1, c2)

    def cells(self):
        return [(r, c) for r in range(self.r1, self.r2 + 1) for c in range(self.c1, self.c2 + 1)]

    def values(self):
        return [self.wb.value(self.sheet, r, c) for r, c in self.cells()]

    def first(self):
        return self.wb.value(self.sheet, self.r1, self.c1)


def numbers(args):
    out = []
    for a in args:
        if isinstance(a, Rng):
            out += [float(v) for v in a.values() if is_number(v)]
        else:
            v = unwrap(a)
            if v is not None and v != "":
                out.append(num_of(v))
    return out


def as_values(x):
    return x.values() if isinstance(x, Rng) else [unwrap(x)]


def matcher(criterion):
    """Excel 条件语义：文本不分大小写、支持 * ? 通配与 > < >= <= <> = 前缀。"""
    crit = unwrap(criterion)
    if is_number(crit):
        target = float(crit)
        return lambda v: (is_number(v) and float(v) == target) or (
            isinstance(v, str) and _to_float(v) == target
        )
    text = "" if crit is None else str(crit)
    m = re.match(r"^(<>|>=|<=|=|>|<)(.*)$", text)
    op, operand = (m.group(1), m.group(2)) if m else ("=", text)
    target = _to_float(operand)
    if target is not None and op != "=":
        compare = {
            "<>": lambda v: v != target,
            ">": lambda v: v > target,
            "<": lambda v: v < target,
            ">=": lambda v: v >= target,
            "<=": lambda v: v <= target,
        }[op]
        return lambda v: compare(float(v)) if is_number(v) else op == "<>"
    pattern = re.compile(
        "^" + re.escape(operand.lower()).replace(r"\*", ".*").replace(r"\?", ".") + "$"
    )

    def textual(v):
        if target is not None and is_number(v):
            hit = float(v) == target
        else:
            hit = bool(pattern.match("" if v is None else str(v).lower()))
        return not hit if op == "<>" else hit

    return textual


def _conditional(total_range, pairs):
    base = pairs[0][0]
    tests = [(rng, matcher(crit)) for rng, crit in pairs]
    total, count = 0.0, 0
    for index, (r, c) in enumerate(base.cells()):
        if not all(test(rng.wb.value(rng.sheet, *rng.cells()[index])) for rng, test in tests):
            continue
        count += 1
        if total_range is not None:
            v = total_range.wb.value(
                total_range.sheet, total_range.r1 + (r - base.r1), total_range.c1 + (c - base.c1)
            )
            if is_number(v):
                total += v
    return total, count


def _pairs(rest):
    return [(rest[i], rest[i + 1]) for i in range(0, len(rest) - 1, 2)]


def _need_range(x, name):
    if not isinstance(x, Rng):
        raise Unsupported(f"{name} 的条件区域不是一个区域")
    return x


def F_SUM(*a):
    return sum(numbers(a))


def F_AVERAGE(*a):
    v = numbers(a)
    if not v:
        raise ZeroDivisionError
    return sum(v) / len(v)


def F_MIN(*a):
    v = numbers(a)
    return min(v) if v else 0.0


def F_MAX(*a):
    v = numbers(a)
    return max(v) if v else 0.0


def F_COUNT(*a):
    return sum(1 for x in a for v in as_values(x) if is_number(v))


def F_COUNTA(*a):
    return sum(1 for x in a for v in as_values(x) if v not in (None, ""))


def F_ROUND(x, n=0):
    x, n = num_of(x), int(num_of(n))
    q = 10**n
    return math.floor(abs(x) * q + 0.5) / q * (1 if x >= 0 else -1)


def F_ABS(x):
    return abs(num_of(x))


def F_IF(cond, a=True, b=False):
    return unwrap(a) if unwrap(cond) else unwrap(b)


def F_IFERROR(a, b):
    # 参数是先求值的：除零之类在进来之前就变成了异常，所以这里只能接住 ExcelError 值
    v = unwrap(a)
    return unwrap(b) if isinstance(v, ExcelError) else v


def F_SUMIF(rng, crit, sum_range=None):
    rng = _need_range(rng, "SUMIF")
    return _conditional(sum_range if sum_range is not None else rng, [(rng, crit)])[0]


def F_SUMIFS(sum_range, *rest):
    return _conditional(sum_range, [(_need_range(r, "SUMIFS"), c) for r, c in _pairs(rest)])[0]


def F_COUNTIF(rng, crit):
    return _conditional(None, [(_need_range(rng, "COUNTIF"), crit)])[1]


def F_COUNTIFS(*rest):
    return _conditional(None, [(_need_range(r, "COUNTIFS"), c) for r, c in _pairs(rest)])[1]


def F_AVERAGEIF(rng, crit, avg_range=None):
    rng = _need_range(rng, "AVERAGEIF")
    total, count = _conditional(avg_range if avg_range is not None else rng, [(rng, crit)])
    if count == 0:
        raise ZeroDivisionError
    return total / count


def F_AVERAGEIFS(avg_range, *rest):
    total, count = _conditional(avg_range, [(_need_range(r, "AVERAGEIFS"), c) for r, c in _pairs(rest)])
    if count == 0:
        raise ZeroDivisionError
    return total / count


def F_OFFSET(ref, rows, cols, height=None, width=None):
    if isinstance(ref, Ref):
        base = Rng(ref.wb, ref.sheet, ref.r, ref.c, ref.r, ref.c)
    elif isinstance(ref, Rng):
        base = ref
    else:
        raise Unsupported("OFFSET 的第一个参数不是引用")
    h = int(num_of(height)) if height is not None else base.r2 - base.r1 + 1
    w = int(num_of(width)) if width is not None else base.c2 - base.c1 + 1
    r1, c1 = base.r1 + int(num_of(rows)), base.c1 + int(num_of(cols))
    return Rng(base.wb, base.sheet, r1, c1, r1 + h - 1, c1 + w - 1)


def F_INDEX(rng, row, col=1):
    return rng.wb.value(rng.sheet, rng.r1 + int(num_of(row)) - 1, rng.c1 + int(num_of(col)) - 1)


def F_MATCH(value, rng, kind=1):
    if int(num_of(kind)) != 0:
        raise Unsupported("MATCH 只支持精确匹配（第三个参数 0）")
    test = matcher(value)
    for i, v in enumerate(rng.values()):
        if test(v):
            return i + 1
    return ExcelError("#N/A")


def F_VLOOKUP(value, rng, col, exact=True):
    if unwrap(exact) not in (False, 0):
        raise Unsupported("VLOOKUP 只支持精确匹配（第四个参数 FALSE / 0）")
    test = matcher(value)
    for r in range(rng.r1, rng.r2 + 1):
        if test(rng.wb.value(rng.sheet, r, rng.c1)):
            return rng.wb.value(rng.sheet, r, rng.c1 + int(num_of(col)) - 1)
    return ExcelError("#N/A")


def F_SUMPRODUCT(*ranges):
    columns = [[float(v) if is_number(v) else 0.0 for v in as_values(r)] for r in ranges]
    return sum(math.prod(parts) for parts in zip(*columns))


FUNCTIONS = {name[2:]: fn for name, fn in dict(globals()).items() if name.startswith("F_")}

REF = re.compile(
    r"(?<![A-Za-z0-9_.$一-鿿])"
    r"(?:(?P<sheet>'(?:[^']|'')+'|[A-Za-z_一-鿿][A-Za-z0-9_.一-鿿]*)!)?"
    r"(?P<a>\$?[A-Za-z]{1,3}\$?\d+)(?::(?P<b>\$?[A-Za-z]{1,3}\$?\d+))?"
    r"(?![A-Za-z0-9_(])"
)


def translate(formula: str, here: str) -> str:
    """Excel 公式 → 受限的 Python 表达式。字符串字面量原样保留，不参与替换。"""
    body = formula[1:] if formula.startswith("=") else formula
    parts = re.split(r'("(?:[^"]|"")*")', body)
    out = []
    for i, part in enumerate(parts):
        if i % 2 == 1:
            out.append(repr(part[1:-1].replace('""', '"')))
            continue
        if "&" in part:
            raise Unsupported("不支持字符串拼接 &")

        def ref(m):
            sheet = m.group("sheet")
            if sheet is None:
                sheet = here
            elif sheet.startswith("'"):
                sheet = sheet[1:-1].replace("''", "'")
            r1, c1 = split_ref(m.group("a"))
            if m.group("b"):
                r2, c2 = split_ref(m.group("b"))
                return f"RNG({sheet!r},{r1},{c1},{r2},{c2})"
            return f"REF({sheet!r},{r1},{c1})"

        code = REF.sub(ref, part)

        def function(m):
            name = m.group(1).upper()
            if name in ("REF", "RNG"):
                return m.group(0)
            if name not in FUNCTIONS:
                raise Unsupported(f"不支持的函数 {name}")
            return f"F_{name}("

        code = re.sub(r"(?<![A-Za-z0-9_'])([A-Za-z][A-Za-z0-9.]*)\s*\(", function, code)
        code = re.sub(r"(\d+(?:\.\d+)?)%", r"(\1/100)", code)
        code = code.replace("<>", "!=").replace("^", "**")
        code = re.sub(r"(?<![<>!=])=(?!=)", "==", code)
        code = re.sub(r"\bTRUE\b", "True", code)
        code = re.sub(r"\bFALSE\b", "False", code)
        out.append(code)
    return "".join(out)


def evaluate(formula: str, here: str, wb: Workbook):
    code = translate(formula, here)
    namespace = {f"F_{name}": fn for name, fn in FUNCTIONS.items()}
    namespace["REF"] = lambda s, r, c: Ref(wb, s, r, c)
    namespace["RNG"] = lambda s, r1, c1, r2, c2: Rng(wb, s, r1, c1, r2, c2)
    # 表达式只来自被测 xlsx 的公式，且经过上面的白名单翻译；不给 builtins
    return unwrap(eval(compile(code, "<formula>", "eval"), {"__builtins__": {}}, namespace))
