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
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote

SKILL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT.parent / "_shared"))

from evowork_skill import (  # noqa: E402
    ensure_office_runtime,
    EXIT_CONVERSION_FAILED,
    EXIT_INVALID_CONTENT,
    EXIT_RUNTIME_MISSING,
    fail,
    load_template,
    lossy_extraction,
    read_content,
    read_template_stamp,
    refuse_overwrite,
    resolve_asset,
    runtime_missing_message,
    succeeded,
    template_stamp,
    validate_content,
    write_extracted,
)

BLOCKS = ("heading", "paragraph", "bullets", "ordered", "table", "image", "quote", "pagebreak")

TOC_HINT = "（目录是 Word 的域：第一次打开时按 F9 或右键「更新域」即可显示页码。）"

#: md 封面里副标题那一行之前的标记（作者 / 日期的标记见 META_COMMENT）
SUBTITLE_COMMENT = "<!-- evowork-subtitle -->"


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


def _md_cell(value: object) -> str:
    # 格子里的 | 会把表切成两列；提取时按同样的转义读回
    return "" if value is None else str(value).replace("|", "\\|")


def _md_image_target(ref: str, out_path: Path) -> str:
    """md 里写的图片地址。

    提取会把图片写成**绝对路径**（相对 .md 解析，见 extract_md）。原样写回的话，用户的 md
    会带上本机目录、换台机器就断 —— 所以落在输出目录之内的图片写回相对路径。
    """
    target = ref
    path = Path(ref)
    if path.is_absolute():
        real = Path(os.path.realpath(path))
        base = Path(os.path.realpath(out_path.parent))
        if real == base or base in real.parents:
            target = real.relative_to(base).as_posix()
    # 带空格或括号的地址要包进尖括号，否则 md 在第一个空格 / 右括号处就截断了
    return f"<{target}>" if re.search(r"[\s()<>]", target) else target


def render_md(content: dict, out_path: Path) -> None:
    lines: list[str] = [f"# {content['title']}", ""]
    if content.get("template"):
        # 提取时靠这一行找回模板。放在标题前面，阅读器会把它当注释丢掉。
        lines.insert(0, "")
        lines.insert(0, f"<!-- evowork-template:{content['template']} -->")
    # 副标题与作者 / 日期各带一行注释标记（阅读器不显示）。提取只认带标记的那两行 ——
    # 2026-10-22 之前是按「标题后第一段含 · 」猜的，用户正文第一段就被吞成了作者和日期
    if content.get("subtitle"):
        lines += [SUBTITLE_COMMENT, f"> {content['subtitle']}", ""]
    fields = [name for name in ("author", "date") if content.get(name)]
    if fields:
        lines += [
            f"<!-- evowork-meta:{'+'.join(fields)} -->",
            " · ".join(content[name] for name in fields),
            "",
        ]
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
            lines += ["| " + " | ".join(_md_cell(c) for c in header) + " |"]
            lines += ["| " + " | ".join("---" for _ in header) + " |"]
            for row in block["rows"]:
                lines += ["| " + " | ".join(_md_cell(c) for c in row) + " |"]
            if block.get("caption"):
                lines += ["", f"*{block['caption']}*"]
            lines += [""]
        elif kind == "image":
            target = _md_image_target(block["path"], out_path)
            lines += [f"![{block.get('caption', '')}]({target})", ""]
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

    def add_paragraph(text: str, spec: dict, style: str | None = None):
        # style 只给引用与题注：Word 的「引用」「题注」样式是它们的语义（提取靠它认回来，
        # Word 的「插入表目录」也靠题注样式）。外观仍由下面的直接格式决定
        paragraph = document.add_paragraph(style=style)
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
            add_paragraph(block["text"], styles["quote"], "Quote")
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
                add_paragraph(block["caption"], styles["caption"], "Caption")
        elif kind == "image":
            path = resolve_asset(block["path"], base_dir, hint="先用 charts 技能生成它。")
            document.add_picture(
                str(path), width=Cm(block.get("width_cm", template["image_default_width_cm"]))
            )
            document.paragraphs[-1].alignment = WD_ALIGN_PARAGRAPH.CENTER
            if block.get("caption"):
                add_paragraph(block["caption"], styles["caption"], "Caption")
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
META_COMMENT = re.compile(r"^<!--\s*evowork-meta:(author|date|author\+date)\s*-->\s*$")
DATE_COMMENT = re.compile(r"^evowork-date:(.+)$")
MAX_BLOCKS = 400
#: 表头里没有字的格子（合并后的空位、左上角的空格）。schema 要求表头每列都有字，
#: 只能占位 —— 占位改变了原文，所以同时记进「收不回」的清单
HEADER_PLACEHOLDER = "—"
CAPTION_LIMITS = {"table": 120, "image": 200}


def _fail_missing(path: Path) -> None:
    if not path.is_file():
        fail(EXIT_INVALID_CONTENT, f"找不到要提取的文件：{path.name}。")


class _Collected:
    """两种提取共用的块收集：块数上限、标题层级、收不回的内容清单（`_dropped`）。"""

    def __init__(self) -> None:
        self.blocks: list[dict] = []
        self.dropped: dict[str, int] = {}
        self.last_heading = 0

    def bump(self, kind: str, count: int = 1) -> None:
        if count > 0:
            self.dropped[kind] = self.dropped.get(kind, 0) + count

    def push(self, block: dict) -> None:
        if len(self.blocks) >= MAX_BLOCKS:
            fail(EXIT_INVALID_CONTENT, f"块超过 {MAX_BLOCKS} 个。拆成两份文档再提取。")
        self.blocks.append(block)

    def heading(self, level: int, text: str) -> None:
        """标题。超过 4 级的降成正文、跳级的补成逐级 —— 都记下来，而不是让整份提取失败。"""
        text = " ".join(text.split())
        if not text:
            return
        if level > 4:
            self.bump("超过 4 级的标题")
            self.push({"block": "paragraph", "text": text})
            return
        if self.last_heading and level > self.last_heading + 1:
            self.bump("跳级的标题")
            level = self.last_heading + 1
        self.push({"block": "heading", "level": level, "text": text})
        self.last_heading = level

    def table_header(self, cells: list) -> list[str]:
        header = []
        for cell in cells:
            text = "" if cell is None else str(cell).strip()
            if not text:
                self.bump("表头空白格")
                text = HEADER_PLACEHOLDER
            header.append(text)
        return header


def _write_media(asset_dir: Path, stem: str, suffix: str, blob: bytes) -> str:
    """把一张图写进 `extracted-media/`，返回相对内容 JSON 的路径。

    **不覆盖、不跟符号链接**（2026-10-22）：之前同名就覆盖，目录是指向别处的链接也照写 ——
    提取第二份文件会冲掉第一份的图，而一个预先放好的链接能让提取往任意目录写文件。
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
            # O_EXCL：名字已被占（文件或链接都算）就换下一个，绝不写进已有的文件
            handle = os.open(asset_dir / name, flags, 0o644)
        except FileExistsError:
            continue
        with os.fdopen(handle, "wb") as out:
            out.write(blob)
        return f"{asset_dir.name}/{name}"
    fail(EXIT_INVALID_CONTENT, f"{asset_dir.name} 里同名的图片太多。换一个 --out 目录再提取。")


# ─────────────────────────── 从 Markdown 提取 ───────────────────────────

FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
ATX_HEADING = re.compile(r"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$")
THEMATIC_BREAK = re.compile(r"^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$")
BULLET_ITEM = re.compile(r"^([ \t]*)[-*+][ \t]+(.*)$")
ORDERED_ITEM = re.compile(r"^([ \t]*)\d{1,9}[.)][ \t]+(.*)$")
IMAGE_LINE = re.compile(r"^!\[([^\]]*)\]\((.*)\)$")
CAPTION_LINE = re.compile(r"^\*(?!\*)(.+?)(?<!\*)\*$")
URL_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]+:")


def _md_list_item(line: str) -> tuple[int, str, str] | None:
    """(缩进, bullets / ordered, 正文)。`-` `*` `+` 都是无序列表。"""
    if THEMATIC_BREAK.match(line):
        return None
    for kind, pattern in (("bullets", BULLET_ITEM), ("ordered", ORDERED_ITEM)):
        match = pattern.match(line)
        if match:
            return len(match.group(1).expandtabs(4)), kind, match.group(2).strip()
    return None


def _md_image_ref(inner: str) -> str | None:
    """`![说明](地址 "标题")` 括号里的地址；认不出来返回 None（那一行按普通段落处理）。"""
    inner = inner.strip()
    if inner.startswith("<"):
        end = inner.find(">")
        rest = inner[end + 1 :].strip() if end > 0 else "x"
        if end <= 1 or (rest and not re.fullmatch(r'"[^"]*"|\'[^\']*\'', rest)):
            return None
        return inner[1:end]
    match = re.fullmatch(r'(\S+)(?:\s+(?:"[^"]*"|\'[^\']*\'))?', inner)
    return match.group(1) if match else None


def _md_cells(raw: str) -> list[str]:
    text = raw.strip()
    if text.startswith("|"):
        text = text[1:]
    if text.endswith("|") and not text.endswith("\\|"):
        text = text[:-1]
    return [cell.strip().replace("\\|", "|") for cell in re.split(r"(?<!\\)\|", text)]


def _md_separator(raw: str) -> bool:
    """`| --- | :--- | ---: | :---: |` —— 对齐行不是数据行（2026-10-22 之前带冒号的会被当成数据）。"""
    cells = _md_cells(raw)
    return bool(cells) and all(re.fullmatch(r":?-+:?", cell) for cell in cells)


def _md_block_start(line: str) -> bool:
    stripped = line.strip()
    return bool(
        FENCE.match(line)
        or THEMATIC_BREAK.match(line)
        or ATX_HEADING.match(line)
        or stripped.startswith(("|", ">", "<"))
        or IMAGE_LINE.match(stripped)
        or _md_list_item(line)
    )


def _md_image(ref: str, md_dir: Path, collected: _Collected) -> Path | None:
    """图片按 **.md 所在目录** 解析，只收这个目录树里真实存在的文件。

    2026-10-22 之前按内容 JSON 的目录解析：JSON 一写进临时目录，每张图都"找不到"，
    还被报成「先用 charts 生成它」。另一半是安全：下载来的 md 写一句
    `![](../../.ssh/id_rsa)`，重新渲染成 docx 就会把本机文件嵌进去 —— 所以目录树之外的
    （含经符号链接绕出去的）一律不收，记进清单。网络图片同样不收（不替用户联网下载）。
    """
    if URL_SCHEME.match(ref):
        collected.bump("网络图片")
        return None
    raw = Path(ref)
    if not os.path.lexists(raw if raw.is_absolute() else md_dir / raw):
        decoded = Path(unquote(ref))
        if os.path.lexists(decoded if decoded.is_absolute() else md_dir / decoded):
            raw = decoded
    root = Path(os.path.realpath(md_dir))
    real = Path(os.path.realpath(raw if raw.is_absolute() else md_dir / raw))
    if real != root and root not in real.parents:
        collected.bump("目录外的图片")
        return None
    if not real.is_file():
        collected.bump("找不到的图片")
        return None
    return real


def extract_md(path: Path) -> dict:
    """把 Markdown 收成内容 JSON。优先认本渲染器写出的形状，也接受普通标题层级。"""
    _fail_missing(path)
    lines = path.read_text(encoding="utf-8").splitlines()
    index = 0
    content: dict = {}
    collected = _Collected()

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
    # 副标题与作者 / 日期只认渲染器写的标记行（见 render_md）。没有标记的引用和段落都是正文
    if index < len(lines) and lines[index].strip() == SUBTITLE_COMMENT:
        if index + 1 < len(lines) and lines[index + 1].startswith(">"):
            content["subtitle"] = lines[index + 1][1:].strip()
            index += 2
        else:
            index += 1
        blank()
    meta = META_COMMENT.match(lines[index].strip()) if index < len(lines) else None
    if meta:
        fields = meta.group(1).split("+")
        values = lines[index + 1].strip().rsplit(" · ", 1) if index + 1 < len(lines) else []
        if len(fields) == 1 and values:
            values = [" · ".join(values)]
        if len(values) == len(fields) and all(value.strip() for value in values):
            content.update({name: value.strip() for name, value in zip(fields, values)})
            index += 2
        else:
            index += 1
        blank()

    md_dir = path.parent
    while index < len(lines):
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        if stripped == "<!-- toc -->":
            content["toc"] = True
            index += 1
            continue
        fence = FENCE.match(line)
        if fence:
            # 代码块原样留成一段（连同围栏）：写回 md 时还是代码块，里面的 `# 注释` 不会变成标题
            marker = fence.group(1)
            closing = re.compile(r"^ {0,3}" + re.escape(marker[0]) + "{%d,}[ \t]*$" % len(marker))
            code = [line]
            index += 1
            while index < len(lines):
                code.append(lines[index])
                index += 1
                if closing.match(code[-1]):
                    break
            collected.push({"block": "paragraph", "text": "\n".join(code)})
            continue
        if THEMATIC_BREAK.match(line):
            collected.push({"block": "pagebreak"})
            index += 1
            continue
        heading = ATX_HEADING.match(line)
        if heading:
            index += 1
            hashes = len(heading.group(1))
            if hashes == 1 and (heading.group(2) or "").strip():
                # 文档标题已经占了 h1。第二个 h1 只能降成一级标题（写回 md 是 ##）
                collected.bump("多余的一级标题")
            collected.heading(max(hashes - 1, 1), heading.group(2) or "")
            continue
        image = IMAGE_LINE.match(stripped)
        ref = _md_image_ref(image.group(2)) if image else None
        if image and ref is not None:
            index += 1
            real = _md_image(ref, md_dir, collected)
            if real is not None:
                # 写绝对路径：内容 JSON 放在哪都能找到图（render_md 写回时再换成相对路径）
                block = {"block": "image", "path": str(real)}
                if image.group(1).strip():
                    block["caption"] = image.group(1).strip()
                collected.push(block)
            continue
        if stripped.startswith("|"):
            table_lines = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                table_lines.append(lines[index])
                index += 1
            rows = [_md_cells(raw) for raw in table_lines if not _md_separator(raw)]
            if len(rows) < 2:
                fail(EXIT_INVALID_CONTENT, "有一张表只有表头、没有数据行。")
            header = collected.table_header(rows[0])
            body = [row + [""] * (len(header) - len(row)) for row in rows[1:]]
            block = {"block": "table", "header": header, "rows": body}
            # 表题：渲染器在表后**空一行**写 `*表题*`（2026-10-22 之前只看紧挨着的那一行）
            look = index
            while look < len(lines) and not lines[look].strip():
                look += 1
            caption = CAPTION_LINE.match(lines[look].strip()) if look < len(lines) else None
            alone = look + 1 >= len(lines) or not lines[look + 1].strip()
            if caption and alone and len(caption.group(1).strip()) <= CAPTION_LIMITS["table"]:
                block["caption"] = caption.group(1).strip()
                index = look + 1
            collected.push(block)
            continue
        if stripped.startswith(">"):
            quote: list[str] = []
            cite = None
            while index < len(lines) and lines[index].strip().startswith(">"):
                piece = lines[index].strip()[1:].strip()
                index += 1
                if piece.startswith("—— "):
                    cite = piece[3:].strip()
                elif piece:
                    quote.append(piece)
            if quote:
                block = {"block": "quote", "text": " ".join(quote).strip()}
                if cite:
                    block["cite"] = cite
                collected.push(block)
            elif cite:
                collected.push({"block": "paragraph", "text": f"—— {cite}"})
            continue
        item = _md_list_item(line)
        if item:
            base, kind, first = item
            items = [first] if first else []
            index += 1
            while index < len(lines):
                current = lines[index]
                if not current.strip():
                    # 空行之后还是同一种列表项（或更深的一级）：同一个松散列表
                    look = index
                    while look < len(lines) and not lines[look].strip():
                        look += 1
                    after = _md_list_item(lines[look]) if look < len(lines) else None
                    if after and (after[0] >= base + 2 or after[1] == kind):
                        index = look
                        continue
                    break
                after = _md_list_item(current)
                if after:
                    indent, other, text = after
                    if indent >= base + 2:
                        # 内容 JSON 的列表只有一层：子项并进来，层级记进清单
                        collected.bump("嵌套列表层级")
                    elif other != kind:
                        break
                    if text:
                        items.append(text)
                    index += 1
                    continue
                if current[:1] in (" ", "\t") and items and not FENCE.match(current):
                    items[-1] = f"{items[-1]} {current.strip()}"
                    index += 1
                    continue
                break
            if items:
                collected.push({"block": kind, "items": items})
            continue
        paragraph = [stripped]
        index += 1
        while index < len(lines) and lines[index].strip() and not _md_block_start(lines[index]):
            paragraph.append(lines[index].strip())
            index += 1
        collected.push({"block": "paragraph", "text": " ".join(paragraph)})

    if not collected.blocks:
        fail(EXIT_INVALID_CONTENT, "这份 Markdown 除了标题没有正文。")
    content["blocks"] = collected.blocks
    content["_dropped"] = collected.dropped
    return content


# ─────────────────────────── 从 docx 提取 ───────────────────────────
#
# 直接读 XML，不用 python-docx 的 paragraph.text / row.cells：
#   · paragraph.text 只收 w:p 下面直接的 w:r 与 w:hyperlink —— 行内内容控件、修订插入的字都不在里面；
#   · row.cells 把合并单元格在每个被合并的位置各返回一次，同一段字会出现好几遍。

OOXML_NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "v": "urn:schemas-microsoft-com:vml",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "dgm": "http://schemas.openxmlformats.org/drawingml/2006/diagram",
}


def _w(name: str) -> str:
    return "{%s}%s" % (OOXML_NS["w"], name)


def _ns(prefix: str, name: str) -> str:
    return "{%s}%s" % (OOXML_NS[prefix], name)


_XPATHS: dict = {}


def _xpath(element, expr: str) -> list:  # noqa: ANN001 -- lxml element
    compiled = _XPATHS.get(expr)
    if compiled is None:
        from lxml import etree  # 随 python-docx 安装；md 那条路径不需要它

        compiled = _XPATHS[expr] = etree.XPath(expr, namespaces=OOXML_NS)
    return compiled(element)


#: 读正文时不进去的子树：属性、删除的修订、文本框（单独报）、图形与公式（单独报）、
#: mc:Fallback（与 Choice 是同一份内容的两种写法）、注音（w:rt 会和正文叠在一起）
_TEXT_SKIP = {
    _w("pPr"),
    _w("rPr"),
    _w("sdtPr"),
    _w("del"),
    _w("moveFrom"),
    _w("txbxContent"),
    _w("drawing"),
    _w("pict"),
    _w("object"),
    _w("rt"),
    _ns("mc", "Fallback"),
    _ns("m", "oMath"),
    _ns("m", "oMathPara"),
}

#: 只列图片 python-docx 写得回去的格式；EMF / WMF 收回来也渲染不了
DOCX_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".tif", ".tiff"}

TOC_LABELS = {"目录", "目 录", "contents", "table of contents"}


def _shows_placeholder(sdt) -> bool:  # noqa: ANN001
    """内容控件里显示的是「单击此处输入文字」一类的提示，不是正文。"""
    properties = sdt.find(_w("sdtPr"))
    return properties is not None and properties.find(_w("showingPlcHdr")) is not None


def _docx_text(element) -> str:  # noqa: ANN001
    parts: list[str] = []

    def walk(node) -> None:  # noqa: ANN001
        for child in node:
            tag = child.tag
            if not isinstance(tag, str) or tag in _TEXT_SKIP:
                continue
            if tag == _w("sdt") and _shows_placeholder(child):
                continue
            if tag == _w("t"):
                parts.append(child.text or "")
            elif tag == _w("tab"):
                parts.append("\t")
            elif tag in (_w("br"), _w("cr")):
                if child.get(_w("type")) not in ("page", "column"):
                    parts.append("\n")
            elif tag == _w("noBreakHyphen"):
                parts.append("-")
            else:
                walk(child)

    walk(element)
    return "".join(parts)


def _docx_children(container, tags: tuple[str, ...]) -> list:  # noqa: ANN001
    """直接子元素，**穿过内容控件与自定义 XML 的包装**。"""
    found = []
    for child in container:
        if child.tag in tags:
            found.append(child)
        elif child.tag == _w("sdt"):
            inner = child.find(_w("sdtContent"))
            if inner is not None and not _shows_placeholder(child):
                found.extend(_docx_children(inner, tags))
        elif child.tag == _w("customXml"):
            found.extend(_docx_children(child, tags))
    return found


def _docx_items(container, collected: _Collected, items: list) -> None:  # noqa: ANN001
    """正文的块级元素，按文档顺序。2026-10-22 之前只走 w:p 与 w:tbl，内容控件（w:sdt）里的正文整段丢了。"""
    for child in container:
        tag = child.tag
        if tag == _w("p"):
            items.append(("p", child))
        elif tag == _w("tbl"):
            items.append(("tbl", child))
        elif tag == _w("sdt"):
            gallery = _xpath(child, "./w:sdtPr/w:docPartObj/w:docPartGallery/@w:val")
            if gallery and gallery[0] == "Table of Contents":
                items.append(("toc", child))
            elif not _shows_placeholder(child):
                inner = child.find(_w("sdtContent"))
                if inner is not None:
                    _docx_items(inner, collected, items)
        elif tag == _w("customXml"):
            _docx_items(child, collected, items)
        elif tag == _w("altChunk"):
            collected.bump("嵌入的外部文档")


class _DocxStyles:
    """段落样式链（自身 → basedOn → …）。样式名一律小写比较：Word 内置样式在 XML 里是 `heading 1`、`caption`。"""

    def __init__(self, document) -> None:  # noqa: ANN001
        self.by_id: dict = {}
        self.default = None
        for style in document.styles.element.findall(_w("style")):
            if style.get(_w("styleId")):
                self.by_id[style.get(_w("styleId"))] = style
            if style.get(_w("type")) == "paragraph" and style.get(_w("default")) in ("1", "true", "on"):
                self.default = style

    def chain(self, p) -> tuple[list, list[str]]:  # noqa: ANN001
        properties = p.find(_w("pPr"))
        ref = properties.find(_w("pStyle")) if properties is not None else None
        style_id = ref.get(_w("val")) if ref is not None else None
        style = self.by_id.get(style_id) if style_id else None
        if style is None:
            style = self.default
        chain: list = []
        while style is not None and style not in chain and len(chain) < 16:
            chain.append(style)
            based = style.find(_w("basedOn"))
            style = self.by_id.get(based.get(_w("val"))) if based is not None else None
        names = []
        for item in chain:
            name = item.find(_w("name"))
            names.append((name.get(_w("val")) or "").strip().lower() if name is not None else "")
        if style_id and style_id not in self.by_id:
            # 引用了没定义的样式：别的工具常这么写（只写 pStyle="Heading1"），Word 按名字认
            names.insert(0, style_id.lower())
        return chain, names


def _style_role(names: list[str]) -> tuple[str, int] | None:
    """最近的一个认得出的样式决定角色。"""
    for name in names:
        heading = re.fullmatch(r"(?:heading|标题)\s*(\d)", name)
        if heading:
            return "heading", int(heading.group(1))
        if re.fullmatch(r"(?:toc|目录)\s*\d", name):
            return "toc", 0
        if name in ("toc heading", "tocheading", "目录标题"):
            return "toc-heading", 0
        if name in ("title", "标题"):
            return "title", 0
        if name in ("subtitle", "副标题"):
            return "subtitle", 0
        if name in ("quote", "intense quote", "intensequote", "引用", "明显引用"):
            return "quote", 0
        if name in ("caption", "题注"):
            return "caption", 0
        if name.startswith("list bullet"):
            return "list", 1
        if name.startswith("list number"):
            return "list", 2
    return None


def _docx_property(p, chain: list, path: str) -> list:  # noqa: ANN001
    """段落自身优先，其次样式链上最近的定义（Word 的继承顺序）。"""
    for holder in [p, *chain]:
        found = _xpath(holder, path)
        if found:
            return found
    return []


def _heading_level(p, chain: list, role: tuple[str, int] | None) -> int | None:  # noqa: ANN001
    """大纲级别 0–8 是 1–9 级标题，**9 是正文**（WPS 给正文段落普遍写 outlineLvl=9）。

    2026-10-22 之前 9 被读成第 10 级标题，整份提取以「标题层级超过 4」失败。
    """
    found = _docx_property(p, chain, "./w:pPr/w:outlineLvl/@w:val")
    if found and str(found[0]).isdigit():
        value = int(found[0])
        return value + 1 if value < 9 else None
    if role and role[0] == "heading":
        return role[1]
    return None


class _DocxNumbering:
    """编号定义：段落的 numId + ilvl → 那一级的 numFmt（bullet / decimal / chineseCounting …）。"""

    def __init__(self, document, styles: _DocxStyles) -> None:  # noqa: ANN001
        self.nums: dict = {}
        self.abstract: dict = {}
        self.styles = styles
        try:
            root = document.part.numbering_part.element
        except Exception:  # noqa: BLE001 -- 没有编号部件的文档
            return
        for item in root.findall(_w("abstractNum")):
            self.abstract[item.get(_w("abstractNumId"))] = item
        for item in root.findall(_w("num")):
            self.nums[item.get(_w("numId"))] = item

    def format(self, num_id: str, level: int, depth: int = 0) -> str | None:
        num = self.nums.get(num_id)
        if num is None or depth > 4:
            return None
        for override in num.findall(_w("lvlOverride")):
            if override.get(_w("ilvl")) == str(level):
                found = _xpath(override, "./w:lvl/w:numFmt/@w:val")
                if found:
                    return str(found[0])
        abstract = _xpath(num, "./w:abstractNumId/@w:val")
        definition = self.abstract.get(abstract[0]) if abstract else None
        if definition is None:
            return None
        # Word 的「多级列表」常把级别定义放在列表样式里：abstractNum 只留一个 numStyleLink
        link = _xpath(definition, "./w:numStyleLink/@w:val")
        linked = self.styles.by_id.get(str(link[0])) if link else None
        if linked is not None:
            target = _xpath(linked, "./w:pPr/w:numPr/w:numId/@w:val")
            return self.format(str(target[0]), level, depth + 1) if target else None
        for lvl in definition.findall(_w("lvl")):
            if lvl.get(_w("ilvl")) == str(level):
                found = _xpath(lvl, "./w:numFmt/@w:val")
                return str(found[0]) if found else "decimal"
        return None


def _list_info(p, chain: list, role, numbering: _DocxNumbering) -> tuple[str | None, int]:  # noqa: ANN001
    """(bullets / ordered / None, 层级)。

    工具栏做的列表是「列表段落」样式 + 段落上的 w:numPr，样式名里看不出有序无序，
    要按编号定义的 numFmt 判（2026-10-22 之前只认 List Bullet / List Number 两个样式名）。
    """
    num_ids = _docx_property(p, chain, "./w:pPr/w:numPr/w:numId/@w:val")
    levels = _docx_property(p, chain, "./w:pPr/w:numPr/w:ilvl/@w:val")
    level = int(levels[0]) if levels and str(levels[0]).isdigit() else 0
    num_id = str(num_ids[0]) if num_ids else None
    if num_id and num_id != "0":
        fmt = numbering.format(num_id, level)
        if fmt == "none":
            return None, level
        if fmt == "bullet":
            return "bullets", level
        if fmt is not None:
            return "ordered", level
    if role and role[0] == "list":
        return ("bullets" if role[1] == 1 else "ordered"), level
    if num_id and num_id != "0":
        return "bullets", level  # 有编号但定义缺失：至少还是一个列表
    return None, level


def _field_kind(instruction: str) -> str | None:
    """TOC 域是目录；带 \\c / \\a 开关的 TOC 是图表目录（内容 JSON 没有这个）。"""
    code = instruction.strip()
    if not re.match(r"TOC\b", code, flags=re.IGNORECASE):
        return None
    return "tof" if re.search(r"\\[ca]\b", code) else "toc"


def _scan_fields(p, stack: list[list[str]], collected: _Collected) -> str | None:  # noqa: ANN001
    """这一段是否（部分）落在目录域里。域可以跨好几段：Word 的目录从第一条开始、到最后一条结束。"""

    def active() -> str | None:
        for entry in stack:
            kind = _field_kind(entry[0])
            if kind:
                return kind
        return None

    hit = active()
    outside = "[not(ancestor::w:txbxContent)][not(ancestor::mc:Fallback)]"
    for node in _xpath(p, f".//w:fldChar{outside} | .//w:instrText{outside} | .//w:fldSimple{outside}"):
        if node.tag == _w("fldChar"):
            kind = node.get(_w("fldCharType"))
            if kind == "begin":
                stack.append([""])
            elif kind == "end" and stack:
                if _field_kind(stack.pop()[0]) == "tof":
                    collected.bump("图表目录")
        elif node.tag == _w("instrText"):
            if stack:
                stack[-1][0] += node.text or ""
        else:
            kind = _field_kind(node.get(_w("instr"), ""))
            if kind == "tof":
                collected.bump("图表目录")
            hit = hit or kind
        hit = hit or active()
    return hit


def _starts_toc(item: tuple, styles: _DocxStyles) -> bool:
    kind, element = item
    if kind == "toc":
        return True
    if kind != "p":
        return False
    instruction = "".join(node.text or "" for node in _xpath(element, ".//w:instrText"))
    simple = _xpath(element, ".//w:fldSimple/@w:instr")
    if _field_kind(instruction) == "toc" or any(_field_kind(str(value)) == "toc" for value in simple):
        return True
    role = _style_role(styles.chain(element)[1])
    return bool(role and role[0] == "toc")


def _count_docx_extras(body, collected: _Collected) -> None:  # noqa: ANN001
    """正文里收不回来、又不在段落文字里的东西：逐类数出来（`_dropped`）。"""
    outside = "[not(ancestor::mc:Fallback)]"
    for kind, expr in (
        ("文本框", f".//w:txbxContent{outside}[not(ancestor::w:txbxContent)]"),
        ("原生图表", f".//c:chart{outside}"),
        ("SmartArt 图形", f".//dgm:relIds{outside}"),
        ("嵌入对象", f".//w:object{outside}"),
        ("公式", f".//m:oMath{outside}[not(ancestor::m:oMath)]"),
        ("脚注", ".//w:footnoteReference"),
        ("尾注", ".//w:endnoteReference"),
        ("修订记录", ".//w:ins | .//w:del | .//w:moveFrom | .//w:moveTo"),
        ("超链接", ".//w:hyperlink[@r:id]"),
    ):
        collected.bump(kind, len(_xpath(body, expr)))
    collected.bump("批注", len(set(_xpath(body, ".//w:commentReference/@w:id"))))
    hyperlink_fields = [
        node
        for node in _xpath(body, ".//w:instrText | .//w:fldSimple/@w:instr")
        # `HYPERLINK \l` 是文内跳转，不是外部地址
        if re.match(r"\s*HYPERLINK\s+(?!\\l)", str(getattr(node, "text", node) or ""))
    ]
    collected.bump("超链接", len(hyperlink_fields))


def _text_outside_fields(root) -> str:  # noqa: ANN001
    """页眉页脚里域以外的字：页码域的结果（"1"）不算内容，模板会重新生成页码。"""
    depth = 0
    parts: list[str] = []
    expr = ".//w:fldChar | .//w:t[not(ancestor::w:fldSimple)][not(ancestor::w:del)][not(ancestor::mc:Fallback)]"
    for node in _xpath(root, expr):
        if node.tag == _w("fldChar"):
            kind = node.get(_w("fldCharType"))
            if kind == "begin":
                depth += 1
            elif kind == "end":
                depth = max(0, depth - 1)
        elif depth == 0:
            parts.append(node.text or "")
    return "".join(parts)


def _count_header_footer(document, expected_header: str | None) -> int:  # noqa: ANN001
    """有内容的页眉页脚部件数。模板自己会写的（我们的页眉标题、页码域）不算。"""
    seen: list = []
    count = 0
    body = document.element.body
    for ref in _xpath(body, ".//w:sectPr/w:headerReference | .//w:sectPr/w:footerReference"):
        part = document.part.related_parts.get(ref.get(_ns("r", "id")))
        if part is None or part in seen:
            continue
        seen.append(part)
        root = part.element
        text = _text_outside_fields(root).strip()
        if ref.tag == _w("headerReference") and expected_header is not None and text == expected_header:
            text = ""
        if text or _xpath(root, ".//w:drawing | .//w:pict | .//w:object"):
            count += 1
    return count


def _expected_header(template: str | None, title: str) -> str | None:
    if not template or not (SKILL_ROOT / "templates" / template / "template.json").is_file():
        return None
    text = load_template(SKILL_ROOT, template).get("header_footer", {}).get("header_text") or ""
    return text.replace("{title}", title).strip() or None


def _paragraph_images(  # noqa: ANN001
    p, part, asset_dir: Path, collected: _Collected, counter: list[int]
) -> list[dict]:
    blocks: list[dict] = []
    outside = "[not(ancestor::mc:Fallback)][not(ancestor::w:txbxContent)]"
    for node in _xpath(p, f".//a:blip{outside} | .//v:imagedata{outside}[not(ancestor::w:object)]"):
        rel = node.get(_ns("r", "embed")) or node.get(_ns("r", "id"))
        target = part.related_parts.get(rel) if rel else None
        suffix = Path(str(target.partname)).suffix.lower() if target is not None else ""
        if target is None or suffix not in DOCX_IMAGE_SUFFIXES:
            # 链接的图片（不在文件里）或 EMF / WMF：取不出来、也插不回去
            collected.bump("取不出来的图片")
            continue
        counter[0] += 1
        name = _write_media(asset_dir, f"image-{counter[0]}", suffix, target.blob)
        blocks.append({"block": "image", "path": name})
    return blocks


def _docx_table(tbl, collected: _Collected) -> list[list[str | None]]:  # noqa: ANN001
    """按网格读表。合并单元格的字**只出现一次**（在左上角那格），被合并的位置留空。

    2026-10-22 之前用 python-docx 的 row.cells：横向合并的格子在它跨过的每一列各返回一次，
    纵向合并的在每一行各返回一次 —— 「华东」出现三遍，重新渲染就是三个华东。
    """
    rows: list[list[str | None]] = []
    for tr in _docx_children(tbl, (_w("tr"),)):
        row: list[str | None] = []
        before = _xpath(tr, "./w:trPr/w:gridBefore/@w:val")
        row.extend([None] * (int(before[0]) if before and str(before[0]).isdigit() else 0))
        for tc in _docx_children(tr, (_w("tc"),)):
            spans = _xpath(tc, "./w:tcPr/w:gridSpan/@w:val")
            span = max(1, int(spans[0]) if spans and str(spans[0]).isdigit() else 1)
            continued = False
            started = False
            for merge in _xpath(tc, "./w:tcPr/w:vMerge | ./w:tcPr/w:hMerge"):
                if merge.get(_w("val")) == "restart":
                    started = True
                else:
                    continued = True
            if started or (span > 1 and not continued):
                collected.bump("合并单元格")
            collected.bump("嵌套表格", len(_docx_children(tc, (_w("tbl"),))))
            collected.bump("表格里的图片", len(_xpath(tc, ".//a:blip[not(ancestor::mc:Fallback)]")))
            paragraphs = _docx_children(tc, (_w("p"),))
            text = "\n".join(_docx_text(p) for p in paragraphs).strip()
            row.append(None if continued or not text else text)
            row.extend([None] * (span - 1))
        rows.append(row)
    return [row for row in rows if any(cell for cell in row)]


def extract_docx(path: Path, asset_dir: Path) -> dict:
    """读 docx 的大纲、列表、表格、引用与题注。封面与目录自带的分页不进入正文。

    收不回来的（页眉页脚、文本框、脚注、批注、修订、原生图表……）逐类记进 `_dropped`，
    由 main() 交给 lossy_extraction 决定停下还是继续 —— 不静默丢。
    """
    _fail_missing(path)
    try:
        import docx
    except ModuleNotFoundError:
        fail(EXIT_RUNTIME_MISSING, runtime_missing_message("office", "读取 docx"))

    document = docx.Document(str(path))
    body = document.element.body
    styles = _DocxStyles(document)
    numbering = _DocxNumbering(document, styles)
    collected = _Collected()
    content: dict = {}
    template = read_template_stamp(document.core_properties.category)
    if template:
        content["template"] = template

    items: list = []
    _docx_items(body, collected, items)

    # 标题：「标题」样式的那一段优先 —— 那是读者看到的标题；核心属性常是模板留下的旧值。
    # 都没有才用文件名（2026-10-22 之前直接用文件名，标题段落还被当成了正文）
    core_title = (document.core_properties.title or "").strip()
    title_element = None
    for kind, element in items:
        if kind == "p" and _docx_text(element).strip():
            role = _style_role(styles.chain(element)[1])
            if role and role[0] == "title":
                title_element = element
                break
    if title_element is not None:
        content["title"] = " ".join(_docx_text(title_element).split())
    else:
        content["title"] = core_title or path.stem
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

    _count_docx_extras(body, collected)
    collected.bump(
        "页眉页脚", _count_header_footer(document, _expected_header(template, core_title))
    )

    list_kind: str | None = None
    list_items: list[str] = []
    pending_caption: str | None = None
    fields: list[list[str]] = []
    consumed: set[str] = set()
    image_counter = [0]

    def settle_caption() -> None:
        """没等到表或图的题注只能降成正文 —— 内容 JSON 没有独立的题注块，所以记进清单。"""
        nonlocal pending_caption
        if pending_caption is not None:
            collected.bump("题注")
            collected.push({"block": "paragraph", "text": pending_caption})
            pending_caption = None

    def put(block: dict) -> None:
        """落一个块。前面有一句还没着落的题注时，表或图就收下它；别的块来了，它只能降成正文。"""
        nonlocal pending_caption
        limit = CAPTION_LIMITS.get(block["block"])
        if pending_caption is not None and limit and len(pending_caption) <= limit:
            block["caption"] = pending_caption
            pending_caption = None
        settle_caption()
        collected.push(block)

    def flush_list() -> None:
        nonlocal list_kind, list_items
        if list_kind and list_items:
            put({"block": list_kind, "items": list_items})
        list_kind, list_items = None, []

    for position, (kind, element) in enumerate(items):
        if kind == "toc":
            content["toc"] = True
            continue
        if kind == "tbl":
            flush_list()
            rows = _docx_table(element, collected)
            if len(rows) < 2:
                fail(EXIT_INVALID_CONTENT, "有一张表只有表头、没有数据行。")
            width = max(len(row) for row in rows)
            if width > 10:
                fail(EXIT_INVALID_CONTENT, "有一张表超过 10 列，文档技能的表装不下。")
            if len(rows) > 201:
                fail(EXIT_INVALID_CONTENT, "有一张表超过 200 行。拆开再提取。")
            rows = [row + [None] * (width - len(row)) for row in rows]
            put({"block": "table", "header": collected.table_header(rows[0]), "rows": rows[1:]})
            continue

        p = element
        chain, names = styles.chain(p)
        role = _style_role(names)
        in_field = _scan_fields(p, fields, collected)
        if in_field == "toc" or (role and role[0] in ("toc", "toc-heading")):
            if in_field == "toc" or role[0] == "toc":
                content["toc"] = True
            continue
        if in_field == "tof":
            continue
        text = _docx_text(p).strip()
        if text == TOC_HINT:
            continue
        if text.lower() in TOC_LABELS and any(
            _starts_toc(item, styles) for item in items[position + 1 : position + 3]
        ):
            continue
        images = _paragraph_images(p, document.part, asset_dir, collected, image_counter)
        # 标题上方的徽标不算正文开始：封面那几行仍要认出来
        started = bool(list_items) or any(block["block"] != "image" for block in collected.blocks)
        if p is title_element:
            text = ""
        elif not started and text:
            # 封面：标题、副标题、作者 · 日期各认一次，只在正文开始之前认
            if title_element is None and "title" not in consumed and text == content["title"]:
                consumed.add("title")
                text = ""
            elif role and role[0] == "subtitle" and "subtitle" not in content:
                content["subtitle"] = " ".join(text.split())
                consumed.add("subtitle")
                text = ""
            elif "subtitle" not in consumed and text == content.get("subtitle"):
                consumed.add("subtitle")
                text = ""
            elif meta and "meta" not in consumed and text == meta:
                consumed.add("meta")
                text = ""
        if not text and not images:
            if _xpath(p, './/w:br[@w:type="page"]') and started:
                flush_list()
                put({"block": "pagebreak"})
            continue

        level = _heading_level(p, chain, role) if text else None
        list_here, depth = _list_info(p, chain, role, numbering) if text and not level else (None, 0)
        previous = collected.blocks[-1] if collected.blocks else None
        if level:
            flush_list()
            settle_caption()
            if _list_info(p, chain, None, numbering)[0]:
                # 标题的自动编号（「第一章」「1.2」）不在文字里，重新渲染就没了
                collected.bump("标题自动编号")
            collected.heading(level, text)
        elif (
            text.startswith("——")
            and not list_items
            and pending_caption is None
            and previous is not None
            and previous["block"] == "quote"
            and "cite" not in previous
            and len(text.lstrip("—").strip()) <= 120
        ):
            previous["cite"] = text.lstrip("—").strip()  # 渲染器把出处写成引用下面的「—— 出处」
        elif role and role[0] == "quote":
            flush_list()
            put({"block": "quote", "text": text})
        elif role and role[0] == "caption":
            flush_list()
            previous = collected.blocks[-1] if collected.blocks else None
            limit = CAPTION_LIMITS.get(previous["block"]) if previous else None
            if pending_caption is None and limit and "caption" not in previous and len(text) <= limit:
                previous["caption"] = text  # 题注在表 / 图下面
            else:
                settle_caption()
                pending_caption = text  # 题注在表 / 图上面：等下一个块
        elif list_here:
            if depth > 0:
                # 内容 JSON 的列表只有一层：子项并进当前列表，层级记进清单
                collected.bump("嵌套列表层级")
            if list_kind is None or (depth == 0 and list_here != list_kind):
                flush_list()
                list_kind = list_here
            list_items.append(text)
        elif text:
            flush_list()
            put({"block": "paragraph", "text": text})
        for image in images:
            flush_list()
            put(image)

    flush_list()
    settle_caption()
    if any(_field_kind(entry[0]) == "toc" for entry in fields):
        # 目录域没有结束标记：它之后的每一段都被当成了目录条目。宁可停下，也不静默丢正文
        fail(
            EXIT_INVALID_CONTENT,
            "目录域没有结束标记（文件可能损坏），分不清目录之后的正文。在 Word 里另存一次再提取。",
        )
    if not collected.blocks:
        fail(EXIT_INVALID_CONTENT, "这份文档除了标题没有可提取的正文。")
    content["blocks"] = collected.blocks
    content["_dropped"] = collected.dropped
    return content


# 一次性的 LibreOffice 配置：关宏与活动内容（与 services/ingest/src/office-preview.ts 相同），
# 另外**加载时不更新外部链接**（Writer 与 Calc 都是 2 = 从不）。没有这一条，一份下载来的 docx
# 可以靠链接图片 / INCLUDETEXT 一类字段，在转换时读本机文件、甚至联网，再把结果画进 PDF。
MACRO_LOCK = (
    '<?xml version="1.0"?>'
    '<oor:items xmlns:oor="http://openoffice.org/2001/registry">'
    '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
    '<prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>'
    '<prop oor:name="DisableActiveContent" oor:op="fuse"><value>true</value></prop>'
    '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>'
    '<prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>'
    "</item>"
    '<item oor:path="/org.openoffice.Office.Writer/Content/Update">'
    '<prop oor:name="Link" oor:op="fuse"><value>2</value></prop>'
    "</item>"
    '<item oor:path="/org.openoffice.Office.Calc/Content/Update">'
    '<prop oor:name="Link" oor:op="fuse"><value>2</value></prop>'
    "</item></oor:items>"
)

SANDBOX_EXEC = Path("/usr/bin/sandbox-exec")
CONVERT_TIMEOUT_S = 45
PDF_LIMIT_BYTES = 25_000_000


def office_converter() -> Path | None:
    """本机 soffice。`EVOWORK_OFFICE_CONVERTER` 与预览共用；找的顺序也与预览相同（先 App，再 PATH）。

    设了覆盖就不再回退：坏路径若被静默换成另一份程序，测试就钉不住失败。
    """
    override = os.environ.get("EVOWORK_OFFICE_CONVERTER")
    if override is not None:
        path = Path(override)
        return path if path.is_file() else None
    for candidate in (
        Path("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
        Path("/Applications/LibreOfficeDev.app/Contents/MacOS/soffice"),
    ):
        if candidate.is_file():
            return candidate
    found = shutil.which("soffice")
    return Path(found) if found else None


def _sandbox_profile(read_roots: list[Path], write_dir: Path) -> str:
    """与 `services/ingest/src/isolated-process.ts` 的 parserSandboxProfile 同一份规则：
    默认全拒、只读系统目录与转换器自身、只写这次的临时目录、**禁一切网络**。
    多读一个 `/bin`：转换器是脚本时要用到 `/bin/sh`（测试用的假转换器就是）。"""
    quoted = lambda path: json.dumps(str(Path(os.path.realpath(path))))  # noqa: E731
    roots = " ".join(f"(subpath {quoted(path)})" for path in read_roots)
    return "\n".join(
        [
            "(version 1)",
            "(deny default)",
            "(allow process-fork)",
            "(allow process-exec)",
            "(allow sysctl-read)",
            "(allow mach-lookup)",
            "(allow file-read-metadata)",
            '(allow file-read-data (literal "/"))',
            '(allow file-read* (subpath "/System") (subpath "/usr") (subpath "/bin") '
            '(subpath "/Library/Apple") (subpath "/Library/Fonts") (literal "/dev/null") '
            f"{roots} (subpath {quoted(write_dir)}))",
            f'(allow file-write* (literal "/dev/null") (subpath {quoted(write_dir)}))',
            "(deny network*)",
        ]
    )


def _run_group(command: list[str], work: Path) -> subprocess.CompletedProcess:
    """独立进程组 + 最小环境（不带账号、模型密钥与真实 HOME）；超时整组杀掉，而不是只杀直接子进程。"""
    env = {"PATH": "/usr/bin:/bin", "HOME": str(work), "TMPDIR": str(work), "LANG": "en_US.UTF-8"}
    process = subprocess.Popen(
        command,
        cwd=str(work),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
    )
    try:
        out, err = process.communicate(timeout=CONVERT_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.communicate()
        fail(EXIT_CONVERSION_FAILED, "LibreOffice 转换 PDF 超时。文档可能太大或已损坏；可以改交付 .docx / .md。")
    return subprocess.CompletedProcess(command, process.returncode, out[-65536:], err[-65536:])


def _convert_isolated(command: list[str], read_roots: list[Path], work: Path) -> subprocess.CompletedProcess:
    """
    macOS：套一层与预览转换器相同的 seatbelt 沙箱（禁网、只写临时目录）。
    **已经在内核的沙箱里时套不上**（`sandbox_apply: Operation not permitted`，默认「请求批准」档就是这样）：
    那一层已经禁网、限写，就在它里面直接跑 —— 只在那种情况下才不套，判据是 sandbox-exec 自己的报错。
    其他平台还没有隔离手段：直接拒绝（与 services/ingest 的 fail closed 一致），不裸跑。
    """
    if sys.platform != "darwin":
        fail(EXIT_RUNTIME_MISSING, "这个平台上还没有隔离的文档转换器，暂不支持导出 PDF。请改交付 .docx / .md。")
    if not SANDBOX_EXEC.is_file():
        fail(EXIT_RUNTIME_MISSING, "找不到系统的 sandbox-exec，不能安全地转换。请改交付 .docx / .md。")
    wrapped = [str(SANDBOX_EXEC), "-p", _sandbox_profile(read_roots, work), *command]
    result = _run_group(wrapped, work)
    if result.returncode == 71 and b"sandbox_apply" in result.stderr:
        result = _run_group(command, work)
    return result


def convert_docx_to_pdf(docx_path: Path, pdf_path: Path) -> None:
    converter = office_converter()
    if converter is None:
        fail(
            EXIT_RUNTIME_MISSING,
            "需要本机 LibreOffice（soffice）才能把文档导出成 PDF。安装后重试，或改交付 .docx / .md。",
        )
    work = Path(os.path.realpath(tempfile.mkdtemp(prefix="evowork-pdf-")))
    try:
        profile = work / "profile"
        (profile / "user").mkdir(parents=True)
        (profile / "user" / "registrymodifications.xcu").write_text(MACRO_LOCK, encoding="utf-8")
        staged = work / "document.docx"
        shutil.copyfile(docx_path, staged)
        executable = Path(os.path.realpath(converter))
        app = str(executable).find(".app/Contents/")
        read_root = Path(str(executable)[: app + 4]) if app >= 0 else executable.parent
        completed = _convert_isolated(
            [
                str(executable),
                "-env:UserInstallation=" + profile.as_uri(),
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
            [read_root],
            work,
        )
        produced = work / "document.pdf"
        if completed.returncode != 0 or not produced.is_file() or produced.is_symlink():
            fail(
                EXIT_CONVERSION_FAILED,
                "LibreOffice 没有写出 PDF（文档可能损坏，或用了转换器不支持的内容）。可以改交付 .docx / .md。",
            )
        if produced.stat().st_size > PDF_LIMIT_BYTES:
            fail(EXIT_CONVERSION_FAILED, "转换出来的 PDF 超过 25MB，没有写出。可以改交付 .docx。")
        data = produced.read_bytes()
        if not data.startswith(b"%PDF-"):
            fail(EXIT_CONVERSION_FAILED, "转换结果不是 PDF。可以改交付 .docx / .md。")
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
    parser.add_argument("--overwrite", action="store_true", help="目标已存在时允许写回（默认拒绝）")
    parser.add_argument("--allow-lossy", action="store_true", help="提取有收不回的内容时仍写出（默认拒绝）")
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
        lossy = lossy_extraction(content.pop("_dropped", {}), args.allow_lossy)
        validate(content, out_path.parent)
        write_extracted(content, out_path)
        succeeded(
            out_path, blocks=len(content["blocks"]), format="json", operation="extract", **lossy
        )
        return

    content_path = Path(args.content).resolve()
    content = read_content(content_path)
    validate(content, content_path.parent)

    if args.validate_only:
        succeeded(blocks=len(content["blocks"]), validated=True)
        return

    refuse_overwrite(out_path, args.overwrite)
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
        from layout_check import for_output  # noqa: E402 -- 与 evowork_skill 同一个 sys.path

        with tempfile.TemporaryDirectory(prefix="evowork-pdf-src-") as tmp:
            docx_path = Path(tmp) / "document.docx"
            render_docx(content, docx_path, content_path.parent)
            # PDF 是从这份 docx 转出来的：版式问题在这里查，转成 PDF 之后就查不了了
            layout = for_output(docx_path)
            convert_docx_to_pdf(docx_path, out_path)
        succeeded(out_path, blocks=len(content["blocks"]), format="pdf", **layout)
        return
    if suffix != ".docx":
        fail(EXIT_INVALID_CONTENT, f"输出格式只支持 .docx、.md 与 .pdf，收到 {suffix or '(无扩展名)'}。")

    render_docx(content, out_path, content_path.parent)
    # 出图后顺手查一遍缺字 / 表格与图片超出版心 / 标题跳级（_shared/layout_check.py）
    from layout_check import for_output  # noqa: E402 -- 与 evowork_skill 同一个 sys.path

    succeeded(out_path, blocks=len(content["blocks"]), format="docx", **for_output(out_path))


if __name__ == "__main__":
    main()
