#!/usr/bin/env python3
"""统计 codex-rs 中指定 crate 的 codex-* 依赖闭包。

用途见 docs/design/08-codex-integration.md。
闭包变大是「借错层」的早期信号——每次升级上游 rev 后重跑，与基线比对。

用法:
    python3 scripts/codex-closure.py <codex-rs 路径> <crate 名> [crate 名 ...]
"""
import os
import re
import sys
from collections import deque


def index_packages(root):
    """package name -> 目录"""
    name2dir = {}
    for dirpath, _dirnames, filenames in os.walk(root):
        if "Cargo.toml" not in filenames:
            continue
        text = _read(os.path.join(dirpath, "Cargo.toml"))
        if "[package]" not in text:
            continue
        m = re.search(r'^\s*name\s*=\s*"([^"]+)"', text, re.M)
        if m:
            name2dir.setdefault(m.group(1), dirpath)
    return name2dir


def _read(path):
    with open(path, encoding="utf-8", errors="ignore") as fh:
        return fh.read()


def direct_deps(name2dir, pkg):
    """pkg 的直接 codex-* 依赖，跳过 dev-dependencies"""
    d = name2dir.get(pkg)
    if not d:
        return []
    out, section = [], None
    for line in _read(os.path.join(d, "Cargo.toml")).splitlines():
        s = line.strip()
        if s.startswith("["):
            section = s
            continue
        if not section or "dependencies" not in section or "dev-dependencies" in section:
            continue
        # [dependencies.codex-protocol] 这种写法
        m = re.match(r"^\[.*dependencies\.([A-Za-z0-9_-]+)\]$", section)
        if m and m.group(1).startswith("codex"):
            out.append(m.group(1))
        m = re.match(r"^([A-Za-z0-9_-]+)\s*=", s)
        if m and m.group(1).startswith("codex"):
            out.append(m.group(1))
    return sorted(set(out))


def closure(name2dir, pkg):
    seen, q = set(), deque([pkg])
    while q:
        for dep in direct_deps(name2dir, q.popleft()):
            if dep not in seen:
                seen.add(dep)
                q.append(dep)
    return seen


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    root, targets = sys.argv[1], sys.argv[2:]
    name2dir = index_packages(root)
    failed = False
    for t in targets:
        if t not in name2dir:
            print(f"{t}: NOT FOUND in {root}")
            failed = True
            continue
        c = closure(name2dir, t)
        core = "YES" if "codex-core" in c else "no"
        otel = "YES" if "codex-otel" in c else "no"
        print(f"{t:26s} closure={len(c):2d}  core={core:3s} otel={otel:3s}")
        print(f"    {', '.join(sorted(c)) or '(none)'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
