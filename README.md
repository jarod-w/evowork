# EvoWork

全场景职场 AI 智能体工作台：用一句话下达需求，自主规划执行，交付可验收的产物。

实现路线一句话：**把 `openai/codex` 当作不可变的执行内核（Execution Kernel），所有 EvoWork
特性通过官方扩展点注入，前端与调度层完全自建。**

## 文档（唯一真源，改架构先改这里）

| 文档                                            | 内容                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| [总纲](docs/evowork-on-codex-design.md)         | 架构 · 决策 D1–D9 · 产品与工程决策 **Q1–Q29** · 里程碑 M0–M9 + M2a · 风险 R1–R11 |
| [详细设计集 01–10](docs/design/README.md)       | 页面/组件/数据模型/协议序列到可开工粒度 · **F1–F16 内核实测断言**                |
| [功能清单](docs/agent-platform-feature-list.md) | 需求基线                                                                         |
| [工作优先级](docs/work-priority.md)             | 排序判据 · P0–P4 分级 · 关键路径 · **§10 尚未被证伪的断言**                      |
| [可视规格](docs/design/ui-spec.html)            | 01 的渲染面：色板带实测对比度 · 32 组件真渲染 · 三张页面拼装图                   |

跨会话必须遵守的规则在仓库上一层的 [`CLAUDE.md`](../CLAUDE.md)（铁律 K1–K7 + 决策树）。

## 仓库结构

```
evowork/
  docs/                  设计与功能文档
  apps/desktop/          桌面壳 + 三栏 UI（Electron + React + Vite）；Q1=A 后同时是本机服务宿主
  services/              L3 服务层
    kernel-adapter/      【本机】app-server JSON-RPC v2 适配层 —— K2 边界的唯一实现处
    store/               【本机】sqlite 8 张表 + 两个迁移器 + 任务状态投影
    scheduler/           【本机】Automations 定时调度（misfire 补偿 + 设备绑定）
    ingest/              【本机】文档解析管道（PDF/Office/ZIP → Markdown + 图片，不出网）
    artifacts/           【本机】产物识别（三信号源）与索引
    gateway/             【云端】Responses API 网关（三家国内模型全量适配）
    identity/            【云端】账号 · 租户 · 配额 · 签名策略包下发
  packages/              跨层共享库：protocol · logging · tokens
  ext/                   Rust 扩展 crate（extension-api contributor）
  plugins/               随产品分发的扩展包：skills · agents · connectors · hooks
  config/                config.toml 模板 · 模式片段 · 场景包 · 权限文案 · 运营位开关
  patches/evowork/       对内核的补丁（K1 硬上限 ≤5 文件 / ≤500 行，当前为空）
  scripts/               漂移雷达 · 补丁预算 · 许可清单
  tools/                 开发期工具（eslint 规则）
```

每个目录下都有一份 README，写清它的里程碑、对应设计文档、以及**该目录特有的纪律**。

## 开发

前置：Node ≥ 22.12 · pnpm 10 · 执行内核签出在 `../codex`（只读，见 CLAUDE.md K1）。

```bash
pnpm install

pnpm run check            # 一次跑全：格式 → lint → 类型 → 测试 → K1 补丁预算
pnpm run test             # 测试
pnpm run lint             # 含 K2 边界纪律与 01 §9 的 token-only 样式
pnpm run typecheck
pnpm run kernel:drift     # 上游漂移 + F1–F16 断言复核（--no-fetch 可离线跑）
pnpm run notices          # 重新生成 THIRD_PARTY_NOTICES.md（K5）
```

内核侧常用命令（在 `../codex` 里跑，见 CLAUDE.md §7）：

```bash
(cd ../codex/codex-rs && cargo build -p codex-app-server)   # EvoWork 唯一对话的进程
(cd ../codex && just app-server-test-client)                # 交互式 JSON-RPC 客户端，摸协议行为
```

## 当前实现状态（2026-09-05）

完整状态见 **[docs/status.md](docs/status.md)**（做到哪了 · 什么验过了 · 什么卡住了）。下表是摘要。

**735 个测试**（733 通过 · 2 个如实跳过），`pnpm run check` 全绿（格式 · lint · 类型 · 测试 · K1 补丁预算）。

| 分级                 | 状态                                                                                                                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 回写总纲        | ✅ 总纲 v0.4 + 详细设计集 v0.2；F1–F16 在 `89a4eec6da` 复核，新增 **F17 / F18** 两条修订                                                                                                                                                                                                                  |
| P0-2 决策            | ✅ Q17–Q29 十三条全部决策（采纳建议），已回写总纲 §10.1.1 / §10.1.3                                                                                                                                                                                                                                       |
| P0-3 仓库骨架        | ✅ pnpm workspace · lint（含 **K2 边界规则**）· 类型 · 测试 · CI · **每日漂移雷达**（F1–F16 机器复核）· K1 补丁预算 · 许可清单                                                                                                                                                                            |
| P1-2 M2a 服务层      | ✅ 核心：`@evowork/protocol`（NDJSON + 双向分发）· `@evowork/store`（14 表 + **两个迁移器** + 状态投影）· `@evowork/kernel-adapter`（会话 / 心跳 / 退避重启 / 会话恢复 · 能力探测与降级 · 事件流三消费者 · 审批双策略 · 场景展开）                                                                        |
| P1-1 M1 网关         | 🟢 全量翻译 · 三家 provider 与错误映射 · 用量规范化 · SSE · 能力端点 · **Q14 不落盘**。**Q16 三家已全部对真实 endpoint 实测**（并改出三个真缺陷，见 status §3）                                                                                                                                           |
| P1-3 M2 前端         | ✅ token 层（含**对比度自动化断言**）· 基础组件 · **19 类 Item 渲染** · 四类审批卡 · 三栏工作台 · **首页与 Composer**（`@` / `/` 补全 · 附件与本机解析承诺 · 三个底栏选择器 · 五态发送按钮）· **任务列表与六组筛选** · **变更视图** · **Electron 引导与 preload**（窗口安全参数被测试钉住）· 本机服务宿主 |
| P2-1 M3 技能与解析   | ✅ 四个办公技能（共用骨架）· 本机解析管道（六道闸门 · zip · 注入载荷）· 三档运行时分发                                                                                                                                                                                                                    |
| P2-2 M4 安全策略     | ✅ 三级路径策略 · profile 文案 · 命令风险 · 并发预算 · guardian 映射 · 审计链 · hooks 策略包                                                                                                                                                                                                              |
| P3-1 M5 自动化       | ✅ cron（时区 + DST 两个边界）· misfire 三策略 · 失败语义 · 设备迁移 · 自然语言解析                                                                                                                                                                                                                       |
| P3-3 M8 产物与可视化 | ✅ Visualizer（R5 落点）· 产物识别三信号 · 分享授权流 · 资料库视图                                                                                                                                                                                                                                        |
| P3-2 M9 打包         | 🟡 入口 · builder 配置 · 体积预算 · 未签名降级；待装 electron 跑通打包                                                                                                                                                                                                                                    |
| P0-4 / P0-5 / P4-2   | ⏸ 外部依赖（模型额度 · 代码签名 · 法务），不在开发序列                                                                                                                                                                                                                                                    |

**尚未被证伪的断言**见 [work-priority §10](docs/work-priority.md) 与 [status §3](docs/status.md)：**U2 已于 2026-09-05 关闭**（三家实测通过）；U1（GLM 产物质量）· U3（misfire 真机）· U4（签名公证）仍开着 —— 它们不会因为"代码写完了"而被勾掉。

## 三件必须一直记住的事

1. **唯一边界是 app-server JSON-RPC v2**（K2）。不读内核的 sqlite / rollout 文件、不链接 Rust。
   诱惑最大的三处在 [09 §2](docs/design/09-service-layer.md)，已做成 lint 规则。
2. **隐私是部署形态而非承诺**（K6 + Q1=A）。解析、执行、索引全在本机；**没有云端兜底路径**。
   离开本机的动作只有两条：模型调用（Q14 网关不落盘）与显式授权的分享（Q10 默认关闭）。
3. **上游在跑**。总纲 v0.1 基线至今 237 个提交。带 `path:line` 的断言动手前重新核对 ——
   或者直接看每日漂移雷达的报告。

## 许可

本仓库代码见 [LICENSE](LICENSE)。执行内核 `openai/codex` 为 Apache-2.0，
分发义务与第三方依赖清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)（K5）。
产品对外**不得出现 Codex / OpenAI 品牌**。
