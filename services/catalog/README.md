# @evowork/catalog

技能 · 连接器 · 专家目录的判定与视图组装（[05](../../docs/design/05-experts-skills-connectors.md)）。

## 这个包的纪律

**不做 Electron、不调内核。** 读盘、写 `connectors.json`、拷技能目录都在桌面宿主；
这里只有能被单测钉住的规则：SKILL.md 解析、P0/P1/P2 静态审计、来源标注、
连接器信任态、专家 TOML 的读写形状。

审计**不执行**被审计目录里的任何脚本（05 §3.3 第 1 条）。测试喂的是文件列表，不是跑 `render.py`。
