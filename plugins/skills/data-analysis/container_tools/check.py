#!/usr/bin/env python3
"""分析提纲 → documents 内容 JSON。不计算、不画图。"""

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


def text(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(EXIT_INVALID_CONTENT, f"{where} 不能为空。")
    return value.strip()


def texts(value: object, where: str) -> list[str]:
    if not isinstance(value, list) or not value:
        fail(EXIT_INVALID_CONTENT, f"{where} 至少要有一条。")
    return [text(item, f"{where}/{index}") for index, item in enumerate(value)]


def objects(value: object, where: str, fields: tuple[str, ...]) -> list[dict[str, str]]:
    if not isinstance(value, list) or not value:
        fail(EXIT_INVALID_CONTENT, f"{where} 至少要有一条。")
    out = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            fail(EXIT_INVALID_CONTENT, f"{where}/{index} 必须是对象。")
        out.append({field: text(item.get(field), f"{where}/{index}/{field}") for field in fields})
    return out


def build(raw: dict) -> dict:
    question = text(raw.get("question"), "question")
    sources = objects(raw.get("sources"), "sources", ("file", "sheet"))
    definitions = objects(raw.get("definitions"), "definitions", ("name", "formula"))
    comparisons = objects(raw.get("comparisons"), "comparisons", ("name", "baseline", "finding"))
    anomalies = texts(raw.get("anomalies"), "anomalies")
    conclusions = texts(raw.get("conclusions"), "conclusions")
    charts = objects(raw.get("charts") or [], "charts", ("title", "source")) if raw.get("charts") else []
    tables = objects(raw.get("tables") or [], "tables", ("title", "source")) if raw.get("tables") else []
    if raw.get("charts") == [] or raw.get("tables") == []:
        fail(EXIT_INVALID_CONTENT, "charts 或 tables 给了空数组。不需要图或表时不要写这个字段。")

    source_lines = [f"{item['file']} / {item['sheet']}" for item in sources]
    definition_lines = [f"{item['name']} = {item['formula']}" for item in definitions]
    comparison_lines = [
        f"{item['name']}（相对{item['baseline']}）：{item['finding']}" for item in comparisons
    ]
    blocks: list[dict] = [
        {"block": "paragraph", "text": question},
        {"block": "heading", "level": 1, "text": "数据来源"},
        {"block": "bullets", "items": source_lines},
        {"block": "heading", "level": 1, "text": "口径"},
        {"block": "bullets", "items": definition_lines},
        {"block": "heading", "level": 1, "text": "对比"},
        {"block": "bullets", "items": comparison_lines},
        {"block": "heading", "level": 1, "text": "异常"},
        {"block": "bullets", "items": anomalies},
        {"block": "heading", "level": 1, "text": "结论"},
        {"block": "bullets", "items": conclusions},
    ]
    if charts:
        blocks.append({"block": "heading", "level": 1, "text": "图"})
        blocks.append(
            {"block": "bullets", "items": [f"{item['title']}（来源：{item['source']}）" for item in charts]}
        )
    if tables:
        blocks.append({"block": "heading", "level": 1, "text": "表"})
        blocks.append(
            {"block": "bullets", "items": [f"{item['title']}（来源：{item['source']}）" for item in tables]}
        )
    return {"template": "memo", "title": question[:120], "blocks": blocks}


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
