"""四个办公技能共用的骨架（08 §5.1 的"统一约定"）。

## 为什么抽出来

`documents` / `spreadsheets` / `presentations` / `charts` 各有各的渲染逻辑，
但**失败的方式完全一样**：内容 JSON 不合法、办公扩展没装、引用的文件不存在。
这三件事的退出码、消息措辞、以及"报错里不许出现用户内容"这条纪律必须四个技能一致 ——
抄四份的结果一定是四份慢慢分叉，而分叉的表现是用户在不同技能里看到不同说法。

CLAUDE.md §3 对 `packages/` 的判据是"被两层以上使用、复制会造成语义分裂"。
这里是同一层里被四处使用，所以它落在 `plugins/skills/_shared/` 而不是 `packages/`。

## 退出码（四个技能一致）

    0   成功
    2   内容 JSON 不合法 → 把 stderr 的具体错误回给模型让它修**一次**（08 §5.3）
    3   运行时缺失 → 提示安装对应扩展（08 §4），不要改用别的方式硬造文件
    4   引用的文件不存在 → 让模型先生成它

## 一条贯穿的纪律：报错里不许出现用户内容

`jsonschema` 的默认消息会把**违规的实例本身**嵌进去
（`{'title': '某公司欠款分析', ...} is not valid under ...`）。那句话会经 stderr
进到内核的命令输出、进 rollout、可能进日志 —— 与 Q14「不落盘正文」同一口径的问题。
所以消息只用三样东西造：路径（索引与字段名）、校验器名、**schema 侧**的期望值。
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path
from typing import Any, Iterable

EXIT_OK = 0
EXIT_INVALID_CONTENT = 2
EXIT_RUNTIME_MISSING = 3
EXIT_MISSING_ASSET = 4

#: 08 §4 的三档运行时。文案必须与 `services/ingest` 一致 ——
#: 一处说"解析组件"、一处说"生成组件"会让用户以为要装两个东西（08 §4 原话）。
RUNTIME_TIERS = {
    "base": {"label": "基础组件", "size": "0MB", "note": "随主程序，无需下载"},
    "office": {"label": "办公扩展", "size": "约 120MB", "note": "Word / Excel / PPT / PDF 文本层"},
    "ocr": {"label": "OCR 扩展", "size": "约 60MB", "note": "扫描件识别"},
}


def runtime_missing_message(tier: str, what: str) -> str:
    """三档运行时缺失时的统一文案（08 §4）。"""
    spec = RUNTIME_TIERS[tier]
    return f"需要安装本地{spec['label']}（{spec['size']}）才能{what}。安装后重试即可。"


#: 办公扩展的安装位置（08 §4：按需下载，装在自己的目录里而不是污染系统 python）。
#: 可用 EVOWORK_OFFICE_PYTHON 覆盖 —— 企业离线部署会把它装在别处。
OFFICE_VENV = Path.home() / ".evowork" / "runtime" / "office"


def office_python() -> Path | None:
    """办公扩展的解释器路径；没装就返回 None。"""
    override = os.environ.get("EVOWORK_OFFICE_PYTHON")
    if override:
        path = Path(override)
        return path if path.exists() else None
    for candidate in (OFFICE_VENV / "bin" / "python", OFFICE_VENV / "Scripts" / "python.exe"):
        if candidate.exists():
            return candidate
    return None


def ensure_office_runtime(modules: Iterable[str]) -> None:
    """需要办公扩展的模块不在当前解释器里时，**换到办公扩展的解释器重跑一次**。

    ## 为什么是 re-exec 而不是让 SKILL.md 写死解释器路径

    SKILL.md 是给模型看的，里面写 `python3 container_tools/render.py`。
    要求它改成一个带绝对路径的解释器，等于把"扩展装在哪"这件事泄漏进提示词 ——
    而那个路径在企业离线部署里是另一个值。

    所以判断留在这里：缺模块 + 扩展装了 → 用扩展的解释器重跑；扩展没装 → 照常报 3 号退出码。
    环境变量做防重入，避免换了解释器还缺模块时无限套娃。
    """
    missing = [name for name in modules if importlib.util.find_spec(name) is None]
    if not missing:
        return
    if os.environ.get("EVOWORK_SKILL_REEXEC") == "1":
        return  # 已经换过一次了，还缺就让调用方按 3 号码处理
    interpreter = office_python()
    if interpreter is None:
        return
    os.execve(
        str(interpreter),
        [str(interpreter), *sys.argv],
        {**os.environ, "EVOWORK_SKILL_REEXEC": "1"},
    )


def fail(code: int, message: str, detail: str | None = None) -> None:
    """机器可读的失败输出。

    artifacts 服务按 `code` 决定给用户看什么话，所以结构比自由文本重要。
    **不打印内容 JSON 本身**。
    """
    payload: dict[str, Any] = {"ok": False, "code": code, "message": message}
    if detail:
        payload["detail"] = detail
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
    sys.exit(code)


VALIDATOR_COPY = {
    "required": "缺少必填字段 {value}",
    "additionalProperties": "有多余字段（schema 不允许额外字段，免得你以为加的字段生效了）",
    "maxItems": "条目太多，最多 {value} 条 —— 超过就该拆开",
    "minItems": "至少要有 {value} 条",
    "maxLength": "太长了，最多 {value} 个字",
    "minLength": "不能为空",
    "maximum": "不能大于 {value}",
    "minimum": "不能小于 {value}",
    "enum": "取值必须是 {value} 之一",
    "const": "取值必须是 {value}",
    "type": "类型应为 {value}",
    "pattern": "格式不对，要匹配 {value}",
    "oneOf": "不符合任何一种已声明的形状",
}


def describe_error(err: Any) -> str:
    """把校验错误变成**不含用户内容**的一句话。见模块头注释。"""
    where = "/".join(str(p) for p in err.path) or "(根)"
    template = VALIDATOR_COPY.get(err.validator)
    if template is None:
        return f"{where}: 不满足 {err.validator} 约束"
    value = err.validator_value
    rendered = " / ".join(str(v) for v in value) if isinstance(value, (list, tuple)) else str(value)
    return f"{where}: {template.format(value=rendered)}"


def intended_branch_errors(err: Any, limit: int = 6) -> list[str]:
    """从 oneOf 的一堆子错误里挑出**用户真正想用的那个分支**的错误。

    做法：`err.context` 里每条子错误的 `schema_path[0]` 是分支序号；
    丢掉那些因为鉴别字段（`const`）不匹配而失败的分支，剩下的就是用户声明的那种。

    不这么做的话，报错会把所有分支的必填字段全列出来（"缺少 bullets" 出现在一页 chart
    的报错里），而模型只有一次修正机会。
    """
    by_branch: dict[int, list] = {}
    rejected: set[int] = set()
    for sub in err.context or []:
        branch = sub.schema_path[0] if sub.schema_path else -1
        if not isinstance(branch, int):
            continue
        if sub.validator == "const":
            rejected.add(branch)
            continue
        by_branch.setdefault(branch, []).append(sub)

    candidates = [subs for branch, subs in sorted(by_branch.items()) if branch not in rejected]
    picked = candidates[0] if candidates else []

    seen: set[str] = set()
    out: list[str] = []
    for sub in picked[:limit]:
        line = describe_error(sub)
        if line in seen:
            continue
        seen.add(line)
        out.append(line)
    return out


def validate_content(
    content: dict,
    schema_path: Path,
    *,
    discriminator: str | None = None,
    known_kinds: Iterable[str] = (),
) -> None:
    """先校验再渲染。失败时给出**具体哪一条不合法**，而不是"内容格式错误"。

    `discriminator` 是那个用来分辨 oneOf 分支的字段名（幻灯片是 `layout`，
    文档块是 `block`）。给了它，oneOf 的报错才能精确到"按你声明的那种形状检查这几条"。
    """
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    try:
        import jsonschema
    except ModuleNotFoundError:
        # jsonschema 属于基础包（随主程序），缺它是安装损坏而不是"扩展没装"
        fail(EXIT_RUNTIME_MISSING, "校验库缺失，请重新安装 EvoWork 的解析组件。")

    validator = jsonschema.Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(content), key=lambda e: list(e.path))
    if not errors:
        return

    lines: list[str] = []
    for err in errors[:8]:
        lines.append(describe_error(err))
        if err.validator == "oneOf" and isinstance(err.instance, dict) and discriminator:
            kind = err.instance.get(discriminator)
            if kind in tuple(known_kinds):
                lines.append(f"  （这一项 {discriminator} = {kind}，按它的形状检查下面几条）")
                lines.extend(f"  - {line}" for line in intended_branch_errors(err))
    fail(
        EXIT_INVALID_CONTENT,
        f"内容 JSON 不符合 schema（{len(errors)} 处）。按下面的提示改，然后重跑一次。",
        "\n".join(lines),
    )


def resolve_asset(ref: str, base: Path, *, hint: str) -> Path:
    """解析内容里引用的文件路径；不存在就以专用退出码失败。"""
    path = Path(ref)
    resolved = path if path.is_absolute() else (base / path)
    if not resolved.exists():
        fail(EXIT_MISSING_ASSET, f"引用的文件不存在：{ref}。{hint}")
    return resolved


def load_template(skill_root: Path, template_id: str) -> dict:
    path = skill_root / "templates" / template_id / "template.json"
    if not path.exists():
        fail(EXIT_INVALID_CONTENT, f"未知模板：{template_id}")
    return json.loads(path.read_text(encoding="utf-8"))


def read_content(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(EXIT_INVALID_CONTENT, f"找不到内容文件：{path}")
    except json.JSONDecodeError as err:
        # 只报位置，不报那一行的内容
        fail(EXIT_INVALID_CONTENT, f"内容文件不是合法 JSON（第 {err.lineno} 行第 {err.colno} 列）。")
    if not isinstance(data, dict):
        fail(EXIT_INVALID_CONTENT, "内容文件的顶层必须是一个对象。")
    return data


def succeeded(out_path: Path | None = None, **extra: Any) -> None:
    """成功输出。调用方（artifacts 服务 / agent）读这一行拿到产物路径。

    `--validate-only` 那条路径没有产物，所以 `out_path` 可以省 ——
    带一个指向内容 JSON 的 `path` 会让调用方以为产物已经生成了。
    """
    payload: dict[str, Any] = {"ok": True}
    if out_path is not None:
        payload["path"] = str(out_path)
    payload.update(extra)
    print(json.dumps(payload, ensure_ascii=False))
