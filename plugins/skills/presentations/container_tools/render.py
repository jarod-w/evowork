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
import os
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
    lossy_extraction,
    refuse_overwrite,
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
    # python-pptx 的空白模板把「最后修改者」写成库作者的名字、备注写成生成库：交付的文件里不留这些
    prs.core_properties.last_modified_by = ""
    prs.core_properties.comments = ""

    out_path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(out_path))


def _paragraphs(shape) -> list[tuple[str, int]]:  # noqa: ANN001
    """(正文, 层级)，空段落不算。

    段内的软换行（Shift+Enter，a:br）在 python-pptx 里是 `\\v`：换成 `\\n` 留在**同一条**里。
    2026-10-22 之前按 splitlines 切，`\\v` 也被当成换行，一条要点被拆成了两条。
    """
    if shape is None or not getattr(shape, "has_text_frame", False) or not shape.has_text_frame:
        return []
    found = []
    for paragraph in shape.text_frame.paragraphs:
        text = "\n".join(line.strip() for line in paragraph.text.replace("\v", "\n").split("\n")).strip()
        if text:
            found.append((text, paragraph.level))
    return found


def _shape_text(shape) -> str:  # noqa: ANN001
    return "\n".join(text for text, _ in _paragraphs(shape))


def _notes(slide) -> str | None:  # noqa: ANN001
    if not slide.has_notes_slide:
        return None
    text = slide.notes_slide.notes_text_frame.text.strip()
    return text or None


def _write_media(asset_dir: Path, stem: str, suffix: str, blob: bytes) -> str:
    """与 documents 技能同一条规则：**不覆盖、不跟符号链接**（2026-10-22）。

    之前同名就覆盖（第二份幻灯片的 slide-3 冲掉第一份的），`extracted-media` 是指向别处的链接也照写。
    """
    if asset_dir.is_symlink():
        fail(
            EXIT_INVALID_CONTENT,
            f"{asset_dir.name} 是一个符号链接，提取不往里面写图片。换一个 --out 目录再提取。",
        )
    if asset_dir.exists() and not asset_dir.is_dir():
        fail(EXIT_INVALID_CONTENT, f"{asset_dir.name} 已存在但不是文件夹。换一个 --out 目录再提取。")
    asset_dir.mkdir(parents=True, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    for attempt in range(1, 1000):
        name = f"{stem}{suffix}" if attempt == 1 else f"{stem}-{attempt}{suffix}"
        try:
            handle = os.open(asset_dir / name, flags, 0o644)
        except FileExistsError:
            continue
        with os.fdopen(handle, "wb") as out:
            out.write(blob)
        return f"{asset_dir.name}/{name}"
    fail(EXIT_INVALID_CONTENT, f"{asset_dir.name} 里同名的图片太多。换一个 --out 目录再提取。")


def _save_picture(shape, asset_dir: Path, index: int) -> str:  # noqa: ANN001
    image = shape.image
    suffix = f".{image.ext}" if image.ext else ".bin"
    return _write_media(asset_dir, f"slide-{index}", suffix, image.blob)


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


def _bullets(shape, page: int, dropped: dict[str, int]) -> list[str]:  # noqa: ANN001
    items = []
    for text, level in _paragraphs(shape):
        if level > 0:
            # 内容 JSON 的要点只有一层：下级要点并进来，层级记进清单
            dropped["嵌套列表层级"] = dropped.get("嵌套列表层级", 0) + 1
        for marker in ("·", "•", "- ", "* "):
            if text.startswith(marker):
                text = text[len(marker) :].strip()
                break
        if text:
            items.append(text)
    if len(items) > 6:
        fail(EXIT_INVALID_CONTENT, f"第 {page} 页要点超过 6 条，五种版式装不下。先拆页再提取。")
    if not items:
        fail(EXIT_INVALID_CONTENT, f"第 {page} 页没有要点。")
    return items


#: 我们自己渲染的页上每个形状都有名字（见 render）；有这几个之一的页按名字原样收回
LAYOUT_SHAPES = ("evowork:section", "evowork:bullets", "evowork:table", "evowork:chart", "evowork:title")
ROLE_SHAPES = (*LAYOUT_SHAPES, "evowork:heading", "evowork:subtitle", "evowork:caption")

#: 每页收不回来的东西按种类报。页码、日期占位符由幻灯片自己生成，不算内容
_SHAPE_LOSS = {
    "text": "文本框",
    "picture": "图片",
    "linked-picture": "图片",
    "table": "表格",
    "chart": "原生图表",
    "smartart": "SmartArt 图形",
    "ole": "嵌入对象",
    "media": "音视频",
    "footer": "页脚",
}


def _flatten(shapes) -> list:  # noqa: ANN001
    """组合图形拆开看：里面的文字、图片、表都算这一页的内容（2026-10-22 之前整组被跳过）。"""
    from pptx.shapes.group import GroupShape

    found = []
    for shape in shapes:
        # 不用 shape.shape_type：认不出几何的形状上它会抛 NotImplementedError
        if isinstance(shape, GroupShape):
            found.extend(_flatten(shape.shapes))
        else:
            found.append(shape)
    return found


def _shape_kind(shape) -> str | None:  # noqa: ANN001
    from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER
    from pptx.shapes.picture import Picture

    if getattr(shape, "has_chart", False):
        return "chart"
    if getattr(shape, "has_table", False):
        return "table"
    if isinstance(shape, Picture):
        try:
            shape.image  # noqa: B018 -- 链接到文件外的图片取不出字节
        except Exception:  # noqa: BLE001
            return "linked-picture"
        return "picture"
    uri = shape._element.xpath("./a:graphic/a:graphicData/@uri")
    if uri and str(uri[0]).endswith("/diagram"):
        return "smartart"
    try:
        shape_type = shape.shape_type
    except NotImplementedError:
        shape_type = None
    if shape_type in (MSO_SHAPE_TYPE.EMBEDDED_OLE_OBJECT, MSO_SHAPE_TYPE.LINKED_OLE_OBJECT):
        return "ole"
    if shape_type == MSO_SHAPE_TYPE.MEDIA:
        return "media"
    if not _paragraphs(shape):
        return None  # 空占位符、纯装饰的形状、线条
    if shape.is_placeholder:
        kind = shape.placeholder_format.type
        if kind in (PP_PLACEHOLDER.DATE, PP_PLACEHOLDER.SLIDE_NUMBER):
            return None
        if kind == PP_PLACEHOLDER.FOOTER:
            return "footer"
    return "text"


def _spec_from_roles(named: dict, page: int, asset_dir: Path, dropped: dict) -> tuple[dict, list]:
    """我们自己生成的页：按 evowork:* 形状名原样收回。"""
    used = [named.get("evowork:heading")]
    if "evowork:section" in named:
        used = [named["evowork:section"]]
        return {"layout": "section", "title": _shape_text(named["evowork:section"])}, used
    if "evowork:bullets" in named:
        used.append(named["evowork:bullets"])
        spec = {
            "layout": "bullets",
            "title": _shape_text(named.get("evowork:heading")),
            "bullets": _bullets(named["evowork:bullets"], page, dropped),
        }
        return spec, used
    if "evowork:table" in named:
        used.append(named["evowork:table"])
        spec = {
            "layout": "table",
            "title": _shape_text(named.get("evowork:heading")),
            "table": _table_block(named["evowork:table"], page),
        }
    elif "evowork:chart" in named:
        used.append(named["evowork:chart"])
        spec = {
            "layout": "chart",
            "title": _shape_text(named.get("evowork:heading")),
            "chart_ref": _save_picture(named["evowork:chart"], asset_dir, page),
        }
    else:
        used = [named["evowork:title"], named.get("evowork:subtitle")]
        spec = {"layout": "title", "title": _shape_text(named["evowork:title"])}
        subtitle = _shape_text(named.get("evowork:subtitle"))
        if subtitle:
            spec["subtitle"] = subtitle
        return spec, used
    caption = _shape_text(named.get("evowork:caption"))
    if caption:
        spec["caption"] = caption
        used.append(named["evowork:caption"])
    return spec, used


def _spec_from_shapes(slide, shapes: list, page: int, asset_dir: Path, dropped: dict) -> tuple[dict, list]:  # noqa: ANN001
    """别人做的页：按「标题 / 要点 / 图表 / 表格 / 章节」归类。用不上的形状由调用方逐个报出来。"""
    kinds = [(shape, _shape_kind(shape)) for shape in shapes]
    texts = [shape for shape, kind in kinds if kind == "text"]
    pictures = [shape for shape, kind in kinds if kind == "picture"]
    tables = [shape for shape, kind in kinds if kind == "table"]
    # 标题占位符排第一：它在 z 序里不一定最靠前
    title_shape = slide.shapes.title
    if title_shape is not None:
        texts.sort(key=lambda shape: 0 if shape.shape_id == title_shape.shape_id else 1)

    def one_line(shape) -> bool:  # noqa: ANN001
        paragraphs = _paragraphs(shape)
        return len(paragraphs) == 1 and "\n" not in paragraphs[0][0]

    if tables or pictures:
        used = [texts[0]] if texts else []
        if tables:
            spec = {
                "layout": "table",
                "title": _shape_text(texts[0]) if texts else "表格",
                "table": _table_block(tables[0], page),
            }
            used.append(tables[0])
        else:
            spec = {
                "layout": "chart",
                "title": _shape_text(texts[0]) if texts else "图表",
                "chart_ref": _save_picture(pictures[0], asset_dir, page),
            }
            used.append(pictures[0])
        # 第二个文本框只有一行、放得进说明时当作说明（数据来源一类）；多行的是另一栏正文，报出来
        if len(texts) >= 2 and one_line(texts[1]) and len(_shape_text(texts[1])) <= 200:
            spec["caption"] = _shape_text(texts[1])
            used.append(texts[1])
        return spec, used
    if len(texts) >= 2 and page == 1 and one_line(texts[0]):
        return {"layout": "title", "title": _shape_text(texts[0]), "subtitle": _shape_text(texts[1])}, texts[:2]
    if len(texts) == 1:
        paragraphs = _paragraphs(texts[0])
        if len(paragraphs) > 1 or paragraphs[0][0].startswith(("·", "•", "- ", "* ")):
            return {"layout": "bullets", "title": "要点", "bullets": _bullets(texts[0], page, dropped)}, texts
        return {"layout": "section", "title": _shape_text(texts[0])}, texts
    if len(texts) >= 2:
        # 两栏版式的第二栏、多出来的文本框：五种版式放不下，由调用方报出来
        spec = {
            "layout": "bullets",
            "title": _shape_text(texts[0]),
            "bullets": _bullets(texts[1], page, dropped),
        }
        return spec, texts[:2]
    fail(EXIT_INVALID_CONTENT, f"第 {page} 页没有可提取的文字或表格。")


def extract_pptx(path: Path, asset_dir: Path) -> dict:
    """按五种版式收回每一页。一页上用不上的形状（第二栏、多余的图和表、原生图表……）逐类记进
    `_dropped`，由 main() 交给 lossy_extraction —— 2026-10-22 之前它们被静默跳过。"""
    if not path.is_file():
        fail(EXIT_INVALID_CONTENT, f"找不到要提取的文件：{path.name}。")
    try:
        from pptx import Presentation
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

    dropped: dict[str, int] = {}
    slides = []
    for page, slide in enumerate(prs.slides, start=1):
        shapes = _flatten(slide.shapes)
        named = {shape.name: shape for shape in shapes if shape.name in ROLE_SHAPES}
        if any(role in named for role in LAYOUT_SHAPES):
            spec, used = _spec_from_roles(named, page, asset_dir, dropped)
        else:
            spec, used = _spec_from_shapes(slide, shapes, page, asset_dir, dropped)
        taken = {shape.shape_id for shape in used if shape is not None}
        for shape in shapes:
            kind = None if shape.shape_id in taken else _shape_kind(shape)
            if kind:
                loss = _SHAPE_LOSS[kind]
                dropped[loss] = dropped.get(loss, 0) + 1
        if not spec.get("title"):
            fail(EXIT_INVALID_CONTENT, f"第 {page} 页没有标题。")
        notes = _notes(slide)
        if notes:
            spec["notes"] = notes
        slides.append(spec)
    if not slides:
        fail(EXIT_INVALID_CONTENT, "这份幻灯片没有页。")
    content["slides"] = slides
    content["_dropped"] = dropped
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
    parser.add_argument("--overwrite", action="store_true", help="目标已存在时允许写回（默认拒绝）")
    parser.add_argument("--allow-lossy", action="store_true", help="提取有收不回的内容时仍写出（默认拒绝）")
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
        lossy = lossy_extraction(content.pop("_dropped", {}), args.allow_lossy)
        validate(content)
        for slide in content["slides"]:
            if slide.get("layout") == "chart":
                resolve_asset(slide["chart_ref"], out_path.parent)
        write_extracted(content, out_path)
        succeeded(
            out_path, slides=len(content["slides"]), format="json", operation="extract", **lossy
        )
        return

    content_path = Path(args.content).resolve()
    content = read_content(content_path)
    validate(content)

    if args.validate_only:
        succeeded(slides=len(content["slides"]), validated=True)
        return

    out_path = Path(args.out).resolve()
    refuse_overwrite(out_path, args.overwrite)
    render(content, out_path, content_path.parent)
    # 出图后顺手查一遍溢出 / 缺字 / 越界（_shared/layout_check.py），结果随成功输出给模型
    from layout_check import for_output  # noqa: E402 -- 与 evowork_skill 同一个 sys.path

    succeeded(out_path, slides=len(content["slides"]), **for_output(out_path))


if __name__ == "__main__":
    main()
