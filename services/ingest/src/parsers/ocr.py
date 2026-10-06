#!/usr/bin/env python3
"""Bounded local PDF/image OCR. The host supplies an OS sandbox; stdout has only progress."""
from __future__ import annotations
import argparse
import csv
import hashlib
import io
import json
import math
import os
from pathlib import Path
import resource
import subprocess
import time

VERSION = '1'
MAX_CHARS = 2_000_000
MAX_PIXELS = 16_000_000


def atomic_json(path, value):
    temp = path.with_suffix('.pending')
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding='utf8')
    os.replace(temp, path)


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def classify(text, image_area, page_area, objects):
    usable = ''.join(c for c in text if not c.isspace())
    if not usable and objects == 0:
        return 'blank'
    bad = sum(c == '\ufffd' or (ord(c) < 32 and c not in '\n\r\t') for c in text)
    if usable and bad / max(1, len(text)) > 0.1:
        return 'suspectText'
    if len(usable) >= 32 and image_area / max(1, page_area) < 0.6:
        return 'textLayer'
    return 'ocrCandidate'


def recognize(image, runtime, temporary, rotation, page_deadline):
    from PIL import Image
    width, height = image.size
    if width <= 0 or height <= 0 or width * height > MAX_PIXELS:
        raise ValueError('PIXEL_LIMIT')
    angle = rotation
    if angle is None:
        probe = temporary / 'direction.pgm'
        image.convert('L').save(probe, format='PPM')
        try:
            detected = subprocess.run([str(runtime / 'bin/tesseract'), str(probe), 'stdout',
                '--tessdata-dir', str(runtime / 'tessdata'), '-l', 'osd', '--psm', '0'],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=max(.1, min(8, page_deadline - time.monotonic())), check=False)
            for line in detected.stdout.decode('utf8', errors='replace').splitlines():
                if line.startswith('Rotate:'):
                    angle = int(line.split(':')[1].strip())
        except subprocess.TimeoutExpired:
            pass
        finally:
            probe.unlink(missing_ok=True)
    direction_failed = angle is None
    angle = angle or 0
    if angle:
        image = image.rotate(-angle, expand=True)
    source = temporary / 'page.pgm'
    target = temporary / 'page'
    image.convert('L').save(source, format='PPM')
    try:
        # No shell, no model/network, no inherited service credentials (host's environment whitelist).
        subprocess.run([str(runtime / 'bin/tesseract'), str(source), str(target),
            '--tessdata-dir', str(runtime / 'tessdata'), '-l', 'chi_sim+eng',
            '--dpi', '300', '--psm', '3', '-c', 'tessedit_create_tsv=1'],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=max(.1, min(30, page_deadline - time.monotonic())), check=True)
        tsv = target.with_suffix('.tsv')
        if tsv.stat().st_size > 16 * 1024 * 1024:
            raise ValueError('OUTPUT_LIMIT')
        lines = {}
        scores = []
        words = []
        for row in csv.DictReader(io.StringIO(tsv.read_text(encoding='utf8')), delimiter='\t'):
            word = row.get('text', '').strip()
            score = float(row['conf'])
            if not word or score < 0:
                continue
            key = (row['block_num'], row['par_num'], row['line_num'])
            lines.setdefault(key, []).append(word)
            scores.append(score)
            # Inverse rotation maps word bounds to the original page, not the rotated OCR bitmap.
            x, y = int(row['left']) / image.width, int(row['top']) / image.height
            w, h = int(row['width']) / image.width, int(row['height']) / image.height
            box = [x, y, w, h]
            if angle == 90:
                box = [y, 1 - x - w, h, w]
            elif angle == 180:
                box = [1 - x - w, 1 - y - h, w, h]
            elif angle == 270:
                box = [1 - y - h, x, h, w]
            words.append({'text': word, 'confidence': score, 'box': box})
        text = '\n'.join(' '.join(words) for words in lines.values())
        score = sum(scores) / len(scores) if scores else 0
        return text, score, words, angle, direction_failed
    finally:
        for path in temporary.iterdir():
            if path.is_file():
                path.unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--out-dir', required=True)
    parser.add_argument('--key', required=True)
    parser.add_argument('--rotation', type=int, choices=[0, 90, 180, 270])
    parser.add_argument('--start-page', type=int, default=1)
    parser.add_argument('--page-count', type=int, default=100)
    args = parser.parse_args()
    # Per-process CPU/output/descriptor bounds, inherited by children. macOS RLIMIT_AS is
    # not a reliable resident-memory bound, so it is not advertised as one.
    resource.setrlimit(resource.RLIMIT_CPU, (120, 120))
    resource.setrlimit(resource.RLIMIT_FSIZE, (32 * 1024 * 1024, 32 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    from PIL import Image
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    source, runtime, output = Path(args.input), Path(args.runtime), Path(args.out_dir)
    source_hash = digest(source)
    if source.stat().st_size > (200 * 1024 * 1024 if source.suffix.lower() == '.pdf' else 20 * 1024 * 1024):
        raise ValueError('FILE_LIMIT')
    temporary = output / 'temporary'
    temporary.mkdir(exist_ok=True)
    manifest = output / 'pages.json'
    try:
        previous = json.loads(manifest.read_text(encoding='utf8')) if manifest.exists() and manifest.stat().st_size <= 32 * 1024 * 1024 else {}
    except (ValueError, OSError):
        previous = {}
    pages = previous.get('pages', []) if previous.get('key') == args.key and previous.get('sourceHash') == source_hash else []
    records = {}
    if isinstance(pages, list):
        for p in pages:
            if isinstance(p, dict) and isinstance(p.get('page'), int) and p['page'] > 0 and p.get('state') in ['complete','blank','failed'] and p.get('source') in ['ocr','textLayer','blank'] and isinstance(p.get('text'), str) and len(p['text']) <= MAX_CHARS:
                payload = {k:v for k,v in p.items() if k != 'checksum'}
                expected = hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode('utf8')).hexdigest()
                if p.get('checksum') == expected:
                    records[p['page']] = p
    if sum(len(p['text']) for p in records.values()) > MAX_CHARS:
        records = {}
    deadline = time.monotonic() + 120
    document = None
    image = None
    if source.suffix.lower() == '.pdf':
        import pypdfium2 as pdfium
        document = pdfium.PdfDocument(str(source))
        if pdfium.raw.FPDF_GetSecurityHandlerRevision(document) != -1:
            raise ValueError('ENCRYPTED')
        total = len(document)
    else:
        if source.suffix.lower() not in ['.png', '.jpg', '.jpeg', '.webp']:
            raise ValueError('UNSUPPORTED')
        image = Image.open(source)
        if getattr(image, 'n_frames', 1) != 1:
            raise ValueError('ANIMATED_IMAGE')
        if image.width * image.height > MAX_PIXELS:
            raise ValueError('PIXEL_LIMIT')
        total = 1
    chars = sum(len(p.get('text', '')) for p in records.values())
    end = min(total, args.start_page - 1 + min(args.page_count, 100))
    for number in range(max(0, args.start_page - 1), end):
        if time.monotonic() >= deadline or chars >= MAX_CHARS:
            break
        if records.get(number + 1, {}).get('state') in ['complete', 'blank']:
            continue
        row = {'page': number + 1, 'state': 'failed', 'text': '', 'source': 'ocr'}
        page = None
        page_deadline = time.monotonic() + 30
        try:
            text = ''
            if document is not None:
                page = document[number]
                width, height = page.get_size()
                if not math.isfinite(width * height) or width <= 0 or height <= 0:
                    raise ValueError('INVALID_PAGE')
                text_page = page.get_textpage()
                try:
                    text = text_page.get_text_range()
                finally:
                    text_page.close()
                objects = list(page.get_objects())
                image_area = sum(max(0, (b[2] - b[0]) * (b[3] - b[1]))
                    for obj in objects if obj.type == 3 for b in [obj.get_bounds()])
                kind = classify(text, image_area, width * height, len(objects))
                row['classification'] = kind
                row['size'] = [width, height]
                if kind == 'blank':
                    row.update(state='blank', source='blank')
                elif kind == 'textLayer':
                    row.update(state='complete', text=text, source='textLayer')
                else:
                    scale = min(300 / 72, math.sqrt((MAX_PIXELS - 100_000) / (width * height)))
                    row['dpi'] = scale * 72
                    if text.strip():
                        row['textLayerText'] = text
                    bitmap = page.render(scale=scale)
                    try:
                        rendered = bitmap.to_pil().copy()
                    finally:
                        bitmap.close()
                    recognized, score, words, angle, direction_failed = recognize(rendered, runtime, temporary, args.rotation, page_deadline)
                    rendered.close()
                    if not recognized.strip():
                        raise ValueError('OCR_NO_TEXT')
                    if text.strip():
                        original_lines = [line.strip() for line in text.splitlines() if line.strip()]
                        recognized_lines = [line.strip() for line in recognized.splitlines() if line.strip()]
                        recognized = '\n'.join(dict.fromkeys(original_lines + recognized_lines))
                    row.update(state='complete', text=recognized, confidence=score, words=words,
                        rotation=angle, directionFailed=direction_failed, needsReview=score < 70 or not recognized or direction_failed or scale < 300 / 72 or bool(text.strip()))
            else:
                recognized, score, words, angle, direction_failed = recognize(image, runtime, temporary, args.rotation, page_deadline)
                if not recognized.strip():
                    raise ValueError('OCR_NO_TEXT')
                row.update(state='complete', classification='ocrCandidate', text=recognized, confidence=score,
                    words=words, rotation=angle, size=list(image.size), directionFailed=direction_failed, needsReview=score < 70 or not recognized or direction_failed)
            allowance = max(0, MAX_CHARS - chars)
            if len(row['text']) > allowance:
                row['text'] = row['text'][:allowance]
                row['truncated'] = True
            chars += len(row['text'])
        except Exception as error:
            row['error'] = 'PAGE_TIMEOUT' if isinstance(error, subprocess.TimeoutExpired) else 'PAGE_FAILED'
        finally:
            if page is not None:
                page.close()
        row['checksum'] = hashlib.sha256(json.dumps(row, ensure_ascii=False, sort_keys=True).encode('utf8')).hexdigest()
        records[number + 1] = row
        atomic_json(manifest, {'key': args.key, 'sourceHash': source_hash, 'total': total,
            'parserVersion': VERSION, 'pages': sorted(records.values(), key=lambda p: p['page'])})
        print(json.dumps({'page': number + 1, 'total': total, 'state': row['state'], 'completed': sum(p['state'] in ['complete', 'blank'] for p in records.values()), 'failed': sum(p['state'] == 'failed' for p in records.values())}), flush=True)
    if image is not None:
        image.close()
    if document is not None:
        document.close()
    if digest(source) != source_hash:
        raise ValueError('SOURCE_CHANGED')
    atomic_json(output / 'manifest.json', {'key': args.key, 'sourceHash': source_hash, 'total': total,
        'parserVersion': VERSION, 'complete': len(records) == total and all(p['state'] in ['complete','blank'] and not p.get('truncated') for p in records.values())})

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never log document/engine stderr, paths or account credentials.
        raise SystemExit(2)
