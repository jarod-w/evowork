#!/usr/bin/env python3
"""内容 JSON → 图表（svg / png）。08 §5.2 的第四个技能。

模型给**数据与标注**，配色 / 字号 / 坐标轴 / 图例由这里按 `templates/default/theme.json`
决定，而那份 theme 的颜色是从 01 §2 的 design token 抄过来的（有测试逐个比对）。

## 中文不乱码这条是这个技能的主要质量点

matplotlib 的默认字体没有中文字形，中文会渲染成一排方框 —— **而且不报错**。
产物打开之前没人会发现。所以这里在渲染前先探测本机有没有可用的中文字体，
没有就以专用退出码停下并说清怎么办，**绝不产出一张方框图**。

退出码与共用骨架一致（见 `plugins/skills/_shared/evowork_skill.py`）：
0 成功 · 2 内容不合法 · 3 运行时/字体缺失 · 4 引用的文件不存在。
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_ROOT.parent / "_shared"))

from evowork_skill import (  # noqa: E402 -- 必须在 sys.path 调整之后
    ensure_office_runtime,
    EXIT_INVALID_CONTENT,
    EXIT_RUNTIME_MISSING,
    fail,
    read_content,
    runtime_missing_message,
    succeeded,
    validate_content,
)

CHARTS = ("bar", "stacked-bar", "line", "pie", "scatter")

#: 按优先级探测的中文字体族。列表本身就是"我们支持哪些环境"的声明。
CJK_FONTS = (
    "PingFang SC",
    "Hiragino Sans GB",
    "Heiti SC",
    "Microsoft YaHei",
    "Noto Sans CJK SC",
    "Source Han Sans SC",
    "WenQuanYi Zen Hei",
    "Noto Sans SC",
)

VALUE_FORMATTERS = {
    "int": lambda v: f"{v:,.0f}",
    "decimal1": lambda v: f"{v:,.1f}",
    "percent": lambda v: f"{v:.1%}",
    "thousands": lambda v: f"{v:,.0f}",
}


def load_theme() -> dict:
    return read_content(SKILL_ROOT / "templates" / "default" / "theme.json")


def validate(content: dict) -> None:
    validate_content(content, SKILL_ROOT / "schema" / "content.schema.json")

    chart = content["chart"]
    series = content["series"]
    categories = content.get("categories")

    # schema 管形状，这里管**跨字段的一致性** —— JSON Schema 表达不了"两个数组一样长"，
    # 而长度对不上是这个技能最常见的错误，且 matplotlib 的报错完全看不懂
    if chart in ("bar", "stacked-bar", "line", "pie"):
        if not categories:
            fail(EXIT_INVALID_CONTENT, f"{chart} 需要 categories（分类轴的标签）。")
        for index, item in enumerate(series):
            if len(item["values"]) != len(categories):
                fail(
                    EXIT_INVALID_CONTENT,
                    f"series[{index}] 的 values 有 {len(item['values'])} 个，"
                    f"categories 有 {len(categories)} 个，两者必须一样长。",
                )
    if chart == "pie":
        if len(series) != 1:
            fail(EXIT_INVALID_CONTENT, "pie 只能有一个 series（一个饼画一组数）。")
        if any(v < 0 for v in series[0]["values"]):
            fail(EXIT_INVALID_CONTENT, "pie 的数值不能为负 —— 负数画不出扇形。")
    if chart == "scatter":
        for index, item in enumerate(series):
            x_values = item.get("x_values")
            if not x_values:
                fail(EXIT_INVALID_CONTENT, f"series[{index}] 缺少 x_values（scatter 需要横坐标）。")
            if len(x_values) != len(item["values"]):
                fail(
                    EXIT_INVALID_CONTENT,
                    f"series[{index}] 的 x_values 与 values 长度不一致。",
                )


def pick_cjk_font(font_manager) -> str | None:  # noqa: ANN001 -- matplotlib.font_manager
    available = {f.name for f in font_manager.fontManager.ttflist}
    for name in CJK_FONTS:
        if name in available:
            return name
    return None


def has_cjk(content: dict) -> bool:
    """内容里有没有中日韩字符。没有就不必强求中文字体。"""
    texts = [content.get("title", ""), content.get("x_label", ""), content.get("y_label", "")]
    texts += [str(c) for c in content.get("categories", [])]
    texts += [s["name"] for s in content["series"]]
    texts.append(content.get("source", ""))
    return any("一" <= ch <= "鿿" for text in texts for ch in text)


def render(content: dict, out_path: Path) -> None:
    try:
        import matplotlib

        matplotlib.use("Agg")  # 无显示环境
        import matplotlib.pyplot as plt
        from matplotlib import font_manager
    except ModuleNotFoundError:
        fail(EXIT_RUNTIME_MISSING, runtime_missing_message("office", "生成图表"))

    theme = load_theme()
    metrics = theme["metrics"]
    mode = theme[content.get("theme", "light")]
    palette = theme["palette"]

    if has_cjk(content):
        font = pick_cjk_font(font_manager)
        if font is None:
            # **不产出方框图**：这是这个技能最容易静默失败的地方
            fail(
                EXIT_RUNTIME_MISSING,
                "本机没有可用的中文字体，图里的中文会渲染成方框。"
                "请安装办公扩展（它带中文字体），或在系统里装一款中文字体后重试。",
            )
        plt.rcParams["font.sans-serif"] = [font]
        plt.rcParams["axes.unicode_minus"] = False  # 负号也要用同一款字体，否则显示成方框

    width = content.get("width_px", 960) / metrics["dpi"]
    height = content.get("height_px", 540) / metrics["dpi"]
    fig, ax = plt.subplots(figsize=(width, height), dpi=metrics["dpi"])
    fig.patch.set_facecolor(mode["background"])
    ax.set_facecolor(mode["background"])

    chart = content["chart"]
    series = content["series"]
    categories = content.get("categories", [])
    formatter = VALUE_FORMATTERS[content.get("value_format", "int")]

    if chart == "pie":
        ax.pie(
            series[0]["values"],
            labels=categories,
            colors=palette[: len(categories)],
            autopct=lambda pct: formatter(pct / 100) if content.get("value_format") == "percent" else f"{pct:.1f}%",
            textprops={"color": mode["text"], "fontsize": metrics["tick_pt"]},
        )
        ax.set_aspect("equal")
    elif chart == "scatter":
        for index, item in enumerate(series):
            ax.scatter(
                item["x_values"], item["values"], label=item["name"], color=palette[index % len(palette)]
            )
    elif chart == "line":
        for index, item in enumerate(series):
            ax.plot(
                categories,
                item["values"],
                label=item["name"],
                color=palette[index % len(palette)],
                linewidth=metrics["line_width"],
                marker="o",
                markersize=4,
            )
    else:  # bar / stacked-bar
        positions = range(len(categories))
        if chart == "stacked-bar":
            bottom = [0.0] * len(categories)
            for index, item in enumerate(series):
                ax.bar(
                    positions,
                    item["values"],
                    bottom=bottom,
                    label=item["name"],
                    color=palette[index % len(palette)],
                    width=metrics["bar_width"],
                )
                bottom = [b + v for b, v in zip(bottom, item["values"])]
        else:
            count = len(series)
            slot = metrics["bar_width"] / count
            for index, item in enumerate(series):
                offset = (index - (count - 1) / 2) * slot
                ax.bar(
                    [p + offset for p in positions],
                    item["values"],
                    label=item["name"],
                    color=palette[index % len(palette)],
                    width=slot,
                )
        ax.set_xticks(list(positions))
        ax.set_xticklabels(categories, fontsize=metrics["tick_pt"], color=mode["text_secondary"])

    ax.set_title(content["title"], fontsize=metrics["title_pt"], color=mode["text"], pad=12)
    if content.get("x_label"):
        ax.set_xlabel(content["x_label"], fontsize=metrics["label_pt"], color=mode["text_secondary"])
    if content.get("y_label"):
        ax.set_ylabel(content["y_label"], fontsize=metrics["label_pt"], color=mode["text_secondary"])

    if chart != "pie":
        ax.grid(axis="y", color=mode["grid"], linewidth=metrics["grid_width"])
        ax.set_axisbelow(True)
        for spine in ("top", "right"):
            ax.spines[spine].set_visible(False)
        for spine in ("left", "bottom"):
            ax.spines[spine].set_color(mode["grid"])
        ax.tick_params(colors=mode["text_secondary"], labelsize=metrics["tick_pt"])
        # **图例必须有**（08 §5.2 的质量点）：多条系列没有图例等于没有信息。
        # 单条系列时图例是噪音，用标题表达就够了
        if len(series) > 1:
            ax.legend(fontsize=metrics["legend_pt"], frameon=False, labelcolor=mode["text"])

    if content.get("source"):
        fig.text(
            0.01,
            0.01,
            f"数据来源：{content['source']}",
            fontsize=metrics["source_pt"],
            color=mode["text_secondary"],
        )

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fig.tight_layout()
    fig.savefig(out_path, format=out_path.suffix.lstrip(".") or "png", facecolor=fig.get_facecolor())
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser(description="内容 JSON → 图表")
    parser.add_argument("--content", required=True)
    parser.add_argument("--out", required=True, help="输出路径，扩展名决定格式（.svg / .png）")
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="只校验不渲染（不需要办公扩展，用于让模型先把内容改对）",
    )
    args = parser.parse_args()

    # 缺办公扩展的模块时换到扩展的解释器重跑（见 evowork_skill.ensure_office_runtime）。
    # --validate-only 不需要它，但提前换掉更简单，也让两条路径的行为一致
    ensure_office_runtime(("matplotlib",))

    content = read_content(Path(args.content).resolve())
    validate(content)

    if args.validate_only:
        succeeded(series=len(content["series"]), validated=True)
        return

    out_path = Path(args.out).resolve()
    if out_path.suffix.lower() not in (".svg", ".png"):
        fail(EXIT_INVALID_CONTENT, f"输出格式只支持 .svg 与 .png，收到 {out_path.suffix or '(无扩展名)'}。")
    render(content, out_path)
    succeeded(out_path, chart=content["chart"], series=len(content["series"]))


if __name__ == "__main__":
    main()
