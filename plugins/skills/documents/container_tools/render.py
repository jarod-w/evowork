#!/usr/bin/env python3
"""内容 JSON → docx / md。08 §5.2 的第一个技能。

模型给**内容与层级**，字号 / 行距 / 页眉页脚 / 目录 / 表格样式由模板决定。

## 两条与别的技能不同的点

1. **md 是一等输出，不是降级。** 很多场景（写进仓库的说明、发给同事的草稿）要的就是 md，
   而 md 走内置渲染，不需要办公扩展 —— 这让"没装扩展"不等于"什么都干不了"。
2. **docx 的目录是一个域（field），不是一段文字。** python-docx 写进去的目录在 Word 里
   第一次打开时是空的，要按 F9 更新域才会出现。这件事必须写在文档里告诉用户，
   否则他会以为目录生成失败了 —— 所以渲染器在目录下方留一行提示。

退出码与共用骨架一致（见 `plugins/skills/_shared/evowork_skill.py`）。
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT.parent / "_shared"))

from evowork_skill import (  # noqa: E402
    ensure_office_runtime,
    EXIT_INVALID_CONTENT,
    EXIT_RUNTIME_MISSING,
    fail,
    load_template,
    read_content,
    read_template_stamp,
    resolve_asset,
    runtime_missing_message,
    succeeded,
    template_stamp,
    validate_content,
    write_extracted,
)

BLOCKS = ("heading", "paragraph", "bullets", "ordered", "table", "image", "quote", "pagebreak")

TOC_HINT = "（目录是 Word 的域：第一次打开时按 F9 或右键「更新域」即可显示页码。）"



# 模板 `page.size` 可选的纸张（竖版宽 × 高，厘米）。缺省 A4
PAGE_SIZES_CM = {"A4": (21.0, 29.7), "A3": (29.7, 42.0), "Letter": (21.59, 27.94)}

def validate(content: dict, base_dir: Path) -> None:
    validate_content(
        content,
        SKILL_ROOT / "schema" / "content.schema.json",
        discriminator="block",
        known_kinds=BLOCKS,
    )

    # schema 表达不了的两条跨字段约束
    for index, block in enumerate(content["blocks"]):
        if block["block"] == "table":
            width = len(block["header"])
            for row_index, row in enumerate(block["rows"]):
                if len(row) != width:
                    fail(
                        EXIT_INVALID_CONTENT,
                        f"blocks/{index}/rows/{row_index}: 这一行有 {len(row)} 格，"
                        f"表头有 {width} 列，两者必须一样长。",
                    )
        if block["block"] == "image":
            resolve_asset(block["path"], base_dir, hint="先用 charts 技能生成它，再引用。")

    levels = [b["level"] for b in content["blocks"] if b["block"] == "heading"]
    for previous, current in zip(levels, levels[1:]):
        if current > previous + 1:
            # 层级跳跃（h1 直接到 h3）会让目录看起来缺一层，且 Word 的导航窗格会错位
            fail(
                EXIT_INVALID_CONTENT,
                f"标题层级从 {previous} 跳到了 {current}。层级只能逐级下降"
                f"（h{previous} 之后是 h{previous + 1}），否则目录会缺一层。",
            )


# ─────────────────────────── markdown（基础包，无需扩展）───────────────────────────


def render_md(content: dict, out_path: Path) -> None:
    lines: list[str] = [f"# {content['title']}", ""]
    if content.get("template"):
        # 提取时靠这一行找回模板。放在标题前面，阅读器会把它当注释丢掉。
        lines.insert(0, "")
        lines.insert(0, f"<!-- evowork-template:{content['template']} -->")
    if content.get("subtitle"):
        lines += [f"> {content['subtitle']}", ""]
    meta = " · ".join(x for x in (content.get("author"), content.get("date")) if x)
    if meta:
        lines += [meta, ""]
    if content.get("toc"):
        # md 的目录由阅读器生成，写一行标记比伪造一份会过期的目录好
        lines += ["<!-- toc -->", ""]

    for block in content["blocks"]:
        kind = block["block"]
        if kind == "heading":
            lines += ["#" * (block["level"] + 1) + " " + block["text"], ""]
        elif kind == "paragraph":
            lines += [block["text"], ""]
        elif kind == "bullets":
            lines += [f"- {item}" for item in block["items"]] + [""]
        elif kind == "ordered":
            lines += [f"{i + 1}. {item}" for i, item in enumerate(block["items"])] + [""]
        elif kind == "quote":
            lines += [f"> {block['text']}"]
            if block.get("cite"):
                lines += [f">", f"> —— {block['cite']}"]
            lines += [""]
        elif kind == "table":
            header = block["header"]
            lines += ["| " + " | ".join(header) + " |"]
            lines += ["| " + " | ".join("---" for _ in header) + " |"]
            for row in block["rows"]:
                lines += ["| " + " | ".join("" if c is None else str(c) for c in row) + " |"]
            if block.get("caption"):
                lines += ["", f"*{block['caption']}*"]
            lines += [""]
        elif kind == "image":
            lines += [f"![{block.get('caption', '')}]({block['path']})", ""]
        elif kind == "pagebreak":
            # md 没有分页概念。用水平线表达"这里原本是分页"，而不是静默丢掉
            lines += ["---", ""]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


# ─────────────────────────── docx（需要办公扩展）───────────────────────────


def render_docx(content: dict, out_path: Path, base_dir: Path) -> None:
    try:
        import docx
        from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        from docx.shared import Cm, Pt, RGBColor
    except ModuleNotFoundError:
        fail(EXIT_RUNTIME_MISSING, runtime_missing_message("office", "生成 docx"))

    template = load_template(SKILL_ROOT, content.get("template", "report"))
    styles = template["styles"]
    fonts = template["font"]

    document = docx.Document()
    section = document.sections[0]
    # 纸张必须显式设：python-docx 的空白模板是**美式 Letter**（8.5×11 英寸）。
    # 2026-09-28 外部验收 A1 要求 A4，按这个技能渲染出来的文档是 Letter —— 国内办公默认就该是 A4。
    width_cm, height_cm = PAGE_SIZES_CM[template["page"].get("size", "A4")]
    if template["page"].get("orientation") == "landscape":
        from docx.enum.section import WD_ORIENT

        section.orientation = WD_ORIENT.LANDSCAPE
        width_cm, height_cm = height_cm, width_cm
    section.page_width, section.page_height = Cm(width_cm), Cm(height_cm)
    for attr in ("top_margin", "bottom_margin", "left_margin", "right_margin"):
        setattr(section, attr, Cm(template["page"]["margin_cm"]))

    def style_run(run, spec: dict) -> None:
        run.font.size = Pt(spec["size_pt"])
        run.font.bold = spec.get("bold", False)
        run.font.italic = spec.get("italic", False)
        if spec.get("color"):
            run.font.color.rgb = RGBColor.from_string(spec["color"])
        run.font.name = fonts["latin"]
        # 中文字体必须写进 rPr 的 eastAsia，否则中文会回落到默认字体（可能是方框）
        run._element.rPr.rFonts.set(qn("w:eastAsia"), fonts["cjk"])

    def add_paragraph(text: str, spec: dict):
        paragraph = document.add_paragraph()
        if spec.get("align") == "center":
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
        fmt = paragraph.paragraph_format
        fmt.space_before = Pt(spec.get("space_before_pt", 0))
        fmt.space_after = Pt(spec.get("space_after_pt", 0))
        if spec.get("line_spacing"):
            fmt.line_spacing = spec["line_spacing"]
        if spec.get("indent_cm"):
            fmt.left_indent = Cm(spec["indent_cm"])
        style_run(paragraph.add_run(text), spec)
        return paragraph

    def set_outline_level(paragraph, level: int) -> None:
        """给标题段落写大纲级别（`heading.level` 从 1 起，`w:outlineLvl` 从 0 起）。

        没有它，目录域即使按 F9 也是空的：域里的 `\\u` 开关按**大纲级别**收条目，
        而模板用的是直接格式化，直接格式化的标题并不自带大纲级别。
        Word 的导航窗格同样读这个属性。

        只写结构、不改外观 —— 字号与间距仍由模板直接格式化，两者互不覆盖。
        """
        pPr = paragraph._p.get_or_add_pPr()
        outline = OxmlElement("w:outlineLvl")
        outline.set(qn("w:val"), str(level - 1))
        # pPr 的子元素顺序由 schema 定死，outlineLvl 必须排在 rPr 之前
        pPr.insert_element_before(
            outline, "w:divId", "w:cnfStyle", "w:rPr", "w:sectPr", "w:pPrChange"
        )

    def add_toc_field() -> None:
        """插入 TOC 域。python-docx 没有现成 API，只能拼 XML。"""
        paragraph = document.add_paragraph()
        run = paragraph.add_run()
        begin = OxmlElement("w:fldChar")
        begin.set(qn("w:fldCharType"), "begin")
        instr = OxmlElement("w:instrText")
        instr.set(qn("xml:space"), "preserve")
        instr.text = 'TOC \\o "1-3" \\h \\z \\u'
        end = OxmlElement("w:fldChar")
        end.set(qn("w:fldCharType"), "end")
        run._r.append(begin)
        run._r.append(instr)
        run._r.append(end)

    # 封面
    add_paragraph(content["title"], styles["title"])
    if content.get("subtitle"):
        add_paragraph(content["subtitle"], styles["subtitle"])
    meta = " · ".join(x for x in (content.get("author"), content.get("date")) if x)
    if meta:
        add_paragraph(meta, styles["subtitle"])
    if template.get("cover_page"):
        document.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    if content.get("toc"):
        add_paragraph("目录", styles["h1"])
        add_toc_field()
        # 不写这一行的话，用户看到空目录会以为生成失败了（见文件头）
        add_paragraph(TOC_HINT, styles["caption"])
        document.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    for block in content["blocks"]:
        kind = block["block"]
        if kind == "heading":
            level = block["level"]
            set_outline_level(add_paragraph(block["text"], styles[f"h{level}"]), level)
        elif kind == "paragraph":
            add_paragraph(block["text"], styles["body"])
        elif kind == "quote":
            add_paragraph(block["text"], styles["quote"])
            if block.get("cite"):
                add_paragraph(f"—— {block['cite']}", styles["caption"])
        elif kind in ("bullets", "ordered"):
            style_name = "List Bullet" if kind == "bullets" else "List Number"
            for item in block["items"]:
                paragraph = document.add_paragraph(style=style_name)
                style_run(paragraph.add_run(item), styles["body"])
        elif kind == "table":
            spec = template["table"]
            table = document.add_table(rows=1, cols=len(block["header"]))
            table.style = spec["style"]
            for index, text in enumerate(block["header"]):
                cell = table.rows[0].cells[index]
                cell.text = ""
                style_run(
                    cell.paragraphs[0].add_run(text),
                    {**styles["body"], "size_pt": spec["font_pt"], "bold": spec["header_bold"]},
                )
                if spec.get("header_fill"):
                    shading = OxmlElement("w:shd")
                    shading.set(qn("w:fill"), spec["header_fill"])
                    cell._tc.get_or_add_tcPr().append(shading)
            for row in block["rows"]:
                cells = table.add_row().cells
                for index, value in enumerate(row):
                    cells[index].text = ""
                    style_run(
                        cells[index].paragraphs[0].add_run("" if value is None else str(value)),
                        {**styles["body"], "size_pt": spec["font_pt"]},
                    )
            if block.get("caption"):
                add_paragraph(block["caption"], styles["caption"])
        elif kind == "image":
            path = resolve_asset(block["path"], base_dir, hint="先用 charts 技能生成它。")
            document.add_picture(
                str(path), width=Cm(block.get("width_cm", template["image_default_width_cm"]))
            )
            document.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
            if block.get("caption"):
                add_paragraph(block["caption"], styles["caption"])
        elif kind == "pagebreak":
            document.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    header_spec = template["header_footer"]
    if header_spec.get("header_text"):
        header = section.header.paragraphs[0]
        header.text = header_spec["header_text"].replace("{title}", content["title"])
        header.alignment = WD_ALIGN_PARAGRAPH.CENTER
    if header_spec.get("footer_page_number"):
        footer = section.footer.paragraphs[0]
        footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
        run = footer.add_run()
        begin = OxmlElement("w:fldChar")
        begin.set(qn("w:fldCharType"), "begin")
        instr = OxmlElement("w:instrText")
        instr.text = "PAGE"
        end = OxmlElement("w:fldChar")
        end.set(qn("w:fldCharType"), "end")
        run._r.append(begin)
        run._r.append(instr)
        run._r.append(end)

    document.core_properties.title = content["title"]
    document.core_properties.category = template_stamp(content.get("template", "report"))
    if content.get("subtitle"):
        document.core_properties.subject = content["subtitle"]
    if content.get("author"):
        document.core_properties.author = content["author"]
    if content.get("date"):
        document.core_properties.comments = f"evowork-date:{content['date']}"

    out_path.parent.mkdir(parents=True, exist_ok=True)
    document.save(out_path)


TEMPLATE_COMMENT = re.compile(r"^<!--\s*evowork-template:([A-Za-z0-9_-]+)\s*-->\s*$")
DATE_COMMENT = re.compile(r"^evowork-date:(.+)$")
MAX_BLOCKS = 400


def _fail_missing(path: Path) -> None:
    if not path.is_file():
        fail(EXIT_INVALID_CONTENT, f"找不到要提取的文件：{path.name}。")


def extract_md(path: Path) -> dict:
    """把 Markdown 收成内容 JSON。优先认本渲染器写出的形状，也接受普通标题层级。"""
    _fail_missing(path)
    lines = path.read_text(encoding="utf-8").splitlines()
    index = 0
    content: dict = {}

    def blank() -> None:
        nonlocal index
        while index < len(lines) and lines[index].strip() == "":
            index += 1

    blank()
    if index < len(lines):
        mark = TEMPLATE_COMMENT.match(lines[index].strip())
        if mark:
            content["template"] = mark.group(1)
            index += 1
            blank()
    if index >= len(lines) or not lines[index].startswith("# "):
        fail(EXIT_INVALID_CONTENT, "提取 Markdown 时，文件需要以一级标题作为文档标题。")
    content["title"] = lines[index][2:].strip()
    index += 1
    blank()
    if index < len(lines) and lines[index].startswith("> ") and not lines[index].startswith("> >"):
        content["subtitle"] = lines[index][2:].strip()
        index += 1
        blank()
    if index < len(lines) and " · " in lines[index] and not lines[index].startswith(("#", ">", "-", "|")):
        author, date = lines[index].split(" · ", 1)
        if author.strip():
            content["author"] = author.strip()
        if date.strip():
            content["date"] = date.strip()
        index += 1
        blank()

    blocks: list[dict] = []

    def push(block: dict) -> None:
        if len(blocks) >= MAX_BLOCKS:
            fail(EXIT_INVALID_CONTENT, f"块超过 {MAX_BLOCKS} 个。拆成两份文档再提取。")
        blocks.append(block)

    while index < len(lines):
        line = lines[index]
        if line.strip() == "":
            index += 1
            continue
        if line.strip() == "<!-- toc -->":
            content["toc"] = True
            index += 1
            continue
        if line.strip() == "---":
            push({"block": "pagebreak"})
            index += 1
            continue
        heading = re.match(r"^(#{2,5}) (.+)$", line)
        if heading:
            push({"block": "heading", "level": len(heading.group(1)) - 1, "text": heading.group(2).strip()})
            index += 1
            continue
        if line.startswith("#"):
            fail(EXIT_INVALID_CONTENT, "标题层级超过 4。提取只保留 h1 到 h4。")
        if line.startswith("!["):
            image = re.match(r"^!\[([^\]]*)\]\(([^)]+)\)\s*$", line)
            if image is None:
                fail(EXIT_INVALID_CONTENT, "有一张图片的写法不是 ![说明](路径)。")
            block = {"block": "image", "path": image.group(2).strip()}
            if image.group(1).strip():
                block["caption"] = image.group(1).strip()
            push(block)
            index += 1
            continue
        if line.startswith("|"):
            table_lines = []
            while index < len(lines) and lines[index].startswith("|"):
                table_lines.append(lines[index])
                index += 1
            rows = [
                [cell.strip() for cell in raw.strip().strip("|").split("|")]
                for raw in table_lines
                if not re.match(r"^\|\s*-+", raw)
            ]
            if len(rows) < 2:
                fail(EXIT_INVALID_CONTENT, "有一张表只有表头、没有数据行。")
            header, body = rows[0], rows[1:]
            push({"block": "table", "header": header, "rows": body})
            if index < len(lines) and lines[index].startswith("*") and lines[index].endswith("*"):
                caption = lines[index].strip("*").strip()
                if caption:
                    blocks[-1]["caption"] = caption
                index += 1
            continue
        if line.startswith("> "):
            quote = [line[2:]]
            index += 1
            cite = None
            while index < len(lines) and lines[index].startswith(">"):
                piece = lines[index][1:].lstrip()
                index += 1
                if piece.startswith("—— "):
                    cite = piece[3:].strip()
                elif piece:
                    quote.append(piece)
            block = {"block": "quote", "text": " ".join(quote).strip()}
            if cite:
                block["cite"] = cite
            push(block)
            continue
        if line.startswith("- "):
            items = []
            while index < len(lines) and lines[index].startswith("- "):
                items.append(lines[index][2:].strip())
                index += 1
            push({"block": "bullets", "items": items})
            continue
        ordered = re.match(r"^\d+\. (.+)$", line)
        if ordered:
            items = []
            while index < len(lines) and re.match(r"^\d+\. (.+)$", lines[index]):
                items.append(re.match(r"^\d+\. (.+)$", lines[index]).group(1).strip())
                index += 1
            push({"block": "ordered", "items": items})
            continue
        paragraph = [line.strip()]
        index += 1
        while index < len(lines) and lines[index].strip() and not lines[index].startswith(
            ("#", ">", "-", "|", "!", "<")
        ) and not re.match(r"^\d+\. ", lines[index]) and lines[index].strip() != "---":
            paragraph.append(lines[index].strip())
            index += 1
        push({"block": "paragraph", "text": " ".join(paragraph)})

    if not blocks:
        fail(EXIT_INVALID_CONTENT, "这份 Markdown 除了标题没有正文。")
    content["blocks"] = blocks
    return content


def _paragraph_text(paragraph) -> str:  # noqa: ANN001 -- python-docx Paragraph
    return paragraph.text.strip()


def _heading_level(paragraph) -> int | None:  # noqa: ANN001
    from docx.oxml.ns import qn

    p_pr = paragraph._p.pPr
    if p_pr is not None:
        outline = p_pr.find(qn("w:outlineLvl"))
        if outline is not None and outline.get(qn("w:val")) is not None:
            return int(outline.get(qn("w:val"))) + 1
    style = paragraph.style.name if paragraph.style is not None else ""
    match = re.fullmatch(r"(?:Heading|标题)\s*(\d+)", style)
    return int(match.group(1)) if match else None


def _list_kind(paragraph) -> str | None:  # noqa: ANN001
    style = paragraph.style.name if paragraph.style is not None else ""
    if style == "List Number":
        return "ordered"
    if style == "List Bullet":
        return "bullets"
    return None


def _is_page_break(paragraph) -> bool:  # noqa: ANN001
    xml = paragraph._p.xml
    return 'w:type="page"' in xml or "w:type='page'" in xml


def _is_toc_field(paragraph) -> bool:  # noqa: ANN001
    xml = paragraph._p.xml
    return "instrText" in xml and "TOC" in xml


def _image_blocks(paragraph, asset_dir: Path, counter: list[int]) -> list[dict]:  # noqa: ANN001
    blocks: list[dict] = []
    embeds = paragraph._p.xpath('.//*[local-name()="blip"]/@*[local-name()="embed"]')
    for embed in embeds:
        part = paragraph.part.related_parts.get(embed)
        if part is None:
            continue
        counter[0] += 1
        suffix = Path(str(part.partname)).suffix or ".bin"
        if suffix.lower() not in {".png", ".jpg", ".jpeg", ".gif", ".emf", ".wmf"}:
            suffix = ".bin"
        asset_dir.mkdir(parents=True, exist_ok=True)
        name = f"image-{counter[0]}{suffix}"
        (asset_dir / name).write_bytes(part.blob)
        blocks.append({"block": "image", "path": f"{asset_dir.name}/{name}"})
    return blocks


def extract_docx(path: Path, asset_dir: Path) -> dict:
    """读 docx 的大纲、列表和表格。封面与目录自带的分页不进入正文。"""
    _fail_missing(path)
    try:
        import docx
        from docx.oxml.ns import qn
    except ModuleNotFoundError:
        fail(EXIT_RUNTIME_MISSING, runtime_missing_message("office", "读取 docx"))

    document = docx.Document(str(path))
    content: dict = {}
    template = read_template_stamp(document.core_properties.category)
    if template:
        content["template"] = template
    title = (document.core_properties.title or "").strip() or path.stem
    content["title"] = title
    subject = (document.core_properties.subject or "").strip()
    if subject:
        content["subtitle"] = subject
    author = (document.core_properties.author or "").strip()
    if author:
        content["author"] = author
    date_match = DATE_COMMENT.match((document.core_properties.comments or "").strip())
    if date_match and date_match.group(1).strip():
        content["date"] = date_match.group(1).strip()

    meta = " · ".join(x for x in (content.get("author"), content.get("date")) if x)
    blocks: list[dict] = []
    counter = [0]
    started = False
    skipped_title = False
    skipped_subject = False
    skipped_meta = False

    def push(block: dict) -> None:
        nonlocal started
        if len(blocks) >= MAX_BLOCKS:
            fail(EXIT_INVALID_CONTENT, f"块超过 {MAX_BLOCKS} 个。拆成两份文档再提取。")
        blocks.append(block)
        started = True

    def flush_list(kind: str | None, items: list[str]) -> None:
        if kind and items:
            push({"block": kind, "items": items})

    list_kind: str | None = None
    list_items: list[str] = []

    body = document.element.body
    paragraph_at = 0
    table_at = 0
    for child in body:
        if child.tag == qn("w:p"):
            paragraph = document.paragraphs[paragraph_at]
            paragraph_at += 1
            text = _paragraph_text(paragraph)
            images = _image_blocks(paragraph, asset_dir, counter)
            if _is_toc_field(paragraph) or text in {TOC_HINT, "目录"}:
                continue
            if not skipped_title and text == title:
                skipped_title = True
                continue
            if subject and not skipped_subject and text == subject:
                skipped_subject = True
                continue
            if meta and not skipped_meta and text == meta:
                skipped_meta = True
                continue
            if _is_page_break(paragraph) and not text:
                if started:
                    flush_list(list_kind, list_items)
                    list_kind, list_items = None, []
                    push({"block": "pagebreak"})
                continue
            level = _heading_level(paragraph)
            kind = _list_kind(paragraph)
            if level or kind or text or images:
                if kind != list_kind:
                    flush_list(list_kind, list_items)
                    list_kind, list_items = kind, []
            if level:
                if not 1 <= level <= 4:
                    fail(EXIT_INVALID_CONTENT, "标题层级超过 4。提取只保留 h1 到 h4。")
                if text:
                    push({"block": "heading", "level": level, "text": text})
            elif kind and text:
                list_items.append(text)
            elif text:
                push({"block": "paragraph", "text": text})
            for image in images:
                push(image)
        elif child.tag == qn("w:tbl"):
            table = document.tables[table_at]
            table_at += 1
            flush_list(list_kind, list_items)
            list_kind, list_items = None, []
            grid = [[cell.text.strip() for cell in row.cells] for row in table.rows]
            grid = [row for row in grid if any(row)]
            if len(grid) < 2:
                fail(EXIT_INVALID_CONTENT, "有一张表只有表头、没有数据行。")
            width = len(grid[0])
            if width > 10:
                fail(EXIT_INVALID_CONTENT, "有一张表超过 10 列，文档技能的表装不下。")
            rows = []
            for row in grid[1:]:
                if len(row) != width:
                    fail(EXIT_INVALID_CONTENT, "有一张表的某一行和表头列数不同。")
                rows.append([cell or None for cell in row])
            if len(rows) > 200:
                fail(EXIT_INVALID_CONTENT, "有一张表超过 200 行。拆开再提取。")
            push({"block": "table", "header": grid[0], "rows": rows})
    flush_list(list_kind, list_items)
    if not blocks:
        fail(EXIT_INVALID_CONTENT, "这份文档除了标题没有可提取的正文。")
    content["blocks"] = blocks
    return content


# 与 services/ingest/src/office-preview.ts 同一套隔离参数：独立配置、关掉宏。
MACRO_LOCK = (
    '<?xml version="1.0"?>'
    '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
    '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
    '<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>'
    '<prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>'
    '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
    "</item></oor:items>"
)


def office_converter() -> Path | None:
    """本机 soffice。`EVOWORK_OFFICE_CONVERTER` 与预览共用。

    设了覆盖就不再回退到 PATH：坏路径若被静默换成另一份程序，测试就钉不住失败。
    """
    override = os.environ.get("EVOWORK_OFFICE_CONVERTER")
    if override is not None:
        path = Path(override)
        return path if path.is_file() else None
    found = shutil.which("soffice")
    if found:
        return Path(found)
    for candidate in (
        Path("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
        Path("/Applications/LibreOfficeDev.app/Contents/MacOS/soffice"),
    ):
        if candidate.is_file():
            return candidate
    return None


def convert_docx_to_pdf(docx_path: Path, pdf_path: Path) -> None:
    converter = office_converter()
    if converter is None:
        fail(
            EXIT_RUNTIME_MISSING,
            "需要本机 LibreOffice（soffice）才能把文档导出成 PDF。安装后重试，或改交付 .docx / .md。",
        )
    work = Path(tempfile.mkdtemp(prefix="evowork-pdf-"))
    try:
        profile = work / "profile"
        (profile / "user").mkdir(parents=True)
        (profile / "user" / "registrymodifications.xcu").write_text(MACRO_LOCK, encoding="utf-8")
        staged = work / "document.docx"
        shutil.copyfile(docx_path, staged)
        try:
            completed = subprocess.run(
                [
                    str(converter),
                    "-env:UserInstallation=" + profile.resolve().as_uri(),
                    "--headless",
                    "--nologo",
                    "--nodefault",
                    "--norestore",
                    "--nolockcheck",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(work),
                    str(staged),
                ],
                capture_output=True,
                timeout=45,
            )
        except subprocess.TimeoutExpired:
            fail(EXIT_RUNTIME_MISSING, "LibreOffice 转换 PDF 超时。请稍后重试，或改交付 .docx / .md。")
        produced = work / "document.pdf"
        if completed.returncode != 0 or not produced.is_file():
            fail(
                EXIT_RUNTIME_MISSING,
                "LibreOffice 没有写出 PDF。请确认 soffice 可用后重试，或改交付 .docx / .md。",
            )
        data = produced.read_bytes()
        if not data.startswith(b"%PDF-"):
            fail(
                EXIT_RUNTIME_MISSING,
                "转换结果不是 PDF。请确认 soffice 可用后重试，或改交付 .docx / .md。",
            )
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_path.write_bytes(data)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def extract_document(path: Path, out_path: Path) -> dict:
    suffix = path.suffix.lower()
    if suffix == ".md":
        return extract_md(path)
    if suffix == ".docx":
        return extract_docx(path, out_path.parent / "extracted-media")
    fail(EXIT_INVALID_CONTENT, f"提取只支持 .docx 与 .md，收到 {suffix or '(无扩展名)'}。")


def main() -> None:
    parser = argparse.ArgumentParser(description="内容 JSON → docx / md，或从已有文件提取内容 JSON")
    parser.add_argument("--content", help="要渲染的内容 JSON")
    parser.add_argument("--extract", help="已有的 .docx / .md，提取成内容 JSON")
    parser.add_argument("--out", required=True, help="渲染：.docx / .md。提取：.json")
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()

    if bool(args.extract) == bool(args.content):
        fail(EXIT_INVALID_CONTENT, "提取用 --extract，生成用 --content，不要同时给，也不要都不给。")
    if args.extract and args.validate_only:
        fail(EXIT_INVALID_CONTENT, "提取会直接写出 JSON，没有 --validate-only。")

    extracting = args.extract
    if extracting and Path(extracting).suffix.lower() == ".docx":
        ensure_office_runtime(("docx",))
    elif not extracting:
        # 缺办公扩展的模块时换到扩展的解释器重跑（见 evowork_skill.ensure_office_runtime）。
        # --validate-only 不需要它，但提前换掉更简单，也让两条路径的行为一致
        ensure_office_runtime(("docx",))

    out_path = Path(args.out).resolve()
    if extracting:
        content = extract_document(Path(extracting).resolve(), out_path)
        validate(content, out_path.parent)
        write_extracted(content, out_path)
        succeeded(out_path, blocks=len(content["blocks"]), format="json", operation="extract")
        return

    content_path = Path(args.content).resolve()
    content = read_content(content_path)
    validate(content, content_path.parent)

    if args.validate_only:
        succeeded(blocks=len(content["blocks"]), validated=True)
        return

    suffix = out_path.suffix.lower()
    if suffix == ".md":
        render_md(content, out_path)
        succeeded(out_path, blocks=len(content["blocks"]), format="md")
        return
    if suffix == ".pdf":
        # 先看转换器，再渲染。缺 soffice 时不要先报「缺 python-docx」，两条都缺时用户先装错东西。
        if office_converter() is None:
            fail(
                EXIT_RUNTIME_MISSING,
                "需要本机 LibreOffice（soffice）才能把文档导出成 PDF。安装后重试，或改交付 .docx / .md。",
            )
        with tempfile.TemporaryDirectory(prefix="evowork-pdf-src-") as tmp:
            docx_path = Path(tmp) / "document.docx"
            render_docx(content, docx_path, content_path.parent)
            convert_docx_to_pdf(docx_path, out_path)
        succeeded(out_path, blocks=len(content["blocks"]), format="pdf")
        return
    if suffix != ".docx":
        fail(EXIT_INVALID_CONTENT, f"输出格式只支持 .docx、.md 与 .pdf，收到 {suffix or '(无扩展名)'}。")

    render_docx(content, out_path, content_path.parent)
    succeeded(out_path, blocks=len(content["blocks"]), format="docx")


if __name__ == "__main__":
    main()
