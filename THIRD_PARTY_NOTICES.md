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
| 签出 | `89a4eec6da` |
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

共 3 个包。

### 全部

| 包 | 版本 | 许可证 |
|---|---|---|
| `react` | 19.2.8 | MIT |
| `react-dom` | 19.2.8 | MIT |
| `scheduler` | 0.27.0 | MIT |

## 3. 解析与产物运行时（按需下载，不随主程序）

08 §4 的三档运行时（办公扩展、OCR 扩展）**不随主程序分发**，在用户显式同意后下载。
它们各自的许可证清单在下载包内随附，并在下载前的确认界面里给出链接：

| 档位 | 主要组件 | 许可证 |
|---|---|---|
| 办公扩展 | CPython · python-docx · openpyxl · python-pptx · pdfplumber | PSF-2.0 · MIT · MIT · MIT · MIT |
| OCR 扩展 | tesseract + 中文语言模型 | Apache-2.0 |

> 这一节的具体版本号在 M3 落地运行时分发时由同一脚本补全（目前尚无这些依赖）。

