# apps/site —— EvoWork 官网（中英双语）

面向普通职场办公用户的 EvoWork 产品官网，覆盖四个核心页面：

- **首页**（`/zh/` · `/en/`）：成品交付演示、Word/Excel/PPT 办公三件套、零门槛模型配置、本地资料/定时/预算/技能提炼、本地隐私与审批边界、可复制场景提示词。
- **下载上手**（`/zh/download` · `/en/download`）：macOS（Apple 芯片）与 Windows 安装包、可配置开关的 macOS 未签名 `xattr` 引导卡、3 分钟零账号接入模型步骤、近期更新摘要。
- **文档中心**（`/zh/docs/:slug` · `/en/docs/:slug`）：以职场办公指南为主（含 DeepSeek / Kimi / GLM 密钥接入、Word/Excel/PPT 技巧、定时任务、安全边界、FAQ），附折叠的开发者与开源分支。
- **企业版**（`/zh/enterprise` · `/en/enterprise`）：公有云托管 / 企业内网 / 离线规划形态、企业治理与交付透明度表、可配置提交地址与兜底邮箱的预约演示表单。

## 设计与复用纪律

1. **Token 单一真源**：样式全部复用 `@evowork/tokens`（`TOKENS_CSS`），遵守 `eslint` 的 `@evowork/no-style-literals` 与 `test/styles.test.ts` 的零硬编码色值约束。
2. **积木化与数据驱动**：所有页面由 `src/components/Sections.tsx` 与 `src/components/InteractiveStage.tsx` 的可复用区块拼装，文案与配置集中在 `src/config.ts` 与 `src/content/{zh,en}.ts`。
3. **可替换演示舞台**：当前桌面端演示区由交互式模拟组件驱动，后续录制真实中英双语视频或截屏时，只需在配置里切换 `stageMedia` 即可无缝替换。
4. **macOS 未签名引导开关**：在 `src/config.ts` 中通过 `showMacUnsignedGuide` 控制；拿到 Apple 公证签名后改为 `false` 即可全局隐藏。

## 本地开发与构建

```bash
pnpm --filter @evowork/site dev     # 本地预览 http://localhost:5175
pnpm --filter @evowork/site build   # 产出静态站点 dist/
pnpm --filter @evowork/site test    # 单元测试与 token 样式检查
```
