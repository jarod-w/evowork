#!/usr/bin/env python3
"""会议纪要 JSON → documents 技能的内容 JSON。

决议和待办是这个文种存在的理由。缺负责人或截止日期时停下来，
不让模型交一份看起来完整、其实没法跟进的纪要。
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

DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def require_text(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(EXIT_INVALID_CONTENT, f"{where} 不能为空。")
    return value.strip()


def require_date(value: object, where: str) -> str:
    text = require_text(value, where)
    if DATE.match(text) is None:
        fail(EXIT_INVALID_CONTENT, f"{where} 必须是 YYYY-MM-DD。")
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        fail(EXIT_INVALID_CONTENT, f"{where} 不是有效日期。")
    return text


def build(raw: dict) -> dict:
    title = require_text(raw.get("title"), "title")
    date = require_date(raw.get("date"), "date")
    attendees = raw.get("attendees")
    if not isinstance(attendees, list) or not attendees:
        fail(EXIT_INVALID_CONTENT, "attendees 至少要有一个人。")
    people = [require_text(item, f"attendees/{index}") for index, item in enumerate(attendees)]
    decisions = raw.get("decisions")
    if not isinstance(decisions, list) or not decisions:
        fail(EXIT_INVALID_CONTENT, "decisions 至少要有一条决议。没有决议就不要写纪要。")
    decision_items = [require_text(item, f"decisions/{index}") for index, item in enumerate(decisions)]
    actions = raw.get("actions")
    if not isinstance(actions, list) or not actions:
        fail(EXIT_INVALID_CONTENT, "actions 至少要有一条待办。")
    rows = []
    for index, action in enumerate(actions):
        if not isinstance(action, dict):
            fail(EXIT_INVALID_CONTENT, f"actions/{index} 必须是对象。")
        rows.append(
            [
                require_text(action.get("task"), f"actions/{index}/task"),
                require_text(action.get("owner"), f"actions/{index}/owner"),
                require_date(action.get("due"), f"actions/{index}/due"),
            ]
        )
    return {
        "template": "memo",
        "title": title,
        "date": date,
        "blocks": [
            {"block": "paragraph", "text": "参会：" + "、".join(people)},
            {"block": "heading", "level": 1, "text": "决议"},
            {"block": "bullets", "items": decision_items},
            {"block": "heading", "level": 1, "text": "待办"},
            {
                "block": "table",
                "header": ["事项", "负责人", "截止日期"],
                "rows": rows,
            },
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="检查会议纪要并写成 documents 内容 JSON")
    parser.add_argument("--content", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    raw = read_content(Path(args.content).resolve())
    allowed = {"title", "date", "attendees", "decisions", "actions"}
    extra = set(raw) - allowed
    if extra:
        fail(EXIT_INVALID_CONTENT, "纪要 JSON 有未声明的字段。只写 title、date、attendees、decisions、actions。")
    content = build(raw)
    out_path = Path(args.out).resolve()
    write_extracted(content, out_path)
    succeeded(out_path, decisions=len(raw["decisions"]), actions=len(raw["actions"]))


if __name__ == "__main__":
    main()
