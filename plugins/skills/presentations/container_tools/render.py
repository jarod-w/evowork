#!/usr/bin/env python3
"""内容 JSON → pptx 渲染器（08 §5.3 的结构化生成）。

模型的输出是内容与结构，**排版由这里决定**。这么切的理由写在 SKILL.md 里，
这里只补一条实现层面的：所有字号、留白、配色都来自 `templates/<id>/template.json`，
渲染代码里不出现字面量数值 —— 否则"换模板"就会变成"改渲染代码"。

退出码、校验失败的措辞、以及"报错里不许出现用户内容"这条纪律都在
`plugins/skills/_shared/evowork_skill.py` 里 —— 四个技能必须一致，见那个文件的头注释。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT.parent / "_shared"))

from evowork_skill import (  # noqa: E402 -- 必须在 sys.path 调整之后
    ensure_office_runtime,
    EXIT_INVALID_CONTENT,
    EXIT_MISSING_ASSET,
    EXIT_OK,
    EXIT_RUNTIME_MISSING,
    fail,
    load_template,
    read_content,
    read_template_stamp,
    resolve_asset as _resolve_asset,
    runtime_missing_message,
    succeeded,
    template_stamp,
    validate_content,
    write_extracted,
)

LAYOUTS = ("title", "bullets", "chart", "table", "section")


def validate(content: dict) -> None:
    """先校验再渲染。具体的报错措辞与"不含用户内容"的纪律在共用骨架里。"""
    validate_content(
        content,
        SKILL_ROOT / "schema" / "content.schema.json",
        discriminator="layout",
        known_kinds=LAYOUTS,
    )


def resolve_asset(ref: str, base: Path) -> Path:
    return _resolve_asset(ref, base, hint="先用 charts 技能生成它，再引用。")


def render(content: dict, out_path: Path, base_dir: Path) -> None:
    try:
        from pptx import Presentation
        from pptx.dml.color import RGBColor
        from pptx.util import Emu, Pt
    except ModuleNotFoundError:
        # 08 §4：办公扩展按需下载。文案要与解析管道**统一**——
        # 不能一处说"解析组件"一处说"生成组件"，那会让用户以为要装两个东西
        # 文案由共用骨架统一给（08 §4：不能一处说"解析组件"一处说"生成组件"）
        fail(EXIT_RUNTIME_MISSING, runtime_missing_message("office", "生成 pptx"))

    template = load_template(SKILL_ROOT, content.get("template", "business"))
    theme = template["theme"]
    metrics = template["metrics"]

    def color(name: str) -> "RGBColor":
        return RGBColor.from_string(theme[name].lstrip("#"))

    prs = Presentation()
    prs.slide_width = Emu(int(metrics["slide_width_emu"]))
    prs.slide_height = Emu(int(metrics["slide_height_emu"]))
    blank = prs.slide_layouts[6]  # 空白版式：所有元素由我们放，避免继承默认主题的字体

    def add_textbox(slide, spec_key: str, text: str, *, style: str, role: str) -> None:
        box = metrics[spec_key]
        shape = slide.shapes.add_textbox(
            Emu(int(box["left"])), Emu(int(box["top"])), Emu(int(box["width"])), Emu(int(box["height"]))
        )
        shape.name = role
        frame = shape.text_frame
        frame.word_wrap = True
        frame.text = text
        style_spec = theme["styles"][style]
        for paragraph in frame.paragraphs:
            paragraph.font.size = Pt(style_spec["size_pt"])
            paragraph.font.bold = style_spec.get("bold", False)
            paragraph.font.color.rgb = color(style_spec["color"])
            # 中文字体必须显式设置，否则在没有装对应字体的机器上会变方框
            paragraph.font.name = theme["font_cjk"]

    for spec in content["slides"]:
        layout = spec["layout"]
        slide = prs.slides.add_slide(blank)

        if layout == "title":
            add_textbox(slide, "title_slide_title", spec["title"], style="display", role="evowork:title")
            if spec.get("subtitle"):
                add_textbox(slide, "title_slide_subtitle", spec["subtitle"], style="subtitle", role="evowork:subtitle")

        elif layout == "section":
            add_textbox(slide, "section_title", spec["title"], style="section", role="evowork:section")

        elif layout == "bullets":
            add_textbox(slide, "body_title", spec["title"], style="title", role="evowork:heading")
            box = metrics["body_content"]
            shape = slide.shapes.add_textbox(
                Emu(int(box["left"])), Emu(int(box["top"])), Emu(int(box["width"])), Emu(int(box["height"]))
            )
            shape.name = "evowork:bullets"
            frame = shape.text_frame
            frame.word_wrap = True
            style_spec = theme["styles"]["body"]
            # 条目多时按模板给的梯度缩字号，而不是让文字溢出框
            size = style_spec["size_pt"]
            for step in metrics["bullet_shrink_steps"]:
                if len(spec["bullets"]) >= step["min_items"]:
                    size = step["size_pt"]
            for index, bullet in enumerate(spec["bullets"]):
                paragraph = frame.paragraphs[0] if index == 0 else frame.add_paragraph()
                paragraph.text = f"· {bullet}"
                paragraph.font.size = Pt(size)
                paragraph.font.color.rgb = color(style_spec["color"])
                paragraph.font.name = theme["font_cjk"]

        elif layout == "chart":
            add_textbox(slide, "body_title", spec["title"], style="title", role="evowork:heading")
            image = resolve_asset(spec["chart_ref"], base_dir)
            box = metrics["chart_area"]
            picture = slide.shapes.add_picture(
                str(image), Emu(int(box["left"])), Emu(int(box["top"])), height=Emu(int(box["height"]))
            )
            picture.name = "evowork:chart"
            if spec.get("caption"):
                add_textbox(slide, "caption", spec["caption"], style="caption", role="evowork:caption")

        elif layout == "table":
            add_textbox(slide, "body_title", spec["title"], style="title", role="evowork:heading")
            table_spec = spec["table"]
            rows = len(table_spec["rows"]) + 1
            cols = len(table_spec["header"])
            box = metrics["table_area"]
            shape = slide.shapes.add_table(
                rows, cols, Emu(int(box["left"])), Emu(int(box["top"])), Emu(int(box["width"])), Emu(int(box["height"]))
            )
            shape.name = "evowork:table"
            table = shape.table
            for col, name in enumerate(table_spec["header"]):
                cell = table.cell(0, col)
                cell.text = name
                for paragraph in cell.text_frame.paragraphs:
                    paragraph.font.size = Pt(theme["styles"]["table_header"]["size_pt"])
                    paragraph.font.bold = True
                    paragraph.font.name = theme["font_cjk"]
            for row_index, row in enumerate(table_spec["rows"], start=1):
                for col in range(cols):
                    cell = table.cell(row_index, col)
                    cell.text = row[col] if col < len(row) else ""
                    for paragraph in cell.text_frame.paragraphs:
                        paragraph.font.size = Pt(theme["styles"]["table_body"]["size_pt"])
                        paragraph.font.name = theme["font_cjk"]
            if spec.get("caption"):
                add_textbox(slide, "caption", spec["caption"], style="caption", role="evowork:caption")

        if spec.get("notes"):
            slide.notes_slide.notes_text_frame.text = spec["notes"]

    prs.core_properties.category = template_stamp(content.get("template", "business"))
    if content.get("title"):
        prs.core_properties.title = content["title"]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(out_path))


def _shape_text(shape) -> str:  # noqa: ANN001
    if shape is None or not getattr(shape, "has_text_frame", False):
        return ""
    return "\n".join(paragraph.text.strip() for paragraph in shape.text_frame.paragraphs).strip()


def _notes(slide) -> str | None:  # noqa: ANN001
    if not slide.has_notes_slide:
        return None
    text = slide.notes_slide.notes_text_frame.text.strip()
    return text or None


def _save_picture(shape, asset_dir: Path, index: int) -> str:  # noqa: ANN001
    image = shape.image
    suffix = f".{image.ext}" if image.ext else ".bin"
    asset_dir.mkdir(parents=True, exist_ok=True)
    name = f"slide-{index}{suffix}"
    (asset_dir / name).write_bytes(image.blob)
    return f"{asset_dir.name}/{name}"


def _table_block(shape, page: int) -> dict:  # noqa: ANN001
    table = shape.table
    header = [cell.text.strip() for cell in table.rows[0].cells]
    if not header or any(not cell for cell in header):
        fail(EXIT_INVALID_CONTENT, f"第 {page} 页的表头有空列。")
    rows = []
    for row in list(table.rows)[1:]:
        values = [cell.text.strip() for cell in row.cells]
        if len(values) != len(header):
            fail(EXIT_INVALID_CONTENT, f"第 {page} 页有一行和表头列数不同。")
        rows.append(values)
    if not rows:
        fail(EXIT_INVALID_CONTENT, f"第 {page} 页的表没有数据行。")
    return {"header": header, "rows": rows}


def _bullets_from_text(text: str, page: int) -> list[str]:
    items = []
    for line in text.splitlines():
        piece = line.strip()
        if piece.startswith("·"):
            piece = piece[1:].strip()
        elif piece.startswith(("- ", "* ")):
            piece = piece[2:].strip()
        if piece:
            items.append(piece)
    if len(items) > 6:
        fail(EXIT_INVALID_CONTENT, f"第 {page} 页要点超过 6 条，五种版式装不下。先拆页再提取。")
    if not items:
        fail(EXIT_INVALID_CONTENT, f"第 {page} 页没有要点。")
    return items


def extract_pptx(path: Path, asset_dir: Path) -> dict:
    if not path.is_file():
        fail(EXIT_INVALID_CONTENT, f"找不到要提取的文件：{path.name}。")
    try:
        from pptx import Presentation
        from pptx.enum.shapes import MSO_SHAPE_TYPE
    except ModuleNotFoundError:
        fail(EXIT_RUNTIME_MISSING, runtime_missing_message("office", "读取 pptx"))

    prs = Presentation(str(path))
    content: dict = {}
    template = read_template_stamp(prs.core_properties.category)
    if template:
        content["template"] = template
    title = (prs.core_properties.title or "").strip()
    if title:
        content["title"] = title

    slides = []
    for page, slide in enumerate(prs.slides, start=1):
        named = {shape.name: shape for shape in slide.shapes}
        notes = _notes(slide)
        if "evowork:section" in named:
            spec = {"layout": "section", "title": _shape_text(named["evowork:section"])}
        elif "evowork:bullets" in named:
            spec = {
                "layout": "bullets",
                "title": _shape_text(named.get("evowork:heading")),
                "bullets": _bullets_from_text(_shape_text(named["evowork:bullets"]), page),
            }
        elif "evowork:table" in named:
            spec = {
                "layout": "table",
                "title": _shape_text(named.get("evowork:heading")),
                "table": _table_block(named["evowork:table"], page),
            }
            caption = _shape_text(named["evowork:caption"]) if "evowork:caption" in named else ""
            if caption:
                spec["caption"] = caption
        elif "evowork:chart" in named:
            spec = {
                "layout": "chart",
                "title": _shape_text(named.get("evowork:heading")),
                "chart_ref": _save_picture(named["evowork:chart"], asset_dir, page),
            }
            caption = _shape_text(named["evowork:caption"]) if "evowork:caption" in named else ""
            if caption:
                spec["caption"] = caption
        elif "evowork:title" in named:
            spec = {"layout": "title", "title": _shape_text(named["evowork:title"])}
            subtitle = _shape_text(named["evowork:subtitle"]) if "evowork:subtitle" in named else ""
            if subtitle:
                spec["subtitle"] = subtitle
        else:
            texts = [_shape_text(shape) for shape in slide.shapes if _shape_text(shape)]
            pictures = [shape for shape in slide.shapes if shape.shape_type == MSO_SHAPE_TYPE.PICTURE]
            tables = [shape for shape in slide.shapes if shape.shape_type == MSO_SHAPE_TYPE.TABLE]
            if tables:
                spec = {
                    "layout": "table",
                    "title": texts[0] if texts else "表格",
                    "table": _table_block(tables[0], page),
                }
            elif pictures:
                spec = {
                    "layout": "chart",
                    "title": texts[0] if texts else "图表",
                    "chart_ref": _save_picture(pictures[0], asset_dir, page),
                }
            elif len(texts) >= 2 and page == 1 and "\n" not in texts[0]:
                spec = {"layout": "title", "title": texts[0], "subtitle": texts[1]}
            elif len(texts) == 1 and ("\n" in texts[0] or texts[0].startswith(("·", "- ", "* "))):
                lines = _bullets_from_text(texts[0], page)
                spec = {"layout": "bullets", "title": "要点", "bullets": lines}
            elif len(texts) >= 2:
                spec = {"layout": "bullets", "title": texts[0], "bullets": _bullets_from_text(texts[1], page)}
            elif len(texts) == 1:
                spec = {"layout": "section", "title": texts[0]}
            else:
                fail(EXIT_INVALID_CONTENT, f"第 {page} 页没有可提取的文字或表格。")
        if not spec.get("title"):
            fail(EXIT_INVALID_CONTENT, f"第 {page} 页没有标题。")
        if notes:
            spec["notes"] = notes
        slides.append(spec)
    if not slides:
        fail(EXIT_INVALID_CONTENT, "这份幻灯片没有页。")
    content["slides"] = slides
    return content


def main() -> None:
    parser = argparse.ArgumentParser(description="把内容 JSON 渲染成 pptx，或从已有 pptx 提取内容 JSON")
    parser.add_argument("--content", help="要渲染的内容 JSON")
    parser.add_argument("--extract", help="已有的 .pptx，提取成内容 JSON")
    parser.add_argument("--out", required=True, help="渲染：.pptx。提取：.json")
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="只校验不渲染（不需要办公扩展，用于让模型先把内容改对）",
    )
    args = parser.parse_args()

    if bool(args.extract) == bool(args.content):
        fail(EXIT_INVALID_CONTENT, "提取用 --extract，生成用 --content，不要同时给，也不要都不给。")
    if args.extract and args.validate_only:
        fail(EXIT_INVALID_CONTENT, "提取会直接写出 JSON，没有 --validate-only。")

    # 缺办公扩展的模块时换到扩展的解释器重跑（见 evowork_skill.ensure_office_runtime）。
    ensure_office_runtime(("pptx",))

    if args.extract:
        source = Path(args.extract).resolve()
        if source.suffix.lower() != ".pptx":
            fail(EXIT_INVALID_CONTENT, f"提取只支持 .pptx，收到 {source.suffix or '(无扩展名)'}。")
        out_path = Path(args.out).resolve()
        content = extract_pptx(source, out_path.parent / "extracted-media")
        validate(content)
        for slide in content["slides"]:
            if slide.get("layout") == "chart":
                resolve_asset(slide["chart_ref"], out_path.parent)
        write_extracted(content, out_path)
        succeeded(out_path, slides=len(content["slides"]), format="json", operation="extract")
        return

    content_path = Path(args.content).resolve()
    content = read_content(content_path)
    validate(content)

    if args.validate_only:
        succeeded(slides=len(content["slides"]), validated=True)
        return

    out_path = Path(args.out).resolve()
    render(content, out_path, content_path.parent)
    succeeded(out_path, slides=len(content["slides"]))


if __name__ == "__main__":
    main()
