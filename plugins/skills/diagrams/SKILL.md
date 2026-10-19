---
name: diagrams
description: 画流程图、组织关系或甘特排期，输出 svg。给文档或幻灯片配流程、汇报关系和项目排期时使用。统计图仍用 charts。
---

# diagrams —— 流程图、组织关系、排期

三种，没有第四种。柱状图、折线图、饼图用 `charts`。

## 怎么用

```bash
node container_tools/mark_artifact.mjs \
  --operation-kind create --expected-output-count 1 --output-format svg \
  --title "报销流程" --path "<绝对路径>/报销流程.svg"

python3 container_tools/render.py --content diagram.json --out "<绝对路径>/报销流程.svg"
```

`.svg` 不需要办公扩展。`.png` 需要本机能找到中文字体，找不到就停，不画方框。文档和幻灯片要嵌图时，优先用 png；只要矢量文件时用 svg。

## 内容 JSON

流程图：

```json
{
  "diagram": "flowchart",
  "title": "报销流程",
  "nodes": [
    { "id": "submit", "text": "提交" },
    { "id": "approve", "text": "审批" },
    { "id": "pay", "text": "付款" }
  ],
  "edges": [
    { "from": "submit", "to": "approve" },
    { "from": "approve", "to": "pay" }
  ]
}
```

组织关系：

```json
{
  "diagram": "org",
  "title": "财务部",
  "root": { "text": "财务总监", "children": [{ "text": "会计" }, { "text": "出纳" }] }
}
```

排期：

```json
{
  "diagram": "gantt",
  "title": "上线计划",
  "rows": [
    { "name": "方案", "start": "2026-09-01", "end": "2026-09-05" },
    { "name": "开发", "start": "2026-09-06", "end": "2026-09-20" }
  ]
}
```

节点、连线或行超上限时停下来，不截断。连线的两端必须是已有节点。排期的结束日不能早于开始日，整张图不超过 366 天。
