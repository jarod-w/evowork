"""layout_check 的测试样本：每个文件里放一个已知的问题，外加一个不该被报的对照。

缺字用 matplotlib 自带的 DejaVu Sans（任何装了办公扩展的机器上都有、且确定没有中文字形），
不用 macOS 才有的 Hiragino —— 测试要在哪台机器上结论都一样。
用法：python3 make_layout_samples.py <输出目录>
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from evowork_skill import ensure_office_runtime  # noqa: E402

ensure_office_runtime(("pptx", "docx"))

from docx import Document  # noqa: E402
from docx.shared import Cm  # noqa: E402
from pptx import Presentation  # noqa: E402
from pptx.util import Inches, Pt  # noqa: E402

#: 测试断言输出里**没有**这几段字（输出纪律：不带用户内容）
SECRET = "客户张三的合同金额八百万元"


def pptx(path: Path) -> None:
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(13.333), Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    full = slide.shapes.add_textbox(Inches(1), Inches(1), Inches(3), Inches(0.6))
    full.name = "overfull"
    full.text_frame.word_wrap = True
    full.text_frame.text = SECRET * 6
    full.text_frame.paragraphs[0].font.size = Pt(18)

    roomy = slide.shapes.add_textbox(Inches(1), Inches(2), Inches(8), Inches(1.2))
    roomy.name = "roomy"
    roomy.text_frame.text = "季度汇报"

    glyph = slide.shapes.add_textbox(Inches(1), Inches(4), Inches(8), Inches(1))
    glyph.name = "glyph"
    glyph.text_frame.text = "Revenue 收入"
    glyph.text_frame.paragraphs[0].font.name = "DejaVu Sans"

    off = slide.shapes.add_textbox(Inches(12.5), Inches(6.8), Inches(3), Inches(1))
    off.name = "off"
    off.text_frame.text = "x"
    prs.save(str(path))


def docx(path: Path) -> None:
    doc = Document()  # python-docx 的默认纸张就是 Letter
    doc.add_heading("一、背景", 1)
    doc.add_heading("细节", 3)
    doc.add_paragraph(SECRET)
    table = doc.add_table(rows=1, cols=3)
    for column in table.columns:
        column.width = Cm(8)
    doc.save(str(path))


if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    pptx(out / "sample.pptx")
    docx(out / "sample.docx")
