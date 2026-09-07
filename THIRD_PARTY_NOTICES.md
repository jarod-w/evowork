# THIRD PARTY NOTICES

> **本文件由 `scripts/gen-third-party-notices.mjs` 生成，不要手改。**
> 依据 CLAUDE.md **K5**（许可与品牌）：保留内核的 `LICENSE` / `NOTICE`，并建立与维护本清单。
> 它同时是 P4-2（法务过审）的送审输入 —— 法务排期是外部等待，清单必须先于它存在。

## 1. 执行内核（随产品分发）

EvoWork 把 `openai/codex` 当作**不可变的执行内核**，桌面安装包内含其编译产物（Q1=A / D9）。

| 项 | 值 |
|---|---|
| 项目 | openai/codex |
| 许可证 | Apache License 2.0 |
| 签出 | `728cb12fe5` |
| LICENSE 首行 | Apache License |

**分发义务（Apache-2.0 §4）**：

1. 安装包内保留 `LICENSE` 原文与 `NOTICE`（若存在）；
2. 修改过的文件需标注（本项目的修改全部集中在 `patches/evowork/`，见 K1 与 `scripts/patch-budget.mjs`）；
3. **不得使用 Codex / OpenAI 商标**做产品标识（K5，且 Apache-2.0 §6 本身不授予商标许可）。

内核 `NOTICE` 原文：

```text
OpenAI Codex
Copyright 2025 OpenAI

This project includes code derived from [Ratatui](https://github.com/ratatui/ratatui), licensed under the MIT license.
Copyright (c) 2016-2022 Florian Dehau
Copyright (c) 2023-2025 The Ratatui Developers
```

## 2. 运行时依赖（npm，生产依赖）

共 112 个包。

### ⚠️ 需要法务单独看的许可证

| 包 | 版本 | 许可证 |
|---|---|---|
| `dompurify` | 3.4.14 | **(MPL-2.0 OR Apache-2.0)** |

这些许可证在**桌面分发**（依赖被打进安装包）下的义务与 MIT/Apache 不同，需逐个确认。

### 全部

| 包 | 版本 | 许可证 |
|---|---|---|
| `@antfu/install-pkg` | 2.0.1 | MIT |
| `@braintree/sanitize-url` | 7.1.2 | MIT |
| `@chevrotain/types` | 11.1.2 | Apache-2.0 |
| `@iconify/types` | 2.0.0 | MIT |
| `@iconify/utils` | 3.1.5 | MIT |
| `@mermaid-js/parser` | 1.2.1 | MIT |
| `@types/d3` | 7.4.3 | MIT |
| `@types/d3-array` | 3.2.2 | MIT |
| `@types/d3-axis` | 3.0.6 | MIT |
| `@types/d3-brush` | 3.0.6 | MIT |
| `@types/d3-chord` | 3.0.6 | MIT |
| `@types/d3-color` | 3.1.3 | MIT |
| `@types/d3-contour` | 3.0.6 | MIT |
| `@types/d3-delaunay` | 6.0.4 | MIT |
| `@types/d3-dispatch` | 3.0.7 | MIT |
| `@types/d3-drag` | 3.0.7 | MIT |
| `@types/d3-dsv` | 3.0.7 | MIT |
| `@types/d3-ease` | 3.0.2 | MIT |
| `@types/d3-fetch` | 3.0.7 | MIT |
| `@types/d3-force` | 3.0.10 | MIT |
| `@types/d3-format` | 3.0.4 | MIT |
| `@types/d3-geo` | 3.1.1 | MIT |
| `@types/d3-hierarchy` | 3.1.7 | MIT |
| `@types/d3-interpolate` | 3.0.4 | MIT |
| `@types/d3-path` | 3.1.1 | MIT |
| `@types/d3-polygon` | 3.0.2 | MIT |
| `@types/d3-quadtree` | 3.0.6 | MIT |
| `@types/d3-random` | 3.0.4 | MIT |
| `@types/d3-scale` | 4.0.9 | MIT |
| `@types/d3-scale-chromatic` | 3.1.0 | MIT |
| `@types/d3-selection` | 3.0.11 | MIT |
| `@types/d3-shape` | 3.2.0 | MIT |
| `@types/d3-time` | 3.0.4 | MIT |
| `@types/d3-time-format` | 4.0.3 | MIT |
| `@types/d3-timer` | 3.0.2 | MIT |
| `@types/d3-transition` | 3.0.9 | MIT |
| `@types/d3-zoom` | 3.0.8 | MIT |
| `@types/geojson` | 7946.0.16 | MIT |
| `@types/trusted-types` | 2.0.7 | MIT |
| `@upsetjs/venn.js` | 2.0.0 | MIT |
| `commander` | 7.2.0, 8.3.0 | MIT |
| `cose-base` | 1.0.3, 2.2.0 | MIT |
| `cytoscape` | 3.34.2 | MIT |
| `cytoscape-cose-bilkent` | 4.1.0 | MIT |
| `cytoscape-fcose` | 2.2.0 | MIT |
| `d3` | 7.9.0 | ISC |
| `d3-array` | 3.2.4 | ISC |
| `d3-array` | 2.12.1 | BSD-3-Clause |
| `d3-axis` | 3.0.0 | ISC |
| `d3-brush` | 3.0.0 | ISC |
| `d3-chord` | 3.0.1 | ISC |
| `d3-color` | 3.1.0 | ISC |
| `d3-contour` | 4.0.2 | ISC |
| `d3-delaunay` | 6.0.4 | ISC |
| `d3-dispatch` | 3.0.1 | ISC |
| `d3-drag` | 3.0.0 | ISC |
| `d3-dsv` | 3.0.1 | ISC |
| `d3-ease` | 3.0.1 | BSD-3-Clause |
| `d3-fetch` | 3.0.1 | ISC |
| `d3-force` | 3.0.0 | ISC |
| `d3-format` | 3.1.2 | ISC |
| `d3-geo` | 3.1.1 | ISC |
| `d3-hierarchy` | 3.1.2 | ISC |
| `d3-interpolate` | 3.0.1 | ISC |
| `d3-path` | 3.1.0 | ISC |
| `d3-path` | 1.0.9 | BSD-3-Clause |
| `d3-polygon` | 3.0.1 | ISC |
| `d3-quadtree` | 3.0.1 | ISC |
| `d3-random` | 3.0.1 | ISC |
| `d3-sankey` | 0.12.3 | BSD-3-Clause |
| `d3-scale` | 4.0.2 | ISC |
| `d3-scale-chromatic` | 3.1.0 | ISC |
| `d3-selection` | 3.0.0 | ISC |
| `d3-shape` | 3.2.0 | ISC |
| `d3-shape` | 1.3.7 | BSD-3-Clause |
| `d3-time` | 3.1.0 | ISC |
| `d3-time-format` | 4.1.0 | ISC |
| `d3-timer` | 3.0.1 | ISC |
| `d3-transition` | 3.0.1 | ISC |
| `d3-zoom` | 3.0.0 | ISC |
| `dagre-d3-es` | 7.0.14 | MIT |
| `dayjs` | 1.11.23 | MIT |
| `delaunator` | 5.1.0 | ISC |
| `dompurify` | 3.4.14 | (MPL-2.0 OR Apache-2.0) |
| `es-toolkit` | 1.52.0 | MIT |
| `fastdom` | 1.0.12 | MIT |
| `hachure-fill` | 0.5.2 | MIT |
| `iconv-lite` | 0.6.3 | MIT |
| `import-meta-resolve` | 4.2.0 | MIT |
| `internmap` | 1.0.1, 2.0.3 | ISC |
| `katex` | 0.16.47 | MIT |
| `khroma` | 2.1.0 | Unknown |
| `layout-base` | 1.0.2, 2.0.1 | MIT |
| `lodash-es` | 4.18.1 | MIT |
| `marked` | 16.4.2 | MIT |
| `mermaid` | 11.17.2 | MIT |
| `package-manager-detector` | 1.8.0 | MIT |
| `path-data-parser` | 0.1.0 | MIT |
| `points-on-curve` | 0.2.0 | MIT |
| `points-on-path` | 0.2.1 | MIT |
| `react` | 19.2.8 | MIT |
| `react-dom` | 19.2.8 | MIT |
| `robust-predicates` | 3.0.3 | Unlicense |
| `roughjs` | 4.6.6 | MIT |
| `rw` | 1.3.3 | BSD-3-Clause |
| `safer-buffer` | 2.1.2 | MIT |
| `scheduler` | 0.27.0 | MIT |
| `strictdom` | 1.0.1 | MIT |
| `stylis` | 4.4.0 | MIT |
| `tinyexec` | 1.3.1 | MIT |
| `ts-dedent` | 2.3.0 | MIT |
| `uuid` | 14.0.2 | MIT |

## 3. 解析与产物运行时（按需下载，不随主程序）

08 §4 的三档运行时（办公扩展、OCR 扩展）**不随主程序分发**，在用户显式同意后下载。
它们各自的许可证清单在下载包内随附，并在下载前的确认界面里给出链接：

| 档位 | 主要组件 | 许可证 |
|---|---|---|
| 办公扩展 · 解释器 | CPython 3.12.14（python-build-standalone 20260901，`install_only`） | PSF-2.0 |
| 办公扩展 · Python 包 | python-docx==1.2.0 · openpyxl==3.1.5 · python-pptx==1.0.2 · matplotlib==3.11.1 · pdfplumber==0.11.10 · jsonschema==4.26.0 | MIT · MIT · MIT · PSF-2.0 · MIT · MIT |
| 办公扩展 · 中文字体 | Noto Sans SC（Google Fonts，安装时切成 wght=400 静态实例） | SIL Open Font License 1.1 |
| OCR 扩展 | tesseract + 中文语言模型 | Apache-2.0 |

> 办公扩展的版本全部钉死并带 sha256 校验，真源是 `services/runtime-installer/src/manifest.ts`；这一节由本脚本从那里读出，不手工维护。

