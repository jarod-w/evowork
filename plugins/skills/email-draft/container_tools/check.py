#!/usr/bin/env python3
"""邮件草稿 JSON → 可复制的 Markdown。不发送。"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT.parent / "_shared"))

from evowork_skill import EXIT_INVALID_CONTENT, fail, read_content, succeeded  # noqa: E402

REFUSED = {"send", "smtp", "deliver", "password", "token"}


def require_text(value: object, where: str) -> str:
    if not isinstance(value, str) or not value.strip():
        fail(EXIT_INVALID_CONTENT, f"{where} 不能为空。")
    return value.strip()


def recipients(value: object, where: str, *, required: bool) -> list[str]:
    if value is None and not required:
        return []
    if not isinstance(value, list) or (required and not value):
        fail(EXIT_INVALID_CONTENT, f"{where} 必须是非空数组。")
    return [require_text(item, f"{where}/{index}") for index, item in enumerate(value)]


def main() -> None:
    parser = argparse.ArgumentParser(description="检查邮件草稿并写成 Markdown")
    parser.add_argument("--content", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    raw = read_content(Path(args.content).resolve())
    refused = sorted(set(raw) & REFUSED)
    if refused:
        fail(EXIT_INVALID_CONTENT, "邮件草稿不能包含发送或凭据字段。把草稿交给用户自己发。")
    extra = set(raw) - {"to", "cc", "subject", "body", "ask"}
    if extra:
        fail(EXIT_INVALID_CONTENT, "邮件草稿有未声明的字段。只写 to、cc、subject、body、ask。")
    to = recipients(raw.get("to"), "to", required=True)
    cc = recipients(raw.get("cc"), "cc", required=False)
    subject = require_text(raw.get("subject"), "subject")
    body = require_text(raw.get("body"), "body")
    ask = require_text(raw.get("ask"), "ask")
    lines = ["收件人：" + "、".join(to)]
    if cc:
        lines.append("抄送：" + "、".join(cc))
    lines += ["主题：" + subject, "", body, "", "要对方做的事：" + ask, ""]
    out_path = Path(args.out).resolve()
    if out_path.suffix.lower() not in {".md", ".txt"}:
        fail(EXIT_INVALID_CONTENT, "邮件草稿只写成 .md 或 .txt。")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines), encoding="utf-8")
    succeeded(out_path, format="markdown")


if __name__ == "__main__":
    main()
