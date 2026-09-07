# @evowork/projects

「项目」= 总纲的「空间 / 工作空间」（CLAUDE.md 第 5 节的映射表）。里程碑：M2 前端补完。
设计：[02 §4.3](../../docs/design/02-information-architecture.md) ·
[spec](../../docs/superpowers/specs/2026-09-07-projects-design.md)。

## 这个包的纪律

**不做 I/O**。sqlite 与 fs 的读写在 Electron 主进程；这里只有判定与视图组装，
所以每一条规则都能单测。照 `services/artifacts` 的形状。

**归属判定与越界判定共用 `@evowork/policy` 的 `normalizePath`**。不自己写一个
`path.resolve` 版本 —— 两处对 `..` 的处理一旦分叉，其中一处就会变成读走私钥的入口。
