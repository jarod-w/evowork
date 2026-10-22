#!/usr/bin/env python3
"""周报 JSON → documents 技能的内容 JSON。三节缺一不可。"""

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

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SECTIONS = (("period", "本期"), ("risks", "风险"), ("next", "下周"))


def require_text(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(EXIT_INVALID_CONTENT, f"{where} 不能为空。")
    return value.strip()


def section(raw: dict, key: str, heading: str) -> list[str]:
    values = raw.get(key)
    if not isinstance(values, list) or not values:
        fail(EXIT_INVALID_CONTENT, f"{heading} 至少要有一条。没有内容就写明「没有」，不要省掉这一节。")
    return [require_text(item, f"{key}/{index}") for index, item in enumerate(values)]


def build(raw: dict) -> dict:
    title = require_text(raw.get("title"), "title")
    date = require_text(raw.get("date"), "date")
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
