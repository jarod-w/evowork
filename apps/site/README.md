# apps/site —— EvoWork 官网（中英双语）

面向职场办公用户的 EvoWork 产品官网，覆盖四个核心页面：

- **首页**（`/zh/` · `/en/`）：成品交付交互舞台、专业技能（金融市场热点分析、学术文献精读、合同审查、报表分析）、从复杂任务到持续交付（Office 工具 / 深入调研分析 / 定时任务）、操作电脑（本地文件读写 + 自动网页与跨页面操作）、三步零门槛上手、本地隐私与审批边界、可复制场景提示词。
- **下载上手**（`/zh/download` · `/en/download`）：macOS（Apple 芯片）与 Windows 安装包、可配置开关的 macOS 未签名 `xattr` 引导卡、3 步快速上手。
- **文档中心**（`/zh/docs/:slug` · `/en/docs/:slug`）：面向职场用户的清晰使用指南（安装与首次使用、接入 DeepSeek/Kimi/GLM 模型密钥、Office 成品指南、本地文件与扫描件识别、专业技能与定时任务、安全与隐私边界）。
- **企业版**（`/zh/enterprise` · `/en/enterprise`）：公有云组织托管 / 企业内网私有部署 / 完全断网离线形态、**下一企业版本核心计划（全量操作日志审计 + 敏感信息检测与仿真脱敏还原）**、管理与内容隔离说明、企业预约演示表单。

## 设计与复用纪律

1. **Token 单一真源**：样式全部复用 `@evowork/tokens`（`TOKENS_CSS`），遵守 `eslint` 的 `@evowork/no-style-literals` 与 `test/styles.test.ts` 的零硬编码色值约束。
2. **积木化与数据驱动**：所有页面由 `src/components/` 的可复用区块拼装，文案与配置集中在 `src/config.ts` 与 `src/content/{zh,en}.ts`。
3. **可替换演示舞台**：桌面端演示区支持后续通过 `mediaOverride` 无缝替换为真实录屏视频或截图。
4. **macOS 未签名引导开关**：在 `src/config.ts` 中通过 `showMacUnsignedGuide` 控制；完成 Apple 公证签名后改为 `false` 即可全局隐藏。

## 本地开发与构建

```bash
pnpm --filter @evowork/site dev     # 本地预览 http://localhost:5175
pnpm --filter @evowork/site build   # 产出静态站点 dist/
pnpm --filter @evowork/site test    # 单元测试与 token 样式检查
```
