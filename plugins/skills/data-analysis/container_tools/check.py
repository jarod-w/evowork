#!/usr/bin/env python3
"""分析提纲 → documents 内容 JSON。不计算、不画图。

2026-10-22 评审后补的两件事：

- **来源要真的在。** 之前只查 ``sources`` 非空，一个不存在的文件照样过；
  图和表的 ``source`` 也可以写成 ``sources`` 里没有的东西。现在 ``sources[].file``
  要指向存在的文件（绝对路径，或相对当前工作目录），每张图、每张表的 ``source``
  必须是 ``sources`` 里的一项（写 ``file``，或写 ``file / sheet``）。
- **documents 收得下。** 渲染器每个列表最多 30 条、每条最多 300 字。之前过了检查、
  到渲染才失败，报错路径是 ``blocks/5 items/0``，对不回 ``comparisons/0``。
  现在同样的上限在这里先查，报原来的字段名。
"""

from __future__ import annotations

import argparse
import sys
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

#: documents 的 content.schema.json：paragraph 的字数、bullets 的条数和每条的字数。
PARAGRAPH_CHARS = 4000
BULLETS_MAX = 30
BULLET_CHARS = 300
#: 文档标题（documents 的 title 上限）。完整的问题写在正文第一段，这里只取开头作标题。
TITLE_MAX = 120


def text(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(EXIT_INVALID_CONTENT, f"{where} 不能为空。")
    return value.strip()


def listed(value: object, where: str) -> list:
    if not isinstance(value, list) or not value:
        fail(EXIT_INVALID_CONTENT, f"{where} 至少要有一条。")
    if len(value) > BULLETS_MAX:
        fail(EXIT_INVALID_CONTENT, f"{where} 超过 {BULLETS_MAX} 条。合并相近的条目或拆成两份报告，不要截断。")
    return value


def texts(value: object, where: str) -> list[str]:
    items = [text(item, f"{where}/{index}") for index, item in enumerate(listed(value, where))]
    for index, item in enumerate(items):
        if len(item) > BULLET_CHARS:
            fail(EXIT_INVALID_CONTENT, f"{where}/{index} 超过 {BULLET_CHARS} 字。拆成两条，不要截断。")
    return items


def objects(value: object, where: str, fields: tuple[str, ...]) -> list[dict[str, str]]:
    out = []
    for index, item in enumerate(listed(value, where)):
        if not isinstance(item, dict):
            fail(EXIT_INVALID_CONTENT, f"{where}/{index} 必须是对象。")
        out.append({field: text(item.get(field), f"{where}/{index}/{field}") for field in fields})
    return out


def lines(items: list[dict[str, str]], where: str, fields: tuple[str, ...], render) -> list[str]:
    """把每个对象拼成报告里的一条；拼出来超长时报原来的字段名。"""
    out = []
    for index, item in enumerate(items):
        line = render(item)
        if len(line) > BULLET_CHARS:
            fail(
                EXIT_INVALID_CONTENT,
                f"{where}/{index} 的 {'、'.join(fields)} 合起来超过 {BULLET_CHARS} 字（报告里写成一条）。写短一些，不要截断。",
            )
        out.append(line)
    return out


def source_label(item: dict[str, str]) -> str:
    return f"{item['file']} / {item['sheet']}"


def check_sources(sources: list[dict[str, str]]) -> None:
    for index, item in enumerate(sources):
        path = Path(item["file"]).expanduser()
        if not path.is_absolute():
            path = Path.cwd() / path
        if not path.is_file():
            fail(
                EXIT_INVALID_CONTENT,
                f"sources/{index}/file 指向的文件不存在（相对路径按当前工作目录算）。"
                "写数据文件的绝对路径；没有数据就不要分析，也不要先造一份数据。",
            )


def check_cited(items: list[dict[str, str]], where: str, sources: list[dict[str, str]]) -> None:
    declared = {item["file"] for item in sources} | {source_label(item) for item in sources}
    for index, item in enumerate(items):
        if item["source"] not in declared:
            fail(
                EXIT_INVALID_CONTENT,
                f"{where}/{index}/source 不是 sources 里的一项。写 sources 里的 file，"
                "或写成「file / sheet」；用到的数据文件先加进 sources。",
            )


def build(raw: dict) -> dict:
    question = text(raw.get("question"), "question")
    if len(question) > PARAGRAPH_CHARS:
        fail(EXIT_INVALID_CONTENT, f"question 超过 {PARAGRAPH_CHARS} 字。")
    sources = objects(raw.get("sources"), "sources", ("file", "sheet"))
    check_sources(sources)
    definitions = objects(raw.get("definitions"), "definitions", ("name", "formula"))
    comparisons = objects(raw.get("comparisons"), "comparisons", ("name", "baseline", "finding"))
    anomalies = texts(raw.get("anomalies"), "anomalies")
    conclusions = texts(raw.get("conclusions"), "conclusions")
    if raw.get("charts") == [] or raw.get("tables") == []:
        fail(EXIT_INVALID_CONTENT, "charts 或 tables 给了空数组。不需要图或表时不要写这个字段。")
    charts = objects(raw["charts"], "charts", ("title", "source")) if raw.get("charts") is not None else []
    tables = objects(raw["tables"], "tables", ("title", "source")) if raw.get("tables") is not None else []
    check_cited(charts, "charts", sources)
    check_cited(tables, "tables", sources)

    def cited(item: dict[str, str]) -> str:
        return f"{item['title']}（来源：{item['source']}）"

    blocks: list[dict] = [
        {"block": "paragraph", "text": question},
        {"block": "heading", "level": 1, "text": "数据来源"},
        {"block": "bullets", "items": lines(sources, "sources", ("file", "sheet"), source_label)},
        {"block": "heading", "level": 1, "text": "口径"},
        {
            "block": "bullets",
            "items": lines(
                definitions,
                "definitions",
                ("name", "formula"),
                lambda item: f"{item['name']} = {item['formula']}",
            ),
        },
        {"block": "heading", "level": 1, "text": "对比"},
        {
            "block": "bullets",
            "items": lines(
                comparisons,
                "comparisons",
                ("name", "baseline", "finding"),
                lambda item: f"{item['name']}（相对{item['baseline']}）：{item['finding']}",
            ),
        },
        {"block": "heading", "level": 1, "text": "异常"},
        {"block": "bullets", "items": anomalies},
        {"block": "heading", "level": 1, "text": "结论"},
        {"block": "bullets", "items": conclusions},
    ]
    if charts:
        blocks.append({"block": "heading", "level": 1, "text": "图"})
        blocks.append({"block": "bullets", "items": lines(charts, "charts", ("title", "source"), cited)})
    if tables:
        blocks.append({"block": "heading", "level": 1, "text": "表"})
        blocks.append({"block": "bullets", "items": lines(tables, "tables", ("title", "source"), cited)})
    return {"template": "memo", "title": question[:TITLE_MAX], "blocks": blocks}


def main() -> None:
    parser = argparse.ArgumentParser(description="检查分析提纲并写成 documents 内容 JSON")
    parser.add_argument("--content", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    raw = read_content(Path(args.content).resolve())
    allowed = {
        "question",
        "sources",
        "definitions",
        "comparisons",
        "anomalies",
        "conclusions",
        "charts",
        "tables",
    }
    if set(raw) - allowed:
        fail(EXIT_INVALID_CONTENT, "分析 JSON 有未声明的字段。")
    content = build(raw)
    out_path = Path(args.out).resolve()
    write_extracted(content, out_path)
    succeeded(out_path, conclusions=len(raw["conclusions"]))


if __name__ == "__main__":
    main()
