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
import stat
import sys
import tempfile
import hashlib
from pathlib import Path
from typing import Any, Iterable

EXIT_OK = 0
EXIT_INVALID_CONTENT = 2
EXIT_RUNTIME_MISSING = 3
EXIT_MISSING_ASSET = 4
#: 转换器在、也跑了，但没转成（超时、文档坏了、被隔离拦下）。与 3 分开：报成「缺运行时」会让用户去重装
EXIT_CONVERSION_FAILED = 5
#: 执行到一半出错，而且没能全部撤回：磁盘上是半完成状态，消息里逐条列出哪些改动已经生效（batch-files）
EXIT_PARTIAL = 6

#: 08 §4 的三档运行时。文案必须与 `services/ingest` 一致 ——
#: 一处说"解析组件"、一处说"生成组件"会让用户以为要装两个东西（08 §4 原话）。
RUNTIME_TIERS = {
    "base": {"label": "基础组件", "size": "0MB", "note": "随主程序，无需下载"},
    "office": {"label": "办公扩展", "size": "随应用提供，无需下载", "note": "Word / Excel / PPT / PDF 文本层"},
    "ocr": {"label": "OCR 扩展", "size": "约 23MB", "note": "扫描件与图片文字识别（PDF 另需办公扩展）"},
}


def runtime_missing_message(tier: str, what: str) -> str:
    """三档运行时缺失时的统一文案（08 §4）。"""
    spec = RUNTIME_TIERS[tier]
    return f"需要安装本地{spec['label']}（{spec['size']}）才能{what}。安装后重试即可。"


#: 办公扩展的安装位置（08 §4：完整成品随包、本地部署，装在自己的目录里而不是污染系统 python）。
#: 可用 EVOWORK_OFFICE_PYTHON 覆盖 —— 企业离线部署会把它装在别处。
OFFICE_VENV = Path.home() / ".evowork" / "runtime" / "office"


def office_interpreter_candidates() -> list[Path]:
    """解释器候选路径，**按优先级**。

    单独一个函数而不是写在 ``office_python()`` 里，是为了让
    ``services/ingest/test/runtime.test.ts`` 能把这份表**原样读走**与 TS 侧比对。
    内联的话那条测试只能自己抄一份候选表 —— 而抄来的表在有人改了这里之后照样通过，
    也就守不住任何东西。
    """
    return [
        OFFICE_VENV / "bin" / "python",
        OFFICE_VENV / "bin" / "python3",
        OFFICE_VENV / "Scripts" / "python.exe",
        OFFICE_VENV / "python.exe",
    ]


def office_python() -> Path | None:
    """办公扩展的解释器路径；没装就返回 None。

    四个候选对应两种布局，**缺一不可**（与 `services/ingest` 的 `officeInterpreterPaths`
    逐条对齐，由 `services/ingest/test/runtime.test.ts` 比对）：

      · ``bin/python`` / ``Scripts/python.exe`` —— venv 布局（企业用 uv 自建的环境）；
      · ``bin/python3`` / ``python.exe``（在根上）—— python-build-standalone 布局，
        也就是内置安装器装出来的那种。windows 上解释器就在根目录，``Scripts/`` 里是 pip.exe。

    只认 venv 那两个的话，内置安装器装完之后技能会说"没装扩展" ——
    装了却用不了是最难查的一类故障。
    """
    override = os.environ.get("EVOWORK_OFFICE_PYTHON")
    if override:
        path = Path(override)
        return path if path.exists() else None
    for candidate in office_interpreter_candidates():
        if candidate.exists():
            return candidate
    return None


def office_fonts_dir() -> Path | None:
    """办公扩展自带的字体目录；没有就返回 None。

    ## 为什么字体要跟着扩展走

    ``charts`` 在画图前探测中文字体，探不到就停下来报错而不是画一张方框图。
    在 macOS / Windows 上系统字体让这一步侥幸能过，但**裸 Linux 或精简 Windows 镜像上过不了**
    —— 而在此之前那句提示写的是"请安装办公扩展（它带中文字体）"，扩展里其实一个字体都没有。
    2026-09-06 起安装器会把一份 Noto Sans SC 装进 ``<扩展根>/fonts/``，这个函数就是去找它。

    目录由**解释器的位置反推**，不是写死 ``~/.evowork``：企业离线部署用
    ``EVOWORK_OFFICE_PYTHON`` 把扩展装在别处，字体自然也在那边。
    """
    interpreter = office_python()
    if interpreter is None:
        return None
    parent = interpreter.parent
    root = parent.parent if parent.name in ("bin", "Scripts") else parent
    fonts = root / "fonts"
    return fonts if fonts.is_dir() else None


#: 办公扩展里**不止**那几个文档库：内容校验用的 `jsonschema` 也只装在扩展里
#: （`services/runtime-installer/src/manifest.ts` 的 REQUIREMENTS），主程序不带它。
#: 所以「当前解释器缺不缺扩展的东西」要连它一起看 —— 系统 python 里恰好有 python-docx、
#: 却没有 jsonschema 时，不换解释器就会在校验那一步失败。
OFFICE_SUPPORT_MODULES = ("jsonschema",)


def ensure_office_runtime(modules: Iterable[str]) -> None:
    """需要办公扩展的模块不在当前解释器里时，**换到办公扩展的解释器重跑一次**。

    ## 为什么是 re-exec 而不是让 SKILL.md 写死解释器路径

    SKILL.md 是给模型看的，里面写 `python3 container_tools/render.py`。
    要求它改成一个带绝对路径的解释器，等于把"扩展装在哪"这件事泄漏进提示词 ——
    而那个路径在企业离线部署里是另一个值。

    所以判断留在这里：缺模块 + 扩展装了 → 用扩展的解释器重跑；扩展没装 → 照常报 3 号退出码。
    环境变量做防重入，避免换了解释器还缺模块时无限套娃。
    """
    configure_plot_cache()
    wanted = (*modules, *OFFICE_SUPPORT_MODULES)
    missing = [name for name in wanted if importlib.util.find_spec(name) is None]
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


def configure_plot_cache() -> Path | None:
    configured = os.environ.get("MPLCONFIGDIR")
    if configured:
        candidate = Path(configured)
        try:
            if candidate.is_dir():
                with tempfile.TemporaryFile(dir=candidate):
                    return candidate
        except OSError:
            pass
    uid = os.getuid() if hasattr(os, "getuid") else None
    identity = str(uid) if uid is not None else hashlib.sha256(str(Path.home()).encode()).hexdigest()[:16]
    root = Path(tempfile.gettempdir()) / f"evowork-office-cache-{identity}"
    try:
        for directory in (root, root / "matplotlib", root / "xdg"):
            directory.mkdir(mode=0o700, exist_ok=True)
            info = directory.lstat()
            if not stat.S_ISDIR(info.st_mode) or (uid is not None and info.st_uid != uid):
                return None
            directory.chmod(0o700)
        os.environ["MPLCONFIGDIR"] = str(root / "matplotlib")
        os.environ.setdefault("XDG_CACHE_HOME", str(root / "xdg"))
        return root / "matplotlib"
    except OSError:
        return None


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
        # jsonschema 随**办公扩展**安装，不随主程序（manifest.ts 的 REQUIREMENTS）。
        # 2026-10-03 之前这里说「校验库缺失，请重新安装 EvoWork 的解析组件」—— 那是把它当成了
        # 基础包；用户机器上没装扩展、系统 python 又没有 jsonschema 时，会被指去修一个没坏的东西。
        if os.environ.get("EVOWORK_SKILL_REEXEC") == "1":
            # 已经换到扩展的解释器了还缺：扩展装坏了
            fail(
                EXIT_RUNTIME_MISSING,
                "办公扩展不完整（缺少校验库 jsonschema），请在设置里重新安装办公扩展。",
            )
        fail(EXIT_RUNTIME_MISSING, runtime_missing_message("office", "校验与生成这份内容"))

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


#: 写进 Office 核心属性 `category` 的模板标记。提取时只认这个前缀，
#: 避免把用户自己写在类别里的字当成模板 id。
TEMPLATE_STAMP_PREFIX = "evowork-template:"


def template_stamp(template_id: str) -> str:
    return f"{TEMPLATE_STAMP_PREFIX}{template_id}"


def read_template_stamp(value: str | None) -> str | None:
    """从核心属性读回模板 id。不是我们写的标记就返回 None，调用方再用默认模板。"""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text.startswith(TEMPLATE_STAMP_PREFIX):
        return None
    name = text[len(TEMPLATE_STAMP_PREFIX) :].strip()
    if not name or any(ch.isspace() for ch in name) or "/" in name or "\\" in name:
        return None
    return name


def document_limits() -> dict[str, int]:
    """documents 渲染器的上限，**直接从它的 schema 读**（合并 #20 时收拢）。

    纪要、周报、分析、扫描纪要都交给 documents 渲染；它们要在检查阶段就按同一套上限拦下，
    报错才能指回模型写的原字段。原先四个检查器各抄了一份数 —— 抄的数迟早与 schema 分叉。
    """
    schema_path = Path(__file__).resolve().parent.parent / "documents" / "schema" / "content.schema.json"
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    defs = schema["$defs"]
    return {
        "title": schema["properties"]["title"]["maxLength"],
        "list_items": defs["bullets"]["properties"]["items"]["maxItems"],
        "item_chars": defs["bullets"]["properties"]["items"]["items"]["maxLength"],
        "table_rows": defs["table"]["properties"]["rows"]["maxItems"],
        "table_columns": defs["table"]["properties"]["header"]["maxItems"],
        "header_chars": defs["table"]["properties"]["header"]["items"]["maxLength"],
    }


def refuse_overwrite(out_path: Path, overwrite: bool) -> None:
    """目标已存在时默认拒绝（2026-10-22 合并 #20 时补）。

    编辑流程会把 `--out` 指回原文件，而重渲染是**有损**的（提取收不回的内容不会回来）。
    shell 的 `>` 覆盖有内核补丁 P6 弹审批，python 写文件没有 —— 所以这道闸放在渲染器里：
    要写回原文件必须显式 `--overwrite`。任务目录里的文件可在 App 里撤销（19 篇的磁盘撤销）；
    目录外的文件没有撤销副本，先另存一份再覆盖。
    """
    if not overwrite and out_path.exists():
        fail(
            EXIT_INVALID_CONTENT,
            f"目标文件已存在：{out_path}。要写回原文件请加 --overwrite；"
            "否则换一个新文件名，别覆盖用户的原件。",
        )


def lossy_extraction(dropped: dict[str, int], allow_lossy: bool) -> dict[str, Any]:
    """提取收不回的内容**必须报出来**（不静默降级，CLAUDE.md §9.1）。

    `dropped` 是「丢了什么 → 几处」。有丢失时默认失败；`--allow-lossy` 才继续，
    并把清单随成功输出交给模型 —— 它要原样告诉用户，再决定要不要改原件。
    """
    lost = {kind: count for kind, count in dropped.items() if count > 0}
    if lost and not allow_lossy:
        summary = "、".join(f"{kind} {count} 处" for kind, count in lost.items())
        fail(
            EXIT_INVALID_CONTENT,
            f"这份文件有内容提取不回来：{summary}。重新渲染会丢掉它们。"
            "先告诉用户会丢什么；用户同意后加 --allow-lossy 再提取，或者改用别的方式编辑。",
        )
    return {"dropped": lost} if lost else {}


def write_extracted(content: dict, out_path: Path) -> None:
    """提取结果只写成 JSON。模型改的是这份 JSON，再交回原来的渲染器。"""
    if out_path.suffix.lower() != ".json":
        fail(EXIT_INVALID_CONTENT, "提取结果必须写成 .json。")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def succeeded(out_path: Path | None = None, **extra: Any) -> None:
    """成功输出。调用方（artifacts 服务 / agent）读这一行拿到产物路径。

    `--validate-only` 那条路径没有产物，所以 `out_path` 可以省 ——
    带一个指向内容 JSON 的 `path` 会让调用方以为产物已经生成了。
    """
    payload: dict[str, Any] = {"ok": True}
    if out_path is not None:
        payload["path"] = str(out_path)
    payload.update(extra)
    quality = extra.get("quality")
    if quality and quality.get("status") != "passed":
        payload.update(ok=False, code=EXIT_PARTIAL, message="文件已生成，但检查未通过，请先修正或复核，不要声明交付已验收。")
    print(json.dumps(payload, ensure_ascii=False))
    if not payload["ok"]:
        sys.exit(EXIT_PARTIAL)
