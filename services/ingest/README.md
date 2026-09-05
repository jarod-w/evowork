# services/ingest —— 本机解析管道（L3）

| 项     | 值                                                                                         |
| ------ | ------------------------------------------------------------------------------------------ |
| 里程碑 | M3 办公技能与解析（8 人周的一部分）                                                        |
| 设计   | [08 产物与解析](../../docs/design/08-artifacts-and-ingest.md) §3（管道）· §4（三档运行时） |
| 约束   | **K6 / Q3：文件在本机解析，原始数据不上传。没有云端兜底路径。**                            |

## 它解决的问题

内核的 `UserInput` 只有 Text / Image / LocalImage / Audio / LocalAudio / Skill / Mention
（README F6）——**没有文档类型**。而清单 §5.3 要求支持 PDF/Word/Excel/PPT/CSV/ZIP……
差额全部由这个管道填：文档 → 本机解析 → Markdown + 关键页 → 注入成 Text + LocalImage + Mention。

## 三条不能松的

1. **没有云端兜底。** office / ocr 档缺失时给的是「装扩展」或「以原始文件引用」两个出路，
   不存在"传到云上解析"这条分支。`test/pipeline.test.ts` 有一条断言扫源码里的
   `fetch` / `node:http` / `WebSocket` —— 这条约束是**结构上不存在**，不是"默认关闭"。
2. **注入载荷里没有全文。** 给路径 + 摘要 + 关键页，agent 要细节时用 shell 读 `content.md`
   （总纲 §6.7）。摘要是启发式的（首段 + 标题 + 表格清单），**不调模型** ——
   解析发生在用户发出第一条消息之前，那时还没有 thread、没有模型选择。
3. **压缩包先列后解。** 中央目录里就有解压后大小，所以炸弹检查在解压任何一个字节之前完成。
   路径穿越拒绝**整包**而不是跳过那一条 —— 跳过单条能让攻击者靠"部分成功"探目录结构。

## 目录

```
src/
  detect.ts          类型识别：magic bytes 优先、扩展名兜底、编码嗅探（GBK/UTF-8）
  gates.ts           六道闸门（08 §3.4），两条是安全硬规则
  runtime.ts         三档运行时（08 §4）+ **与技能侧共用的缺失文案**
  inject.ts          turn/start 载荷 + 启发式摘要
  pipeline.ts        编排：识别 → 闸门 → 落盘 → 解析 → 注入
  parsers/
    builtin.ts       基础包：txt / md / csv / tsv / json
    zip.ts           最小 zip 读取器（自己写，因为这条路径是安全敏感的）
```

## 改这里之前要知道的

| 位置                              | 约束                                                      | 改错的表现                                       |
| --------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `detect.ts` 的 zip 分支           | docx/xlsx/pptx 与 zip **同头**，只能看内部条目区分        | 把 xlsx 当成压缩包解开，得到一堆 xml             |
| `gates.ts` 的 `checkArchive` 顺序 | 先查穿越（安全），再查规模（资源）                        | 一个既穿越又超大的包报成"太大了"                 |
| `inject.ts` 的 `SUMMARY_LIMIT`    | 200 字（08 §3.2）                                         | 放宽它等于把全文往 prompt 里塞                   |
| `runtime.ts` 的 `RUNTIME_TIERS`   | 与 `plugins/skills/_shared/evowork_skill.py` **逐字相同** | 用户在解析与生成时看到两种说法，以为要装两个东西 |
| `parsers/builtin.ts` 的列类型     | 判据是"全部都像"不是"多数像"                              | 混了一个"合计"的列被当成数值列，下游在那一行炸   |

## 还没做的

- **office / ocr 档的实际解析器**（python-docx / openpyxl / python-pptx / pdfplumber / tesseract）：
  接口是 `ExternalParser`，宿主注入。它必须在**受限子进程**里跑且网络关闭 ——
  强制点在 M4 的沙箱，这里只是接口约束。
- 扩展包的下载与安装编排（M9 打包时与更新通道一起做）。
- 解析结果进资料库全文索引（第 ⑥ 步，M8）。
