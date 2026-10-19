#!/usr/bin/env python3
"""流程图 / 组织关系 / 排期 → svg 或 png。

统计图不在这里。svg 与 png 用同一份坐标，避免一种格式只剩文字清单。
"""

from __future__ import annotations

import argparse
import html
import os
import sys
from datetime import datetime
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT.parent / "_shared"))

from evowork_skill import (  # noqa: E402
    EXIT_INVALID_CONTENT,
    EXIT_RUNTIME_MISSING,
    fail,
    office_fonts_dir,
    read_content,
    succeeded,
)

INK = "#1D1D1B"
LINE = "#C4C3BD"
ACCENT = "#0169CC"
FONT = "Noto Sans SC, PingFang SC, Microsoft YaHei, sans-serif"
MAX_NODES = 24
MAX_EDGES = 40
MAX_ROWS = 20
MAX_SPAN_DAYS = 366


def text_of(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(EXIT_INVALID_CONTENT, f"{where} 不能为空。")
    if len(value.strip()) > 40:
        fail(EXIT_INVALID_CONTENT, f"{where} 超过 40 字。")
    return value.strip()


def parse_day(value: object, where: str) -> datetime:
    text = text_of(value, where)
    try:
        return datetime.strptime(text, "%Y-%m-%d")
    except ValueError:
        fail(EXIT_INVALID_CONTENT, f"{where} 必须是 YYYY-MM-DD。")


def has_cjk(parts: list[dict]) -> bool:
    blob = " ".join(part.get("text", "") for part in parts)
    return any("一" <= ch <= "鿿" for ch in blob)


def flowchart(content: dict) -> tuple[int, int, list[dict]]:
    nodes = content.get("nodes")
    edges = content.get("edges")
    if not isinstance(nodes, list) or not nodes:
        fail(EXIT_INVALID_CONTENT, "flowchart 至少要有一个节点。")
    if len(nodes) > MAX_NODES:
        fail(EXIT_INVALID_CONTENT, f"节点超过 {MAX_NODES} 个。拆成两张图。")
    if not isinstance(edges, list):
        fail(EXIT_INVALID_CONTENT, "flowchart 的 edges 必须是数组。")
    if len(edges) > MAX_EDGES:
        fail(EXIT_INVALID_CONTENT, f"连线超过 {MAX_EDGES} 条。拆成两张图。")
    labels: dict[str, str] = {}
    order: list[str] = []
    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            fail(EXIT_INVALID_CONTENT, f"nodes/{index} 必须是对象。")
        node_id = text_of(node.get("id"), f"nodes/{index}/id")
        if node_id in labels:
            fail(EXIT_INVALID_CONTENT, "有两个节点用了同一个 id。")
        labels[node_id] = text_of(node.get("text"), f"nodes/{index}/text")
        order.append(node_id)
    pairs = []
    for index, edge in enumerate(edges):
        if not isinstance(edge, dict):
            fail(EXIT_INVALID_CONTENT, f"edges/{index} 必须是对象。")
        source = text_of(edge.get("from"), f"edges/{index}/from")
        target = text_of(edge.get("to"), f"edges/{index}/to")
        if source not in labels or target not in labels:
            fail(EXIT_INVALID_CONTENT, f"edges/{index} 的两端必须是已有节点。")
        if source == target:
            fail(EXIT_INVALID_CONTENT, f"edges/{index} 不能指向自己。")
        pairs.append((source, target))
    width, box_w, box_h, gap, top = 640, 200, 52, 36, 56
    positions = {node_id: top + index * (box_h + gap) for index, node_id in enumerate(order)}
    height = top + len(order) * (box_h + gap) + 24
    parts: list[dict] = []
    center = width // 2
    for source, target in pairs:
        forward = order.index(target) > order.index(source)
        y1 = positions[source] + (box_h if forward else 0)
        y2 = positions[target] + (0 if forward else box_h)
        parts.append({"op": "arrow", "x1": center, "y1": y1, "x2": center, "y2": y2})
    for node_id in order:
        parts.append(
            {
                "op": "box",
                "x": (width - box_w) // 2,
                "y": positions[node_id],
                "w": box_w,
                "h": box_h,
                "text": labels[node_id],
            }
        )
    return width, height, parts


def org_layout(node: object, where: str, depth: int, count: list[int]) -> dict:
    if depth > 4:
        fail(EXIT_INVALID_CONTENT, "组织关系超过 4 层。拆开再画。")
    count[0] += 1
    if count[0] > MAX_NODES:
        fail(EXIT_INVALID_CONTENT, f"组织节点超过 {MAX_NODES} 个。拆成两张图。")
    if not isinstance(node, dict):
        fail(EXIT_INVALID_CONTENT, f"{where} 必须是对象。")
    children = node.get("children") or []
    if not isinstance(children, list):
        fail(EXIT_INVALID_CONTENT, f"{where}/children 必须是数组。")
    return {
        "text": text_of(node.get("text"), f"{where}/text"),
        "children": [
            org_layout(child, f"{where}/children/{index}", depth + 1, count)
            for index, child in enumerate(children)
        ],
    }


def org(content: dict) -> tuple[int, int, list[dict]]:
    root = org_layout(content.get("root"), "root", 1, [0])
    box_w, box_h, gap_x, gap_y = 140, 48, 24, 64

    def measure(node: dict) -> int:
        if not node["children"]:
            node["width"] = box_w
            return box_w
        width = sum(measure(child) for child in node["children"]) + gap_x * (len(node["children"]) - 1)
        node["width"] = max(width, box_w)
        return node["width"]

    measure(root)
    parts: list[dict] = []
    bottom = 56

    def place(node: dict, left: int, top: int) -> None:
        nonlocal bottom
        x = left + (node["width"] - box_w) / 2
        parts.append({"op": "box", "x": int(x), "y": top, "w": box_w, "h": box_h, "text": node["text"]})
        bottom = max(bottom, top + box_h)
        cursor = left
        for child in node["children"]:
            child_x = int(cursor + child["width"] / 2)
            parts.append(
                {
                    "op": "arrow",
                    "x1": int(x + box_w / 2),
                    "y1": top + box_h,
                    "x2": child_x,
                    "y2": top + box_h + gap_y,
                }
            )
            place(child, cursor, top + box_h + gap_y)
            cursor += child["width"] + gap_x

    place(root, 24, 56)
    return int(root["width"]) + 48, bottom + 32, parts


def gantt(content: dict) -> tuple[int, int, list[dict]]:
    rows = content.get("rows")
    if not isinstance(rows, list) or not rows:
        fail(EXIT_INVALID_CONTENT, "gantt 至少要有一行。")
    if len(rows) > MAX_ROWS:
        fail(EXIT_INVALID_CONTENT, f"排期超过 {MAX_ROWS} 行。拆成两张图。")
    parsed = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            fail(EXIT_INVALID_CONTENT, f"rows/{index} 必须是对象。")
        start = parse_day(row.get("start"), f"rows/{index}/start")
        end = parse_day(row.get("end"), f"rows/{index}/end")
        if end < start:
            fail(EXIT_INVALID_CONTENT, f"rows/{index} 的结束日早于开始日。")
        parsed.append((text_of(row.get("name"), f"rows/{index}/name"), start, end))
    origin = min(item[1] for item in parsed)
    horizon = max(item[2] for item in parsed)
    span = (horizon - origin).days + 1
    if span > MAX_SPAN_DAYS:
        fail(EXIT_INVALID_CONTENT, f"排期跨度超过 {MAX_SPAN_DAYS} 天。缩短范围或拆开。")
    label_w, row_h, day_w = 160, 36, max(2, min(12, 720 // span))
    width = label_w + span * day_w + 48
    height = 64 + len(parsed) * row_h + 24
    parts: list[dict] = []
    for index, (name, start, end) in enumerate(parsed):
        y = 56 + index * row_h
        x = label_w + (start - origin).days * day_w
        bar_w = max(day_w, ((end - start).days + 1) * day_w)
        parts.append({"op": "label", "x": 24, "y": y + 22, "text": name})
        parts.append({"op": "bar", "x": x, "y": y + 6, "w": bar_w, "h": 20})
    return width, height, parts


def layout(content: dict) -> tuple[str, int, int, list[dict]]:
    title = text_of(content.get("title"), "title")
    kind = content.get("diagram")
    if kind == "flowchart":
        width, height, parts = flowchart(content)
    elif kind == "org":
        width, height, parts = org(content)
    elif kind == "gantt":
        width, height, parts = gantt(content)
    else:
        fail(EXIT_INVALID_CONTENT, "diagram 只能是 flowchart、org 或 gantt。")
    return title, width, height, parts


def to_svg(title: str, width: int, height: int, parts: list[dict]) -> str:
    body = [
        f'<text x="24" y="32" font-family="{FONT}" font-size="16" font-weight="600" fill="{INK}">{html.escape(title)}</text>'
    ]
    for part in parts:
        if part["op"] == "box":
            body.append(
                f'<rect x="{part["x"]}" y="{part["y"]}" width="{part["w"]}" height="{part["h"]}" rx="6" '
                f'fill="#FFFFFF" stroke="{LINE}"/>'
                f'<text x="{part["x"] + part["w"] / 2}" y="{part["y"] + part["h"] / 2 + 5}" text-anchor="middle" '
                f'font-family="{FONT}" font-size="14" fill="{INK}">{html.escape(part["text"])}</text>'
            )
        elif part["op"] == "arrow":
            body.append(
                f'<line x1="{part["x1"]}" y1="{part["y1"]}" x2="{part["x2"]}" y2="{part["y2"]}" '
                f'stroke="{ACCENT}" stroke-width="1.5" marker-end="url(#arrow)"/>'
            )
        elif part["op"] == "label":
            body.append(
                f'<text x="{part["x"]}" y="{part["y"]}" font-family="{FONT}" font-size="13" fill="{INK}">'
                f'{html.escape(part["text"])}</text>'
            )
        elif part["op"] == "bar":
            body.append(
                f'<rect x="{part["x"]}" y="{part["y"]}" width="{part["w"]}" height="{part["h"]}" rx="4" fill="{ACCENT}"/>'
            )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
        '<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">'
        f'<path d="M0,0 L6,3 L0,6 Z" fill="{ACCENT}"/></marker></defs>'
        '<rect width="100%" height="100%" fill="#F6F5F2"/>'
        + "".join(body)
        + "</svg>\n"
    )


def find_cjk_font() -> Path | None:
    # 设了就只用这一处：路径不存在时不再回退到系统字体，否则「指定了坏路径」
    # 会静默画出方框。测试用一个不存在的路径钉住这条失败。
    override = os.environ.get("EVOWORK_CJK_FONT")
    if override is not None:
        path = Path(override)
        return path if path.is_file() else None
    candidates: list[Path] = []
    fonts = office_fonts_dir()
    if fonts is not None:
        candidates += sorted(fonts.glob("*.ttf")) + sorted(fonts.glob("*.otf")) + sorted(fonts.glob("*.ttc"))
    candidates += [
        Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
        Path("/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf"),
        Path("/System/Library/Fonts/PingFang.ttc"),
        Path("C:/Windows/Fonts/msyh.ttc"),
    ]
    return next((path for path in candidates if path.is_file()), None)


def to_png(title: str, width: int, height: int, parts: list[dict], out_path: Path) -> None:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ModuleNotFoundError:
        fail(EXIT_RUNTIME_MISSING, "需要安装本地办公扩展（约 120MB）才能把图示导出成 png。安装后重试即可。")
    font_path = find_cjk_font() if has_cjk([{"text": title}, *parts]) else None
    if has_cjk([{"text": title}, *parts]) and font_path is None:
        fail(
            EXIT_RUNTIME_MISSING,
            "本机没有可用的中文字体，png 里的中文会变成方框。请安装办公扩展，或改输出 svg。",
        )
    try:
        font = ImageFont.truetype(str(font_path), 14) if font_path else ImageFont.load_default()
    except OSError:
        fail(EXIT_RUNTIME_MISSING, "中文字体文件打不开。请改输出 svg，或重装办公扩展。")
    image = Image.new("RGB", (width, height), "#F6F5F2")
    draw = ImageDraw.Draw(image)
    draw.text((24, 12), title, fill=INK, font=font)
    for part in parts:
        if part["op"] == "box":
            draw.rounded_rectangle(
                (part["x"], part["y"], part["x"] + part["w"], part["y"] + part["h"]),
                radius=6,
                outline=LINE,
                fill="#FFFFFF",
            )
            draw.text((part["x"] + 12, part["y"] + part["h"] / 2 - 8), part["text"], fill=INK, font=font)
        elif part["op"] == "arrow":
            draw.line((part["x1"], part["y1"], part["x2"], part["y2"]), fill=ACCENT, width=2)
        elif part["op"] == "label":
            draw.text((part["x"], part["y"] - 14), part["text"], fill=INK, font=font)
        elif part["op"] == "bar":
            draw.rounded_rectangle(
                (part["x"], part["y"], part["x"] + part["w"], part["y"] + part["h"]),
                radius=4,
                fill=ACCENT,
            )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(out_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="流程图、组织关系或排期 → svg / png")
    parser.add_argument("--content", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    content = read_content(Path(args.content).resolve())
    title, width, height, parts = layout(content)
    out_path = Path(args.out).resolve()
    suffix = out_path.suffix.lower()
    if suffix == ".svg":
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(to_svg(title, width, height, parts), encoding="utf-8")
        succeeded(out_path, diagram=content["diagram"], format="svg")
        return
    if suffix == ".png":
        to_png(title, width, height, parts, out_path)
        succeeded(out_path, diagram=content["diagram"], format="png")
        return
    fail(EXIT_INVALID_CONTENT, f"输出格式只支持 .svg 与 .png，收到 {suffix or '(无扩展名)'}。")


if __name__ == "__main__":
    main()
