#!/usr/bin/env python3
"""Deterministic synthetic O0 corpus. Truth is generated before running any recognizer."""
import argparse
import hashlib
import json
import time
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

p = argparse.ArgumentParser()
p.add_argument('--output', required=True)
p.add_argument('--font', required=True)
a = p.parse_args()
root = Path(a.output)
root.mkdir(parents=True, exist_ok=True)
font = ImageFont.truetype(a.font, 40)
images = []
truth = []
for page in range(1, 31):
    lines = [f'EvoWork local OCR page {page}', f'合同编号 2026-{1000 + page}',
        f'付款金额 {12300 + page}.67 元', f'Invoice amount {12300 + page}.67 CNY',
        '简体中文和英文印刷体识别', '本机处理资料并保留原文件'] * 3
    image = Image.new('RGB', (1200, 1600), 'white')
    draw = ImageDraw.Draw(image)
    for index, line in enumerate(lines):
        draw.text((80, 50 + index * 78), line, font=font, fill='black')
    images.append(image)
    truth.append({'page': page, 'text': '\n'.join(lines), 'amount': f'{12300 + page}.67', 'number': f'2026-{1000 + page}'})
images[0].save(root / 'clear-print.pdf', 'PDF', save_all=True, append_images=images[1:], resolution=150, creationDate=time.gmtime(0), modDate=time.gmtime(0))
images[0].save(root / 'clear-print.png')
images[0].rotate(90, expand=True).save(root / 'rotated.png')
for image in images:
    image.close()
source = root / 'clear-print.pdf'
(root / 'truth.json').write_text(json.dumps({'corpus': 'synthetic-clear-print-v1',
    'fontSha256': hashlib.sha256(Path(a.font).read_bytes()).hexdigest(),
    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'pages': truth}, ensure_ascii=False, indent=2), encoding='utf8')
# A native text page and truly blank page, independent of OCR and generated page headings.
objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>',
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    b'<< /Length 98 >>\nstream\nBT /F1 16 Tf 50 700 Td (Native text stays native. Invoice amount 12345.67 CNY. Page one.) Tj ET\nendstream',
    b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 7 0 R >>',
    b'<< /Length 0 >>\nstream\n\nendstream']
# Ensure the stream length reflects the actual content.
content = b'BT /F1 16 Tf 50 700 Td (Native text stays native. Invoice amount 12345.67 CNY. Page one.) Tj ET\n'
objects[3] = f'<< /Length {len(content)} >>\nstream\n'.encode() + content + b'endstream'
pdf = bytearray(b'%PDF-1.4\n'); offsets = [0]
for index, obj in enumerate(objects, 1):
    offsets.append(len(pdf)); pdf += f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n'
xref = len(pdf); pdf += f'xref\n0 {len(offsets)}\n0000000000 65535 f \n'.encode()
for offset in offsets[1:]: pdf += f'{offset:010d} 00000 n \n'.encode()
pdf += f'trailer\n<< /Size {len(offsets)} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()
(root / 'native-and-blank.pdf').write_bytes(pdf)
