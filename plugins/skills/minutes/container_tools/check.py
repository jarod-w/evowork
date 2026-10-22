#!/usr/bin/env python3
"""会议纪要 JSON → documents 技能的内容 JSON。

决议和待办是这个文种存在的理由。缺负责人或截止日期时停下来，
不让模型交一份看起来完整、其实没法跟进的纪要。

但「必填」不能变成「必须编一个」（2026-10-22 评审）：本技能看不到会议原文，
没法核对负责人和日期是不是材料里写的。所以材料里没定的，要**明说**「待定」或「未定」——
空着、写「无」「-」「TBD」都不收，免得读纪要的人分不清是没定还是漏了。
截止日期早于会议日期的，多半是倒推或抄错，也不收。
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date as Day
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
#: 材料里没定的负责人、截止日期，只认这两种写法。
UNDECIDED = ("待定", "未定")
#: 看起来像「没定」、却没说清的占位写法。
PLACEHOLDERS = frozenset(
    {"-", "--", "—", "——", "/", "?", "？", "无", "暂无", "没有", "不明", "未知", "待确认", "tbd", "n/a", "na", "none"}
)

#: documents 渲染器的上限（它的 content.schema.json）。这里放行的，渲染器必须也放行 ——
#: 否则过了检查、到渲染那一步才失败，报错路径（blocks/2 items/0）还对不回原字段。
TITLE_MAX = 120
BULLETS_MAX = 30
BULLET_CHARS = 300
PARAGRAPH_CHARS = 4000
TABLE_ROWS_MAX = 200


def require_text(value: object, where: str, limit: int | None = None) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(EXIT_INVALID_CONTENT, f"{where} 不能为空。")
    text = value.strip()
    if limit is not None and len(text) > limit:
        fail(EXIT_INVALID_CONTENT, f"{where} 超过 {limit} 字。拆开或缩短，不要截断。")
    return text


def parse_date(text: str, where: str) -> Day:
    if DATE.match(text) is None:
        fail(EXIT_INVALID_CONTENT, f"{where} 必须是 YYYY-MM-DD。")
    try:
        day = datetime.strptime(text, "%Y-%m-%d").date()
    except ValueError:
        fail(EXIT_INVALID_CONTENT, f"{where} 不是有效日期。")
    return day


def require_known(value: object, where: str, what: str) -> str:
    text = require_text(value, where)
    if text.lower() in PLACEHOLDERS:
        fail(EXIT_INVALID_CONTENT, f"{where} 是占位写法。{what}材料里没定就写「待定」或「未定」，不要编一个。")
    return text


def build(raw: dict) -> tuple[dict, int]:
    title = require_text(raw.get("title"), "title", TITLE_MAX)
    date_text = require_text(raw.get("date"), "date")
    meeting = parse_date(date_text, "date")
    attendees = raw.get("attendees")
    if not isinstance(attendees, list) or not attendees:
        fail(EXIT_INVALID_CONTENT, "attendees 至少要有一个人。")
    people = [require_text(item, f"attendees/{index}") for index, item in enumerate(attendees)]
    if len("参会：" + "、".join(people)) > PARAGRAPH_CHARS:
        fail(EXIT_INVALID_CONTENT, f"attendees 合起来超过 {PARAGRAPH_CHARS} 字。")
    decisions = raw.get("decisions")
    if not isinstance(decisions, list) or not decisions:
        fail(EXIT_INVALID_CONTENT, "decisions 至少要有一条决议。没有决议就不要写纪要。")
    if len(decisions) > BULLETS_MAX:
        fail(EXIT_INVALID_CONTENT, f"decisions 超过 {BULLETS_MAX} 条。合并相近的决议或拆成两份纪要，不要截断。")
    decision_items = [
        require_text(item, f"decisions/{index}", BULLET_CHARS) for index, item in enumerate(decisions)
    ]
    actions = raw.get("actions")
    if not isinstance(actions, list) or not actions:
        fail(EXIT_INVALID_CONTENT, "actions 至少要有一条待办。")
    if len(actions) > TABLE_ROWS_MAX:
        fail(EXIT_INVALID_CONTENT, f"actions 超过 {TABLE_ROWS_MAX} 条。拆成两份纪要，不要截断。")
    rows = []
    undecided = 0
    for index, action in enumerate(actions):
        if not isinstance(action, dict):
            fail(EXIT_INVALID_CONTENT, f"actions/{index} 必须是对象。")
        if set(action) - {"task", "owner", "due"}:
            fail(EXIT_INVALID_CONTENT, f"actions/{index} 有未声明的字段。只写 task、owner、due。")
        task = require_text(action.get("task"), f"actions/{index}/task")
        owner = require_known(action.get("owner"), f"actions/{index}/owner", "负责人")
        due = require_known(action.get("due"), f"actions/{index}/due", "截止日期")
        if due not in UNDECIDED and parse_date(due, f"actions/{index}/due") < meeting:
            fail(
                EXIT_INVALID_CONTENT,
                f"actions/{index}/due 早于会议日期。按材料抄截止日期；材料里没定就写「待定」，不要倒推一个日期。",
            )
        if owner in UNDECIDED or due in UNDECIDED:
            undecided += 1
        rows.append([task, owner, due])
    content = {
        "template": "memo",
        "title": title,
        "date": date_text,
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
    return content, undecided


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
    content, undecided = build(raw)
    out_path = Path(args.out).resolve()
    write_extracted(content, out_path)
    # 有「待定」的待办要原样告诉用户：纪要发出去之前，这几条还得有人认领、定日期。
    succeeded(out_path, decisions=len(raw["decisions"]), actions=len(raw["actions"]), undecided=undecided)


if __name__ == "__main__":
    main()
