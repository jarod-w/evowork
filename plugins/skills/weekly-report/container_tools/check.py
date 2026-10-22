#!/usr/bin/env python3
"""周报 JSON → documents 技能的内容 JSON。三节缺一不可。

documents 渲染器有上限（每节最多 30 条、每条最多 300 字、标题最多 120 字）。
2026-10-22 之前这里不管，模型过了检查、到渲染才失败，报错路径是 ``blocks/1 items/0``，
对不回 ``period/0``。所以同样的上限在这里先查一遍，报原来的字段名。
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
    document_limits,
)

#: documents 渲染器的上限，从它的 schema 读（evowork_skill.document_limits）
_LIMITS = document_limits()

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SECTIONS = (("period", "本期"), ("risks", "风险"), ("next", "下周"))

#: documents 的 content.schema.json：title、bullets 的条数和每条的字数。
TITLE_MAX = _LIMITS["title"]
BULLETS_MAX = _LIMITS["list_items"]
BULLET_CHARS = _LIMITS["item_chars"]


def require_text(value: object, where: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(EXIT_INVALID_CONTENT, f"{where} 不能为空。")
    text = value.strip()
    if len(text) > limit:
        fail(EXIT_INVALID_CONTENT, f"{where} 超过 {limit} 字。拆成两条或写短一些，不要截断。")
    return text


def section(raw: dict, key: str, heading: str) -> list[str]:
    values = raw.get(key)
    if not isinstance(values, list) or not values:
        fail(EXIT_INVALID_CONTENT, f"{heading} 至少要有一条。没有内容就写明「没有」，不要省掉这一节。")
    if len(values) > BULLETS_MAX:
        fail(EXIT_INVALID_CONTENT, f"{key} 超过 {BULLETS_MAX} 条。合并相近的条目，不要截断。")
    return [require_text(item, f"{key}/{index}", BULLET_CHARS) for index, item in enumerate(values)]


def build(raw: dict) -> dict:
    title = require_text(raw.get("title"), "title", TITLE_MAX)
    date = require_text(raw.get("date"), "date", TITLE_MAX)
    if DATE.match(date) is None:
        fail(EXIT_INVALID_CONTENT, "date 必须是 YYYY-MM-DD。")
    try:
        datetime.strptime(date, "%Y-%m-%d")
    except ValueError:
        fail(EXIT_INVALID_CONTENT, "date 不是有效日期。")
    blocks: list[dict] = []
    for key, heading in SECTIONS:
        blocks.append({"block": "heading", "level": 1, "text": heading})
        blocks.append({"block": "bullets", "items": section(raw, key, heading)})
    return {"template": "memo", "title": title, "date": date, "blocks": blocks}


def main() -> None:
    parser = argparse.ArgumentParser(description="检查周报并写成 documents 内容 JSON")
    parser.add_argument("--content", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    raw = read_content(Path(args.content).resolve())
    extra = set(raw) - {"title", "date", "period", "risks", "next"}
    if extra:
        fail(EXIT_INVALID_CONTENT, "周报 JSON 有未声明的字段。只写 title、date、period、risks、next。")
    content = build(raw)
    out_path = Path(args.out).resolve()
    write_extracted(content, out_path)
    succeeded(out_path, sections=3)


if __name__ == "__main__":
    main()
