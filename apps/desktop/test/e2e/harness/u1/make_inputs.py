"""U1（08 §5.4）三个任务的输入：一份销售 Excel、一份费用明细 csv。

固定种子：同一份输入跨模型、跨时间可比 —— 评分要比的是模型，不是数据。
用法：python3 make_inputs.py <输出目录>
"""

import csv
import random
import sys
from pathlib import Path

from openpyxl import Workbook

REGIONS = ["华东", "华南", "华北", "西南"]
PRODUCTS = ["标准版", "专业版", "企业版"]
DEPARTMENTS = ["市场部", "销售部", "研发部", "行政部", "财务部"]
CATEGORIES = ["差旅", "办公", "培训", "招待", "软件"]


def sales(path: Path, rng: random.Random) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "月度销售"
    ws.append(["月份", "区域", "产品", "销售额（万元）", "订单数"])
    for month in range(1, 13):
        for region in REGIONS:
            for product in PRODUCTS:
                base = {"标准版": 18, "专业版": 32, "企业版": 55}[product]
                season = 1 + 0.25 * (month in (6, 11, 12))
                amount = round(base * season * rng.uniform(0.7, 1.4), 2)
                ws.append([f"2026-{month:02d}", region, product, amount, rng.randint(20, 160)])
    target = wb.create_sheet("年度目标")
    target.append(["区域", "年度目标（万元）"])
    for region in REGIONS:
        target.append([region, rng.choice([1600, 1800, 2000, 2200])])
    wb.save(path)


def expenses(path: Path, rng: random.Random) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(["日期", "部门", "类别", "金额（元）", "经办人"])
        for _ in range(240):
            month = rng.randint(1, 6)
            writer.writerow(
                [
                    f"2026-{month:02d}-{rng.randint(1, 28):02d}",
                    rng.choice(DEPARTMENTS),
                    rng.choice(CATEGORIES),
                    round(rng.uniform(80, 12000), 2),
                    rng.choice(["王敏", "李强", "陈静", "赵磊", "孙悦"]),
                ]
            )


def main() -> None:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20261022)
    sales(out / "销售数据.xlsx", rng)
    expenses(out / "费用明细.csv", rng)


if __name__ == "__main__":
    main()
