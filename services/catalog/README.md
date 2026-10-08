# @evowork/catalog

技能 · 连接器 · 专家目录的判定与视图组装（[05](../../docs/design/05-experts-skills-connectors.md)）。

## 这个包的纪律

**不做 Electron、不调内核。** 读盘、写 `connectors.json`、拷技能目录都在桌面宿主；
这里只有能被单测钉住的规则：SKILL.md 解析、P0/P1/P2 静态审计、来源标注、
连接器信任态、专家 TOML 的读写形状。

技能元数据使用 `js-yaml` 的 JSON schema 读取，支持 BOM、引号与多行描述；只对内核同样容忍的未引用冒号标量做兼容修复，多行正文不改写。安装前的有效性检查由宿主调用，空描述与错误类型不能伪报安装成功。

审计**不执行**被审计目录里的任何脚本（05 §3.3 第 1 条）。测试喂的是文件列表，不是跑 `render.py`。

## 「套件」与插件 Hub（[13](../../docs/design/13-plugin-hub.md)）

- `bundles.ts`：「套件」Tab 只列本机与工作区市场 —— 内核自己同步进 `<kernelHome>/.tmp/` 的市场**按路径**滤掉（判一类，不判名字）；
  插件包的安装前审计与技能同一套规则，再叠加插件特有的成分（带应用连接器 = 不可装，stdio MCP / hooks = P2）。
- `hub.ts`：Hub 条目与本机记录的合并、本地重审与云端结论的对账（按 `AUDIT_RULES_VERSION`）、
  5.4 的更新判定（能力不扩大才静默更新）、prompt 预算的口径（与内核 `render.rs` 一致）。
- **改了 `audit.ts` 里任何一条判定，就要改 `AUDIT_RULES_VERSION`**：同版本时客户端要求结论与索引一致，
  不改版本号会把正常的包判成「被动过」。
- **这个包不出网**：`test/hub.test.ts` 扫整个 `src/`，也不许依赖 `@evowork/hub-client`。
