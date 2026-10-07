# 资料库长词与混合检索性能优化验收

日期：2026-10-07（Asia/Shanghai）。延续 [首次验收记录](2026-10-06-ocr-and-library-search.md)，保留其原始性能结果。本次只优化已有检索和投影索引，不改变资料授权、OCR 或检索语义。

## 改动与原因

首次基准的长词/混合查询五次最大值为 564/667 ms。分段测量显示主要耗时在 SQL，片段生成约 15–22 ms：10,000 个范围 ID 每次展开成 SQL `VALUES`；单长词为匹配与评分重复扫描；读取 FTS 的未索引文档 ID 会载入重复正文/meta；短词条件扫描全部 FTS 行。

本次改为一个绑定 JSON 范围数组，单长词复用评分结果，FTS 行通过 `(fts_rowid, document_id)` 覆盖索引关联文档；短词沿文档分块索引查全部原文块，首次命中即停止。FTS 作为关联外层，避免查询计划将 10,000 个范围 ID 与每条匹配行组合探测。查询计划控制依据见 [SQLite 官方优化器说明 §7.1.2、§8.1、§9](https://sqlite.org/optoverview.html)。文档 ID 与绑定范围均为字符串，保留其字面比较。

投影迁移 v5 只添加索引，不重建正文、不修改权威版本。升级测试先在旧实现上失败（投影仍为 v4），补充迁移后通过；已有源 hash、页定位正文与元数据保留，升级后可查询。

标题优先、BM25、更新时间/ID 排序、跨块 AND、范围先于分页、字面引号/FTS 关键字、Unicode/全半角规范化、2 秒可终止只读进程均保留。没有在排序前截断候选文档；短词可以出现在不含长词的另一块或较后页。

## 同机 A/B 结果

机器：MacBookAir10,1 / Apple M1，macOS arm64，Node 24.19.0。实际数据库含 10,000 文档、100,000 分块，144,629,760 字节，低于 1 GiB。正文与 [首次格式/检索基准](2026-10-06-library-baseline.json) 相同；数据库 SHA-256 与全部采样见 [原始报告](2026-10-07-library-search-performance.json)。

旧实现取自提交 `60d0a2e` 的 `services/store/src/library-query.ts`，新旧使用同一数据库、同一范围和 `details: true`。每组各采样 30 次，交替 A/B 顺序，顺序运行避免自身竞争；每次新建独立读进程与连接。计时包含进程启动、SQL 匹配/排序和 20 个文档的片段/高亮；保留每组首个观测，不预先丢弃慢样本。P95 按最近秩取第 29 个有序观测。

| 查询 | 旧版 P95（ms） | 新版 P50（ms） | 新版 P95（ms） | 新版最大值（ms） | 目标 |
| --- | --- | --- | --- | --- | --- |
| `ZXCVUNIQUE` | 426 | 215 | **220** | 225 | ≤500 ms，通过 |
| `合同` | 188 | 109 | **115** | 135 | ≤2 s，通过 |
| `ZXCVUNIQUE 付款` | 506 | 244 | **258** | 264 | ≤500 ms，通过 |
| `ZXCVUNIQUE ordinary` | 661 | 444 | **451** | 482 | ≤500 ms，通过 |
| `ZXCVUNIQUE ordinary 付款` | 745 | 476 | **496** | 500 | ≤500 ms，通过 |

150 组 A/B 查询的完整结果逐项一致：文档顺序、标题、来源片段、位置和高亮。测量前后数据库 hash 不变。

本次没有清空操作系统文件缓存；证明的是上述固定语料、正常文件缓存状态下的进程/连接重新启动延迟，不是磁盘缓存完全冷启动或所有真实语料的 P95 保证。两个长词加短词的 P95 接近 500 ms，仍需后续更广语料、较长分块、选择性差异与冷启动采样。首次五次基准与本次 30 次 A/B 的运行状态不同，不能将两次数字当作严格同场对照；上表旧/新版才是本次同场对照。

## 复现

从仓库根目录执行；输出使用独立临时目录。未设置数据库时脚本创建相同规模语料；指定数据库时检查文档/分块数、记录 hash，并在测量后复核不变。

```bash
mkdir -p <temporary-output>
git show 60d0a2e:services/store/src/library-query.ts > <temporary-output>/baseline.ts
pnpm exec esbuild <temporary-output>/baseline.ts --bundle --platform=node --format=esm --outfile=<temporary-output>/baseline.mjs
EVOWORK_LIBRARY_SEARCH_OUTPUT=<temporary-output> \
EVOWORK_LIBRARY_SEARCH_BASELINE=<temporary-output>/baseline.mjs \
node scripts/verify-library-search.mjs
```

`EVOWORK_LIBRARY_SEARCH_DATABASE` 可指定已有的本机验收数据库。脚本会正常升级其投影索引，应仅指向验收副本；省略旧版模块可单独验证新版。任一结果不一致、规模不符、正文片段缺失、数据库变化或 P95 超出目标，脚本失败，不静默跳过。

## 回归检查

`pnpm run check` 退出 0：169 个测试文件通过、1 个跳过；2708 项测试通过、2 项跳过。格式、lint、类型、内核补丁预算、协议形状、许可清单均通过。完整 `pnpm run build` 退出 0。真实 Electron + 发货内核 + 本机确定性模型网关的 `library-search.spec.mjs` **1/1 通过**（6.9 秒）：正文命中、高亮、位置预览、引用到未发送草稿、刷新后范围保留，以及移除副本后原文件保留。

测试覆盖晚页/跨块长短词 AND、多个长词、标题优先与 BM25/时间/ID 顺序、分页前范围、特殊 ID/字面操作符、超时和取消，以及 v4 升级后继续读取已有正文。

本次基准达到既定性能目标。OCR 的 x64、签名发行包和复杂扫描质量等其它发布门槛保持独立，仍见首次验收记录。
